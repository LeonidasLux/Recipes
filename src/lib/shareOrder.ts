/* ============================================================
   分享一张点单 + 认出「分享出去的那条链接」

   点单本来就是发给另一半看的，微信是最常走的那条路 —— 所以分享走**系统分享面板**
   （`@capacitor/share`：原生包与网页版都是它，面板里第一个就是微信），
   面板起不来（桌面浏览器、老 WebView）就退回复制到剪贴板，至少能粘进微信发出去。

   链接要满足两件事：**对方点一下就能打开应用**、**打开就直接跳到这一单**。
   所以分享出去的地址随平台走（见 orderLink）：
     · 原生包（APK）里给应用自己的 scheme —— `jishiben://o/<订单 id>`，
       `AndroidManifest.xml` 里注册了它（见 CONTEXT §11），点一下由系统把应用拉起来；
     · 网页版（PWA）在别人的手机上只有浏览器，就给本页地址 ——
       `<本页地址>#/o/<订单 id>`，点开就是网页版的这一单。

   两条路都落到同一个路由 `/o/<订单 id>`（`App.tsx` 的 OpenOrder）：
   我点的单进「点单」、对方点的进「掌勺」，并把那一单展开。
   ============================================================ */

import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { dayTag, mealLabel, orderDay, orderItems, orderSummary } from '../data/helpers';
import type { Order } from '../data/types';

/** 应用自己的 URL scheme（`AndroidManifest.xml` 里注册的就是它） */
export const LINK_SCHEME = 'jishiben';

/** 深链 / 路由里的那一段路径：`jishiben://o/<id>` ↔ `#/o/<id>` ↔ 路由 `/o/<id>` */
const ORDER_PATH = 'o';

/** 分享面板的标题（邮件当主题、系统面板顶部那条） */
const SHARE_TITLE = '记食本 · 点单';

/** 网页版分享出去的链接底座：当前页地址，去掉查询 / hash 与结尾的 index.html */
function webBase(): string {
  /* 浏览器里 location 是全局；jsdom（冒烟测试）只装了 window，所以两条都看一眼 */
  const g = globalThis as {
    location?: { origin?: string; pathname?: string };
    window?: { location?: { origin?: string; pathname?: string } };
  };
  const loc = (typeof location !== 'undefined' ? location : g.location ?? g.window?.location) as
    | { origin?: string; pathname?: string }
    | undefined;
  const origin = loc?.origin ?? '';
  if (!origin) return '';
  return `${origin}${(loc?.pathname ?? '').replace(/index\.html$/, '')}`;
}

/* 冒烟测试跑在 jsdom 里，平台判定永远是「网页」，而分享出去的链接**随平台变**。
   要覆盖原生包那条路（`jishiben://`）就得把判定换掉；只给测试用，业务代码别调。 */
let platformOverride: boolean | null = null;

export function setSharePlatformForTest(native: boolean | null): void {
  platformOverride = native;
}

function isNativeApp(): boolean {
  return platformOverride ?? Capacitor.isNativePlatform();
}

/**
 * 这一单分享出去的那条链接。
 *
 * 原生包给 `jishiben://o/<id>`（点一下直接进应用）；网页版给本页地址 + `#/o/<id>`
 * （微信里是能点的 https 链接，点开是网页版的这一单 —— 网页版没有「打开应用」这回事）。
 * `native` 只在测试里显式传，业务代码一律走默认的当前平台。
 */
export function orderLink(orderId: string, native: boolean = isNativeApp()): string {
  if (native) return `${LINK_SCHEME}://${ORDER_PATH}/${orderId}`;
  return `${webBase()}#/${ORDER_PATH}/${orderId}`;
}

const SCHEME_RE = new RegExp(`^${LINK_SCHEME}:(?:\\/\\/)?${ORDER_PATH}\\/([^/?#\\s]+)`, 'i');
const FRAGMENT_RE = new RegExp(`#\\/${ORDER_PATH}\\/([^/?#\\s]+)`, 'i');

/**
 * 从一条链接里认出「要打开哪一单」，认不出来返回 null（别的链接一概不管）。
 *
 * 认这两种写法：
 *   `jishiben://o/<id>`（原生包里分享出去的那条，也可能是 `jishiben:o/<id>` 这种没双斜杠的）
 *   `https://…/#/o/<id>`（网页版分享出去的那条；同一套解析以后接了 Android App Links 也能用）
 */
export function parseOrderLink(raw: string | null | undefined): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  const hit = SCHEME_RE.exec(s) ?? FRAGMENT_RE.exec(s);
  if (!hit) return null;
  const id = hit[1] ?? '';
  try {
    return decodeURIComponent(id) || null;
  } catch {
    /* 不是合法的百分号编码：原样用，别把一次点链接变成报错 */
    return id || null;
  }
}

/**
 * 分享文案（纯函数，便于单测）。长这样：
 *
 *   【记食本】明天晚餐 · 番茄炖牛腩 等 2 道
 *   番茄炖牛腩、巴斯克芝士蛋糕
 *   给掌勺的话：少放辣
 *   点开这一单 → jishiben://o/o2
 *
 * 只点了一道菜时第二行与第一行重复，就不印；没写「给掌勺的话」时那行也没有。
 */
export function orderShareText(order: Order, link: string): string {
  const names = orderItems(order).map((it) => it.dishName);
  const summary = orderSummary(order);
  const dishes = names.join('、');
  const when = `${dayTag(orderDay(order))}${mealLabel(order.meal)}`;
  return [
    `【记食本】${when} · ${summary}`,
    dishes !== summary ? dishes : '',
    order.note ? `给掌勺的话：${order.note}` : '',
    `点开这一单 → ${link}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 分享的走法：交了面板 / 退回复制 / 用户把面板关掉了 */
export type ShareOutcome = 'shared' | 'copied' | 'canceled';

/** 复制纯文本：先走剪贴板 API，老 WebView 上退回 textarea + execCommand，都失败就抛错 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* 没有剪贴板 API（老 WebView、非安全上下文）：走下面那条老路 */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  document.body.appendChild(ta);
  ta.select();
  try {
    const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
    if (!copied) throw new Error('copy failed');
  } finally {
    ta.remove();
  }
}

/**
 * 把文案交给系统分享面板（`@capacitor/share`：原生与网页版同一个入口）。
 *
 * 三种结果分开说清楚，界面才不会撒谎：面板交出去了 → `shared`（用户取消分享时原生那边
 * reject 的是 "Share canceled"，也算这一种，不复制、不提示）；这台机器根本没有分享面板
 * → 复制到剪贴板 → `copied`；复制也不行就抛错。
 */
export async function shareOrderText(text: string, title = SHARE_TITLE): Promise<ShareOutcome> {
  const can = await Share.canShare()
    .then((r) => Boolean(r?.value))
    .catch(() => false);
  if (!can) {
    await copyText(text);
    return 'copied';
  }
  try {
    await Share.share({ title, text, dialogTitle: title });
    return 'shared';
  } catch (e) {
    /* 用户取消（原生那边 reject 的是 "Share canceled"）、或上一次面板还开着
       （reject "Can't share while sharing is in progress"）：都当没发生，不复制也不提示 */
    if (/cancel|in progress/i.test(e instanceof Error ? e.message : String(e))) return 'canceled';
    await copyText(text);
    return 'copied';
  }
}
