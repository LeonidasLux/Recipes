/* 应用内更新（Android）：查 GitHub Release → 下载 APK → 交给系统安装器。

   为什么要有它：包挂在 GitHub 的 Release 上，手工更新得「开浏览器 → 找最新 Release →
   下载 → 点安装」。这里把这几步收进「设置 → 关于」：打开弹窗就顺手查一次，有新版本
   就下载并拉起系统安装器。

   分工：
     · 查版本 / 比大小 / 解析 Release 是纯 Web 逻辑 —— api.github.com 给 CORS 头，
       WebView 里直连（公开仓库读 Release 不需要 token）；
     · 下载 APK 与拉起安装器必须走原生（`android/app/src/main/java/.../AppUpdaterPlugin.java`），
       经下面的 bridge 调用。网页版没有这条路 —— 刷新就是最新版，所以整块界面只在
       Android 上出现（`isAppUpdaterAvailable()`）。
   ============================================================ */

import { Capacitor, registerPlugin } from '@capacitor/core';
import { APP_VERSION } from './version';

/** 更新来源：本项目自己的公开仓库（读 Release 不需要 token，未登录限流 60 次/小时也够用） */
export const UPDATE_REPO = 'LeonidasLux/Recipes';

/* ─── 版本号比较（纯函数）─────────────────────── */

/** 把 `v1.2.3` / `1.2` / `1.2.3-beta.1` 解析成 `[1,2,3]`；解析不出来返回 null */
export function parseVersion(v: string): number[] | null {
  const m = String(v).trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** 比版本号：a 更新返回 1，b 更新返回 -1，一样返回 0（解析不出来的当 0.0.0） */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [0, 0, 0];
  const pb = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 字节数转人话：7.2 MB / 512 KB */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '大小未知';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

/* ─── 读最新 Release ─────────────────────────── */

export interface ReleaseInfo {
  /** 去掉 `v` 前缀的版本号，如 `1.0.3` */
  version: string;
  /** 原始 tag，如 `v1.0.3` */
  tag: string;
  apkUrl: string;
  apkName: string;
  sizeBytes: number;
  publishedAt: string;
  notes: string;
}

export class UpdateError extends Error {
  kind: 'network' | 'notfound' | 'ratelimit' | 'format';
  constructor(kind: UpdateError['kind'], message: string) {
    super(message);
    this.kind = kind;
    this.name = 'UpdateError';
  }
}

/**
 * 从 GitHub Releases API 的 `releases/latest` 返回里挑出我们要的那条信息。
 * 附件名约定是 `jishiben-<tag>.apk`（见 `.github/workflows/android-apk.yml`），
 * 挑不出这个名字就退回第一个 `.apk`；一个 APK 都没有返回 null。
 */
export function parseLatestRelease(raw: unknown): ReleaseInfo | null {
  const r = raw as {
    tag_name?: unknown;
    body?: unknown;
    published_at?: unknown;
    assets?: unknown;
  } | null;
  if (!r || typeof r !== 'object') return null;
  const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : '';
  const version = tag.replace(/^v/i, '');
  if (!version) return null;

  const assets = Array.isArray(r.assets) ? (r.assets as Array<Record<string, unknown>>) : [];
  const apks = assets.filter(
    (a) => a && typeof a.name === 'string' && (a.name as string).toLowerCase().endsWith('.apk'),
  );
  if (!apks.length) return null;
  const pick = apks.find((a) => a.name === `jishiben-${tag}.apk`) ?? apks[0]!;
  const apkUrl = typeof pick.browser_download_url === 'string' ? pick.browser_download_url : '';
  if (!apkUrl) return null;

  return {
    version,
    tag,
    apkUrl,
    apkName: String(pick.name),
    sizeBytes: typeof pick.size === 'number' ? pick.size : 0,
    publishedAt: typeof r.published_at === 'string' ? r.published_at : '',
    notes: typeof r.body === 'string' ? r.body : '',
  };
}

/** 拉最新 Release（超时 15 秒，与仓库同步同一档）*/
export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      /* 跟仓库同步一个道理：别让浏览器缓存把「刚发的新版本」藏起来 */
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch {
    throw new UpdateError('network', '连不上 GitHub，检查网络后重试。');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) throw new UpdateError('notfound', '还没找到已发布的新版本，稍后再试。');
  if (res.status === 403 || res.status === 429) {
    throw new UpdateError('ratelimit', 'GitHub 暂时限流了，等一会儿再试。');
  }
  if (!res.ok) throw new UpdateError('network', `GitHub 返回 ${res.status}，稍后再试。`);

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new UpdateError('format', 'GitHub 回的格式看不懂，稍后再试。');
  }
  const info = parseLatestRelease(raw);
  if (!info) throw new UpdateError('format', '这条 Release 里没有 APK 附件。');
  return info;
}

export interface UpdateCheck {
  currentVersion: string;
  latest: ReleaseInfo;
  hasUpdate: boolean;
}

/** 查一次有没有新版本：比的是 `package.json` 的版本（本机版本）与 Release 的 tag */
export async function checkForUpdate(current: string = APP_VERSION): Promise<UpdateCheck> {
  const latest = await fetchLatestRelease();
  return {
    currentVersion: current,
    latest,
    hasUpdate: compareVersions(latest.version, current) > 0,
  };
}

/* ─── 平台判定与原生桥 ───────────────────────── */

export interface UpdateProgress {
  received: number;
  total: number;
  /** 0～100；服务端没给总长度时是 -1 */
  percent: number;
}

export interface UpdaterBridge {
  /** 系统有没有允许本应用装包（Android 8+ 的「安装未知应用」开关） */
  canInstall(): Promise<boolean>;
  /** 打开系统的那个开关页 */
  openInstallSettings(): Promise<void>;
  /** 下载 APK（进度回调）并拉起系统安装器，返回落地的文件路径 */
  downloadAndInstall(url: string, onProgress: (p: UpdateProgress) => void): Promise<string>;
}

/* 冒烟测试跑在 jsdom 里，平台判定永远是「网页」。想覆盖真机那条路（检查更新 → 下载 →
   拉起安装器）得把平台与原生桥换掉；只给测试用，业务代码别调。 */
let platformOverride: 'android' | 'web' | null = null;
let bridgeOverride: UpdaterBridge | null = null;

export function setUpdaterPlatformForTest(p: 'android' | 'web' | null): void {
  platformOverride = p;
}

export function setUpdaterBridgeForTest(b: UpdaterBridge | null): void {
  bridgeOverride = b;
}

/** 能不能走应用内更新：只有 Android 原生包可以；网页版刷新就是最新版 */
export function isAppUpdaterAvailable(): boolean {
  if (platformOverride) return platformOverride === 'android';
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

interface AppUpdaterPlugin {
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  downloadAndInstall(options: { url: string }): Promise<{ path: string; bytes: number }>;
  addListener(
    event: 'progress',
    cb: (p: UpdateProgress) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

/* 本地插件（android/app/src/main/java/.../AppUpdaterPlugin.java），MainActivity 里注册 */
const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater');

const nativeBridge: UpdaterBridge = {
  async canInstall() {
    return Boolean((await AppUpdater.canInstall())?.allowed);
  },
  async openInstallSettings() {
    await AppUpdater.openInstallSettings();
  },
  async downloadAndInstall(url, onProgress) {
    /* 进度是原生推过来的 `progress` 事件；下完（或失败）都要把监听摘掉 */
    const handle = await AppUpdater.addListener('progress', (p) => onProgress(p));
    try {
      const r = await AppUpdater.downloadAndInstall({ url });
      return r?.path ?? '';
    } finally {
      await handle.remove();
    }
  },
};

export function updaterBridge(): UpdaterBridge {
  return bridgeOverride ?? nativeBridge;
}
