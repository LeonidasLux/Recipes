import type {
  DB,
  Meal,
  Order,
  OrderItem,
  OrderStatus,
  PersonKey,
  Profiles,
  Recipe,
  SourceKey,
  SyncConfig,
  ViewRole,
} from './types';

/* ─── 时间 ───────────────────────────────────── */

function pad(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

/** 只要日期部分：`2026-10-07`（判断「今天」等比较用） */
export function dateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 记录时间统一格式：`2026-10-07 09:40`。
 *
 * 所有「记录下来的时间字段」（菜谱收藏 / 更新时间、订单下单 / 更新时间、
 * 昵称更新时间、同步日志、同步时间戳）都用它，**必须带年月日**，
 * 不能只剩下小时和分钟，否则跨天就分不清是哪一天。
 */
export function stamp(d: Date = new Date()): string {
  return `${dateKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 当前时刻的完整时间戳（见 stamp） */
export function nowStamp(): string {
  return stamp();
}

/**
 * 精确到秒的时间戳：`2026-10-07 09:40:12`。
 *
 * 只给**同步时间**用（`lastPulledAt` / `lastPushedAt` / 同步状态里的 `lastAt`）：
 * 点一次「立即同步」得看得出确实又同步过了，分钟精度常常看不出变化。
 * 菜谱 / 订单那些记录时间仍用 `nowStamp()`，到分钟就够。
 */
export function nowStampSec(): string {
  const d = new Date();
  return `${stamp(d)}:${pad(d.getSeconds())}`;
}

/* ─── 来源徽章 ───────────────────────────────── */

export interface SrcMeta {
  label: string;
  cls: string;
}

const SRC_MAP: Record<SourceKey, SrcMeta> = {
  red: { label: '小红书', cls: 'sred' },
  bili: { label: 'B站', cls: 'sbili' },
  douyin: { label: '抖音', cls: 'sdou' },
  generic: { label: '网页', cls: 'sgeneric' },
  manual: { label: '手动', cls: 'smanual' },
};

export function srcMeta(key: SourceKey): SrcMeta {
  return SRC_MAP[key] ?? SRC_MAP.generic;
}

/** 来源小点的颜色变量（列表内联色用） */
export function srcColorVar(key: SourceKey): string {
  switch (key) {
    case 'red':
      return 'var(--src-red)';
    case 'bili':
      return 'var(--src-bili)';
    case 'douyin':
      return 'var(--src-douyin)';
    case 'manual':
      return 'var(--ink)';
    default:
      return 'var(--muted)';
  }
}

/* ─── 订单状态 ───────────────────────────────── */

export interface StatusMeta {
  cls: string;
  label: string;
  icon: 'clock' | 'pot' | 'check';
}

export function statusMeta(status: OrderStatus): StatusMeta {
  if (status === 'pending') return { cls: 'pending', label: '待接', icon: 'clock' };
  if (status === 'accepted') return { cls: 'accepted', label: '已接', icon: 'pot' };
  return { cls: 'done', label: '已完成', icon: 'check' };
}

export function mealLabel(meal: Meal): string {
  return meal === 'dinner' ? '晚餐' : '午餐';
}

/* ─── 订单 helper（多菜模型）─────────────────── */

export function orderItems(o: Order): OrderItem[] {
  return o?.items ?? [];
}

export function itemNames(o: Order): string[] {
  return orderItems(o).map((it) => it.dishName);
}

export function firstItem(o: Order): OrderItem {
  const arr = orderItems(o);
  return arr.length ? arr[0] : { recipeId: null, dishName: '未命名' };
}

export function orderMain(o: Order): string {
  return firstItem(o).dishName;
}

/** “番茄炖牛腩 等 2 道” 式摘要 */
export function orderSummary(o: Order): string {
  const names = itemNames(o);
  if (!names.length) return '空单';
  if (names.length === 1) return names[0];
  return `${names[0]} 等 ${names.length} 道`;
}

export function findRecipe(db: DB, id: string | null | undefined): Recipe | null {
  if (!id) return null;
  return db.recipes.find((r) => r.id === id) ?? null;
}

/** 取订单里第一道有插画的菜（列表大图用） */
export function orderArt(o: Order, db: DB): string | null {
  for (const it of orderItems(o)) {
    const r = findRecipe(db, it.recipeId);
    if (r?.art) return r.art;
  }
  return null;
}

export function itemArt(it: OrderItem, db: DB): string | null {
  return findRecipe(db, it.recipeId)?.art ?? null;
}

/** 某道菜是否出现在未完成的单里 */
export function recipeInOpenOrder(orders: Order[], recipeId: string | null): Order | null {
  if (!recipeId) return null;
  for (const o of orders) {
    if (o.status === 'done') continue;
    if (orderItems(o).some((it) => it.recipeId === recipeId)) return o;
  }
  return null;
}

/* ─── 两个人（a / b）──────────────────────────── */

export const PERSON_KEYS: readonly PersonKey[] = ['a', 'b'] as const;

/** 两个人里的另一位 */
export function partnerOf(p: PersonKey): PersonKey {
  return p === 'a' ? 'b' : 'a';
}

/** 某人设过的昵称；没设过返回空串，兜底措辞交给调用方 */
export function nicknameOf(profiles: Profiles | undefined, p: PersonKey): string {
  return profiles?.[p]?.nickname?.trim() ?? '';
}

/** 本机这个人是谁（config.me）；缺省算 a */
export function meOf(cfg: SyncConfig | null): PersonKey {
  return cfg?.me === 'b' ? 'b' : 'a';
}

/** 本机当前角色（config.view）：决定底部第二格是「点单」还是「掌勺」；缺省算点单 */
export function viewOf(cfg: SyncConfig | null): ViewRole {
  return cfg?.view === 'cook' ? 'cook' : 'order';
}

/**
 * 这张单是不是「今天的单」。
 *
 * 订单时间戳是 `2026-10-07 09:40` 这类带年月日的绝对串（见 nowStamp），
 * 所以按「日期部分是不是今天」判断：点单页用它把「今日点单」与「历史点单」分开。
 * 老缓存 / 老仓库里可能还留着 `今天 09:40` 这类相对串，一并按「今天」认。
 */
export function isTodayOrder(o: Order): boolean {
  const s = o?.createdAt ?? '';
  return s.startsWith(dateKey()) || s.startsWith('今天');
}

/* ─── 插画路径 ───────────────────────────────── */

export function artUrl(art: string): string {
  return `/art/${art}`;
}

/** 无插画时的首字占位 */
export function initial(title: string): string {
  return (title || '菜').charAt(0);
}

/* ─── 标识符 ─────────────────────────────────── */

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ─── 日期问候（顶栏那行小字）───────────────── */

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function todayLine(d = new Date()): string {
  return `${WEEKDAYS[d.getDay()]} · ${d.getMonth() + 1}月${d.getDate()}日`;
}
