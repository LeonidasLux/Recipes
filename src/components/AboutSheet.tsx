import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icons';
import { APP_VERSION } from '../lib/version';
import {
  checkForUpdate,
  formatBytes,
  isAppUpdaterAvailable,
  updaterBridge,
  type ReleaseInfo,
  type UpdateProgress,
} from '../lib/update';

/** 更新的界面状态：没查 / 查着 / 已最新 / 有新版本 / 下载中 / 缺系统授权 / 已交给安装器 / 出错 */
type Phase =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'needPermission'
  | 'installing'
  | 'error';

/**
 * 「关于」弹层：设置页里点「关于记食本」打开。
 *
 * 除了版本号，Android 上还能**应用内更新**：打开就顺手查一次 GitHub Release，
 * 有新版本就地下载并把 APK 交给系统安装器（下载与安装是原生插件干的，见 `src/lib/update.ts`）。
 * 网页版没有这条路 —— 刷新就是最新版，所以只留一句说明。
 *
 * 点遮罩、点右上角 ×、按 Esc 都能关掉；手机返回键那一层由调用方用
 * `useBackClose` 登记（见 `src/lib/back.tsx`）。
 */
export function AboutSheet({ onClose }: { onClose: () => void }) {
  const native = isAppUpdaterAvailable();

  const [phase, setPhase] = useState<Phase>('idle');
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [latestVersion, setLatestVersion] = useState('');
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [message, setMessage] = useState('');

  const check = useCallback(async () => {
    setPhase('checking');
    setProgress(null);
    try {
      const r = await checkForUpdate(APP_VERSION);
      setRelease(r.latest);
      setLatestVersion(r.latest.version);
      setPhase(r.hasUpdate ? 'available' : 'latest');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '检查更新失败，稍后再试。');
      setPhase('error');
    }
  }, []);

  /* 打开弹窗就查一次：手机上「关于」里直接看得见有没有新版本 */
  useEffect(() => {
    if (native) void check();
  }, [native, check]);

  const install = useCallback(async (rel: ReleaseInfo) => {
    const bridge = updaterBridge();
    try {
      /* 先问系统允不允许装包：没开的话别白下几 MB，直接引导去开开关 */
      if (!(await bridge.canInstall())) {
        setPhase('needPermission');
        return;
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '系统没有允许应用内安装，请手动更新。');
      setPhase('error');
      return;
    }
    setProgress(null);
    setPhase('downloading');
    try {
      await bridge.downloadAndInstall(rel.apkUrl, (p) => setProgress(p));
      setPhase('installing');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '下载安装包失败，稍后重试。');
      setPhase('error');
    }
  }, []);

  async function openInstallPermission() {
    try {
      await updaterBridge().openInstallSettings();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '打不开系统设置，请手动到系统里允许安装。');
      setPhase('error');
    }
  }

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

        {native ? (
          <div className="ab-upd">
            {phase === 'idle' && (
              <button
                id="appUpdateCheckBtn"
                type="button"
                className="btn-primary ab-upd-btn"
                onClick={() => void check()}
              >
                <Icon name="download" />
                <span>检查更新</span>
              </button>
            )}

            {phase === 'checking' && <p className="ab-upd-t">正在检查更新…</p>}

            {phase === 'latest' && (
              <>
                <p className="ab-upd-t ok">已是最新版本</p>
                <p className="ab-upd-d">当前 v{latestVersion || APP_VERSION}</p>
                <div className="ab-upd-row">
                  <button
                    id="appUpdateCheckBtn"
                    type="button"
                    className="btn-sticker"
                    onClick={() => void check()}
                  >
                    再检查一次
                  </button>
                </div>
              </>
            )}

            {phase === 'available' && release && (
              <>
                <p className="ab-upd-t">
                  发现新版本 <b>v{release.version}</b>
                </p>
                <p className="ab-upd-d">
                  当前 v{APP_VERSION} · 安装包 {formatBytes(release.sizeBytes)} · 装好后重新打开应用
                </p>
                <div className="ab-upd-row">
                  <button
                    id="appUpdateInstallBtn"
                    type="button"
                    className="btn-primary ab-upd-btn"
                    onClick={() => void install(release)}
                  >
                    <Icon name="download" />
                    <span>下载并安装</span>
                  </button>
                </div>
              </>
            )}

            {phase === 'downloading' && (
              <>
                <p className="ab-upd-t">正在下载安装包…</p>
                {progress && progress.percent >= 0 && (
                  <div className="ab-bar">
                    <i style={{ width: `${progress.percent}%` }} />
                  </div>
                )}
                <p className="ab-upd-d">
                  {progress
                    ? progress.percent >= 0
                      ? `已下载 ${formatBytes(progress.received)} / ${formatBytes(progress.total)}（${progress.percent}%）`
                      : `已下载 ${formatBytes(progress.received)}`
                    : '正在连接 GitHub…'}
                </p>
              </>
            )}

            {phase === 'needPermission' && (
              <>
                <p className="ab-upd-t">先允许「安装未知应用」</p>
                <p className="ab-upd-d">
                  手机系统默认不允许应用自己装包。点下面的按钮打开开关（把「安装未知应用」里的记食本设为允许），回来再点「我开好了」。
                </p>
                <div className="ab-upd-row">
                  <button
                    id="appUpdatePermBtn"
                    type="button"
                    className="btn-primary ab-upd-btn"
                    onClick={() => void openInstallPermission()}
                  >
                    去系统设置
                  </button>
                  <button
                    id="appUpdateRetryBtn"
                    type="button"
                    className="btn-sticker"
                    onClick={() => release && void install(release)}
                  >
                    我开好了
                  </button>
                </div>
              </>
            )}

            {phase === 'installing' && (
              <>
                <p className="ab-upd-t ok">已交给系统安装器</p>
                <p className="ab-upd-d">按手机上的提示点「安装」；装好后重新打开应用就是新版本。</p>
              </>
            )}

            {phase === 'error' && (
              <>
                <p className="ab-upd-t err">{message}</p>
                <div className="ab-upd-row">
                  {release && (
                    <button
                      id="appUpdateRetryBtn"
                      type="button"
                      className="btn-sticker solid"
                      onClick={() => void install(release)}
                    >
                      重试
                    </button>
                  )}
                  <button
                    id="appUpdateCheckBtn"
                    type="button"
                    className="btn-sticker"
                    onClick={() => void check()}
                  >
                    重新检查
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="ab-hint">网页版刷新一下就是最新版；装到手机上的包可以在这里直接更新。</p>
        )}
      </div>
    </div>
  );
}
