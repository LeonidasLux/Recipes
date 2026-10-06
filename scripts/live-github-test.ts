/* 真实 GitHub 同步自检 —— 直接调用 src/lib/github.ts，不重写一套。
   凭证从环境变量 JISHIBEN_TOKEN / JISHIBEN_REPO 读。

   安全性：如果仓库里已经有 recipes.json / orders.json，会先备份到 .tmp/，
   测完自动还原，不留改动。

   用法：
     JISHIBEN_TOKEN=ghp_xxx JISHIBEN_REPO=owner/repo \
       npx esbuild scripts/live-github-test.ts --bundle --platform=node --format=esm \
         --target=node20 --outfile=.tmp/live.mjs \
     && JISHIBEN_TOKEN=ghp_xxx JISHIBEN_REPO=owner/repo node .tmp/live.mjs        */

import { writeFileSync, mkdirSync } from 'node:fs';
import {
  GithubError,
  ORDERS_PATH,
  RECIPES_PATH,
  getJson,
  putJson,
  verifyRepo,
  withTimeout,
} from '../src/lib/github';
import { seed } from '../src/data/seed';
import type { RemoteOrders, RemoteRecipes } from '../src/data/types';

/* ─── 从环境变量读凭证 ───────────────────────── */

const repo = process.env.JISHIBEN_REPO ?? '';
const token = process.env.JISHIBEN_TOKEN ?? '';

if (!repo || !token) {
  console.error('✗ 缺 JISHIBEN_TOKEN / JISHIBEN_REPO');
  process.exit(1);
}
const branch = 'main';

mkdirSync('.tmp', { recursive: true });

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures++;
    console.error(`✗ ${label}${detail ? `\n   ${detail}` : ''}`);
  }
};

console.log(`仓库 ${repo} @ ${branch}    token ${token.slice(0, 8)}…${token.slice(-4)}\n`);

/* ─── 1. 只读：仓库 / 分支 / token 是否可用 ──── */

console.log('[1] 校验凭证与仓库');
{
  const { signal, done } = withTimeout(20000);
  try {
    await verifyRepo(repo, branch, token, signal);
    check(true, 'verifyRepo：token 有效、仓库与分支都存在');
  } catch (e) {
    check(false, 'verifyRepo', e instanceof Error ? e.message : String(e));
    process.exit(1);
  } finally {
    done();
  }
}

/* ─── 2. 只读：错误分支是否被正确分类 ────────── */

console.log('\n[2] 错误分类（只读，不碰你的数据）');
{
  {
    const { signal, done } = withTimeout(20000);
    try {
      await getJson(repo, RECIPES_PATH, branch, 'ghp_thisTokenIsDefinitelyInvalid000000', signal);
      check(false, '无效 token 应当抛错');
    } catch (e) {
      check(
        e instanceof GithubError && e.kind === 'auth',
        `无效 token → GithubError(kind=auth)  「${e instanceof Error ? e.message : String(e)}」`,
        `实际拿到：${e instanceof Error ? e.constructor.name : typeof e}`,
      );
    } finally {
      done();
    }
  }

  {
    const { signal, done } = withTimeout(20000);
    try {
      await verifyRepo('LeonidasLux/definitely-not-a-real-repo-xyz', branch, token, signal);
      check(false, '不存在的仓库应当抛错');
    } catch (e) {
      check(
        e instanceof GithubError && e.kind === 'notfound',
        `不存在的仓库 → GithubError(kind=notfound)  「${e instanceof Error ? e.message : String(e)}」`,
        `实际拿到：${e instanceof Error ? e.constructor.name : typeof e}`,
      );
    } finally {
      done();
    }
  }
}

/* ─── 3. 读取现状 ────────────────────────────── */

console.log('\n[3] 读取仓库现状');
const before = {
  recipes: await readOrNull<RemoteRecipes>(RECIPES_PATH),
  orders: await readOrNull<RemoteOrders>(ORDERS_PATH),
};

async function readOrNull<T>(path: string) {
  const { signal, done } = withTimeout(20000);
  try {
    return await getJson<T>(repo!, path, branch, token!, signal);
  } finally {
    done();
  }
}

console.log(
  `   recipes.json：${before.recipes ? `${before.recipes.data.recipes?.length ?? '?'} 条菜谱（sha ${before.recipes.sha.slice(0, 7)}）` : '不存在'}`,
);
console.log(
  `   orders.json ：${before.orders ? `${before.orders.data.orders?.length ?? '?'} 条点单（sha ${before.orders.sha.slice(0, 7)}）` : '不存在'}`,
);

/* 已有数据就先备份，测完还原 */
if (before.recipes) writeFileSync('.tmp/backup-recipes.json', JSON.stringify(before.recipes.data, null, 2));
if (before.orders) writeFileSync('.tmp/backup-orders.json', JSON.stringify(before.orders.data, null, 2));
if (before.recipes || before.orders) {
  console.log('   （已备份到 .tmp/，测完会还原）');
}

/* ─── 4. 写入：中文往返 + 提交即同步 ─────────── */

console.log('\n[4] 写入并回读（UTF-8 中文往返）');
const demo = seed();

const recipesDoc: RemoteRecipes = {
  schema: 2,
  updatedAt: '自检',
  recipes: demo.recipes,
};
const ordersDoc: RemoteOrders = {
  schema: 2,
  updatedAt: '自检',
  orders: demo.orders,
};

const stamp = new Date().toISOString();
{
  const { signal, done } = withTimeout(30000);
  try {
    const sha = await putJson(
      repo, RECIPES_PATH, branch, token,
      recipesDoc, `记食本：同步自检 ${stamp}`, before.recipes?.sha, signal,
    );
    check(typeof sha === 'string' && sha.length > 0, `PUT recipes.json 成功（新 sha ${sha.slice(0, 7)}）`);
  } catch (e) {
    check(false, 'PUT recipes.json', e instanceof Error ? e.message : String(e));
  } finally {
    done();
  }
}

let recipesShaAfter = '';
{
  const { signal, done } = withTimeout(30000);
  try {
    const sha = await putJson(
      repo, ORDERS_PATH, branch, token,
      ordersDoc, `记食本：同步自检 ${stamp}`, before.orders?.sha, signal,
    );
    check(typeof sha === 'string' && sha.length > 0, `PUT orders.json 成功（新 sha ${sha.slice(0, 7)}）`);
    recipesShaAfter = sha;
  } catch (e) {
    check(false, 'PUT orders.json', e instanceof Error ? e.message : String(e));
  } finally {
    done();
  }
}
void recipesShaAfter;

/* 回读校验 */
{
  const r = await readOrNull<RemoteRecipes>(RECIPES_PATH);
  const same =
    r &&
    r.data.recipes?.length === demo.recipes.length &&
    r.data.recipes[0].title === demo.recipes[0].title &&
    r.data.recipes[0].note === demo.recipes[0].note &&
    r.data.recipes[3].title === '巴斯克芝士蛋糕';
  check(Boolean(same), '回读 recipes.json：条数与中文内容逐字一致', r ? `拿到 ${r.data.recipes?.length} 条` : '拿到 null');
}

{
  const o = await readOrNull<RemoteOrders>(ORDERS_PATH);
  const same =
    o &&
    o.data.orders?.length === demo.orders.length &&
    o.data.orders[1].note === '少放辣' &&
    o.data.orders[1].items?.length === 2 &&
    o.data.orders[1].items[0].dishName === '溏心蛋葱油拌面';
  check(Boolean(same), '回读 orders.json：一单多菜结构 + 中文备注一致', o ? `拿到 ${o.data.orders?.length} 条` : '拿到 null');
}

/* ─── 5. 冲突重试路径（用旧 sha 再提交一次）──── */

console.log('\n[5] 冲突处理：拿过期 sha 提交');
{
  const { signal, done } = withTimeout(30000);
  try {
    await putJson(repo, RECIPES_PATH, branch, token, recipesDoc, '记食本：故意用过期 sha', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', signal);
    check(false, '过期 sha 应当被仓库拒绝');
  } catch (e) {
    check(
      e instanceof GithubError && (e.kind === 'conflict' || e.kind === 'notfound'),
      `过期 sha → GithubError(kind=${e instanceof GithubError ? e.kind : '?'})，会被同步引擎捕获并刷新 sha 重试`,
      `实际：${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    done();
  }
}

/* ─── 6. 还原 ────────────────────────────────── */

console.log('\n[6] 还原仓库');
if (before.recipes || before.orders) {
  const cur = { r: await readOrNull<RemoteRecipes>(RECIPES_PATH), o: await readOrNull<RemoteOrders>(ORDERS_PATH) };

  if (before.recipes) {
    const { signal, done } = withTimeout(30000);
    try {
      await putJson(repo, RECIPES_PATH, branch, token, before.recipes.data, '记食本：还原自检前的数据', cur.r?.sha, signal);
      check(true, 'recipes.json 已还原为自检前的内容');
    } catch (e) {
      check(false, '还原 recipes.json', e instanceof Error ? e.message : String(e));
    } finally {
      done();
    }
  }
  if (before.orders) {
    const { signal, done } = withTimeout(30000);
    try {
      await putJson(repo, ORDERS_PATH, branch, token, before.orders.data, '记食本：还原自检前的数据', cur.o?.sha, signal);
      check(true, 'orders.json 已还原为自检前的内容');
    } catch (e) {
      check(false, '还原 orders.json', e instanceof Error ? e.message : String(e));
    } finally {
      done();
    }
  }
} else {
  console.log('   （仓库原本是空的，写入的演示数据就是首次连接时的初始内容，保留不动）');
}

console.log(failures ? `\n✗ 真实同步自检失败：${failures} 项\n` : '\n✓ 真实同步自检全部通过\n');
process.exit(failures ? 1 : 0);
