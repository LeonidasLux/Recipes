import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from './Icons';
import { useBackClose } from '../lib/back';
import {
  DOUBLE_TAP_SCALE,
  ORIGIN,
  isDoubleTap,
  isZoomed,
  panTo,
  pinchTo,
  zoomTo,
  type Box,
  type Point,
  type Tap,
  type View,
} from '../lib/zoom';

/** 手势中间态：单指拖动 / 双指捏合（手指一多就从拖动切到捏合） */
type Gesture =
  | { kind: 'drag'; start: View; from: Point }
  | { kind: 'pinch'; start: View; dist: number; mid: Point };

/** 手抖容差：移动没超过它就算「点一下」，双击才有机会被认出来 */
const TAP_SLOP = 8;

const viewport = (): Box => ({ w: window.innerWidth, h: window.innerHeight });

function midOf(pts: Point[]): Point {
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

/** 两指距离（只认前两根手指） */
function distOf(pts: Point[]): number {
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

/**
 * 点开看大图：整屏遮罩 + 居中的原尺寸照片。
 *
 * 图片本身**能放大看细节**：双指捏合缩放、双击在「原始大小 ↔ 2 倍」之间来回，
 * 放大之后单指拖 / 双指拖都能挪着看边角（数学都在 `src/lib/zoom.ts`，
 * 拖不出屏幕）。手指一动就不算「点一下」，所以拖完不会顺手把双击也触发了。
 *
 * 点遮罩、点右上角 ×、按 Esc、按手机返回键都能关掉；**放大状态下按返回键先还原
 * 到原始大小**，再按一次才关掉整层（这一层由这里自己用 `useBackClose` 登记在
 * 调用方那层之上，见 `src/lib/back.tsx`）。只给真实的菜谱照片用 —— 本地插画是
 * 示意图，放大没有意义，所以那种情况详情页压根不给点击。
 */
export function PhotoViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [view, setView] = useState<View>(ORIGIN);
  /** 改动中（拖动 / 捏合）关掉过渡动画，手势才跟手；双击放大与回弹才走动画 */
  const [moving, setMoving] = useState(false);
  const viewRef = useRef<View>(ORIGIN);
  const gestures = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  /** 这一次手势动过没有：动过就不算「点一下」，免得拖动完又判成双击 */
  const moved = useRef(false);
  const lastTap = useRef<Tap | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const zoomed = isZoomed(view);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* 放大之后返回键先还原大小（这一层盖在调用方登记的「关掉大图」之上） */
  useBackClose(zoomed, () => apply(ORIGIN));

  function apply(next: View) {
    viewRef.current = next;
    setView(next);
  }

  /** 图片当前的版面尺寸（未缩放：offsetWidth 不吃 transform）；量不到就交给夹取兜底 */
  function imageBox(): Box {
    const el = imgRef.current;
    return { w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 };
  }

  /** 视口里的坐标 → 相对视口中心的偏移（缩放锚点用） */
  function centered(p: Point): Point {
    const vp = viewport();
    return { x: p.x - vp.w / 2, y: p.y - vp.h / 2 };
  }

  /**
   * 「点一下」：连着两下（时间够近、落点够近）就是双击 —— 原始大小双击放大到
   * 2 倍（锚住点的地方），已经放大了就还原。真机触摸的双击不一定补 `dblclick`，
   * 所以在这儿自己数，鼠标双击也走同一条路。
   */
  function tap(p: Point) {
    const now = Date.now();
    const prev = lastTap.current;
    lastTap.current = { t: now, x: p.x, y: p.y };
    if (!isDoubleTap(prev, { t: now, x: p.x, y: p.y })) return;
    lastTap.current = null;
    setMoving(false);
    if (isZoomed(viewRef.current)) apply(ORIGIN);
    else apply(zoomTo(viewRef.current, DOUBLE_TAP_SCALE, centered(p), viewport(), imageBox()));
  }

  function onPointerDown(e: ReactPointerEvent<HTMLImageElement>) {
    const p = { x: e.clientX, y: e.clientY };
    gestures.current.set(e.pointerId, p);
    /* 手指滑出图片也要继续收事件，不然一挪到遮罩上这把手势就断了 */
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 环境不支持就算了：留在图上是正常路径，滑出去只是这一次手势提前结束 */
    }
    moved.current = false;
    const pts = [...gestures.current.values()];
    if (pts.length >= 2) {
      gesture.current = { kind: 'pinch', start: viewRef.current, dist: distOf(pts), mid: centered(midOf(pts)) };
      setMoving(true);
    } else {
      gesture.current = { kind: 'drag', start: viewRef.current, from: p };
      setMoving(isZoomed(viewRef.current));
    }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLImageElement>) {
    if (!gestures.current.has(e.pointerId)) return;
    const p = { x: e.clientX, y: e.clientY };
    gestures.current.set(e.pointerId, p);
    const g = gesture.current;
    /* 没经过 pointerdown 的移动（不该有）不动图，免得算出一个野的起始点 */
    if (!g) return;
    const pts = [...gestures.current.values()];
    if (g.kind === 'pinch') {
      if (pts.length < 2) return;
      moved.current = true;
      setMoving(true);
      apply(pinchTo({ view: g.start, dist: g.dist, mid: g.mid }, { dist: distOf(pts), mid: centered(midOf(pts)) }, viewport(), imageBox()));
      return;
    }
    const dx = p.x - g.from.x;
    const dy = p.y - g.from.y;
    /* 还没认出这是拖动（位移在容差里）就按兵不动，好让「点一下」保住双击的机会；
       一旦认出来就按「起点 + 总位移」走，手指回到起点图也回到原位。 */
    if (!moved.current && Math.hypot(dx, dy) <= TAP_SLOP) return;
    moved.current = true;
    /* 没放大时拖动不动图：图本来就完整可见，居中待着最好看 */
    if (!isZoomed(g.start)) return;
    setMoving(true);
    apply(panTo(g.start, g.start.x + dx, g.start.y + dy, viewport(), imageBox()));
  }

  function onPointerEnd(e: ReactPointerEvent<HTMLImageElement>) {
    const id = e.pointerId;
    const wasDrag = gesture.current?.kind === 'drag';
    gestures.current.delete(id);
    try {
      e.currentTarget.releasePointerCapture(id);
    } catch {
      /* 没捕获过 / 环境不支持，忽略 */
    }
    const pts = [...gestures.current.values()];
    if (pts.length === 0) {
      if (wasDrag && !moved.current) tap({ x: e.clientX, y: e.clientY });
      gesture.current = null;
      setMoving(false);
      return;
    }
    if (pts.length === 1) {
      /* 双指松开一根：剩下那根接着拖，从当前视图续上，别跳 */
      gesture.current = { kind: 'drag', start: viewRef.current, from: pts[0] };
      moved.current = true;
    }
  }

  return (
    <div className="photoview" role="dialog" aria-modal="true" aria-label={`${alt} · 大图`}>
      <button type="button" className="pv-mask" aria-label="关闭大图" onClick={onClose} />
      <img
        ref={imgRef}
        className={`pv-img${zoomed ? ' zoomed' : ''}${moving ? ' moving' : ''}`}
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      />
      <button type="button" className="pv-close" aria-label="关闭" onClick={onClose}>
        <Icon name="x" />
      </button>
    </div>
  );
}
