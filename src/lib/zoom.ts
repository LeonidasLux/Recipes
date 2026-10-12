/**
 * 大图（`PhotoViewer`）的缩放 / 平移数学 —— 纯函数，便于单测。
 *
 * 坐标系：原点在**视口中心**，x 向右、y 向下，单位是 CSS 像素。图片本身是个
 * 居中的 `<img>`，所以它的 `transform-origin`（默认就是图片中心）正好落在原点；
 * 图片用 `translate(x, y) scale(scale)` 变换，于是：
 *   · `scale` 由捏合倍数 / 双击决定；
 *   · `x` / `y` 是图片中心离视口中心多远。
 * 这样换算的好处是：缩放不需要读 `getBoundingClientRect()`，只跟「手指在视口里的
 * 坐标 − 视口中心」有关，双击 / 捏合都锚得住手指底下那个点。
 *
 * 平移一律要夹取（`clampPan`）：**图比视口小的那一维不许拖**（居中就是最好看的
 * 位置），比视口大的那一维最多拖到「图边贴住屏幕边」—— 这样怎么拖都不会把图拖丢。
 */

/** 大图的当前视图：缩放倍数 + 平移量 */
export interface View {
  scale: number;
  x: number;
  y: number;
}

/** 一个矩形尺寸（视口 / 图片版面都用它，不关心位置） */
export interface Box {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 原始大小：没放大也没拖动 */
export const ORIGIN: View = { scale: 1, x: 0, y: 0 };
/** 双击放到的倍数（再想放大就捏合） */
export const DOUBLE_TAP_SCALE = 2;
export const MIN_SCALE = 1;
export const MAX_SCALE = 5;

/** 双击的时间窗（毫秒）与两次落点的最大偏差（像素）：超出就当两次单击 */
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_SLOP = 28;

/** 一次「点一下」的时间与落点，用来判双击 */
export interface Tap {
  t: number;
  x: number;
  y: number;
}

/** 是不是放大状态（浮点误差留一点余量） */
export function isZoomed(view: View): boolean {
  return view.scale > MIN_SCALE + 0.001;
}

/** 缩放倍数夹进 [1, 5] */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** 四舍五入到小数点后 2 位；-0 归一成 0，免得 transform 里出现 "-0px" */
function round(n: number): number {
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
}

/**
 * 把视图夹进合法范围：
 *   · 倍数夹进 [1, 5]；
 *   · 平移的边界 = 图（放大后）比视口多出来的那一半 —— 图的尺寸不到视口时
 *     边界是 0，也就是只能居中；`img` 量不到（图还没加载 / 测试环境没有布局）
 *     时同样退回「不许拖」，宁可不动也不能把图拖出屏幕。
 */
export function clampPan(view: View, vp: Box, img: Box): View {
  const scale = clampScale(view.scale);
  const maxX = Math.max(0, (img.w * scale - vp.w) / 2);
  const maxY = Math.max(0, (img.h * scale - vp.h) / 2);
  return {
    scale: round(scale),
    x: round(Math.min(maxX, Math.max(-maxX, view.x))),
    y: round(Math.min(maxY, Math.max(-maxY, view.y))),
  };
}

/** 平移到 (x, y)（相对视口中心），并夹取 */
export function panTo(view: View, x: number, y: number, vp: Box, img: Box): View {
  return clampPan({ scale: view.scale, x, y }, vp, img);
}

/**
 * 缩放到 `scale`，锚住 `at`（`at` 是相对视口中心的偏移）：锚点底下那块图，
 * 缩放前后待在原地。放大后超出边界时由 `clampPan` 收回来（此时锚点会偏一点，
 * 这是正常的 —— 总不能让图飘出屏幕去迁就手指）。
 */
export function zoomTo(view: View, scale: number, at: Point, vp: Box, img: Box): View {
  const next = clampScale(scale);
  const k = next / clampScale(view.scale);
  return clampPan({ scale: next, x: at.x + k * (view.x - at.x), y: at.y + k * (view.y - at.y) }, vp, img);
}

/** 捏合的起始状态：起始视图 + 两指距离 + 两指中点（相对视口中心） */
export interface PinchStart {
  view: View;
  dist: number;
  mid: Point;
}

/**
 * 捏合中：倍数按「两指距离之比」走，同时让起始中点底下那块图跟着现在的
 * 中点走 —— 两指一起挪就是平移，两指张合就是缩放，一个公式全包。
 */
export function pinchTo(start: PinchStart, now: { dist: number; mid: Point }, vp: Box, img: Box): View {
  /* 两指叠在一起（距离 0）这种量不出来的情况当成没动，别把倍数算飞 */
  const ratio = start.dist > 0 && now.dist > 0 ? now.dist / start.dist : 1;
  const scale = clampScale(start.view.scale * ratio);
  const k = scale / clampScale(start.view.scale);
  const x = now.mid.x + k * (start.view.x - start.mid.x);
  const y = now.mid.y + k * (start.view.y - start.mid.y);
  return clampPan({ scale, x, y }, vp, img);
}

/** 两次「点一下」落在同一个地方、且够快，才算双击 */
export function isDoubleTap(prev: Tap | null, next: Tap): boolean {
  if (!prev) return false;
  if (next.t - prev.t > DOUBLE_TAP_MS) return false;
  return Math.hypot(next.x - prev.x, next.y - prev.y) <= DOUBLE_TAP_SLOP;
}
