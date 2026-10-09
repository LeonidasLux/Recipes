import { useEffect, useState } from 'react';
import { useStore } from '../data/store';
import { artUrl, initial } from '../data/helpers';
import { getImage, withTimeout } from '../lib/github';
import { cachedPhoto, markPhotosUploaded, rememberPhoto } from '../lib/photo';

/**
 * 菜谱照片（本机缓存优先，必要时去仓库取一张）。
 *
 * 照片字节只在仓库里，本机那份是缓存 —— 换手机 / 清缓存后第一次打开要联网取，
 * 取到了顺手写回缓存，之后（含离线）就一直能用。
 *
 * `fetch: false`（列表 / 缩略图那种成批出现的地方）只看本机缓存，绝不发请求：
 * 一屏几十条菜谱、每条都拉一张几百 KB 的图，手机流量受不了。
 * 想看到照片，进一次详情页（那边 fetch: true）就缓存下来了。
 */
export function useRecipePhoto(
  image: string | null | undefined,
  opts: { fetch?: boolean } = {},
): string | null {
  const { db, connected } = useStore();
  const path = image ?? '';
  const wantFetch = opts.fetch === true;
  const [src, setSrc] = useState<string | null>(() => (path ? cachedPhoto(path) : null));

  useEffect(() => {
    if (!path) {
      setSrc(null);
      return;
    }
    const hit = cachedPhoto(path);
    if (hit) {
      setSrc(hit);
      return;
    }
    setSrc(null);
    if (!wantFetch) return;
    const cfg = db.config;
    if (!connected || !cfg?.repo || !cfg.token) return;

    let alive = true;
    const t = withTimeout(25000);
    getImage(cfg.repo, path, cfg.branch, cfg.token, t.signal)
      .then((f) => {
        if (!alive || !f) return;
        rememberPhoto(path, f.dataUrl);
        /* 从仓库取到了 = 这张图仓库里确实有：标记一下，本机缓存紧张时它可以被淘汰 */
        markPhotosUploaded([path]);
        setSrc(f.dataUrl);
      })
      .catch(() => {
        /* 取不到（离线 / 图没了）就继续用插画兜底，不打扰用户 */
      })
      .finally(() => t.done());
    return () => {
      alive = false;
      t.done();
    };
  }, [path, wantFetch, connected, db.config]);

  return src;
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
  const photo = useRecipePhoto(image, { fetch });
  if (photo) return <img src={photo} alt={title} loading="lazy" />;
  if (art) return <img src={artUrl(art)} alt={title} loading="lazy" />;
  return <span className="mono">{initial(title)}</span>;
}
