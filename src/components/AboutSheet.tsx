import { useEffect } from 'react';
import { Icon } from './Icons';
import { APP_VERSION } from '../lib/version';

/**
 * 「关于」弹层：设置页里点「关于记食本」打开。
 *
 * 现在只展示版本号，别的应用信息以后往这里加。
 * 点遮罩、点右上角 ×、按 Esc 都能关掉；手机返回键那一层由调用方用
 * `useBackClose` 登记（见 `src/lib/back.tsx`）。
 */
export function AboutSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="aboutsheet" role="dialog" aria-modal="true" aria-label="关于记食本">
      <button type="button" className="ab-mask" aria-label="关闭关于" onClick={onClose} />

      <div className="card sticker ab-card">
        <button type="button" className="ab-close" aria-label="关闭" onClick={onClose}>
          <Icon name="x" />
        </button>

        <h2 className="ab-name">记食本</h2>
        <p className="ab-ver" id="appVersion">
          版本 {APP_VERSION}
        </p>
      </div>
    </div>
  );
}
