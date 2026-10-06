/* 生成图标：把「首次设置页顶部那张锅+云插画」光栅化成 PNG。

   单一来源：`public/art/sync-pot.svg`。改插画，图标跟着变 —— 桌面图标和
   App 里的图标从此是同一张图，不会各画各的。

   为什么自带光栅化：项目对图标生成一直是「纯 Node、零第三方依赖」
   （zlib 内置写 PNG）。这里就地实现一个**极简 SVG 光栅化**，只覆盖这张
   插画用到的元素与命令（rect / circle / path 的 M L H V C S Z），
   遇到不认识的命令会直接报错，避免悄悄画错。

   一次产出两套：
     · PWA 图标       → public/
     · Android 图标   → android/app/src/main/res/mipmap-<density>/
                        （原生工程存在时才写；含自适应图标的前景层，透明底、图形收在安全区内）

   用法：node scripts/make-icons.mjs                                      */

import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public');
const ANDROID_RES = resolve(ROOT, 'android/app/src/main/res');
const ART_PATH = resolve(OUT, 'art/sync-pot.svg');

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

/* ─── 极简 SVG 解析（只支持这张插画用到的部分）───── */

function hexColor(raw) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(raw).trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

const sameColor = (a, b) => Boolean(a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

/** 把 path 的 d 折线化；每个子路径是 { pts, closed } */
function parsePathData(d) {
  const tokens = d.match(/[MmLlHhVvCcSsZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const subs = [];
  let cur = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrl = null;
  let cmd = null;
  let i = 0;
  const num = () => parseFloat(tokens[i++]);
  const open = (x, y) => {
    cur = { pts: [[x, y]], closed: false };
    subs.push(cur);
    lastCtrl = null;
  };
  const lineTo = (x, y) => {
    if (!cur || cur.closed) open(cx, cy);
    cur.pts.push([x, y]);
    lastCtrl = null;
  };
  const curveTo = (x1, y1, x2, y2, x, y) => {
    if (!cur || cur.closed) open(cx, cy);
    const p0x = cx;
    const p0y = cy;
    const STEPS = 18; // 图标尺度下足够平滑
    for (let k = 1; k <= STEPS; k++) {
      const t = k / STEPS;
      const mt = 1 - t;
      cur.pts.push([
        mt * mt * mt * p0x + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x,
        mt * mt * mt * p0y + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y,
      ]);
    }
    cx = x;
    cy = y;
    lastCtrl = [x2, y2];
  };

  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[A-Za-z]$/.test(tok)) {
      cmd = tok;
      i++;
      continue;
    }
    if (!cmd) throw new Error(`make-icons：路径缺少命令 → ${d}`);
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'M') {
      const x = num();
      const y = num();
      const ax = rel ? cx + x : x;
      const ay = rel ? cy + y : y;
      open(ax, ay);
      cx = sx = ax;
      cy = sy = ay;
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L') {
      const x = num();
      const y = num();
      const ax = rel ? cx + x : x;
      const ay = rel ? cy + y : y;
      lineTo(ax, ay);
      cx = ax;
      cy = ay;
    } else if (C === 'H') {
      const ax = rel ? cx + num() : num();
      lineTo(ax, cy);
      cx = ax;
    } else if (C === 'V') {
      const ay = rel ? cy + num() : num();
      lineTo(cx, ay);
      cy = ay;
    } else if (C === 'C') {
      const x1 = num();
      const y1 = num();
      const x2 = num();
      const y2 = num();
      const x = num();
      const y = num();
      curveTo(
        rel ? cx + x1 : x1,
        rel ? cy + y1 : y1,
        rel ? cx + x2 : x2,
        rel ? cy + y2 : y2,
        rel ? cx + x : x,
        rel ? cy + y : y,
      );
    } else if (C === 'S') {
      const x2 = num();
      const y2 = num();
      const x = num();
      const y = num();
      /* S：第一个控制点是上一个控制点关于当前点的对称点 */
      const rx1 = lastCtrl ? 2 * cx - lastCtrl[0] : cx;
      const ry1 = lastCtrl ? 2 * cy - lastCtrl[1] : cy;
      curveTo(
        rx1,
        ry1,
        rel ? cx + x2 : x2,
        rel ? cy + y2 : y2,
        rel ? cx + x : x,
        rel ? cy + y : y,
      );
    } else if (C === 'Z') {
      if (cur) cur.closed = true;
      cx = sx;
      cy = sy;
      lastCtrl = null;
    } else {
      throw new Error(`make-icons：不支持路径命令「${cmd}」，去改 scripts/make-icons.mjs`);
    }
  }
  return subs;
}

/** 圆角矩形 / 圆 → 折线 */
function roundRectPoly(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  const pts = [];
  const arc = (cx0, cy0, from, to) => {
    const N = 8;
    for (let k = 0; k <= N; k++) {
      const a = from + ((to - from) * k) / N;
      pts.push([cx0 + Math.cos(a) * rr, cy0 + Math.sin(a) * rr]);
    }
  };
  const P = Math.PI / 2;
  arc(x + w - rr, y + rr, -P, 0);
  arc(x + w - rr, y + h - rr, 0, P);
  arc(x + rr, y + h - rr, P, Math.PI);
  arc(x + rr, y + rr, Math.PI, Math.PI + P);
  return { pts, closed: true };
}

function circlePoly(cx0, cy0, r) {
  const pts = [];
  const N = 64;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    pts.push([cx0 + Math.cos(a) * r, cy0 + Math.sin(a) * r]);
  }
  return { pts, closed: true };
}

/** 只解析 rect / circle / path，属性只认 fill / stroke / stroke-width / opacity */
function parseSvg(svg) {
  const viewBox = /viewBox\s*=\s*"([^"]+)"/i.exec(svg);
  const vb = (viewBox?.[1] ?? '0 0 96 96').trim().split(/\s+/).map(Number);
  const W = vb[2] || 96;
  const H = vb[3] || 96;

  const attr = (el, name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(el);
    return m ? m[1] : null;
  };

  const shapes = [];
  for (const el of svg.match(/<(rect|circle|path)\b[^>]*\/?>/gi) ?? []) {
    const tag = /^<(\w+)/.exec(el)[1].toLowerCase();
    const fillRaw = attr(el, 'fill');
    const strokeRaw = attr(el, 'stroke');
    const width = parseFloat(attr(el, 'stroke-width') ?? '0') || 0;
    const opacity = parseFloat(attr(el, 'opacity') ?? '1');

    let polys;
    if (tag === 'rect') {
      polys = [
        roundRectPoly(
          +attr(el, 'x'),
          +attr(el, 'y'),
          +attr(el, 'width'),
          +attr(el, 'height'),
          +(attr(el, 'rx') ?? 0),
        ),
      ];
    } else if (tag === 'circle') {
      polys = [circlePoly(+attr(el, 'cx'), +attr(el, 'cy'), +attr(el, 'r'))];
    } else {
      polys = parsePathData(attr(el, 'd') ?? '');
    }

    shapes.push({
      tag,
      fill: fillRaw && fillRaw !== 'none' ? hexColor(fillRaw) : null,
      stroke: strokeRaw && strokeRaw !== 'none' ? { color: hexColor(strokeRaw), width } : null,
      opacity,
      polys: polys.map((sub) => ({
        ...sub,
        box: bbox(sub.pts, 0.75),
        strokeBox: bbox(sub.pts, Math.max(width / 2, 0.75)),
      })),
    });
  }
  if (!shapes.length) throw new Error(`make-icons：${ART_PATH} 里没解析出任何图形`);
  return { width: W, height: H, shapes };
}

/* ─── 采样：点在图形里的判定 ───────────────────── */

/** 折线包围盒（含 padding）—— 每个像素要跑几千次判定，先靠它把大部分图形挡掉 */
function bbox(pts, pad) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

const inBox = (box, x, y) => x >= box[0] && y >= box[1] && x <= box[2] && y <= box[3];

function distToSeg(px, py, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / len2)) : 0;
  return Math.hypot(px - (a[0] + vx * t), py - (a[1] + vy * t));
}

/** 描边判定：到任一段的距离 ≤ 线宽一半 —— 圆角端点 / 转角天然就对 */
function onStroke(shape, x, y) {
  const half = shape.stroke.width / 2;
  for (const sub of shape.polys) {
    const { pts, closed } = sub;
    if (!inBox(sub.strokeBox, x, y)) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      if (distToSeg(x, y, pts[i], pts[i + 1]) <= half) return true;
    }
    if (closed && pts.length > 2 && distToSeg(x, y, pts[pts.length - 1], pts[0]) <= half) return true;
  }
  return false;
}

/** 填充判定：even-odd（这几张插画都是简单图形，够用） */
function inFill(shape, x, y) {
  let inside = false;
  for (const sub of shape.polys) {
    if (!inBox(sub.box, x, y)) continue;
    const { pts } = sub;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** 按绘制顺序叠加，返回 [r, g, b, a]（直通 alpha） */
function sampleArt(shapes, x, y) {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (const s of shapes) {
    let hit = null;
    if (s.stroke && s.stroke.width > 0 && onStroke(s, x, y)) hit = s.stroke.color;
    else if (s.fill && inFill(s, x, y)) hit = s.fill;
    if (!hit) continue;
    const sa = s.opacity;
    const na = sa + a * (1 - sa);
    if (na <= 0) continue;
    r = (hit[0] * sa + r * a * (1 - sa)) / na;
    g = (hit[1] * sa + g * a * (1 - sa)) / na;
    b = (hit[2] * sa + b * a * (1 - sa)) / na;
    a = na;
  }
  return [r, g, b, a];
}

/* ─── 渲染（4×4 超采样抗锯齿）─────────────────── */

const ART = parseSvg(readFileSync(ART_PATH, 'utf8'));
/** 插画自带的奶油底色 —— 出血填充 / 自适应图标背景都用它 */
const CREAM = hexColor('#FFF3DC');

/**
 * @param {number} size   输出边长
 * @param {object} opts
 *   scale       插画整体缩放（1 = 铺满）
 *   dy          插画纵向偏移（插画单位，正数往下挪），用来把内容摆正
 *   bleed       铺满画布的不透明底色（不传就是透明底）
 *   clipCircle  圆形裁剪（Android 圆形图标）
 *   noBackdrop  不画插画自带的那块圆角底（自适应图标的前景层用）
 */
function render(size, opts = {}) {
  const { scale = 1, dy = 0, bleed = null, clipCircle = false, noBackdrop = false } = opts;
  const W = ART.width;
  const H = ART.height;
  const shapes = noBackdrop
    ? ART.shapes.filter((s) => !(s.tag === 'rect' && sameColor(s.fill, CREAM)))
    : ART.shapes;

  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ax = ((px + (sx + 0.5) / SS) / size) * W;
          const ay = ((py + (sy + 0.5) / SS) / size) * H;
          /* 圆形裁剪：圈外不贡献任何覆盖 */
          if (clipCircle && Math.hypot(ax - W / 2, ay - H / 2) > W / 2) continue;

          /* 画布坐标 → 插画坐标（绕中心缩放 + 纵向偏移） */
          const artX = W / 2 + (ax - W / 2) / scale;
          const artY = H / 2 + (ay - H / 2 - dy) / scale;
          const c = artX >= 0 && artX <= W && artY >= 0 && artY <= H
            ? sampleArt(shapes, artX, artY)
            : [0, 0, 0, 0];

          /* 出血底色 = 插画按 alpha 合成在不透明的底色之上（源在上） */
          if (bleed) {
            const ca = c[3];
            sr += c[0] * ca + bleed[0] * (1 - ca);
            sg += c[1] * ca + bleed[1] * (1 - ca);
            sb += c[2] * ca + bleed[2] * (1 - ca);
            sa += 1;
          } else {
            sr += c[0] * c[3];
            sg += c[1] * c[3];
            sb += c[2] * c[3];
            sa += c[3];
          }
        }
      }
      const i = (py * size + px) * 4;
      const alpha = sa / (SS * SS);
      rgba[i] = sa > 0 ? Math.round(sr / sa) : 0;
      rgba[i + 1] = sa > 0 ? Math.round(sg / sa) : 0;
      rgba[i + 2] = sa > 0 ? Math.round(sb / sa) : 0;
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

/* ─── PWA 图标 ────────────────────────────────── */

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'icon-192.png'), render(192));
writeFileSync(resolve(OUT, 'icon-512.png'), render(512));
/* 桌面图标会被系统裁圆：垫满奶油底、图形缩进安全区 */
writeFileSync(resolve(OUT, 'icon-maskable-512.png'), render(512, { bleed: CREAM, scale: 0.88 }));
writeFileSync(resolve(OUT, 'apple-touch-icon.png'), render(180));
/* favicon 直接用同一张插画（插画自带底，任何尺寸都清楚） */
writeFileSync(resolve(OUT, 'icon.svg'), readFileSync(ART_PATH));

console.log('PWA 图标 →', OUT, '（源：public/art/sync-pot.svg）');

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
  writeFileSync(resolve(dir, 'ic_launcher.png'), render(iconSize));
  writeFileSync(
    resolve(dir, 'ic_launcher_round.png'),
    render(iconSize, { bleed: CREAM, clipCircle: true, scale: 0.9 }),
  );

  /* 自适应图标的前景层：透明底、不带插画自带的奶油底（背景由下面的颜色提供），
     图形收进中间安全区（可见区只有中间的 ~66%） */
  writeFileSync(
    resolve(dir, 'ic_launcher_foreground.png'),
    render(fgSize, { noBackdrop: true, scale: 0.9, dy: 3.4 }),
  );
}

/* 自适应图标的背景色 —— 用插画自己的奶油底色，拼起来和原图一致 */
writeFileSync(
  resolve(ANDROID_RES, 'values/ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#FFF3DC</color>
</resources>
`,
);

console.log('Android 图标 →', ANDROID_RES);
console.log('  mipmap-{mdpi..xxxhdpi}/ic_launcher[_round|_foreground].png');
