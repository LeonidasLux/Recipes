import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useStore } from '../data/store';
import { artUrl, initial } from '../data/helpers';
import { cachedPhoto, subscribePhotoCache } from '../lib/photo';
import { requestPhoto } from '../lib/photoQueue';

/**
 * 菜谱照片（本机缓存优先，没有就让取图队列去仓库拿一张）。
 *
 * 照片字节只在仓库里，本机那份是缓存 —— 换手机 / 清缓存后第一次打开要联网取，
 * 取到了顺手写回缓存，之后（含离线）就一直能用。
 *
 * 取图分两种节奏，都走 `photoQueue` 那条「一次最多两张、同一张只取一次」的队列：
 * · `fetch: true`：详情页 / 大图那种一次只显示一张的地方 —— 进屏就取（插队）。
 * · `fetch: false`：列表 / 缩略图那种成批出现的地方 —— **滚到眼前才取**。
 *   一屏几十条菜谱要是一次全发出去，手机流量受不了；没有 IntersectionObserver
 *   的老 WebView（和 jsdom 测试环境）没得挑，直接取。
 */
export function useRecipePhoto(image: string | null | undefined, opts: { fetch?: boolean } = {}) {
  const { db, connected } = useStore();
  const path = image ?? '';
  const wantFetch = opts.fetch === true;

  /* 缓存里有没有这张图 —— 队列取回来时会通知，缩略图自己换成照片 */
  const src = useSyncExternalStore(subscribePhotoCache, () => (path ? cachedPhoto(path) : null));

  const cfg = db.config;
  const repo = cfg?.repo ?? '';
  const branch = cfg?.branch ?? '';
  const token = cfg?.token ?? '';
  const ready = path !== '' && src === null && connected && repo !== '' && token !== '';
  /** 同一个 path 只排一次队（取不到的重试节奏由队列的冷却时间管） */
  const asked = useRef('');

  const ask = useCallback(() => {
    if (!ready || asked.current === path) return;
    asked.current = path;
    requestPhoto(path, { repo, branch, token }, { priority: wantFetch });
  }, [ready, path, repo, branch, token, wantFetch]);

  /* 详情页只有一张图，进屏就取；没有 IntersectionObserver 的环境也只能直接取 */
  useEffect(() => {
    if (wantFetch || typeof IntersectionObserver !== 'function') ask();
  }, [wantFetch, ask]);

  /**
   * 挂到没照片时渲染出来的那个 img / span 上：**滚到眼前**才排一次队。
   * 返回的清理函数由 React 19 的 ref 回调接管（元素换掉时自动断开观察）。
   */
  const attach = useCallback(
    (el: HTMLElement | null) => {
      if (!el || !ready || asked.current === path) return;
      if (typeof IntersectionObserver !== 'function') return;
      const io = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        ask();
      });
      io.observe(el);
      return () => io.disconnect();
    },
    [ready, path, ask],
  );

  return { src, attach };
}

/**
 * 封面：照片 → 本地插画 → 标题首字，三级兜底。
 * 用的地方都是「容器里放一张图」的结构（`.thumb` / `.da` / `.heroimg`…），
 * 所以这里只输出 img 或 span，样式交给外层容器。
 */
export function Cover({
  image,
  art,
  title,
  fetch = false,
}: {
  image?: string | null;
  art?: string | null;
  title: string;
  fetch?: boolean;
}) {
  const { src, attach } = useRecipePhoto(image, { fetch });
  if (src) return <img src={src} alt={title} loading="lazy" />;
  /* 还没有照片：先摆插画 / 首字，顺手让它当「滚到眼前」的观察目标 */
  if (art) return <img ref={attach} src={artUrl(art)} alt={title} loading="lazy" />;
  return (
    <span ref={attach} className="mono">
      {initial(title)}
    </span>
  );
}
