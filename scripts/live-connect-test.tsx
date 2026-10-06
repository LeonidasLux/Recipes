/* 端到端验证「首次连接」：在 jsdom 里真的填表、真的点「连接并拉取」，走真实网络。
   仓库里已有 recipes.json / orders.json，所以 connect 只会拉取、不会写入 ——
   脚本会对比前后 commit sha 来证明这一点。

   用法：
     JISHIBEN_TOKEN=ghp_xxx JISHIBEN_REPO=owner/repo \
       npx esbuild scripts/live-connect-test.tsx --bundle --platform=node --format=esm \
         --target=node20 --loader:.css=empty --external:react --external:react-dom \
         --external:react-dom/client --external:react-router-dom --external:jsdom \
         --outfile=.tmp/live-connect.mjs \
     && JISHIBEN_TOKEN=... JISHIBEN_REPO=... node --import ./scripts/register-dom.mjs .tmp/live-connect.mjs
*/

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '../src/App';

const token = process.env.JISHIBEN_TOKEN ?? '';
const repo = process.env.JISHIBEN_REPO ?? '';

if (!token || !repo) {
  console.error('缺 JISHIBEN_TOKEN / JISHIBEN_REPO');
  process.exit(1);
}

const root = document.getElementById('root') as HTMLElement;
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures++;
    console.error(`✗ ${label}${detail ? `\n   ${detail}` : ''}`);
  }
};

/** 仓库里某个文件的 sha；不存在返回 'none' */
async function fileSha(path: string): Promise<string> {
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (r.status === 404) return 'none';
  const j = (await r.json()) as { sha?: string };
  return j.sha ?? 'unknown';
}

/** 最近一次提交的 sha（诊断用） */
async function headSha(): Promise<string> {
  const r = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  const j = (await r.json()) as Array<{ sha: string }>;
  return j[0]?.sha ?? 'none';
}

/* React 在原型上劫持了 value setter，必须走原生 setter 才能触发 onChange */
async function type(sel: string, value: string) {
  const el = root.querySelector<HTMLInputElement>(sel);
  if (!el) throw new Error(`找不到 ${sel}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function click(sel: string) {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`点不到 ${sel}`);
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

/* ─── 跑 ─────────────────────────────────────── */

console.log(`仓库 ${repo}   token ${token.slice(0, 8)}…${token.slice(-4)}\n`);

localStorage.clear();
const before = {
  recipes: await fileSha('recipes.json'),
  orders: await fileSha('orders.json'),
  profiles: await fileSha('profiles.json'),
};

await act(async () => {
  createRoot(root).render(
    <MemoryRouter initialEntries={['/setup']}>
      <AppShell />
    </MemoryRouter>,
  );
});
await wait(700);

console.log('[填表]');
await type('#fNickname', '小辉');
await type('#fToken', token);
await type('#fRepo', repo);
check(
  root.querySelector<HTMLInputElement>('#fToken')?.value === token,
  'token 原样进入输入框（没有被自动大写/空格污染）',
);
check(root.querySelector<HTMLInputElement>('#fRepo')?.value === repo, '仓库名原样进入输入框');

console.log('\n[点「连接并拉取」]');
await click('button[type="submit"]');
/* verifyRepo + pull 两个文件的真实网络往返 */
await wait(9000);

const html = root.innerHTML;
const success = html.includes('仓库已接管你的菜谱');
const stillForm = html.includes('连接并拉取');

if (success) {
  check(true, '连接成功 —— 出现「仓库已接管你的菜谱」');
  const m = html.match(/第一次拉取完成 · (\d+) 条菜谱 · (\d+) 条点单/);
  console.log(`   ${m ? `拉到 ${m[1]} 条菜谱 · ${m[2]} 条点单` : '（没解析到统计行）'}`);
  console.log(`   ${html.includes('仓库里还没有数据') ? '仓库原本是空的，推了初始内容' : '从仓库拉取了已有数据'}`);
} else {
  const err = html.match(/连接失败<\/b><br>([^<]*)<br><span[^>]*>([^<]*)/);
  check(false, '连接成功', err ? `页面报错：「${err[1]}」 / 「${err[2]}」` : '既没有成功视图也没捕获到错误文案');
  if (stillForm) console.log('   （表单仍在，输入已保留）');
}

/* 菜谱 / 订单没变就不该被重写；昵称是新填的，写 profiles.json 是正确的 */
const after = {
  recipes: await fileSha('recipes.json'),
  orders: await fileSha('orders.json'),
  profiles: await fileSha('profiles.json'),
};
console.log('\n[写入范围]');
check(before.recipes === after.recipes, 'recipes.json 未被重写（内容没变就不写）');
check(before.orders === after.orders, 'orders.json 未被重写');
if (before.profiles === 'none') {
  check(after.profiles !== 'none', 'profiles.json 被创建（昵称进仓库）');
} else {
  console.log(`   profiles.json 原本就存在（sha ${before.profiles.slice(0, 7)}），本次${before.profiles === after.profiles ? '未变' : '已更新'}`);
}
console.log(`   最新提交 ${await headSha()}`);

/* 连接成功后模式应该被记住 */
const saved = localStorage.getItem('jishiben-db-v1');
if (saved) {
  const db = JSON.parse(saved);
  console.log(
    `   localStorage: configured=${db.configured} repo="${db.config?.repo}" me=${db.config?.me} ` +
      `nickname="${db.config?.nickname}" 菜谱=${db.recipes?.length} 单=${db.orders?.length}`,
  );
  check(db.configured === true, '配置已落本地（configured=true）');
  check(db.config?.repo === repo, `本地记住了仓库 ${db.config?.repo}`);
  check(db.config?.token === token, 'token 存本机（localStorage，设计如此）');
  check(
    typeof db.config?.tokenMask === 'string' && db.config.tokenMask !== token,
    '界面上用的是掩码 tokenMask，不是明文',
  );
} else {
  check(false, '本地已落配置', 'localStorage 里没有 jishiben-db-v1');
}

/* 最关键的安全性质：token 绝不能出现在推给仓库的文件里 */
console.log('\n[token 是否会漏进仓库]');
for (const path of ['recipes.json', 'orders.json']) {
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw' },
  });
  const text = await r.text();
  check(
    !text.includes(token) && !text.includes('ghp_') && !text.includes('token'),
    `${path} 里没有 token / 凭证字段`,
    text.includes('ghp_') ? '文件里出现了 ghp_ 前缀！' : '',
  );
}

console.log(failures ? `\n✗ 连接流程验证失败：${failures} 项\n` : '\n✓ 连接流程验证通过\n');
process.exit(failures ? 1 : 0);
