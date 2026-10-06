/* 生成图标：纯 Node 写 PNG（zlib 内置），无第三方依赖。
   图形 = 暖橙底 + 深棕的锅，和 App 里的锅图标同源。

   一次产出两套：
     · PWA 图标       → public/
     · Android 图标   → android/app/src/main/res/mipmap-<density>/
                        （原生工程存在时才写；含自适应图标的前景层，透明底、图形收在安全区内）

   用法：node scripts/make-icons.mjs                                      */

import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public');
const ANDROID_RES = resolve(ROOT, 'android/app/src/main/res');

/* 调色：从设计 token 的 oklch 换算出的 sRGB */
const ACCENT = [255, 163, 63]; // oklch(0.79 0.155 63)
const INK = [59, 39, 30]; // oklch(0.295 0.035 46)

/* ─── PNG 编码 ────────────────────────────────── */

function crc32of(buf) {
  if (typeof crc32 === 'function') return crc32(buf) >>> 0;
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32of(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ─── 图形（24×24 坐标系，和设计源的锅图标一致）─── */

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/** 锅身：上宽下窄，底部圆角 */
function inPotBody(x, y) {
  if (y < 11 || y > 18) return false;
  const t = (y - 11) / 7;
  const half = 7 - 1.6 * t;
  const dx = Math.abs(x - 12);
  const r = 3;
  if (y > 18 - r) {
    const dy = y - (18 - r);
    const inner = half - r;
    if (dx > inner) return Math.hypot(dx - inner, dy) <= r;
  }
  return dx <= half;
}

const inLid = (x, y) => inRoundRect(x, y, 7.9, 8, 16.1, 11, 0.7);
const inHandles = (x, y) =>
  inRoundRect(x, y, 8.6, 4.8, 9.9, 8.2, 0.6) || inRoundRect(x, y, 14.1, 4.8, 15.4, 8.2, 0.6);

const isInk = (x, y) => inPotBody(x, y) || inLid(x, y) || inHandles(x, y);

/** 底：圆角方形或正圆 */
function inBg(x, y, inset, radius, circle) {
  if (circle) {
    return Math.hypot(x - 12, y - 12) <= 12 - inset;
  }
  return inRoundRect(x, y, inset, inset, 24 - inset, 24 - inset, radius);
}

/* ─── 渲染（4×4 超采样抗锯齿）─────────────────── */

/**
 * @param {number} size    输出边长
 * @param {object} opts
 *   drawBg   是否画橙色底（自适应图标的前景层不画）
 *   circle   底用正圆（ic_launcher_round）
 *   bleed    底铺满整张图（maskable / 自适应底图）
 *   scale    图形相对画布的比例
 *   dy       图形纵向偏移（24 坐标系）
 */
function render(size, opts = {}) {
  const { drawBg = true, circle = false, bleed = false, scale = 0.92, dy = -0.6 } = opts;
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;
  const inset = bleed ? 0 : 1.6;
  const radius = bleed ? 0 : 5.4;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let inkHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((px + (sx + 0.5) / SS) / size) * 24;
          const v = ((py + (sy + 0.5) / SS) / size) * 24;

          if (drawBg && inBg(u, v, inset, radius, circle)) bgHits++;

          const gx = (u - 12) / scale + 12;
          const gy = (v - 12 - dy) / scale + 12;
          if (isInk(gx, gy)) inkHits++;
        }
      }

      const total = SS * SS;
      const bgA = bgHits / total;
      const inkA = inkHits / total;

      /* ink 叠在 accent 上；不画底时 ink 直接压透明 */
      const r = drawBg ? ACCENT[0] * (1 - inkA) + INK[0] * inkA : INK[0];
      const g = drawBg ? ACCENT[1] * (1 - inkA) + INK[1] * inkA : INK[1];
      const b = drawBg ? ACCENT[2] * (1 - inkA) + INK[2] * inkA : INK[2];

      const alpha = drawBg ? bgA : inkA;

      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

/* ─── PWA 图标 ────────────────────────────────── */

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'icon-192.png'), render(192, { scale: 0.92 }));
writeFileSync(resolve(OUT, 'icon-512.png'), render(512, { scale: 0.92 }));
writeFileSync(resolve(OUT, 'icon-maskable-512.png'), render(512, { bleed: true, scale: 0.68 }));
writeFileSync(resolve(OUT, 'apple-touch-icon.png'), render(180, { scale: 0.92 }));

const hex = (c) => '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');
writeFileSync(
  resolve(OUT, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect x="1.6" y="1.6" width="20.8" height="20.8" rx="5.4" fill="${hex(ACCENT)}"/>
  <g fill="${hex(INK)}">
    <path d="M5 11h14l-1.5 6.5a4 4 0 0 1-4 3h-3a4 4 0 0 1-4-3Z"/>
    <rect x="7.9" y="8" width="8.2" height="3" rx="0.7"/>
    <rect x="8.6" y="4.8" width="1.3" height="3.4" rx="0.6"/>
    <rect x="14.1" y="4.8" width="1.3" height="3.4" rx="0.6"/>
  </g>
</svg>
`,
);

console.log('PWA 图标 →', OUT);

/* ─── Android 图标 ───────────────────────────── */

if (!existsSync(ANDROID_RES)) {
  console.log('没找到 android/app/src/main/res —— 跳过 Android 图标（先跑 npx cap add android）');
  process.exit(0);
}

/** density → [launcher 边长, 自适应前景层边长(108dp)] */
const DENSITIES = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];

for (const [density, iconSize, fgSize] of DENSITIES) {
  const dir = resolve(ANDROID_RES, `mipmap-${density}`);
  mkdirSync(dir, { recursive: true });

  /* 老式图标（Android 8 以下 / 部分启动器） */
  writeFileSync(resolve(dir, 'ic_launcher.png'), render(iconSize, { scale: 0.92 }));
  writeFileSync(resolve(dir, 'ic_launcher_round.png'), render(iconSize, { circle: true, scale: 0.84 }));

  /* 自适应图标的前景层：透明底，图形收进中间安全区（可见区只有中间的 ~66%） */
  writeFileSync(
    resolve(dir, 'ic_launcher_foreground.png'),
    render(fgSize, { drawBg: false, scale: 0.46 }),
  );
}

/* 自适应图标的背景色 —— 用 App 的主色，别用默认的白色 */
writeFileSync(
  resolve(ANDROID_RES, 'values/ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${hex(ACCENT)}</color>
</resources>
`,
);

console.log('Android 图标 →', ANDROID_RES);
console.log('  mipmap-{mdpi..xxxhdpi}/ic_launcher[_round|_foreground].png');
