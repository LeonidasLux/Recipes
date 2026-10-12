import type {
  DB,
  Meal,
  Order,
  OrderChange,
  OrderItem,
  OrderStatus,
  PersonKey,
  Profiles,
  Recipe,
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

/* ─── 「哪天吃」─────────────────────────────────
   单子上记的是绝对日期 key（`2026-10-12`），界面上再翻成「今天 / 明天 / 后天」
   这类相对说法 —— 相对话只在**看的那一刻**才有意义，所以不落库。 */

/** 相对今天的第 n 天（n 可以是负数：昨天就是 `dayKey(-1)`）的日期 key */
export function dayKey(n = 0, d: Date = new Date()): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  return dateKey(x);
}

/** 日期 key 是不是一个正经的 `YYYY-MM-DD` */
export function isDayKey(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * 日期 key 的说法：今天 / 明天 / 后天 / 昨天，更远就给「10月12日」
 * （跨年的再带上年份）。认不出来的 key 原样回（正常数据走不到，`orderDay` 兜过底）。
 */
export function dayWord(key: string, d: Date = new Date()): string {
  const rel: [number, string][] = [
    [0, '今天'],
    [1, '明天'],
    [2, '后天'],
    [-1, '昨天'],
  ];
  for (const [n, word] of rel) if (key === dayKey(n, d)) return word;
  if (!isDayKey(key)) return key;
  const [y, m, day] = key.split('-').map(Number);
  return y === d.getFullYear() ? `${m}月${day}日` : `${y}年${m}月${day}日`;
}

/**
 * 卡片 / 按钮上的日期前缀：**不是今天就给个词（「明天」「后天」），是今天给空串**。
 * 今天是最常见的情况，就不用每处都写个「今天」占地方了。
 */
export function dayTag(key: string, d: Date = new Date()): string {
  return key === dayKey(0, d) ? '' : dayWord(key, d);
}

/**
 * 这张单是哪一天吃。
 *
 * 优先读 `dateKey`；老数据（写于加这个字段之前）没有，就按 `createdAt` 那一天算
 * —— 那时候「下单当天吃」是唯一的用法。更老的数据里 createdAt 还是
 * `今天 09:40` / `昨天 10:00` 这种相对串，一并认。
 */
export function orderDay(o: Order | null | undefined, d: Date = new Date()): string {
  const key = o?.dateKey;
  if (isDayKey(key)) return key;
  const created = typeof o?.createdAt === 'string' ? o.createdAt : '';
  if (isDayKey(created.slice(0, 10))) return created.slice(0, 10);
  if (created.startsWith('昨天')) return dayKey(-1, d);
  return dayKey(0, d);
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
  if (meal === 'breakfast') return '早餐';
  if (meal === 'dinner') return '晚餐';
  if (meal === 'night') return '夜宵';
  return '午餐';
}

/** 口语化的餐别（组合器那句「今天中午」）：早上 / 中午 / 晚上 / 夜宵 */
export function mealWord(meal: Meal): string {
  if (meal === 'breakfast') return '早上';
  if (meal === 'dinner') return '晚上';
  if (meal === 'night') return '夜宵';
  return '中午';
}

/** 四个餐别，界面上按这个顺序摆（早 → 午 → 晚 → 夜宵） */
export const MEALS: readonly Meal[] = ['breakfast', 'lunch', 'dinner', 'night'] as const;

/** 是不是合法餐别（读任意来源的数据 —— 老缓存 / 老仓库 —— 时用） */
export function isMeal(v: unknown): v is Meal {
  return MEALS.includes(v as Meal);
}

/**
 * 各餐别对应的**时间区间**（当天 0 点起的分钟数，左闭右开；夜宵跨零点）。
 *
 * 点单时按「现在几点」先默认选一餐 —— 这个默认是给人省的：一天四顿，忘了改
 * 就会点错餐别。区间只是默认值，用户随时能手动改（见 `mealForTime`）。
 */
export const MEAL_WINDOWS: readonly { meal: Meal; from: number; to: number }[] = [
  { meal: 'breakfast', from: 5 * 60, to: 10 * 60 },
  { meal: 'lunch', from: 10 * 60, to: 15 * 60 },
  { meal: 'dinner', from: 15 * 60, to: 21 * 60 },
  /* 夜宵从 21:00 一直算到第二天 05:00（跨零点），所以它的区间是「尾 < 头」 */
  { meal: 'night', from: 21 * 60, to: 5 * 60 },
];

/** 某个餐别的时间区间文案：`05:00–10:00`（界面上告诉用户默认是怎么来的） */
export function mealWindow(meal: Meal): string {
  const w = MEAL_WINDOWS.find((x) => x.meal === meal) ?? MEAL_WINDOWS[0];
  const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  return `${hhmm(w.from)}–${hhmm(w.to)}`;
}

/** 这个时刻（默认现在）该默认选哪一餐：落在哪个区间就是哪一餐 */
export function mealForTime(d: Date = new Date()): Meal {
  const min = d.getHours() * 60 + d.getMinutes();
  for (const w of MEAL_WINDOWS) {
    const hit = w.from < w.to ? min >= w.from && min < w.to : min >= w.from || min < w.to;
    if (hit) return w.meal;
  }
  /* 区间是首尾相接的，走不到这儿；兜底给午餐，别返回 undefined */
  return 'lunch';
}

/* ─── 订单 helper（多菜模型）─────────────────── */

export function orderItems(o: Order): OrderItem[] {
  return o?.items ?? [];
}

/** 掌勺方在这张单上记过的加减菜记录（老数据 / 老仓库没有这个字段） */
export function orderChanges(o: Order): OrderChange[] {
  return o?.changes ?? [];
}

/**
 * 一条改动记录的文字：`减掉「A」「B」、加了「C」、挪到明天、改成晚餐、给掌勺的话改成「少放辣」`
 * （同步日志与卡片上的记录共用这一句话）。
 */
export function changeText(c: OrderChange): string {
  const parts: string[] = [];
  if (c.removed.length) parts.push(`减掉${c.removed.map((n) => `「${n}」`).join('')}`);
  if (c.added.length) parts.push(`加了${c.added.map((n) => `「${n}」`).join('')}`);
  if (c.date) parts.push(`挪到${dayWord(c.date)}`);
  if (c.meal) parts.push(`改成${mealLabel(c.meal)}`);
  if (c.note !== undefined) {
    parts.push(c.note ? `给掌勺的话改成「${c.note}」` : '清空了给掌勺的话');
  }
  return parts.join('、');
}

/** 一条改动记录到底改了什么（什么都没有 = 空改动，不该落库） */
export function hasChange(c: OrderChange): boolean {
  return Boolean(c.removed.length || c.added.length || c.meal || c.date || c.note !== undefined);
}

/**
 * 两张菜列表的差（按「菜谱 id / 菜名」逐份对消）：返回少的（被减掉的）与多的（加上去的）菜名。
 * 同一道菜在单里出现两次也按份数算 —— 点菜方改单时拿它生成改动记录。
 */
export function diffItems(
  before: OrderItem[],
  after: OrderItem[],
): { removed: string[]; added: string[] } {
  const keyOf = (it: OrderItem) => (it.recipeId ? `r:${it.recipeId}` : `n:${it.dishName}`);
  const pool = new Map<string, OrderItem[]>();
  before.forEach((it) => {
    const k = keyOf(it);
    pool.set(k, [...(pool.get(k) ?? []), it]);
  });
  const added: OrderItem[] = [];
  after.forEach((it) => {
    const k = keyOf(it);
    const bucket = pool.get(k) ?? [];
    const hit = bucket.shift();
    if (hit) pool.set(k, bucket);
    else added.push(it);
  });
  return {
    removed: [...pool.values()].flat().map((it) => it.dishName),
    added: added.map((it) => it.dishName),
  };
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

/** 取订单里第一道有封面（照片或插画）的菜谱（列表大图用） */
export function orderCover(o: Order, db: DB): Recipe | null {
  for (const it of orderItems(o)) {
    const r = findRecipe(db, it.recipeId);
    if (r && (r.image || r.art)) return r;
  }
  return null;
}

export function itemCover(it: OrderItem, db: DB): Recipe | null {
  const r = findRecipe(db, it.recipeId);
  return r && (r.image || r.art) ? r : null;
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

/**
 * 掌勺那边还有几单没做完：对方点的、状态不是「已完成」。
 * 角色开关右上角那枚数字红点与底部第二格（角色是掌勺时的「掌勺」格）共用同一个数。
 */
export function openCookCount(orders: Order[], me: PersonKey): number {
  return orders.filter((o) => o.placedBy !== me && o.status !== 'done').length;
}

/** 数字红点的文案：超过 99 显示 `99+` */
export function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
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
