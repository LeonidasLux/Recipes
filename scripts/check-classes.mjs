/* 对账：TSX 里用到的 class 是否都在样式表里有定义（移植时最容易漏的一环） */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const css =
  readFileSync('src/styles/app.css', 'utf8') + readFileSync('src/styles/screens.css', 'utf8');

const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

/** 这些类有意不定义，见 README「与原型的两处刻意差异」 */
const INTENTIONALLY_UNDEFINED = new Set(['h3']);

const used = new Map();

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
    } else if (/\.tsx?$/.test(entry.name)) {
      const src = readFileSync(p, 'utf8');
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const raw = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
        for (const tok of raw.split(/\s+/)) {
          if (/^[a-z][\w-]*$/.test(tok)) {
            if (!used.has(tok)) used.set(tok, []);
            used.get(tok).push(relative('.', p));
          }
        }
      }
    }
  }
}

walk('src');

const missing = [...used.entries()].filter(
  ([c]) => !defined.has(c) && !INTENTIONALLY_UNDEFINED.has(c),
);

console.log(`CSS 已定义 ${defined.size} 个类；TSX 引用 ${used.size} 个类`);

if (missing.length) {
  console.log('\n✗ 以下类在样式表里找不到定义：');
  for (const [c, files] of missing) {
    console.log(`  .${c}   ← ${[...new Set(files)].join(', ')}`);
  }
  process.exit(1);
}

const untouched = [...defined].filter((c) => !used.has(c) && !c.startsWith('s-'));
console.log('\n✓ TSX 引用的类全部有定义');
if (untouched.length) {
  console.log(`\n样式表里 ${untouched.length} 个类没被 TSX 直接引用（多为状态类/后代选择器）：`);
  console.log('  ' + untouched.sort().join('  '));
}
