/* ============================================================
   菜谱照片：读文件 → 压成 data URL → 本机缓存

   为什么压：手机截图动辄两三 MB，直接塞进仓库既费流量，又会撞上
   GitHub contents 接口「超过 1 MB 读不到正文」的上限。这里把长边收到
   1800px 以内、按质量阶梯压到 800 KB 以下 —— 这个尺寸给 DeepSeek 识图
   够看清字，当菜谱封面也够用。

   压不动就退回原始 data URL（老 WebView 没有 canvas 2d，jsdom 里也没有）：
   宁可这张图大一点，也别让「加截图」这条路直接失败。

   本机缓存：照片字节只存在仓库里（`images/xxx.jpg`），本机这份 data URL
   是**缓存**、不是真源 —— 换手机 / 清缓存后去仓库重新取一份就行。
   缓存单独放一个 localStorage key，且带总量上限，别把主库撑爆。
   ============================================================ */

/** 压完的目标上限：超过就不必再存了（GitHub contents 读正文的上限是 1 MB） */
export const MAX_PHOTO_BYTES = 800_000;

/** 缩放后的最长边 */
const MAX_SIDE = 1800;
/** JPEG 质量阶梯：够小就停 */
const QUALITIES = [0.85, 0.7, 0.55];

/** 本机缓存的总量上限（localStorage 一般只有 5 MB，留出主库的位置） */
const CACHE_KEY = 'jishiben-photos-v2';
/** v1 只存 data URL、没有「已上传」标记，读进来当「没传过」处理（宁可多留，不可弄丢） */
const CACHE_KEY_V1 = 'jishiben-photos-v1';
const CACHE_LIMIT_BYTES = 3_500_000;

/* ─── data URL 小工具（纯函数，好测）───────────── */

export function isPhotoDataUrl(s: string): boolean {
  return /^data:image\/[\w.+-]+;base64,/.test(s ?? '');
}

/** data:image/jpeg;base64,xxx → image/jpeg */
export function dataUrlMime(dataUrl: string): string {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,/.exec(dataUrl ?? '');
  return m ? m[1].toLowerCase() : 'image/jpeg';
}

/** data:image/jpeg;base64,xxx → xxx（去掉所有空白） */
export function dataUrlBase64(dataUrl: string): string {
  const i = (dataUrl ?? '').indexOf(',');
  return (i >= 0 ? dataUrl.slice(i + 1) : '').replace(/\s+/g, '');
}

/** data URL 里图片的字节数（估算，用于判断要不要继续压） */
export function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrlBase64(dataUrl);
  if (!b64) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/** MIME → 文件扩展名（仓库里的图片路径用它） */
export function imageExtFor(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  return 'jpg';
}

/** 字节 → base64（分块，避免一次 spread 撑爆调用栈） */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 → 字节（图片预览 / 测试断言用） */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob((b64 ?? '').replace(/\s+/g, ''));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Blob / File → data URL（不依赖 FileReader，老 WebView 也稳） */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/* ─── 压缩 ───────────────────────────────────── */

function loadImage(img: HTMLImageElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('读图超时')), 8000);
    img.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('读不出这张图'));
    };
    img.src = src;
  });
}

/**
 * 把一张 data URL 缩到 MAX_SIDE 以内并逐档降质量。
 * 环境没有 canvas 2d（老 WebView / jsdom）时原样返回 —— 上层照样能存。
 */
export async function shrinkPhoto(raw: string): Promise<string> {
  if (typeof document === 'undefined' || !isPhotoDataUrl(raw)) return raw;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return raw;

  const img = document.createElement('img');
  await loadImage(img, raw);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return raw;

  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  /* 截图基本不透明，但 PNG 有透明通道时光填白底，免得转 JPEG 变黑块 */
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  let out = raw;
  for (const q of QUALITIES) {
    out = canvas.toDataURL('image/jpeg', q);
    if (dataUrlBytes(out) <= MAX_PHOTO_BYTES) return out;
  }
  return out;
}

/**
 * 用户选的截图 / 照片 → data URL。
 * 先原样读出来，再尽力压小；压不了（没有 canvas）就用原始那张。
 */
export async function photoToDataUrl(file: Blob): Promise<string> {
  const raw = await blobToDataUrl(file);
  try {
    return await shrinkPhoto(raw);
  } catch {
    return raw;
  }
}

/* ─── 本机缓存（只存本机，不进仓库）──────────── */

/**
 * 缓存里的一条：图的字节 + 「仓库里已经有这张图了吗」。
 *
 * 这个标记是**淘汰顺序的依据**：已上传的丢了也能从仓库取回来，没上传的丢了就真没了
 * （老版本正是按「谁最老丢谁」淘汰 —— 几张截图就把还没传上去的那张挤掉了，
 * 仓库里于是少一张图，而菜谱里还指着它）。
 */
interface PhotoEntry {
  /** data URL */
  d: string;
  /** 已确认仓库里有这张图 */
  up: boolean;
}

let cache: Map<string, PhotoEntry> | null = null;

/* ─── 缓存变更通知 ───────────────────────────────
   列表里的缩略图要能在「图取回来了」之后自己刷新：Photo 组件订阅这里，
   缓存一写就重渲染（取图队列 photoQueue.ts 取的图也走同一条路）。 */

const listeners = new Set<() => void>();

/** 订阅本机照片缓存的变化（返回取消订阅的函数） */
export function subscribePhotoCache(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function notifyPhotoCache(): void {
  for (const fn of [...listeners]) fn();
}

function loadCache(): Map<string, PhotoEntry> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, Partial<PhotoEntry>>;
      for (const [k, v] of Object.entries(obj ?? {})) {
        if (v && typeof v.d === 'string' && isPhotoDataUrl(v.d)) cache.set(k, { d: v.d, up: v.up === true });
      }
    } else {
      /* 老版本（v1）只有 data URL：当成「没传过」，先保住它们 */
      const old = localStorage.getItem(CACHE_KEY_V1);
      if (old) {
        const obj = JSON.parse(old) as Record<string, string>;
        for (const [k, v] of Object.entries(obj ?? {})) {
          if (typeof v === 'string' && isPhotoDataUrl(v)) cache.set(k, { d: v, up: false });
        }
      }
    }
  } catch {
    /* 隐私模式 / 数据坏了：当没缓存，去仓库重新取 */
  }
  return cache;
}

/**
 * 写回 localStorage：**先保「还没上传」的**（那些丢不起），再放「仓库里已有」的。
 * 同一档里从新到旧收，放不下的老图就不留了（要用时再从仓库取回来）。
 */
function persistCache(): void {
  const entries = [...(cache ?? new Map<string, PhotoEntry>())];
  const kept = new Map<string, PhotoEntry>();
  let used = 0;
  const take = (onlyUploaded: boolean) => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const [k, v] = entries[i];
      if (v.up !== onlyUploaded || kept.has(k)) continue;
      const size = dataUrlBytes(v.d);
      if (used + size > CACHE_LIMIT_BYTES) continue;
      used += size;
      kept.set(k, v);
    }
  };
  take(false); /* 第一轮：还没传上去的（丢不起） */
  take(true); /* 第二轮：仓库里已经有的（丢了还能取） */
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      /* 隐私模式，忽略 */
    }
  }
}

/** 本机缓存里的这张图（没有就返回 null，调用方决定要不要去仓库取） */
export function cachedPhoto(path: string): string | null {
  if (!path) return null;
  return loadCache().get(path)?.d ?? null;
}

/** 这张图是不是已经确认在仓库里了（确认过 = 本机这份丢了也不要紧） */
export function isPhotoUploaded(path: string): boolean {
  if (!path) return false;
  return loadCache().get(path)?.up === true;
}

/** 记下一张图的字节（新增 / 换图 / 从仓库拉回来时都走这里） */
export function rememberPhoto(path: string, dataUrl: string): void {
  if (!path || !isPhotoDataUrl(dataUrl)) return;
  const c = loadCache();
  c.delete(path);
  c.set(path, { d: dataUrl, up: false });
  persistCache();
  notifyPhotoCache();
}

/** 记下「这些图仓库里已经有了」：之后本机缓存不够用时，优先淘汰它们 */
export function markPhotosUploaded(paths: string[]): void {
  const c = loadCache();
  let changed = false;
  for (const p of paths) {
    const e = c.get(p);
    if (!e || e.up) continue;
    c.set(p, { d: e.d, up: true });
    changed = true;
  }
  if (changed) persistCache();
}

/** 这张图不要了（删除菜谱时顺手清掉） */
export function forgetPhoto(path: string): void {
  if (!path) return;
  const c = loadCache();
  if (!c.delete(path)) return;
  persistCache();
  notifyPhotoCache();
}
