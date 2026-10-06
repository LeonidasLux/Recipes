/* ============================================================
   从「分享文案」里解析出菜谱信息

   为什么不做真抓取：小红书/B站都**不返回 CORS 头**，浏览器读不到页面内容
   （实测小红书页面确实把标题内嵌在 window.__INITIAL_STATE__ 里，但那需要
   服务端去抓）。所以这里走另一条路 —— 各平台分享时复制出来的是一整段
   带标题的文字，直接把它粘进来，比抓页面更准、更快、也不用后端。

   解析是启发式的，不可能覆盖所有格式。所以界面上**标题永远可编辑** ——
   解析结果只是预填，不替用户做决定。宁可留空，也不编造。
   ============================================================ */

import type { SourceKey } from '../data/types';

export interface ParsedShare {
  /** 文案里找到的第一个链接；没有则为空串 */
  url: string;
  source: SourceKey;
  /** 解析出的标题，可能是空串（那就交给用户手填） */
  title: string;
  author: string;
}

/**
 * 各平台分享文案里的固定尾巴。
 *
 * **顺序有意义**：长而具体的必须排在短而通用的前面。
 * 曾经把「打开抖音…」放在「复制打开抖音，看看【xx的作品】」前面，
 * 结果前者先把「打开抖音」吃掉了，后者再也匹配不上，标题里就残留了「看看【xx的作品】」。
 */
const BOILERPLATE: RegExp[] = [
  /* 小红书 */
  /复制本条信息[，,]?\s*打开[【\[]?小红书[】\]]?\s*(?:App|APP)?\s*(?:查看精彩内容)?[！!。.～~]?/gi,
  /打开[【\[]?小红书[】\]]?\s*(?:App|APP)?\s*(?:查看|搜索)?(?:精彩内容)?[！!。.～~]?/gi,
  /* 抖音：先长后短 */
  /复制打开(?:Dou音|抖音)[，,]?\s*看看\s*[【\[]?\s*[^】\]]{0,30}\s*[】\]]?\s*(?:的?作品)?[！!。.～~]?/gi,
  /复制此链接[，,]?\s*打开(?:Dou音|抖音)(?:搜索)?[，,]?\s*(?:直接观看视频)?[！!。.～~]?/gi,
  /点击链接直接打开\s*(?:或复制本条信息[，,]?\s*打开「?(?:抖音|Dou音)」?搜索直接打开)?[！!。.～~]?/gi,
  /打开(?:Dou音|抖音)(?:搜索|看看)?[，,]?\s*(?:直接观看视频)?[！!。.～~]?/gi,
  /* 通用 */
  /(?:小红书|抖音|哔哩哔哩|B站|微博)\s*号[：:]\s*[\w.\-]+/gi,
  /分享自\s*(?:小红书|抖音|哔哩哔哩|B站)/gi,
  /^\s*(?:发表于|发布于|编辑于)\s*.{0,20}$/gm,
  /^\s*网页链接\s*$/gm,
];

/** 抖音文案里的「看看【xxx的作品】」—— 顺手把作者捞出来 */
const DOUYIN_AUTHOR = /[【\[]\s*([^】\]]{1,20}?)\s*的?作品\s*[】\]]/;

const URL_RE = /https?:\/\/[^\s，。！？、；：「」『』（）()【】\[\]<>"']+/i;

/** 从一段文案里取出第一个链接 */
export function extractUrl(text: string): string {
  return text.match(URL_RE)?.[0] ?? '';
}

/** 按域名判断来源 */
export function detectSource(raw: string): SourceKey | null {
  const url = extractUrl(raw) || raw.trim();
  let host: string;
  try {
    host = new URL(url.toLowerCase()).hostname;
  } catch {
    return null;
  }
  if (host.includes('xiaohongshu') || host.includes('xhslink')) return 'red';
  if (host.includes('bilibili') || host.includes('b23.tv')) return 'bili';
  if (host.includes('douyin') || host.includes('iesdouyin')) return 'douyin';
  return 'generic';
}

/**
 * 从文案里挑出最像标题的一句。
 * 策略：去掉链接和平台尾巴，再取最长的一行 —— 分享文案里标题几乎总是最长的那句。
 */
function pickTitle(text: string): string {
  let s = text;
  for (const re of BOILERPLATE) s = s.replace(re, '\n');
  s = s.replace(new RegExp(URL_RE.source, 'gi'), '\n');

  const lines = s
    .split(/[\n\r]+/)
    .map((line) => line.replace(/^[\s\-—–·|>»]+|[\s\-—–·|]+$/g, '').trim())
    .filter((line) => /[一-龥A-Za-z0-9]/.test(line)) // 纯 emoji / 纯标点的行丢掉
    .filter((line) => line.length >= 2);

  if (!lines.length) return '';

  const best = lines.reduce((a, b) => (b.length > a.length ? b : a));

  return best
    .replace(/#[^#\s]{1,24}#?/g, ' ') // 话题标签
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ') // 表情
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-—–·|【]+|[\s\-—–·|】]+$/g, '') // 顺手去掉 B站标题外面的【】
    .trim()
    .slice(0, 40);
}

export function parseShare(text: string): ParsedShare {
  const url = extractUrl(text);
  const source = detectSource(text) ?? 'generic';

  /* 抖音文案里的作者最好拿；其它平台只能留空 */
  const author = text.match(DOUYIN_AUTHOR)?.[1]?.trim() ?? '';

  /* 只有一条链接、没有别的文字 —— 那就没有标题可解，老实留空 */
  const leftover = text.replace(new RegExp(URL_RE.source, 'gi'), '').trim();
  const title = leftover.length >= 2 ? pickTitle(text) : '';

  return { url, source, title, author };
}

/* ─── 封面插画猜测 ───────────────────────────── */

/**
 * 抓不到真封面（要服务端），但本地有几张卡通插画。
 * 按标题里的关键词配一张——猜错也只是张示意图，用户可以不管。
 */
const ART_KEYWORDS: Array<[RegExp, string]> = [
  [/番茄|西红柿|牛腩|炖牛肉/, 'tomato-beef.svg'],
  [/虾|虾仁/, 'garlic-shrimp.svg'],
  [/鸡腿|卤味|卤/, 'braised-leg.svg'],
  [/椰子鸡|椰子|火锅/, 'coconut-chicken.svg'],
  [/西米|西米露|杨枝甘露/, 'mango-sago.svg'],
  [/芒果|糯米饭/, 'mango-sticky-rice.svg'],
  [/三杯鸡|九层塔|台式/, 'three-cup-chicken.svg'],
  [/蛋糕|芝士|巴斯克|烘焙/, 'basque-cake.svg'],
  [/面|拌面|葱油|拉面|面条/, 'scallion-noodle.svg'],
];

export function guessArt(title: string): string {
  for (const [re, art] of ART_KEYWORDS) {
    if (re.test(title)) return art;
  }
  return '';
}
