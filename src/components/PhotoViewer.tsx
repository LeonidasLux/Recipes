import { useEffect } from 'react';
import { Icon } from './Icons';

/**
 * 点开看大图：整屏遮罩 + 居中的原尺寸照片。
 *
 * 点遮罩、点右上角 ×、按 Esc、按手机返回键都能关掉（返回键那一层由调用方用
 * `useBackClose` 登记，见 `src/lib/back.tsx`）。只给真实的菜谱照片用 ——
 * 本地插画是示意图，放大没有意义，所以那种情况详情页压根不给点击。
 */
export function PhotoViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="photoview" role="dialog" aria-modal="true" aria-label={`${alt} · 大图`}>
      <button type="button" className="pv-mask" aria-label="关闭大图" onClick={onClose} />
      <img className="pv-img" src={src} alt={alt} />
      <button type="button" className="pv-close" aria-label="关闭" onClick={onClose}>
        <Icon name="x" />
      </button>
    </div>
  );
}
