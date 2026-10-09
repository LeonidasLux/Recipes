/* 冒烟测试：在 jsdom 里真的把 App 挂载起来。
   分两层：
     · 渲染层 —— 逐个路由校验进场骨架之后的真实内容
     · 交互层 —— 真实点击/输入，校验点单、接单、存备注这些业务动作 */



import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { existsSync, readFileSync } from 'node:fs';
import { applyVersion, resolveVersion } from './set-version.mjs';
import { AppShell } from '../src/App';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { DB_KEY, emptyProfiles, migrate, normalizeOrders, normalizeProfiles, normalizeRecipes, SCHEMA, seed } from '../src/data/seed';
import { detectSource, extractUrl, guessArt, parseShare, searchKeyword, toDishName } from '../src/lib/share';
import {
  aiKeyShapeError,
  buildAiMessages,
  DeepseekError,
  maskAiKey,
  normalizeAiKey,
  normalizeAiRecipe,
  parseJsonLoose,
  recognizeRecipe,
  verifyAiKey,
  type AiMessage,
} from '../src/lib/ai';

/** 取一条 AI 消息里的可读文字：带截图时 content 是「文字 + 图片」块数组 */
function aiText(m: AiMessage): string {
  return typeof m.content === 'string'
    ? m.content
    : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}
import {
  compactPage,
  isFetchableUrl,
  ReaderError,
  readPageHtml,
} from '../src/lib/reader';
import {
  GithubError,
  deleteFile,
  getFileSha,
  getImageIndex,
  getJson,
  getImage,
  imageMimeOf,
  imagePath,
  maskToken,
  normalizeToken,
  putImage,
  putJson,
  tokenShapeError,
  verifyRepo,
  withTimeout,
} from '../src/lib/github';
import {
  MAX_PHOTO_BYTES,
  base64ToBytes,
  blobToDataUrl,
  bytesToBase64,
  cachedPhoto,
  dataUrlBase64,
  dataUrlBytes,
  dataUrlMime,
  forgetPhoto,
  imageExtFor,
  isPhotoDataUrl,
  isPhotoUploaded,
  markPhotosUploaded,
  photoToDataUrl,
  rememberPhoto,
} from '../src/lib/photo';
import {
  artUrl,
  dateKey,
  initial,
  mealLabel,
  meOf,
  nicknameOf,
  nowStamp,
  nowStampSec,
  orderSummary,
  partnerOf,
  recipeInOpenOrder,
  srcMeta,
  statusMeta,
} from '../src/data/helpers';
import { backAction, isRootPath, pressBack, trackHistory } from '../src/lib/back';
import { keepsNativeLongPress } from '../src/lib/gestures';
import type { DB, Order, Profiles, Recipe } from '../src/data/types';

/** 记录时间统一格式：`2026-10-07 09:40` —— 必须带年月日 */
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
/** 同步时间精确到秒：`2026-10-07 09:40:12` */
const SYNC_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const root = document.getElementById('root') as HTMLElement;

let failures = 0;

function fail(name: string, detail: string) {
  failures++;
  console.error(`✗ ${name}\n   ${detail}`);
}

function ok(name: string) {
  console.log(`✓ ${name}`);
}

/** 断言：条件成立就 ok，否则 fail 并带上细节 */
function check(cond: boolean, label: string, detail = '') {
  if (cond) ok(label);
  else fail(label, detail);
}

/* ─── 虚拟时钟 ─────────────────────────────────
   由 register-dom.mjs 预加载注入。它未武装时透传真实定时器，这里主动 arm 之后，
   所有 setTimeout / setInterval 都要靠 advance() 推进 —— 于是「等 700ms 进场骨架 /
   等防抖」不再真的空等挂钟，整套冒烟从一分多钟掉到个位数秒。
   若注入缺失（比如有人不走 npm run smoke 而是手搓命令），回退到真实等待，行为不变。 */
interface DomClock {
  readonly armed: boolean;
  arm(): void;
  advance(ms: number): Promise<void>;
}

const domClock = (globalThis as unknown as { __domClock?: DomClock }).__domClock;
domClock?.arm();
console.log(domClock?.armed ? '[时钟] 虚拟 —— 定时器由 settle() 推进，不空等挂钟' : '[时钟] 真实等待（未注入虚拟时钟）');

/** 推进虚拟时间 ms 毫秒，并让 React 把期间产生的状态更新冲刷干净 */
async function settle(ms: number) {
  await act(async () => {
    if (domClock?.armed) await domClock.advance(ms);
    else await new Promise((res) => setTimeout(res, ms));
  });
}

/* ─── 挂载 / 交互工具 ────────────────────────── */

interface Mounted {
  html(): string;
  $(sel: string): HTMLElement | null;
  $$(sel: string): HTMLElement[];
  text(sel: string): string;
  wait(ms: number): Promise<void>;
  click(sel: string): Promise<void>;
  clickEl(el: HTMLElement): Promise<void>;
  type(sel: string, value: string): Promise<void>;
  /**
   * 模拟中文输入法提交候选词：只派发 composition 事件，compositionend 之后
   * **不补** input —— 有些 Android WebView / 输入法就是这样，受控输入框会因此丢字。
   */
  ime(sel: string, value: string): Promise<void>;
  /** React 把 onBlur 挂在 focusout 上，要派发 focusout 才触发 */
  blur(sel: string): Promise<void>;
  /**
   * 在可滚动容器上派发 scroll。jsdom 不做布局，scrollHeight / clientHeight 恒为 0，
   * 等价于「已经滚到底」——正好用来驱动滚动懒加载。
   */
  scroll(sel: string): Promise<void>;
  /** pointerType 传 'touch' 才像真机触摸；不传等同于鼠标 */
  pointerDown(sel: string, pointerType?: string): Promise<void>;
  pointerUp(sel: string): Promise<void>;
  /** 派发 contextmenu（长按链接时系统补的那个事件），返回是否被 preventDefault */
  contextMenu(sel: string): Promise<boolean>;
  /** 长按：按下 → 推进虚拟时间（默认 600ms）→ 松手 */
  longPress(sel: string, ms?: number): Promise<void>;
  value(sel: string): string;
  /** 在某个容器里按文字定位卡片，再点它里面的目标元素 */
  clickInCard(cardSel: string, matchText: string, targetSel: string): Promise<void>;
  /** 在一组候选元素里按可见文字点第一个命中的 */
  clickByText(sel: string, text: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * 往受控输入框里塞值。React 在原型上劫持了 value setter，
 * 必须走原生 setter 才能让 React 的 value tracker 察觉到变化。
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
}

async function mount(path: string): Promise<Mounted> {
  let r!: Root;
  await act(async () => {
    r = createRoot(root);
    r.render(
      <MemoryRouter initialEntries={[path]}>
        <AppShell />
      </MemoryRouter>,
    );
  });
  /* 等进场骨架（460～520ms）：虚拟时钟下是瞬时的 */
  await settle(700);

  const mounted: Mounted = {
    html: () => root.innerHTML,
    $: (sel) => root.querySelector<HTMLElement>(sel),
    $$: (sel) => [...root.querySelectorAll<HTMLElement>(sel)],
    text(sel) {
      const el = root.querySelector(sel);
      return el ? (el.textContent ?? '').trim() : '';
    },
    async wait(ms) {
      await settle(ms);
    },
    async click(sel) {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`点不到 ${sel}`);
      await mounted.clickEl(el);
    },
    async clickEl(el) {
      await act(async () => {
        el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
    },
    async clickByText(sel, text) {
      const el = mounted.$$(sel).find((c) => (c.textContent ?? '').includes(text));
      if (!el) throw new Error(`找不到包含「${text}」的 ${sel}`);
      await mounted.clickEl(el);
    },
    async clickInCard(cardSel, matchText, targetSel) {
      const card = mounted
        .$$(cardSel)
        .find((c) => (c.textContent ?? '').includes(matchText));
      if (!card) throw new Error(`找不到包含「${matchText}」的 ${cardSel}`);
      const target = card.querySelector<HTMLElement>(targetSel);
      if (!target) throw new Error(`卡片「${matchText}」里找不到 ${targetSel}`);
      await mounted.clickEl(target);
    },
    async type(sel, value) {
      const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
      if (!el) throw new Error(`找不到输入框 ${sel}`);
      await act(async () => {
        setNativeValue(el, value);
        el.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    async ime(sel, value) {
      const el = root.querySelector<HTMLInputElement>(sel);
      if (!el) throw new Error(`找不到输入框 ${sel}`);
      await act(async () => {
        el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      });
      await act(async () => {
        setNativeValue(el, value);
        el.dispatchEvent(new window.CompositionEvent('compositionupdate', { bubbles: true, data: value }));
      });
      /* 关键：只到 compositionend 为止，不补 input（模拟会丢字的那种 Android 输入法） */
      await act(async () => {
        el.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true, data: value }));
      });
    },
    async blur(sel) {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`找不到 ${sel}`);
      await act(async () => {
        el.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
      });
    },
    async scroll(sel) {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`找不到可滚动容器 ${sel}`);
      await act(async () => {
        el.dispatchEvent(new window.Event('scroll', { bubbles: true }));
      });
    },
    async pointerDown(sel, pointerType) {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`找不到 ${sel}`);
      await act(async () => {
        const ev = new window.Event('pointerdown', { bubbles: true, cancelable: true });
        /* jsdom 没有 PointerEvent，用普通 Event 顶上；pointerType 得手动挂 */
        Object.defineProperty(ev, 'pointerType', { value: pointerType ?? '' });
        el.dispatchEvent(ev);
      });
    },
    async contextMenu(sel) {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`找不到 ${sel}`);
      let prevented = false;
      await act(async () => {
        prevented = !el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      return prevented;
    },
    async pointerUp(sel) {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`找不到 ${sel}`);
      await act(async () => {
        el.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
      });
    },
    async longPress(sel, ms = 600) {
      await mounted.pointerDown(sel);
      await settle(ms);
      await mounted.pointerUp(sel);
    },
    value(sel) {
      const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
      return el ? el.value : '';
    },
    async close() {
      await act(async () => {
        r.unmount();
      });
      root.innerHTML = '';
    },
  };
  return mounted;
}

/* ─── 场景装载 ───────────────────────────────── */

function useDb(mutate?: (db: DB) => void) {
  const db = seed();
  db.configured = true;
  /* 名字随仓库同步，示例里给上，方便断言具体称呼 */
  db.profiles = {
    a: { nickname: '小辉', updatedAt: nowStamp() },
    b: { nickname: '小红', updatedAt: nowStamp() },
  };
  db.config = {
    repo: 'xiaoman/family-recipes',
    branch: 'main',
    token: 'ghp_example_token_value',
    tokenMask: 'ghp_••••••••alue',
    aiKey: '',
    aiKeyMask: '',
    aiOn: true,
    me: 'a',
    view: 'order',
    autoPull: true,
    intervalSec: 60,
    /* 同步时间到秒，跟真实写入保持一致 */
    lastPulledAt: nowStampSec(),
    lastPushedAt: nowStampSec(),
  };
  mutate?.(db);
  localStorage.clear();
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  return db;
}

function readDb(): DB {
  return JSON.parse(localStorage.getItem(DB_KEY)!) as DB;
}

/* ─── 假的 GitHub API：把 connect() 的完整路径挪到离线测试里 ───
   真实网络才走得通的那条路径曾经藏过一个「后一次写入覆盖前一次」的 bug，
   只有 stub 掉 fetch 才能在没有网络的情况下把它钉住。 */

/**
 * 假 GitHub。
 *
 * restore() 还原的是**安装时**的 fetch（不是最初的），这样可以层层叠加：
 * 整个套件先铺一层「什么都读不到」的底，个别用例再盖一层定制行为。
 * 目的之一是保证离线套件绝不真的打 api.github.com。
 */
interface FakeGithub {
  calls: string[];
  /** 每次 PUT 带的 sha —— 用来验证「撞车后重试用的是新读到的 sha，不是旧 sha」 */
  puts: Array<{ path: string; sha?: string }>;
  /** 每次 PUT 的正文（图片用例要断言 base64 对不对） */
  putBodies: Array<{ path: string; content?: string }>;
  /** 被 DELETE 掉的文件路径（删菜谱要顺手删图） */
  deletes: string[];
  /** 每次 DELETE 带的 sha（验证删图用的是目录清单里的 sha，而不是先下载一遍图） */
  deleteShas: Array<{ path: string; sha?: string }>;
  /** 识图请求的正文（假 GitHub 顺带当 DeepSeek 用时记的） */
  aiBodies: string[];
  /** 每次 fetch 的 cache 选项 —— 用来验证读仓库绕过了浏览器 HTTP 缓存 */
  fetches: Array<{ method: string; path: string; cache?: string }>;
  restore(): void;
}

function installFakeGithub(opts: {
  /** 仓库里已有的文件；给 undefined 表示 404（空仓库） */
  recipes?: unknown;
  orders?: unknown;
  profiles?: unknown;
  /** 让 verifyRepo 返回这个状态码，用来测错误分支 */
  repoStatus?: number;
  /** 让第一次 PUT 返回这个状态码（用来测 409 冲突自动重试） */
  putFailOnce?: number;
  /** 撞车的同时「另一台设备」先推了一版：之后 GET 到的是新 sha */
  shaChangedAfterConflict?: boolean;
  /** 撞车后连读也读不到（模拟取不回新 sha） */
  getFailAfterConflict?: boolean;
  /** 让假 GitHub 像真的一样校验 sha：对不上回 409，没带 sha 回 422 */
  validateSha?: boolean;
  /** 仓库里已有的图片：路径（如 `images/r1.jpg`）→ base64 正文 */
  images?: Record<string, string>;
  /**
   * 顺带当 DeepSeek 用（批量识图要「识图 + 推仓库」同时发生，单个 stubFetch 装不下）：
   * 识图请求按调用次序返回这里的菜名。
   */
  aiTitles?: string[];
  /** 每次识图先等这么久（虚拟时钟下的毫秒数）：用来测「识别中」的中间态与「停止」 */
  aiDelayMs?: number;
  /** 让 Git Trees（读 images/ 清单）失败，用来测退回「逐张问」的老路 */
  treeFails?: boolean;
}): FakeGithub {
  const calls: string[] = [];
  const puts: Array<{ path: string; sha?: string }> = [];
  const putBodies: Array<{ path: string; content?: string }> = [];
  const deletes: string[] = [];
  const deleteShas: Array<{ path: string; sha?: string }> = [];
  const fetches: Array<{ method: string; path: string; cache?: string }> = [];
  /** 识图请求的正文（断言「一次一张图」用） */
  const aiBodies: string[] = [];
  let aiCount = 0;
  let putCount = 0;
  let remoteChanged = false;
  const prev = globalThis.fetch;
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  /* 仓库里三份文件当前的 sha；文件不存在时是 undefined（对应 404） */
  const shaState: Record<string, string | undefined> = {
    recipes: opts.recipes === undefined ? undefined : 'sha-recipes',
    orders: opts.orders === undefined ? undefined : 'sha-orders',
    profiles: opts.profiles === undefined ? undefined : 'sha-profiles',
  };
  const blob = { recipes: opts.recipes, orders: opts.orders, profiles: opts.profiles } as Record<string, unknown>;
  /* 图片是真·二进制文件：仓库里的 shape 就是「路径 → base64 正文」 */
  const images: Record<string, string> = { ...(opts.images ?? {}) };
  for (const p of Object.keys(images)) shaState[p] = `sha-${p}-init`;
  /* GET 的 URL 带 ?ref=main，取名字前先把查询串砍掉 */
  const nameOf = (url: string) => url.split('/contents/')[1]?.split('?')[0]?.replace('.json', '') ?? '';

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.replace('https://api.github.com', '');
    calls.push(`${method} ${path}`);
    fetches.push({ method, path, cache: init?.cache });

    /* 顺带当 DeepSeek：识图请求一张一張回菜名（见 opts.aiTitles） */
    if (url.includes('api.deepseek.com/chat/completions')) {
      aiBodies.push(String(init?.body ?? ''));
      const title = (opts.aiTitles ?? [])[aiCount] ?? '';
      aiCount++;
      if (opts.aiDelayMs) await new Promise((r) => setTimeout(r, opts.aiDelayMs));
      return json({ choices: [{ message: { content: JSON.stringify({ title, author: '阿珍', steps: '1. 焯水' }) } }] });
    }

    /* Git Trees：仓库里 images/ 的清单（只给路径 + sha，不含图的正文） */
    if (url.includes('/git/trees/')) {
      if (opts.treeFails) return json({ message: 'Server Error' }, 500);
      const tree = Object.entries(shaState)
        .filter(([, sha]) => sha !== undefined)
        .map(([name, sha]) => ({
          path: name.startsWith('images/') ? name : `${name}.json`,
          mode: '100644',
          type: 'blob',
          sha,
        }));
      return json({ sha: 'sha-tree', tree, truncated: false });
    }

    if (method === 'PUT') {
      putCount++;
      const body = JSON.parse(String(init?.body ?? '{}')) as { sha?: string };
      puts.push({ path, sha: body.sha });
      putBodies.push({ path, content: (body as { content?: string }).content });
      const name = nameOf(url);
      if (name.startsWith('images/')) images[name] = (body as { content?: string }).content ?? '';
      /* 真 GitHub 的行为：没有 sha 或 sha 不是当前这个 → 422 / 409 */
      if (opts.validateSha) {
        if (shaState[name] === undefined) {
          if (body.sha !== undefined) return json({ message: 'conflict' }, 409);
        } else if (body.sha !== shaState[name]) {
          return json({ message: 'conflict' }, body.sha === undefined ? 422 : 409);
        }
      }
      if (opts.putFailOnce && putCount === 1) {
        remoteChanged = true;
        if (opts.shaChangedAfterConflict) {
          for (const k of ['recipes', 'orders', 'profiles']) {
            if (shaState[k] !== undefined) shaState[k] = `sha-${k}-v2`;
          }
        }
        return json({ message: 'conflict' }, opts.putFailOnce);
      }
      shaState[name] = `sha-${name}-new`;
      /* 真 GitHub 会真的把正文存下来：写过的文件，之后再读要能读到新内容 */
      const written = (body as { content?: string }).content ?? '';
      try {
        blob[name] = JSON.parse(Buffer.from(written, 'base64').toString('utf8'));
      } catch {
        /* 图片之类不是 JSON 的（图片走上面那条 images 分支） */
      }
    }

    if (/\/repos\/[\w.-]+\/[\w.-]+$/.test(url) && method === 'GET') {
      return opts.repoStatus && opts.repoStatus !== 200
        ? json({ message: 'Bad credentials' }, opts.repoStatus)
        : json({ full_name: 'owner/repo' });
    }
    if (url.includes('/branches/')) return json({ name: 'main' });

    if (url.includes('/contents/')) {
      const name = nameOf(url);
      if (method === 'GET') {
        if (remoteChanged && opts.getFailAfterConflict) return json({ message: 'Server Error' }, 500);
        if (shaState[name] === undefined) return json({ message: 'Not Found' }, 404);
        /* 图片：正文就是 base64 本身，不再套一层 JSON */
        return json({
          sha: shaState[name],
          content: name.startsWith('images/') ? images[name] : b64(JSON.stringify(blob[name])),
        });
      }
      if (method === 'DELETE') {
        const delBody = JSON.parse(String(init?.body ?? '{}')) as { sha?: string };
        deletes.push(name);
        deleteShas.push({ path: name, sha: delBody.sha });
        delete shaState[name];
        delete images[name];
        return json({ content: { sha: 'sha-deleted' } });
      }
      return json({ content: { sha: shaState[name] ?? `sha-${name}-new` } });
    }
    return json({ message: 'unexpected call' }, 500);
  }) as typeof fetch;

  return { calls, puts, putBodies, deletes, deleteShas, aiBodies, fetches, restore: () => void (globalThis.fetch = prev) };
}

const FAKE_CFG = { repo: 'owner/repo', token: 'ghp_012345678901234567890123456789012345' };

/* ─── github.ts 单元测试的通用桩 ─── */

interface StubCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** 极简 fetch 桩：按路由返回响应并记录调用，用于直接测 github.ts 的读写函数 */
function stubFetch(
  routes: Array<{ match: RegExp; method?: string; reply: (url: string, call: StubCall) => Response }>,
): { calls: StubCall[]; restore(): void } {
  const calls: StubCall[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: StubCall = { method, url, headers, body };
    calls.push(call);
    const route = routes.find((r) => r.match.test(url) && (!r.method || r.method === method));
    if (!route) return new Response(JSON.stringify({ message: 'no route' }), { status: 500 });
    return route.reply(url, call);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = prev) };
}

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function utf8b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/** 跑一个必然抛错的调用，取回 GithubError（不是 GithubError 记为 null） */
async function githubErrOf(fn: () => Promise<unknown>): Promise<GithubError | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof GithubError ? e : null;
  }
}

/* 真实格式的分享文案，用来驱动添加菜谱的交互测试 */
const XHS_SHARE =
  '西红柿炒鸡蛋，你就像我这样做，真的很下饭！ http://xhslink.com/a/tomato-egg 复制本条信息，打开【小红书】App查看精彩内容！';
const BILI_SHARE = '【电饭煲卤鸡腿，脱骨那种】 https://b23.tv/xyz789';
/** AI 识别用例：占位 Key（形状合法即可，绝不填真实 Key） */
const AI_KEY = 'sk-0123456789abcdef0123456789abcdef';
const AI_SHARE =
  '番茄牛腩巨好吃！食材：牛腩500g、番茄3个。做法：1 焯水 2 炖40分钟。 http://xhslink.com/a/ai-test 复制本条信息，打开【小红书】App查看精彩内容！';
/** 假的小红书笔记页：作者名一处写在 meta、一处写在内嵌 JSON、一处写在作者块 */
const PAGE_HTML = `<html><head><title>番茄牛腩 - 小红书</title>
<meta property="og:description" content="酸甜开胃，一锅搞定">
<meta name="author" content="爱做饭的阿珍">
<script>window.__INITIAL_STATE__={"user":{"nickname":"阿珍的厨房"}};</script>
</head><body>
<div class="author-name">爱做饭的阿珍</div>
<p>牛腩冷水下锅焯水，番茄去皮炒出沙，加热水小火炖 40 分钟。</p>
</body></html>`;
/** 只贴一条 B站搜索链接（用户实际反馈的那种输入） */
const BILI_SEARCH =
  'https://search.bilibili.com/all?vt=04531052&keyword=%E6%9D%91%E9%A9%B4&from_source=web_search&spm_id_from=333.1007&search_source=5';

/** 测试用的一张假截图：5 字节（PNG 头 + 一个高位字节，验 base64 往返不丢） */
const SHOT_BYTES = new Uint8Array([137, 80, 78, 71, 250]);
const SHOT_B64 = Buffer.from(SHOT_BYTES).toString('base64');
const SHOT_DATA_URL = `data:image/png;base64,${SHOT_B64}`;

/** 往文件选择框里塞一张假图并派发 change —— 走的就是真机上「选截图」那条路 */
async function pickPhoto(m: Mounted, sel: string, bytes: Uint8Array = SHOT_BYTES, name = 'shot.png') {
  const input = m.$(sel) as HTMLInputElement | null;
  if (!input) throw new Error(`找不到文件选择框 ${sel}`);
  const file = new window.File([bytes], name, { type: 'image/png' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

/** 一次选多张（批量识图）：每张字节不一样，方便断言「一图一菜谱」 */
async function pickPhotos(m: Mounted, sel: string, n: number) {
  const input = m.$(sel) as HTMLInputElement | null;
  if (!input) throw new Error(`找不到文件选择框 ${sel}`);
  const files = Array.from({ length: n }, (_, i) =>
    new window.File([new Uint8Array([137, 80, 78, 71, 100 + i])], `shot${i}.png`, { type: 'image/png' }),
  );
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

/** 从记录的调用里取出被 PUT 过的文件路径（去重、排序） */
function putPaths(calls: string[]): string[] {
  const paths = calls
    .filter((c) => c.startsWith('PUT'))
    .map((c) => c.split('/contents/')[1] ?? c);
  return [...new Set(paths)].sort();
}

/** 填表 → 点连接 */
async function fillAndConnect(m: Mounted, opts: { partner?: string } = {}) {
  await m.type('#fNickname', '小辉');
  if (opts.partner) await m.type('#fPartnerNickname', opts.partner);
  await m.type('#fToken', FAKE_CFG.token);
  await m.type('#fRepo', FAKE_CFG.repo);
  await m.click('button[type="submit"]');
  await m.wait(1500);
}

/* ═══════════ 一、渲染层 ═══════════ */

async function renderChecks() {
  const expectIn = async (name: string, path: string, want: string[], reject: string[] = []) => {
    const m = await mount(path);
    const html = m.html();
    const missing = want.filter((s) => !html.includes(s));
    const extra = reject.filter((s) => html.includes(s));
    if (missing.length || extra.length) {
      fail(
        `${name}  (${path})`,
        [missing.length ? `缺少：${missing.join(' / ')}` : '', extra.length ? `不该出现：${extra.join(' / ')}` : '']
          .filter(Boolean)
          .join('；'),
      );
    } else {
      ok(`${name}  (${path})`);
    }
    await m.close();
  };

  localStorage.clear();
  console.log('\n[全新安装 · 未配置仓库]');
  await expectIn('首次设置向导', '/setup', [
    '让菜谱跟着仓库走',
    '四步就好',
    '我的昵称',
    '另一半的昵称',
    '连接并拉取',
    '稍后再说（本地模式）',
  ]);
  await expectIn('根路径重定向到向导', '/', ['让菜谱跟着仓库走']);
  await expectIn('菜谱库也先去向导', '/library', ['让菜谱跟着仓库走']);

  /* 报错横幅必须贴在「连接并拉取」上方，而不是夹在导入配置和表单之间（原型的老毛病）。
     用 DOM 节点比较位置 —— 按字符串匹配会命中「四步就好」里那句提到按钮名的正文。 */
  {
    const m = await mount('/setup');
    const banner = m.$('.errbanner');
    const repoField = m.$('#fRepo');
    const cta = m.$('button[type="submit"]');

    if (!banner || !repoField || !cta) {
      fail('报错横幅位置', `找不到节点 banner=${!!banner} repo=${!!repoField} cta=${!!cta}`);
    } else {
      const FOLLOWING = window.Node.DOCUMENT_POSITION_FOLLOWING;
      const afterRepo = (repoField.compareDocumentPosition(banner) & FOLLOWING) !== 0;
      const beforeCta = (banner.compareDocumentPosition(cta) & FOLLOWING) !== 0;
      const insideForm = banner.closest('form') !== null;
      if (!afterRepo || !beforeCta || !insideForm) {
        fail(
          '报错横幅位置',
          `应位于仓库字段之后、提交按钮之前且在表单内（afterRepo=${afterRepo} beforeCta=${beforeCta} insideForm=${insideForm}）`,
        );
      } else {
        ok('报错横幅贴在「连接并拉取」上方（不在导入配置下面）');
      }
    }
    await m.close();
  }

  useDb();
  console.log('\n[已配置 · 点单视图]');
  await expectIn('1 首次设置（可重新进入）', '/setup', ['让菜谱跟着仓库走', '导入配置']);
  await expectIn('2 菜谱库', '/library', [
    '我的菜谱库',
    '番茄炖牛腩',
    '溏心蛋葱油拌面',
    '小红书',
    'B站',
    '搜菜名、备注或作者',
    '点单',
  ], ['已同步', '本地模式', '同步中']);
  await expectIn(
    '3 菜谱详情（r5 不在任何单里）',
    '/recipe/r5',
    ['菜谱详情', '台式三杯鸡', '我的备注', '九层塔要关火再放', '查看原文', '去点单 · 带上这道菜', '台味阿宏'],
  );
  await expectIn(
    '3b 已在未完成单里的菜 → CTA 禁用',
    '/recipe/r1',
    ['番茄炖牛腩', '已在今天单里', '去点单查看'],
    ['去点单 · 带上这道菜'],
  );
  await expectIn('4 添加菜谱', '/add', [
    '添加菜谱',
    '粘贴小红书 / B站 / 抖音的分享链接或文案',
    '传张截图',
    '识别',
    '菜名',
    '保存并同步',
    'DeepSeek',
  ]);
  await expectIn('5 点单（未选菜 → 发送键禁用）', '/order', [
    '点一顿饭',
    '今天中午',
    '从菜谱库挑选',
    '随机加一道',
    '今日点单',
    '先选几道菜',
    '番茄炖牛腩 等 2 道',
    '已接',
  ]);
  await expectIn('5b 详情带来的预选菜', '/order?add=r2', ['溏心蛋葱油拌面', '发给小红 · 午餐 · 1 道']);
  await expectIn('6 同步与仓库', '/sync', [
    '同步与仓库',
    '我是谁',
    'AI 识别（DeepSeek）',
    'xiaoman/family-recipes',
    '最近同步',
    '小红',
    '断开并清除本地缓存',
    '已同步',
  ]);

  console.log('\n[已配置 · 掌勺视图]');
  /* me = a 时，掌勺屏只显示对方（b）点的单：o2 待接、o3 已做完 */
  await expectIn('7 今日菜单', '/cook', [
    '今日菜单',
    '晚餐单 · 2 道菜',
    '接下这顿',
    '已做完',
    '少放辣',
  ]);

  /* 底部导航固定 4 格：第二格跟着本机角色（config.view）走 */
  {
    const m = await mount('/library');
    const got = m.$$('.tabbar .tab').map((t) => (t.textContent ?? '').trim());
    const want = ['菜谱库', '点单', '添加', '设置'];
    check(got.join(' / ') === want.join(' / '), `底部导航顺序：${want.join(' / ')}`, `实际：${got.join(' / ')}`);
    await m.close();
  }
  {
    useDb((db) => {
      db.config!.view = 'cook';
    });
    const m = await mount('/library');
    const got = m.$$('.tabbar .tab').map((t) => (t.textContent ?? '').trim());
    const want = ['菜谱库', '掌勺', '添加', '设置'];
    check(
      got.join(' / ') === want.join(' / '),
      `掌勺角色 → 底部第二格为掌勺：${want.join(' / ')}`,
      `实际：${got.join(' / ')}`,
    );
    await m.close();
  }

  console.log('\n[空 / 错态预览]');
  await expectIn('菜谱库空态', '/library?state=empty', ['还没有菜谱', '添加第一条菜谱']);
  await expectIn('点单空态', '/order?state=empty', ['今天还没下过单']);

  useDb((db) => {
    db.config!.repo = '';
    db.config!.token = '';
    db.config!.tokenMask = '';
  });
  console.log('\n[本地模式 · 未连仓库]');
  await expectIn('菜谱库不再显示同步状态', '/library', ['我的菜谱库'], ['本地模式', '已同步']);
  await expectIn('同步页显示未连接面板', '/sync', ['还没有连接仓库', '去首次设置']);
}

/* ═══════════ 二、交互层 ═══════════ */

async function interactionChecks() {
  console.log('\n[交互 · 点单流程]');
  useDb();
  {
    const m = await mount('/order');
    const before = readDb().orders.length;

    /* 多选两道菜 */
    await m.click('.pick');
    await m.click('.dishgrid .pick:nth-child(3)');
    if (!m.text('.sendbtn').includes('2 道')) {
      fail('选中两道菜后发送键文案', `实际是「${m.text('.sendbtn')}」`);
    } else {
      ok('选中两道菜 → 发送键显示「2 道」');
    }

    /* 切晚餐 */
    await m.click('.seg.ony button:nth-child(2)');
    if (!m.text('.sendbtn').includes('晚餐')) fail('切晚餐', `实际是「${m.text('.sendbtn')}」`);
    else ok('切到晚餐 → 发送键跟着变');

    /* 移除一颗胶囊 */
    await m.click('.sel .x');
    if (m.$$('.sel').length !== 1) fail('点胶囊移除', `剩余 ${m.$$('.sel').length} 颗`);
    else ok('点胶囊可移除已选菜');

    /* 手动加一道没收藏的 */
    await m.type('.manualrow input', '手抓饼加蛋');
    await m.click('.manualrow .btn-sticker');
    if (m.$$('.sel').length !== 2) fail('手动加菜', `剩余 ${m.$$('.sel').length} 颗`);
    else ok('手动输入也能加进这顿');

    /* 给掌勺的话 */
    check(m.$('.ordernote')?.getAttribute('placeholder') === '给掌勺的话（可不填）', '组合器里有「给掌勺的话」输入框');
    await m.type('.ordernote', '  少放辣，米饭少一点  ');

    /* 发送 */
    await m.click('.sendbtn');
    await m.wait(900);
    const after = readDb();
    const created = after.orders[0];
    if (after.orders.length !== before + 1) {
      fail('发送后落库', `订单数 ${before} → ${after.orders.length}`);
    } else if (created.meal !== 'dinner' || created.status !== 'pending' || created.items.length !== 2) {
      fail('新订单字段', JSON.stringify(created));
    } else if (created.items[1].recipeId !== null || created.items[1].dishName !== '手抓饼加蛋') {
      fail('临时菜 recipeId 应为 null', JSON.stringify(created.items));
    } else {
      ok('发送 → 落库为一单两菜、状态待接、含临时菜');
    }
    check(created.note === '少放辣，米饭少一点', '★ 备注随单落库（首尾空格去掉）', `实际「${created.note}」`);
    check(
      DATE_TIME_RE.test(created.createdAt) && DATE_TIME_RE.test(created.updatedAt),
      '★ 新订单的下单 / 更新时间都带年月日',
      `${created.createdAt} / ${created.updatedAt}`,
    );
    if (m.$$('.sel').length !== 0) fail('发送后清空组合器', `还剩 ${m.$$('.sel').length} 颗`);
    else ok('发送后组合器清空');
    check(m.value('.ordernote') === '', '发送后备注框也清空', `实际「${m.value('.ordernote')}」`);

    /* 展开订单详情 */
    await m.click('.ocard .osum');
    if (!m.$('.ocard.open .odetail')) fail('展开订单', '没有 .ocard.open');
    else ok('点订单卡可展开看每道菜');

    await m.close();
  }

  console.log('\n[交互 · 掌勺接单]');
  useDb();
  {
    const m = await mount('/cook');
    const pending = readDb().orders.find((o) => o.status === 'pending')!;

    /* 定位「待接」那张卡，点它的主按钮 */
    await m.clickInCard('.cookcard', '待接', '.btn-sticker');
    await m.wait(800);
    const nowAccepted = readDb().orders.find((o) => o.id === pending.id)!;
    if (nowAccepted.status !== 'accepted') fail('接下这顿', `status = ${nowAccepted.status}`);
    else ok('「接下这顿」→ 状态回传为已接');

    /* 同一张卡现在应该变成「全部做好了」 */
    if (!m.html().includes('全部做好了')) {
      fail('接单后按钮切换', '没出现「全部做好了」');
    } else {
      ok('接单后按钮变成「全部做好了」');
    }
    await m.clickInCard('.cookcard', '溏心蛋葱油拌面', '.btn-sticker');
    await m.wait(800);
    const nowDone = readDb().orders.find((o) => o.id === pending.id)!;
    if (nowDone.status !== 'done') fail('全部做好了', `status = ${nowDone.status}`);
    else ok('「全部做好了」→ 状态回传为已完成');

    if (!readDb().logs.some((l) => l.text.includes('已接下'))) fail('接单写同步日志', '日志里没有');
    else ok('接单动作写入了同步日志');

    await m.close();
  }

  console.log('\n[交互 · 备注与添加]');
  useDb();
  {
    const m = await mount('/recipe/r5');
    await m.click('#editRecipeBtn');
    await m.type('#editNote', '九层塔换成罗勒也行，但香气差一点。');
    await m.click('.editrow .btn-sticker.primary');
    await m.wait(200);
    const r5 = readDb().recipes.find((r) => r.id === 'r5')!;
    if (r5.note !== '九层塔换成罗勒也行，但香气差一点。') fail('保存备注', `note = ${r5.note}`);
    else ok('编辑备注 → 落库并写日志');
    if (!readDb().logs.some((l) => l.text.includes('已更新'))) fail('备注写日志', '日志里没有');
    else ok('备注保存写入同步日志');
    await m.close();
  }

  {
    const m = await mount('/add');
    await m.type('#shareInput', XHS_SHARE);
    await m.click('#recognizeBtn');
    await m.wait(100);

    check(m.html().includes('西红柿炒鸡蛋'), '粘贴分享文案 → 拆出标题');
    check(
      m.value('#mTitle') === '西红柿炒鸡蛋',
      '★ 标题只留菜名（去掉了后面那串描述），且可改',
      `实际「${m.value('#mTitle')}」`,
    );
    check(
      m.value('#mUrl') === 'http://xhslink.com/a/tomato-egg',
      '链接也一并从文案里拆出来',
      `实际「${m.value('#mUrl')}」`,
    );

    await m.click('.actionbar .btn-primary');
    await m.wait(1000);
    const added = readDb().recipes[0];
    check(
      added?.title === '西红柿炒鸡蛋' && added.source === 'red',
      '保存 → 新菜谱进库（菜名 / 来源正确）',
      JSON.stringify(added),
    );
    check(added?.art === 'tomato-beef.svg', '按标题配了张封面插画', `实际「${added?.art}」`);
    check(readDb().recipes.length === 7, '菜谱数 +1', `实际 ${readDb().recipes.length}`);
    await m.close();
  }

  /* 只贴链接没有文案 —— 不编造标题，直接留给用户填 */
  useDb();
  {
    const m = await mount('/add');
    await m.type('#shareInput', 'https://xhslink.cn/o/7cNiFbAw2if');
    await m.click('#recognizeBtn');
    await m.wait(100);
    check(m.value('#mTitle') === '', '★ 只贴链接 → 标题留空，不编造');
    check(m.value('#mSource') === 'red', '但来源认出来了（小红书）');
    check(
      !(m.$('.actionbar .btn-primary') as HTMLButtonElement).disabled,
      '保存键一直可点（点完才说缺什么，而不是给个点不动的灰按钮）',
    );
    await m.click('.actionbar .btn-primary');
    await m.wait(50);
    check(m.html().includes('总得有个名字才能存'), '★ 没菜名就点保存 → 当场把「菜名」标红');
    check(readDb().recipes.length === 6, '没有半截数据落库', String(readDb().recipes.length));
    check(m.$('.s-add') !== null, '也没离开这一页');
    await m.close();
  }

  console.log('\n[交互 · 谁都能改备注]');
  useDb();
  {
    const m = await mount('/recipe/r2');
    await m.click('#editRecipeBtn');
    await m.type('#editNote', '葱油分两次淋，第一次拌面第二次提香。');
    await m.click('.editrow .btn-sticker.primary');
    await m.wait(200);
    const r2 = readDb().recipes.find((r) => r.id === 'r2')!;
    check(r2.note === '葱油分两次淋，第一次拌面第二次提香。', '★ 备注成功并落库');

    /* 谁都能点单，所以详情页常驻「去点单」操作栏（r2 已在单里则显示「已在今天单里」） */
    check(m.$('.actionbar') !== null, '详情页常驻「去点单」操作栏');
    await m.close();
  }

  console.log('\n[交互 · 谁都能加菜谱]');
  useDb();
  {
    const m = await mount('/add');
    check(m.html().includes('添加菜谱'), '能打开添加菜谱页');

    await m.type('#shareInput', BILI_SHARE);
    await m.click('#recognizeBtn');
    await m.wait(100);
    check(m.value('#mTitle') === '电饭煲卤鸡腿', 'B站文案解析正常（也只留菜名）', `实际「${m.value('#mTitle')}」`);

    await m.click('.actionbar .btn-primary');
    await m.wait(1000);
    const added = readDb().recipes[0];
    check(added?.title === '电饭煲卤鸡腿' && added.source === 'bili', '★ 保存成功，新菜谱进库');
    check(readDb().recipes.length === 7, '菜谱数 +1', `实际 ${readDb().recipes.length}`);
    await m.close();
  }

  console.log('\n[交互 · 手动添加菜谱（可无来源）]');
  useDb();
  {
    const m = await mount('/add');
    /* 手填不藏在「手动添加」按钮后面：字段一直摆着，直接写就行（少一层展开收起） */
    check(m.$('#mTitle') !== null && m.$('#mSteps') !== null, '★ 一进来就能直接填菜名和做法');
    check(m.$('#manualBtn') === null, '没有多余的「手动添加」按钮');
    check(m.value('#mSource') === 'manual', '★ 没贴链接时来源默认就是「手动」', m.value('#mSource'));
    check(m.$('[aria-label="查看大图"]') === null, '★ 没选截图时封面是插画 / 首字，不给点（示意图放大没意义）');
    check(
      m.html().indexOf('粘贴小红书') < m.html().indexOf('id="mTitle"'),
      '顺序是先「贴链接 / 传截图」再填菜谱本身',
    );

    await m.type('#mTitle', '外婆的梅干菜扣肉');
    await m.type('#mSteps', '1. 梅干菜泡软\n2. 五花肉焯水\n3. 上锅蒸 1 小时');
    await m.type('#mNote', '蒸久一点更糯');
    await m.click('.actionbar .btn-primary');
    await m.wait(1000);
    const added = readDb().recipes[0];
    check(added?.title === '外婆的梅干菜扣肉', '★ 手动添加保存成功');
    check(added?.source === 'manual', '★ 没有平台来源，记为「手动」', `实际 ${added?.source}`);
    check(added?.steps === '1. 梅干菜泡软\n2. 五花肉焯水\n3. 上锅蒸 1 小时', '★ 做法落库', JSON.stringify(added?.steps));
    check(added?.note === '蒸久一点更糯', '备注落库');
    check(
      added?.url === '' && added?.author === '',
      '★ 没填链接 / 作者就是空串，不拿「来自剪藏」这种假出处顶替',
      `url=${added?.url} author=${added?.author}`,
    );
    await m.close();
  }
  {
    /* 手动加的菜同样能从列表筛出来 */
    useDb((db) => {
      db.recipes.unshift({
        id: 'r9',
        title: '外婆的梅干菜扣肉',
        source: 'manual',
        url: '',
        author: '来自剪藏',
        art: '',
        steps: '上锅蒸 1 小时',
        note: '',
        createdAt: '刚刚',
        updatedAt: '刚刚',
      });
    });
    const m = await mount('/library');
    await m.clickByText('.chip', '手动');
    check(m.$$('.dishrow').length === 1, '★ 按「手动」筛选只剩手写的那条', `实际 ${m.$$('.dishrow').length}`);
    check(m.html().includes('外婆的梅干菜扣肉'), '筛出来的就是它');
    await m.close();
  }

  console.log('\n[交互 · 设置页填 DeepSeek Key]');
  useDb();
  {
    const m = await mount('/sync');
    check(m.html().includes('AI 识别（DeepSeek）'), '设置页有 AI 识别配置区');
    check(m.html().includes('未设置'), '还没填 Key 时显示「未设置」');
    check((m.$('#aiOnSwitch') as HTMLInputElement).disabled, '没 Key 时「识别时使用 AI」开关是禁用的');

    await m.click('#editAiKeyBtn');
    await m.type('#aiKeyInput', AI_KEY);
    await m.click('#saveAiKeyBtn');
    await m.wait(100);

    const cfg = readDb().config!;
    check(cfg.aiKey === AI_KEY, '★ Key 落库（只存本机 config，不进仓库）', `实际「${cfg.aiKey}」`);
    check(cfg.aiKeyMask === maskAiKey(AI_KEY), '★ 只存掩码供展示', `实际「${cfg.aiKeyMask}」`);
    check(cfg.aiOn === true, '保存后自动开启 AI 识别');
    check(m.html().includes(maskAiKey(AI_KEY)), '设置页显示的是掩码');
    check(!m.html().includes(AI_KEY), '★ 明文 Key 不出现在页面上（输入框已清空）');
    check(!(m.$('#aiOnSwitch') as HTMLInputElement).disabled, '有 Key 后开关可用');
    check(!m.html().includes('识别时读取原链接'), '★ 设置页里没有「读原链接」这一块');
    check(m.$('#linkOnSwitch') === null, '也没有它的开关（读链接默认就用，不可关）');

    await m.click('#aiOnSwitch');
    await m.wait(50);
    check(readDb().config!.aiOn === false, '开关能关掉「识别时使用 AI」');
    await m.click('#aiOnSwitch');
    await m.wait(50);
    check(readDb().config!.aiOn === true, '开关能再打开');

    await m.click('#clearAiKeyBtn');
    await m.wait(50);
    check(readDb().config!.aiKey === '' && readDb().config!.aiOn === false, '★ 清除 Key 并退回本地解析');
    await m.close();
  }

  console.log('\n[交互 · AI 识别（DeepSeek）]');
  useDb((db) => {
    db.config!.aiKey = AI_KEY;
    db.config!.aiKeyMask = maskAiKey(AI_KEY);
    db.config!.aiOn = true;
  });
  {
    const ds = stubFetch([
      { match: /^https:\/\/r\.jina\.ai\//, reply: () => new Response(PAGE_HTML) },
      {
        match: /api\.deepseek\.com\/chat\/completions/,
        method: 'POST',
        reply: () =>
          jsonRes({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: '番茄牛腩',
                    author: '爱做饭的阿珍',
                    steps: '1. 牛腩冷水下锅焯水\n2. 小火炖 40 分钟',
                    note: '八角可放可不放',
                  }),
                },
              },
            ],
          }),
      },
    ]);

    const m = await mount('/add');
    check(m.text('#recognizeBtn') === 'AI 识别', '配了 Key → 按钮变成「AI 识别」', m.text('#recognizeBtn'));
    check(!m.html().includes('填 DeepSeek Key'), '★ 配了 Key 就不再挂「去设置里填 Key」的提示（按钮文案已经说明）');

    await m.type('#shareInput', AI_SHARE);
    await m.click('#recognizeBtn');
    await m.wait(300);

    const chatCalls = ds.calls.filter((c) => c.url.includes('chat/completions'));
    check(chatCalls.length === 1, '★ 真的调了一次 DeepSeek chat/completions', `实际 ${chatCalls.length} 次`);
    check(chatCalls[0].headers.Authorization === `Bearer ${AI_KEY}`, '请求带上了 Bearer Key');
    check(
      (chatCalls[0].body as { model?: string; response_format?: { type?: string } })?.model === 'deepseek-flash',
      '★ 用的是 deepseek-flash 模型（识图与文案识别同一个）',
      String((chatCalls[0].body as { model?: string })?.model),
    );
    check(
      (chatCalls[0].body as { thinking?: { type?: string } })?.thinking?.type === 'disabled',
      '★ 识别关掉思考模式（照着抄的活儿，快且省 token）',
    );

    check(m.value('#mTitle') === '番茄牛腩', '★ AI 的菜名填进输入框', `实际「${m.value('#mTitle')}」`);
    check(
      m.value('#mSteps') === '1. 牛腩冷水下锅焯水\n2. 小火炖 40 分钟',
      '★ AI 把做法也拆出来填进「做法」',
      JSON.stringify(m.value('#mSteps')),
    );
    check(m.value('#mAuthor') === '爱做饭的阿珍', 'AI 的作者填进去', `实际「${m.value('#mAuthor')}」`);
    check(m.value('#mNote') === '八角可放可不放', 'AI 的小贴士填进备注');
    check(m.value('#mUrl') === 'http://xhslink.com/a/ai-test', '链接仍以本地解析为准（AI 不改 URL）');
    check(m.value('#mSource') === 'red', '来源按域名判断，不受 AI 影响');

    /* AI 拆出来的做法落库后能在详情页看到 */
    await m.click('.actionbar .btn-primary');
    await m.wait(1000);
    const added = readDb().recipes[0];
    check(
      added?.title === '番茄牛腩' && added?.steps === '1. 牛腩冷水下锅焯水\n2. 小火炖 40 分钟',
      '★ AI 识别结果能一路存进仓库',
      JSON.stringify({ title: added?.title, steps: added?.steps }),
    );
    await m.close();
    ds.restore();
  }

  {
    /* Key 失效：把 DeepSeek 的原始原因告诉用户，同时回退到本地解析，别让识别整个失败 */
    const ds = stubFetch([
      {
        match: /api\.deepseek\.com\/chat\/completions/,
        method: 'POST',
        reply: () => jsonRes({ error: { message: 'Authentication Fails' } }, 401),
      },
    ]);
    const m = await mount('/add');
    await m.type('#shareInput', XHS_SHARE);
    await m.click('#recognizeBtn');
    await m.wait(300);
    check(
      m.value('#mTitle') === '西红柿炒鸡蛋',
      '★ AI 失败 → 回退到本地解析的标题',
      `实际「${m.value('#mTitle')}」`,
    );
    check(m.html().includes('API Key 无效'), '★ 把 Key 失效的原因告诉用户');
    await m.close();
    ds.restore();
  }

  {
    /* 关掉 AI：连 DeepSeek 都不该碰 */
    useDb((db) => {
      db.config!.aiKey = AI_KEY;
      db.config!.aiOn = false;
    });
    const ds = stubFetch([]);
    const m = await mount('/add');
    check(m.text('#recognizeBtn') === '识别', 'AI 关掉后按钮回到「识别」');
    await m.type('#shareInput', XHS_SHARE);
    await m.click('#recognizeBtn');
    await m.wait(200);
    check(ds.calls.length === 0, '★ 关掉 AI 后一个请求都不发（也不读原链接）', `实际 ${ds.calls.length} 次`);
    check(m.value('#mTitle') === '西红柿炒鸡蛋', '本地解析照常工作');
    await m.close();
    ds.restore();
  }

  console.log('\n[交互 · 上传菜谱截图 + AI 识图]');
  useDb((db) => {
    db.config!.aiKey = AI_KEY;
    db.config!.aiKeyMask = maskAiKey(AI_KEY);
    db.config!.aiOn = true;
  });
  {
    const ds = stubFetch([
      {
        match: /chat\/completions/,
        method: 'POST',
        reply: () =>
          jsonRes({
            choices: [
              { message: { content: '{"title":"红烧肉","author":"阿珍","steps":"1. 焯水后炒糖色","note":"小火慢炖"}' } },
            ],
          }),
      },
    ]);
    const m = await mount('/add');
    check(m.text('#recognizeBtn') === 'AI 识别', '还没选图时按钮是「AI 识别」');

    await pickPhoto(m, '#photoInput');
    await m.wait(200);
    check(m.text('#recognizeBtn') === 'AI 识图', '★ 选完截图按钮变成「AI 识图」');
    check(m.html().includes('换张截图'), '截图按钮变成「换张截图」');
    check(m.$('button[aria-label="移除截图"]') !== null, '★ 有「移除截图」的入口');

    /* 封面上的截图点一下能看大图：点 × / 点遮罩 / Esc 都能关，且不离开添加页 */
    check(m.$('[aria-label="查看大图"]') !== null, '★ 添加页封面上的截图也能点开看大图');
    await m.click('[aria-label="查看大图"]');
    check(m.$('.photoview') !== null, '点封面 → 打开大图');
    check(m.$('.pv-img')?.getAttribute('src') === SHOT_DATA_URL, '大图用的就是刚选的这张');
    await m.click('.pv-close');
    check(m.$('.photoview') === null && m.$('.s-add') !== null, '点 × 关掉大图，人还在添加页');
    await m.click('[aria-label="查看大图"]');
    await m.click('.pv-mask');
    check(m.$('.photoview') === null, '点遮罩也能关掉');

    const call = ds.calls.find((c) => c.method === 'POST' && c.url.includes('chat/completions'));
    const sent = JSON.stringify(call?.body ?? {});
    check(sent.includes(SHOT_DATA_URL), '★ 选完截图自动识图，整张图交给了 DeepSeek');
    check(m.value('#mTitle') === '红烧肉', '★ 识图结果把菜名填进表单', m.value('#mTitle'));
    check(m.value('#mSteps') === '1. 焯水后炒糖色', '做法也填进去了');
    check(m.value('#mSource') === 'manual', '★ 只给截图没给链接 → 来源记成「手动」', m.value('#mSource'));
    check(!sent.includes('r.jina.ai'), '没有链接就不去读页面');

    /* 存库：菜谱里记的是仓库图片路径，图的字节先落在本机缓存里等推送 */
    await m.click('.actionbar .btn-primary');
    await m.wait(1000);
    const added = readDb().recipes[0];
    check(/^images\/.+\.png$/.test(added.image), '★ 菜谱记住仓库图片路径', added.image);
    check(cachedPhoto(added.image) === SHOT_DATA_URL, '★ 图的字节先落在本机缓存（推送时上传仓库）');
    await m.close();
    ds.restore();
  }
  {
    /* 没配 Key：识图没有，但截图照样能连菜谱一起存下来 */
    useDb();
    const m = await mount('/add');
    check(m.text('#recognizeBtn') === '识别', '没配 Key 时按钮还是「识别」');
    await pickPhoto(m, '#photoInput');
    await m.wait(200);
    check(m.html().includes(SHOT_DATA_URL), '★ 截图预览立刻显示（不用等 AI）');
    check(m.html().includes('填 DeepSeek Key'), '★ 提示先配 Key 才能识图');
    await m.type('#mTitle', '手填的菜名');
    await m.click('.actionbar .btn-primary');
    await m.wait(1000);
    const added = readDb().recipes[0];
    check(added.title === '手填的菜名' && /^images\//.test(added.image), '★ 没 AI 也能把截图连同菜谱一起存');
    check(cachedPhoto(added.image) === SHOT_DATA_URL, '图也跟着菜谱留在本机');
    await m.close();
  }

  console.log('\n[交互 · 批量识图：一张截图一套编辑区，用户确认才入库]');
  useDb((db) => {
    db.config!.aiKey = AI_KEY;
    db.config!.aiKeyMask = maskAiKey(AI_KEY);
    db.config!.aiOn = true;
  });
  {
    const titles = ['红烧肉', '糖醋排骨', '清蒸鲈鱼'];
    /* 这一个假网络同时当 GitHub 和 DeepSeek：识图按顺序给三道菜的菜名 */
    const gh = installFakeGithub({ aiTitles: titles });

    const m = await mount('/add');
    await pickPhotos(m, '#photoInput', 3);
    await m.wait(900);

    check(gh.aiBodies.length === 3, '★ 三张图 = 三次识图请求', String(gh.aiBodies.length));
    const sentShots = gh.aiBodies.map((b) => /data:image\/png;base64,[^"]+/.exec(b)?.[0] ?? '');
    check(new Set(sentShots).size === 3 && sentShots.every(Boolean), '每次请求带的图各不相同，也没漏图');

    check(readDb().recipes.length === 6, '★ 识别完先不入库，等用户确认', String(readDb().recipes.length));
    check(m.$$('.batch-tag').length === 3, '★ 三张图 → 三套编辑区纵向排开', String(m.$$('.batch-tag').length));
    check(
      m.value('#b0Title') === '红烧肉' && m.value('#b1Title') === '糖醋排骨' && m.value('#b2Title') === '清蒸鲈鱼',
      '★ 识别结果按顺序预填进各自的编辑区',
      [m.value('#b0Title'), m.value('#b1Title'), m.value('#b2Title')].join(' / '),
    );
    check(m.value('#b1Steps') === '1. 焯水', '做法也各自填好');
    check(m.$('#mTitle') === null, '批量时不摆单条那张表单');
    check(m.$$('[aria-label^="查看第"]').length === 3, '每张图的封面都点得开看大图');

    /* 用户逐条看 / 改 */
    await m.type('#b1Title', '糖醋小排');
    await m.type('#b1Note', '第 2 张的备注');
    await m.clickByText('.actionbar .btn-primary', '保存 3 道菜');
    await m.wait(1000);
    await m.wait(1200);

    const db = readDb();
    check(db.recipes.length === 9, '★ 用户点「保存 3 道菜」才真的入库', String(db.recipes.length));
    const added = db.recipes.slice(0, 3);
    check(
      added.some((r) => r.title === '糖醋小排' && r.note === '第 2 张的备注'),
      '★ 用户改过的内容按改后的存',
      JSON.stringify(added.map((r) => r.title)),
    );
    check(
      new Set(added.map((r) => r.image)).size === 3 && added.every((r) => /^images\/r_.+\.png$/.test(r.image)),
      '★ 每条菜谱各带一张自己的图（一图一菜谱）',
      JSON.stringify(added.map((r) => r.image)),
    );
    const wantShots = [100, 101, 102].map(
      (b) => `data:image/png;base64,${Buffer.from([137, 80, 78, 71, b]).toString('base64')}`,
    );
    const gotShots = added.map((r) => cachedPhoto(r.image));
    check(wantShots.every((w) => gotShots.includes(w)), '★ 每张图的字节都落在本机缓存里（推送时上传）', JSON.stringify(gotShots));

    const imgPuts = gh.putBodies.filter((p) => p.path.includes('images/'));
    check(imgPuts.length === 3, '★ 三张图都传上了仓库', String(imgPuts.length));
    check(
      gh.putBodies.filter((p) => p.path.includes('recipes.json')).length === 1,
      '★ 三条一起入库只推一次菜谱库（防抖合并）',
    );
    check(m.$('.s-add') === null, '存完离开添加页');
    await m.close();
    gh.restore();
  }
  {
    /* 认不出菜名（或用户没填）：卡上提醒、保存时拦住，也可以把那张移除 */
    useDb((db) => {
      db.config!.aiKey = AI_KEY;
      db.config!.aiOn = true;
    });
    const gh = installFakeGithub({ aiTitles: ['红烧肉', ''] });
    const m = await mount('/add');
    await pickPhotos(m, '#photoInput', 2);
    await m.wait(900);
    check(m.html().includes('没认出菜名，自己填一个'), '★ 认不出菜名的那张在卡上提醒一句');
    await m.click('.actionbar .btn-primary');
    await m.wait(100);
    check(readDb().recipes.length === 6, '★ 缺菜名就拦住，一条都不落库', String(readDb().recipes.length));
    check(m.html().includes('第 2 张还缺菜名'), '告诉用户是哪一张');
    check(
      (m.$('#b1Title')?.parentElement?.className ?? '').includes('invalid'),
      '把那一条的「菜名」标红',
      m.$('#b1Title')?.parentElement?.className,
    );
    const removeBtns = m.$$('.batch-tag button');
    await m.clickEl(removeBtns[1]);
    check(m.$$('.batch-tag').length === 1, '★ 「移除这张」把不要的那张去掉');
    await m.click('.actionbar .btn-primary');
    await m.wait(1000);
    check(readDb().recipes.length === 7, '剩下那道正常入库');
    await m.close();
    gh.restore();
  }
  {
    /* 识别中可以「停止」：后面的图不再发请求，剩下的留白让用户自己填 */
    useDb((db) => {
      db.config!.aiKey = AI_KEY;
      db.config!.aiOn = true;
    });
    const gh = installFakeGithub({ aiTitles: ['第一道', '第二道', '第三道'], aiDelayMs: 200 });
    const m = await mount('/add');
    await pickPhotos(m, '#photoInput', 3);
    await m.wait(50);
    check(m.html().includes('识别中 0 / 3'), '★ 识别中显示进度', m.text('.actionbar .btn-primary'));
    await m.clickByText('.actionbar .btn-ghost', '停止');
    await m.wait(900);
    check(gh.aiBodies.length === 1, '★ 停止后不再往后发识图请求', String(gh.aiBodies.length));
    check(m.html().includes('已停止，自己填吧'), '剩下的在卡上说明「已停止」');
    check(readDb().recipes.length === 6, '停之前也没入库（等用户确认）');
    await m.close();
    gh.restore();
  }
  {
    /* 一次最多 9 张；「取消」把整批丢掉、回到普通表单 */
    useDb((db) => {
      db.config!.aiKey = AI_KEY;
      db.config!.aiOn = true;
    });
    const gh = installFakeGithub({ aiTitles: Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 道`) });
    const m = await mount('/add');
    await pickPhotos(m, '#photoInput', 12);
    await m.wait(900);
    check(m.$$('.batch-tag').length === 9, '★ 一次最多认 9 张', String(m.$$('.batch-tag').length));
    check(gh.aiBodies.length === 9, '也只发了 9 次请求', String(gh.aiBodies.length));
    check(m.html().includes('一次最多 9 张'), '告诉用户剩下的没认（分批再来）');
    await m.clickByText('.actionbar .btn-ghost', '取消');
    check(m.$('.batch-tag') === null && m.$('#mTitle') !== null, '★ 「取消」丢掉这批，回到普通表单');
    check(readDb().recipes.length === 6, '取消后一条都没入库');
    await m.close();
    gh.restore();
  }
  {
    /* 没配 Key：批量识图没有可用的眼睛，直接说清楚，别静默吞掉 */
    useDb();
    const ds = stubFetch([]);
    const m = await mount('/add');
    await pickPhotos(m, '#photoInput', 2);
    await m.wait(200);
    check(ds.calls.length === 0 && m.$('.batch-tag') === null, '★ 没配 Key 时不发请求、也不进批量流程', String(ds.calls.length));
    check(m.html().includes('批量识图要先'), '提示先去填 DeepSeek Key');
    check(readDb().recipes.length === 6, '没有半截数据落库');
    await m.close();
    ds.restore();
  }

  console.log('\n[交互 · 详情页看照片：缓存优先，没缓存才去仓库取]');
  localStorage.clear();
  {
    /* 另一台手机传的图：本机只有路径，没有字节 */
    const gh = installFakeGithub({
      images: { 'images/r1.png': SHOT_B64 },
    });
    useDb((db) => {
      db.recipes[0].image = 'images/r1.png';
    });
    const m = await mount('/library');
    check(m.html().includes('番茄炖牛腩'), '菜谱照常列出来');
    check(!gh.calls.some((c) => c.includes('images/')), '★ 列表不为了缩略图逐张拉图（省流量）');
    check(!m.html().includes(SHOT_DATA_URL), '没下载前缩略图先用本地插画');
    await m.close();

    const m2 = await mount('/recipe/r1');
    await m2.wait(300);
    check(
      gh.calls.some((c) => c.startsWith('GET') && c.includes('images/r1.png')),
      '★ 进详情页去仓库取这张照片',
    );
    check(m2.html().includes(SHOT_DATA_URL), '★ 详情页把照片显示出来');
    check(cachedPhoto('images/r1.png') === SHOT_DATA_URL, '★ 取回来顺手写进本机缓存（之后离线也能看）');

    /* 点一下看大图：整屏遮罩 + 原图，点遮罩 / × / Esc 都能关 */
    check(m2.$('[aria-label="查看大图"]') !== null, '★ 封面成了可点的按钮（右下角有放大标记）');
    await m2.click('[aria-label="查看大图"]');
    check(m2.$('.photoview') !== null, '★ 点封面 → 打开大图');
    check(m2.$('.pv-img')?.getAttribute('src') === SHOT_DATA_URL, '大图用的就是这张照片');
    await m2.click('.pv-close');
    check(m2.$('.photoview') === null && m2.$('.s-detail') !== null, '点 × 关掉大图，人还在详情页');

    await m2.click('[aria-label="查看大图"]');
    await m2.click('.pv-mask');
    check(m2.$('.photoview') === null, '点遮罩也能关掉');

    await m2.click('[aria-label="查看大图"]');
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    check(m2.$('.photoview') === null, 'Esc 也能关掉');
    await m2.close();

    /* 已经缓存过：再进列表就带上照片，且不再发请求 */
    const before = gh.calls.length;
    const m3 = await mount('/library');
    check(m3.html().includes(SHOT_DATA_URL), '★ 缓存过之后列表缩略图直接用照片');
    check(gh.calls.length === before, '不再重复拉图');
    await m3.close();
    gh.restore();
  }

  {
    /* 插画是示意图，不给点击：没传过照片的菜谱，封面不该是个按钮 */
    useDb();
    const m = await mount('/recipe/r5');
    await m.wait(400);
    check(m.$('[aria-label="查看大图"]') === null, '★ 只有「上传的照片」能点开看大图，插画封面不套按钮');
    await m.close();
  }

  console.log('\n[交互 · 详情页编辑：换图 / 移除照片]');
  localStorage.clear();
  {
    const gh = installFakeGithub({ images: { 'images/old.png': SHOT_B64 } });
    useDb((db) => {
      db.recipes[0].image = 'images/old.png';
    });
    const m = await mount('/recipe/r1');
    await m.wait(300);
    check(m.html().includes(SHOT_DATA_URL), '详情页先把仓库里的旧图显示出来');

    await m.click('#editRecipeBtn');
    check(m.html().includes('菜谱照片'), '编辑区有照片一栏');
    await pickPhoto(m, '#editPhoto', new Uint8Array([9, 8, 7]), 'new.png');
    await m.wait(200);
    check(m.html().includes('data:image/png;base64,CQgH'), '★ 刚选的图立刻在编辑框里预览');
    await m.click('.editrow .btn-sticker.primary');
    await m.wait(1500);

    const afterSwap = readDb().recipes.find((r) => r.id === 'r1')!;
    check(
      afterSwap.image !== 'images/old.png' && /^images\/r_.+\.png$/.test(afterSwap.image),
      '★ 换了图 → 菜谱改指新图片路径',
      afterSwap.image,
    );
    check(cachedPhoto(afterSwap.image) === 'data:image/png;base64,CQgH', '新图的字节也在本机缓存里');
    check(gh.deletes.includes('images/old.png'), '★ 旧图顺手从仓库删掉（换了图不留孤儿）', gh.deletes.join(' | '));

    /* 再把它整个移除 */
    await m.click('#editRecipeBtn');
    await m.click('#editPhotoRemove');
    await m.click('.editrow .btn-sticker.primary');
    await m.wait(1500);
    check(readDb().recipes.find((r) => r.id === 'r1')!.image === '', '★ 移除照片 → 路径清空（退回本地插画）');
    check(gh.deletes.includes(afterSwap.image), '★ 移除掉的那张图也从仓库删掉', gh.deletes.join(' | '));
    await m.close();
    gh.restore();
  }

  console.log('\n[交互 · 识别时读取原链接]');
  useDb((db) => {
    db.config!.aiKey = AI_KEY;
    db.config!.aiKeyMask = maskAiKey(AI_KEY);
    db.config!.aiOn = true;
  });
  {
    const ds = stubFetch([
      { match: /^https:\/\/r\.jina\.ai\//, reply: () => new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }) },
      {
        match: /chat\/completions/,
        method: 'POST',
        reply: () => jsonRes({ choices: [{ message: { content: '{"title":"番茄牛腩","author":"阿珍的厨房","steps":"1. 焯水"}' } }] }),
      },
    ]);

    const m = await mount('/add');
    check(!m.html().includes('会先打开原链接'), '★ 改动原理不再写成段落（读原链接是「识别」的内部行为，不打扰用户）');
    await m.type('#shareInput', AI_SHARE);
    await m.click('#recognizeBtn');
    await m.wait(500);

    const readerCall = ds.calls.find((c) => c.url.startsWith('https://r.jina.ai/'));
    check(readerCall !== undefined, '★ 真的经 r.jina.ai 去读了原链接');
    check(
      readerCall?.url === 'https://r.jina.ai/http://xhslink.com/a/ai-test',
      '读的就是文案里那个链接',
      readerCall?.url,
    );
    check(readerCall?.headers['x-respond-with'] === 'html', '要的是整页 HTML（作者名在里面）');

    const aiCall = ds.calls.find((c) => c.method === 'POST' && c.url.includes('chat/completions'));
    check(aiCall !== undefined, '读完链接照常走 AI');
    check(
      JSON.stringify(aiCall?.body).includes('阿珍的厨房'),
      '★ 页面线索（含作者）被带进了给 AI 的提示词',
    );
    check(m.value('#mAuthor') === '阿珍的厨房', '★ 作者填进输入框', `实际「${m.value('#mAuthor')}」`);
    await m.close();
    ds.restore();
  }
  {
    /* 抓不到页面（反爬 / 登录墙）：不报错，照着文案识别 */
    const ds = stubFetch([
      { match: /^https:\/\/r\.jina\.ai\//, reply: () => jsonRes({ message: 'blocked' }, 403) },
      {
        match: /chat\/completions/,
        method: 'POST',
        reply: () => jsonRes({ choices: [{ message: { content: '{"title":"番茄牛腩","author":"文案里的作者"}' } }] }),
      },
    ]);
    const m = await mount('/add');
    await m.type('#shareInput', AI_SHARE);
    await m.click('#recognizeBtn');
    await m.wait(500);
    check(ds.calls.some((c) => c.url.includes('chat/completions')), '★ 读链接失败也照样走 AI');
    check(m.value('#mAuthor') === '文案里的作者', '作者就用 AI 从文案里抽到的');
    check(m.value('#mTitle') === '番茄牛腩', '识别照常完成');
    await m.close();
    ds.restore();
  }
  {
    /* 文案里没有链接：没东西可读，就不该去碰 r.jina.ai */
    useDb((db) => {
      db.config!.aiKey = AI_KEY;
      db.config!.aiOn = true;
    });
    const ds = stubFetch([
      { match: /^https:\/\/r\.jina\.ai\//, reply: () => new Response(PAGE_HTML) },
      { match: /chat\/completions/, method: 'POST', reply: () => jsonRes({ choices: [{ message: { content: '{"title":"番茄牛腩"}' } }] }) },
    ]);
    const m = await mount('/add');
    await m.type('#shareInput', '番茄牛腩 做法看这里，先焯水再炖 40 分钟');
    await m.click('#recognizeBtn');
    await m.wait(400);
    check(!ds.calls.some((c) => c.url.includes('r.jina.ai')), '★ 文案里没有链接就不去读页面');
    check(ds.calls.some((c) => c.url.includes('chat/completions')), '照样走 AI');
    await m.close();
    ds.restore();
  }

  console.log('\n[交互 · 只贴一条搜索链接]');
  useDb();
  {
    const m = await mount('/add');
    await m.type('#shareInput', BILI_SEARCH);
    await m.click('#recognizeBtn');
    await m.wait(100);
    check(m.value('#mTitle') === '村驴', '★ 搜索链接 → 用搜索词当菜名', `实际「${m.value('#mTitle')}」`);
    check(m.value('#mSource') === 'bili', '来源认成 B站', m.value('#mSource'));
    check(!(m.$('.actionbar .btn-primary') as HTMLButtonElement).disabled, '有标题了，保存键可用');
    await m.close();
  }
  useDb((db) => {
    db.config!.aiKey = AI_KEY;
    db.config!.aiKeyMask = maskAiKey(AI_KEY);
    db.config!.aiOn = true;
  });
  {
    const ds = stubFetch([
      { match: /^https:\/\/r\.jina\.ai\//, reply: () => new Response('<html><head><title>村驴-哔哩哔哩_bilibili</title></head><body>村驴</body></html>') },
      {
        match: /chat\/completions/,
        method: 'POST',
        reply: () =>
          jsonRes({
            choices: [{ message: { content: '{"title":"酸甜爽脆的腌萝卜保姆级教程来了‼️","author":"村驴"}' } }],
          }),
      },
    ]);
    const m = await mount('/add');
    await m.type('#shareInput', BILI_SEARCH);
    await m.click('#recognizeBtn');
    await m.wait(500);
    const aiCall = ds.calls.find((c) => c.method === 'POST' && c.url.includes('chat/completions'));
    check(aiCall !== undefined, '搜索链接照样走 AI');
    check(JSON.stringify(aiCall?.body).includes('页面线索'), '把页面线索交给了 AI');
    check(
      m.value('#mTitle') === '酸甜爽脆的腌萝卜',
      '★ 模型给的是整句视频标题（带「保姆级教程来了」）→ 最终只留菜品名',
      `实际「${m.value('#mTitle')}」`,
    );
    await m.close();
    ds.restore();
  }
  {
    /* 模型抽不出菜名（返回空）→ 兜底的搜索词顶上 */
    const ds = stubFetch([
      { match: /^https:\/\/r\.jina\.ai\//, reply: () => new Response('<html><head><title>村驴</title></head><body>村驴</body></html>') },
      {
        match: /chat\/completions/,
        method: 'POST',
        reply: () => jsonRes({ choices: [{ message: { content: '{"title":"","author":"村驴"}' } }] }),
      },
    ]);
    const m = await mount('/add');
    await m.type('#shareInput', BILI_SEARCH);
    await m.click('#recognizeBtn');
    await m.wait(500);
    check(m.value('#mTitle') === '村驴', '★ AI 抽不出菜名时，用搜索引擎词兜底', `实际「${m.value('#mTitle')}」`);
    await m.close();
    ds.restore();
  }

  console.log('\n[交互 · 搜索与筛选]');
  useDb();
  {
    const m = await mount('/library');
    await m.type('.searchbar input', '椰');
    if (!m.html().includes('找到 2 道')) fail('搜索计数', '没有「找到 2 道」');
    else ok('搜索「椰」→ 命中 2 道并显示计数');
    if (m.html().includes('番茄炖牛腩')) fail('搜索结果过滤', '不该出现番茄炖牛腩');
    else ok('搜索结果已过滤掉不匹配的菜');

    await m.type('.searchbar input', 'zzz');
    if (!m.html().includes('没找到')) fail('无结果空态', '没有出现空态');
    else ok('搜不到 → 给出无结果空态');
    await m.close();
  }

  {
    const m = await mount('/library');
    await m.click('.chips .chip:nth-child(2)'); // 小红书
    const rows = m.$$('.dishrow').length;
    if (rows !== 3) fail('按平台筛选', `小红书应为 3 道，实际 ${rows}`);
    else ok('按小红书筛选 → 只剩 3 道');
    await m.close();
  }

  console.log('\n[交互 · 点单次数与菜谱库排序]');
  localStorage.clear();
  {
    /* 下单：单里每道菜的点单次数 +1，没点的不动 */
    useDb();
    const before = readDb().recipes.map((r) => [r.id, r.orderCount] as const);
    const beforeOf = (id: string) => before.find(([rid]) => rid === id)![1];
    const m = await mount('/order');
    await m.click('.dishgrid .pick:nth-child(1)'); // 番茄炖牛腩
    await m.click('.dishgrid .pick:nth-child(3)'); // 椰子鸡火锅
    await m.click('.sendbtn');
    await m.wait(900);
    const countOf = (id: string) => readDb().recipes.find((r) => r.id === id)!.orderCount;
    check(countOf('r1') === beforeOf('r1') + 1, '★ 下单后点过的菜 +1', `${beforeOf('r1')} → ${countOf('r1')}`);
    check(countOf('r3') === beforeOf('r3') + 1, '★ 同一单里的第二道菜也 +1', `${beforeOf('r3')} → ${countOf('r3')}`);
    check(countOf('r2') === beforeOf('r2'), '没点过的菜次数不变');
    await m.close();
  }
  {
    /* 删掉一张单：这张单给菜谱记的次数退回去 */
    useDb();
    const before = readDb().recipes.find((r) => r.id === 'r1')!.orderCount;
    const m = await mount('/order');
    await m.longPress('.osum'); /* 今天那张单里有 r1 */
    await m.click('.tip-del');
    const after = readDb().recipes.find((r) => r.id === 'r1')!.orderCount;
    check(after === before - 1, '★ 删掉那张单，点单次数退回', `${before} → ${after}`);
    check(after >= 0, '次数不会掉到负数', String(after));
    await m.close();
  }
  {
    /* 排序：点单次数 / 更新时间，各支持升序与降序 */
    useDb((db) => {
      const set = (id: string, orderCount: number, updatedAt: string) => {
        const r = db.recipes.find((x) => x.id === id)!;
        r.orderCount = orderCount;
        r.updatedAt = updatedAt;
      };
      set('r1', 3, '2026-01-01 09:00');
      set('r2', 1, '2026-03-01 09:00');
      set('r3', 5, '2026-02-01 09:00');
      set('r4', 2, '2026-05-01 09:00');
      set('r5', 0, '2026-04-01 09:00');
      set('r6', 4, '2026-01-15 09:00');
    });
    const m = await mount('/library');
    const titles = () => m.$$('.dishrow .title').map((e) => (e.textContent ?? '').trim());
    const rowOf = (t: string) => m.$$('.dishrow').find((r) => (r.textContent ?? '').includes(t))!;

    check(m.$('.sortbar') !== null, '★ 菜谱库有排序条');
    check(rowOf('番茄炖牛腩').querySelector('.cnt')?.textContent?.trim() === '点过 3 次', '★ 列表里显示点单次数');
    check(titles()[0] === '番茄炖牛腩', '默认保持收藏先后', titles().join(' / '));

    const dirLabel = () => (m.$('.sortbar .dir')?.textContent ?? '').trim();
    await m.clickByText('.sortbar .schip', '点单次数');
    check(
      titles().join(' / ') === '椰子鸡火锅 / 芒果糯米饭 / 番茄炖牛腩 / 巴斯克芝士蛋糕 / 溏心蛋葱油拌面 / 台式三杯鸡',
      '★ 点单次数降序',
      titles().join(' / '),
    );
    check(dirLabel() === '降序', '方向按钮显示当前是降序', dirLabel());
    await m.click('.sortbar .dir'); /* 切到升序 */
    check(dirLabel() === '升序', '点方向按钮 → 变升序', dirLabel());
    check(titles()[0] === '台式三杯鸡' && titles()[5] === '椰子鸡火锅', '★ 点单次数升序', titles().join(' / '));

    await m.clickByText('.sortbar .schip', '更新时间');
    check(titles()[0] === '番茄炖牛腩' && titles()[5] === '巴斯克芝士蛋糕', '★ 更新时间升序', titles().join(' / '));
    await m.click('.sortbar .dir');
    check(titles()[0] === '巴斯克芝士蛋糕' && titles()[5] === '番茄炖牛腩', '★ 更新时间降序', titles().join(' / '));
    await m.close();
  }

  console.log('\n[交互 · token 形状校验]');
  localStorage.clear();
  {
    const GOOD = 'ghp_012345678901234567890123456789012345'; // 40 位占位串，切勿填真实 token
    const m = await mount('/setup');

    /* 手机键盘「首字母自动大写」的典型后果 */
    await m.type('#fToken', 'Ghp_' + GOOD.slice(4));
    await m.blur('#fToken');
    if (!m.html().includes('首字母自动大写')) fail('自动大写检测', '没给出针对性提示');
    else ok('Ghp_ 开头 → 提示可能是键盘首字母自动大写');

    /* 粘贴时被换行/空格截断 */
    await m.type('#fToken', 'ghp_0123456789 01234567890123456789012345');
    if (m.value('#fToken') !== GOOD) fail('空白剔除', `输入框里是 ${m.value('#fToken')}`);
    else ok('粘贴混入的空格被即时剔除');

    /* 位数不足 */
    await m.type('#fToken', 'ghp_short');
    await m.blur('#fToken');
    if (!m.html().includes('经典 token 是 40 位')) fail('位数校验', '没提示位数不对');
    else ok('位数不足 → 提示经典 token 应为 40 位');

    /* 合法 token 不该报错 */
    await m.type('#fToken', GOOD);
    await m.blur('#fToken');
    if (m.html().includes('首字母自动大写') || m.html().includes('经典 token 是 40 位')) {
      fail('合法 token', '不该报错');
    } else {
      ok('合法的 40 位 token → 无报错');
    }

    /* 输入框必须关掉手机键盘的自动大写/自动更正 */
    const input = m.$('#fToken');
    if (input?.getAttribute('autocapitalize') !== 'none' || input?.getAttribute('autocorrect') !== 'off') {
      fail('输入框属性', `autocapitalize=${input?.getAttribute('autocapitalize')} autocorrect=${input?.getAttribute('autocorrect')}`);
    } else {
      ok('token 输入框已关闭自动大写与自动更正');
    }

    await m.close();
  }

  console.log('\n[交互 · 称呼跟着人走]');
  useDb(); // profiles: a=小辉, b=小红；本机 me=a
  {
    const m = await mount('/order');
    await m.click('.pick');
    check(m.html().includes('发给小红 · 午餐 · 1 道'), '我点单 → 叫对方「小红」');
    await m.close();
  }
  {
    /* 把本机换成另一半，称呼立刻对调 —— 不再靠「角色」决定 */
    useDb((db) => {
      db.config!.me = 'b';
    });
    const m = await mount('/order');
    await m.click('.pick');
    check(m.html().includes('发给小辉 · 午餐 · 1 道'), '★ 换成另一半 → 对方变成「小辉」');
    await m.close();
  }
  {
    useDb(); // me=a：我掌勺，做的是小红点的单
    const m = await mount('/cook');
    let html = m.html();
    check(html.includes('小辉 · 掌勺'), '掌勺问候语用「小辉」');
    check(html.includes('小红点给你的几道菜'), '掌勺副标题用对方「小红」');
    /* 已完成单默认折叠：先展开，才能看到完成标记里的称呼 */
    await m.clickByText('.morebar', '已做完');
    html = m.html();
    check(html.includes('做完啦，小红已收到'), '已完成标记也用对方的昵称');
    await m.close();
  }

  console.log('\n[交互 · 没设昵称时的兜底]');
  useDb((db) => {
    db.profiles = { a: { nickname: '', updatedAt: '—' }, b: { nickname: '', updatedAt: '—' } };
  });
  {
    const m = await mount('/order');
    await m.click('.pick');
    check(m.html().includes('发给对方 · 午餐 · 1 道'), '对方没名字 → 退回「对方」，不显示空白');
    await m.close();
  }
  {
    const m = await mount('/cook');
    const html = m.html();
    check(html.includes('我来掌勺'), '自己没名字 → 问候语退回「我来掌勺」');
    check(!html.includes('对方点给你的几道菜'), '对方没名字 → 副标题用中性措辞');
    await m.close();
  }

  console.log('\n[交互 · 在同步页改昵称]');
  useDb();
  {
    const m = await mount('/sync');
    check(m.html().includes('小辉') && m.html().includes('小红'), '同步页列出两个昵称');

    await m.click('#editNamesBtn');
    await m.type('#nickPartner', '大厨老王');
    await m.click('#saveNamesBtn');
    await m.wait(200);

    check(readDb().profiles.b.nickname === '大厨老王', '改名落库');
    check(readDb().profiles.a.nickname === '小辉', '没动的那一栏保持不变');
    check(
      DATE_TIME_RE.test(readDb().profiles.b.updatedAt),
      '★ 昵称更新时间带年月日',
      readDb().profiles.b.updatedAt,
    );
    check(readDb().logs.some((l) => l.text.includes('昵称已更新并推送')), '改名写入同步日志（会触发推送）');
    await m.close();
  }
  {
    /* 改完名字，别的屏立刻用新名字 */
    const m = await mount('/order');
    await m.click('.pick');
    check(m.html().includes('发给大厨老王 · 午餐 · 1 道'), '★ 改完名字，点单页立刻用新称呼');
    await m.close();
  }

  console.log('\n[交互 · 清空昵称回到兜底]');
  useDb();
  {
    const m = await mount('/sync');
    await m.click('#editNamesBtn');
    await m.type('#nickPartner', '');
    await m.click('#saveNamesBtn');
    await m.wait(200);
    check(readDb().profiles.b.nickname === '', '清空后落库为空串');
    await m.close();
  }
  {
    const m = await mount('/order');
    await m.click('.pick');
    check(m.html().includes('发给对方'), '清空后界面退回「对方」');
    await m.close();
  }

  console.log('\n[交互 · 输入框以 DOM 为准（中文输入法 / 键盘延迟提交）]');
  /* Android WebView 的输入法提交候选词时可能只发 compositionend、不补 input：
     受控 value 拿不到新字，失焦时 React 还会把输入框回写成旧值（用户看到的「一失焦就没了」）。
     全应用所有文本输入框都要扛住这一下，中文输入框是重灾区。 */
  localStorage.clear();
  {
    const m = await mount('/setup');
    await m.ime('#fNickname', '小辉');
    check(m.value('#fNickname') === '小辉', 'IME 提交后输入框里有字');

    await m.blur('#fNickname');
    check(m.value('#fNickname') === '小辉', '★ 失焦后昵称没有被回写成空');
    const nickField = m.$('#fNickname')?.closest('.field') as HTMLElement | null;
    check(!nickField?.className.includes('invalid'), '失焦校验按输入框里的真实内容判定，不误报「昵称要填 1–12 个字」');

    /* 走到落库才算真的没丢：修之前这一步会被「先填一个昵称」拦下 */
    await m.clickByText('.btn-ghost', '稍后再说（本地模式）');
    await m.wait(250);
    check(readDb().profiles.a.nickname === '小辉', '★ IME 填的昵称能落库（本地模式进入成功）');
    await m.close();
  }
  {
    const m = await mount('/setup');
    await m.ime('#fPartnerNickname', '小红');
    await m.blur('#fPartnerNickname');
    check(m.value('#fPartnerNickname') === '小红', '★ 另一半的昵称同样不丢字');
    await m.close();
  }
  {
    const GOOD = 'ghp_012345678901234567890123456789012345';
    const m = await mount('/setup');

    await m.ime('#fRepo', 'owner/repo');
    await m.blur('#fRepo');
    check(m.value('#fRepo') === 'owner/repo', '仓库输入框不丢字');

    await m.ime('#fToken', GOOD);
    await m.blur('#fToken');
    check(m.value('#fToken') === GOOD, '★ token 输入框不丢字（归一化后仍然对）', `实际「${m.value('#fToken')}」`);
    check(!m.html().includes('经典 token 是 40 位'), '失焦校验不会拿旧值误报格式错');

    /* 配置 JSON 是粘贴进来的 —— 粘完直接点「导入并填充」，中间那一下 input 也可能缺 */
    await m.ime('#importJson', JSON.stringify({ nickname: '小辉', partnerNickname: '小红', token: GOOD, repo: 'owner/repo', branch: 'dev', intervalSec: 600 }));
    await m.clickByText('details.adv .btn-sticker.solid', '导入并填充');
    check(m.value('#fBranch') === 'dev', '★ 导入配置：粘贴的 JSON 没丢（分支被填上了）');
    await m.close();
  }
  useDb();
  {
    const m = await mount('/sync');
    await m.click('#editNamesBtn');
    await m.ime('#nickMe', '小辉辉');
    await m.blur('#nickMe');
    check(m.value('#nickMe') === '小辉辉', '★ 同步页：IME 提交后不丢字');
    await m.click('#saveNamesBtn');
    await m.wait(200);
    check(readDb().profiles.a.nickname === '小辉辉', '★ 同步页：IME 改的昵称保存并落库');
    await m.close();
  }
  {
    const GOOD = 'ghp_012345678901234567890123456789012345';
    const m = await mount('/sync');
    await m.click('#editTokenBtn');
    await m.ime('#tokenInput', GOOD);
    await m.blur('#tokenInput');
    check(m.value('#tokenInput') === GOOD, '同步页 token 输入框不丢字');
    await m.click('#saveTokenBtn');
    await m.wait(100);
    check(readDb().config?.token === GOOD, '★ 同步页换 token 真的读到了输入内容');
    await m.close();
  }
  {
    const m = await mount('/library');
    await m.ime('.searchbar input', '椰');
    await m.blur('.searchbar input');
    check(m.value('.searchbar input') === '椰', '菜谱库搜索框不丢字');
    check(m.html().includes('找到 2 道'), '★ 搜索条件真的生效（不是只显示在框里）');
    await m.close();
  }
  {
    const m = await mount('/order');
    await m.ime('.manualrow input', '红烧排骨');
    await m.blur('.manualrow input');
    check(m.value('.manualrow input') === '红烧排骨', '点单手动加菜输入框不丢字');
    await m.ime('.ordernote', '少放辣');
    await m.blur('.ordernote');
    check(m.value('.ordernote') === '少放辣', '★ 点单备注框同样不丢字');
    await m.clickByText('.manualrow button', '加进这顿');
    check(m.html().includes('红烧排骨'), '★ 手动加的菜真的进了这顿');
    await m.close();
  }
  {
    const m = await mount('/order');
    await m.ime('.picksearch input', '椰');
    await m.blur('.picksearch input');
    check(m.value('.picksearch input') === '椰', '★ 点单挑选网格的搜索框不丢字');
    check(m.$$('.dishgrid .pick').length === 2, '★ 挑选搜索真的过滤了网格（不是只显示在框里）', `实际 ${m.$$('.dishgrid .pick').length}`);
    await m.close();
  }
  {
    const m = await mount('/add');
    await m.ime('#shareInput', BILI_SHARE);
    await m.click('#recognizeBtn');
    await m.wait(100);
    check(
      m.value('#mTitle') === '电饭煲卤鸡腿',
      '★ 添加菜谱：粘贴的分享文案没丢（识别出标题）',
      `实际「${m.value('#mTitle')}」`,
    );

    await m.ime('#mTitle', '可乐鸡翅');
    await m.ime('#mSteps', '1. 焯水\n2. 煎到两面金黄\n3. 加可乐焖 20 分钟');
    await m.ime('#mNote', '收汁时开盖');
    await m.blur('#mNote');
    check(
      m.value('#mTitle') === '可乐鸡翅' && m.value('#mNote') === '收汁时开盖' && m.value('#mSteps').includes('焖 20 分钟'),
      '标题 / 做法 / 备注输入框不丢字',
    );

    await m.click('.actionbar .btn-primary');
    await m.wait(1000);
    const added = readDb().recipes[0];
    check(
      added?.title === '可乐鸡翅' && added?.note === '收汁时开盖' && added?.steps === '1. 焯水\n2. 煎到两面金黄\n3. 加可乐焖 20 分钟',
      '★ 靠输入法填进去的标题、做法与备注真的存进库',
      JSON.stringify(added),
    );
    await m.close();
  }
  useDb();
  {
    const m = await mount('/recipe/r5');
    await m.click('#editRecipeBtn');
    await m.ime('#editNote', '九层塔最后放，关火再拌');
    await m.blur('#editNote');
    await m.click('.editrow .btn-sticker.primary');
    await m.wait(200);
    check(
      readDb().recipes.find((r) => r.id === 'r5')?.note === '九层塔最后放，关火再拌',
      '★ 详情页备注：输入法填的内容真的落库',
    );
    await m.close();
  }
}

/* ═══════════ 三、分享文案解析 ═══════════ */

function parseChecks() {
  console.log('\n[分享文案解析]');

  const cases: Array<{ name: string; text: string; want: Partial<ReturnType<typeof parseShare>> }> = [
    {
      name: '小红书（标题在链接前）',
      text: '西红柿炒鸡蛋，你就像我这样做，真的很下饭！ http://xhslink.com/a/tomato-egg 复制本条信息，打开【小红书】App查看精彩内容！',
      want: { source: 'red', url: 'http://xhslink.com/a/tomato-egg', title: '西红柿炒鸡蛋' },
    },
    {
      name: '小红书（你给的短链 + 带话题和表情）',
      text: '蒜香黄油虾仁🦐 新手也不会翻车 #家常菜# #快手菜# https://xhslink.cn/o/7cNiFbAw2if 复制本条信息，打开【小红书】App查看精彩内容！',
      want: { source: 'red', url: 'https://xhslink.cn/o/7cNiFbAw2if', title: '蒜香黄油虾仁' },
    },
    {
      name: '抖音（顺手拆出作者）',
      text: '7.43 复制打开抖音，看看【糖水小铺的作品】椰香芒果西米露 https://v.douyin.com/abc123/',
      want: { source: 'douyin', url: 'https://v.douyin.com/abc123/', title: '椰香芒果西米露', author: '糖水小铺' },
    },
    {
      name: 'B站（标题裹在【】里）',
      text: '【电饭煲卤鸡腿，脱骨那种】 https://b23.tv/xyz789',
      want: { source: 'bili', url: 'https://b23.tv/xyz789', title: '电饭煲卤鸡腿' },
    },
    {
      name: '只贴一个链接 → 不编造标题',
      text: 'https://xhslink.cn/o/7cNiFbAw2if',
      want: { source: 'red', url: 'https://xhslink.cn/o/7cNiFbAw2if', title: '' },
    },
    {
      name: '不认识的站点',
      text: '奶奶的梅干菜扣肉做法 https://example.com/recipe/42',
      want: { source: 'generic', url: 'https://example.com/recipe/42', title: '奶奶的梅干菜扣肉' },
    },
    {
      name: '只贴一条 B站搜索链接 → 用搜索词当标题',
      text: 'https://search.bilibili.com/all?vt=04531052&keyword=%E6%9D%91%E9%A9%B4&from_source=web_search',
      want: { source: 'bili', title: '村驴', fromSearch: true },
    },
    {
      name: '只贴一条百度搜索链接 → 用 wd 当标题',
      text: 'https://www.baidu.com/s?wd=%E7%95%AA%E8%8C%84%E7%89%9B%E8%85%A9',
      want: { source: 'generic', title: '番茄牛腩', fromSearch: true },
    },
    {
      name: '搜索链接后面还带文案 → 用文案的标题，不是搜索词',
      text: '村驴的腌萝卜 https://search.bilibili.com/all?keyword=%E8%85%8C%E8%90%9D%E5%8D%9C',
      want: { title: '村驴的腌萝卜', fromSearch: false },
    },
  ];

  for (const c of cases) {
    const got = parseShare(c.text);
    const bad = Object.entries(c.want).filter(([k, v]) => got[k as keyof typeof got] !== v);
    if (bad.length) {
      fail(
        `解析 · ${c.name}`,
        bad.map(([k, v]) => `${k} 期望「${v}」实际「${got[k as keyof typeof got]}」`).join('；'),
      );
    } else {
      ok(`解析 · ${c.name}`);
    }
  }

  console.log('\n[链接提取与来源识别]');
  check(extractUrl('没有链接的纯文字') === '', '没有链接 → 空串');
  check(extractUrl('看这个 https://a.com/1 和 https://b.com/2') === 'https://a.com/1', '多个链接只取第一个');
  check(detectSource('https://www.xiaohongshu.com/explore/1') === 'red', 'xiaohongshu.com → 小红书');
  check(detectSource('https://b23.tv/xyz') === 'bili', 'b23.tv → B站');
  check(detectSource('https://v.douyin.com/abc/') === 'douyin', 'douyin → 抖音');
  check(detectSource('https://example.com/recipe') === 'generic', '其它站点 → 网页');
  check(detectSource('这不是一个链接') === null, '不是链接 → null');

  console.log('\n[链接里的搜索词]');
  check(
    searchKeyword('https://search.bilibili.com/all?vt=1&keyword=%E6%9D%91%E9%A9%B4&from_source=x') === '村驴',
    'B站 keyword 解出中文搜索词',
  );
  check(searchKeyword('https://www.youtube.com/results?search_query=ramen') === 'ramen', 'YouTube search_query');
  check(searchKeyword('https://www.baidu.com/s?wd=%E7%95%AA%E8%8C%84') === '番茄', '百度 wd');
  check(searchKeyword('https://www.bilibili.com/video/BV1xx') === '', '普通链接没有搜索词');
  check(searchKeyword('不是链接') === '', '不是链接 → 空串');
  check(toDishName('村驴，真的会做菜') === '村驴', 'toDishName 只留菜名');
  check(
    toDishName('酸甜爽脆的腌萝卜保姆级教程来了‼️') === '酸甜爽脆的腌萝卜',
    '★ toDishName 剥掉「保姆级教程来了」这类营销尾巴',
    toDishName('酸甜爽脆的腌萝卜保姆级教程来了‼️'),
  );
  check(toDishName('【牛肉辣椒酱 保姆级教程来了！】') === '牛肉辣椒酱', 'B站【】+ 空格说明也一起收掉');
  check(toDishName('蒜香黄油虾仁') === '蒜香黄油虾仁', '本来就干净的菜名不动它');
  check(toDishName('台式三杯鸡') === '台式三杯鸡', '带「台式」前缀的菜名不会被误剥');

  /* 封面猜测只是示意，别猜错得太离谱就行 */
  const art = [
    ['番茄炖牛腩', 'tomato-beef.svg'],
    ['蒜香黄油虾仁', 'garlic-shrimp.svg'],
    ['椰香芒果西米露', 'mango-sago.svg'],
    ['卤鸡腿', 'braised-leg.svg'],
    ['椰子鸡火锅', 'coconut-chicken.svg'],
    ['台式三杯鸡', 'three-cup-chicken.svg'],
    ['巴斯克芝士蛋糕', 'basque-cake.svg'],
    ['葱油拌面', 'scallion-noodle.svg'],
    ['芒果糯米饭', 'mango-sticky-rice.svg'],
    ['一个没有关键词的怪名字', ''],
  ] as const;
  for (const [title, want] of art) {
    check(guessArt(title) === want, `封面猜测 · ${title} → ${want || '无（用首字占位）'}`, `实际 ${guessArt(title) || '无'}`);
  }
}

/* ═══════════ github.ts 读写层 ═══════════ */

async function githubChecks() {
  const FULL = 'ghp_012345678901234567890123456789012345';

  console.log('\n[github · token 工具]');
  check(maskToken(FULL) === 'ghp_••••••••2345', 'maskToken 保留前缀与后四位', `实际「${maskToken(FULL)}」`);
  check(maskToken('short') === '••••', 'token 太短时整体打码', `实际「${maskToken('short')}」`);
  check(normalizeToken(' ghp_ab c\ndef ') === 'ghp_abcdef', 'normalizeToken 去掉所有空白');
  check(tokenShapeError(FULL) === null, '规范 40 位 token 通过校验');
  check(tokenShapeError('github_pat_11ABCDEFG') === null, 'fine-grained token 通过校验');
  check((tokenShapeError('') ?? '').includes('请填写'), '空 token 报错');
  check((tokenShapeError('Ghp_' + FULL.slice(4)) ?? '').includes('首字母自动大写'), '大写 G 提示手机键盘自动大写');
  check((tokenShapeError('ghp_short') ?? '').includes('40 位'), '位数不足提示经典 token 40 位');
  check((tokenShapeError('ghp_中文') ?? '').includes('不可见字符'), '混入非 ASCII 提示重新复制');

  console.log('\n[github · withTimeout]');
  {
    const t = withTimeout(20);
    const early = t.signal.aborted;
    await settle(40); /* withTimeout 走的是裸 setTimeout，同样受虚拟时钟管辖 */
    check(!early && t.signal.aborted, '超时后 signal 被 abort');
    t.done();
    const t2 = withTimeout(1000);
    t2.done();
    await settle(5);
    check(!t2.signal.aborted, 'done() 之后不再 abort');
  }

  console.log('\n[github · getJson]');
  {
    const gh = stubFetch([
      { match: /\/contents\/recipes\.json/, reply: () => jsonRes({ sha: 'sha-1', content: utf8b64(JSON.stringify({ name: '番茄炖牛腩' })) }) },
    ]);
    const file = await getJson<{ name: string }>('owner/repo', 'recipes.json', 'main', 'tok');
    check(file?.data.name === '番茄炖牛腩' && file?.sha === 'sha-1', '中文 JSON 经 base64 正确往返');
    const call = gh.calls[0];
    check(call.url.includes('/repos/owner/repo/contents/recipes.json?ref=main'), '拼接 ref 查询参数', call.url);
    check(call.headers.Authorization === 'Bearer tok', '带 Bearer 授权头');
    check(call.headers.Accept === 'application/vnd.github+json', '带 Accept 头');
    check(call.headers['X-GitHub-Api-Version'] === '2022-11-28', '带 API 版本头');
    gh.restore();
  }
  {
    const gh = stubFetch([{ match: /.*/, reply: () => jsonRes({ message: 'Not Found' }, 404) }]);
    const file = await getJson('owner/repo', 'recipes.json', 'main', 'tok');
    check(file === null, '404 → 返回 null（文件不存在）');
    gh.restore();
  }
  {
    const gh = stubFetch([{ match: /.*/, reply: () => jsonRes({ message: 'Bad credentials' }, 401) }]);
    const e = await githubErrOf(() => getJson('owner/repo', 'recipes.json', 'main', 'tok'));
    check(e?.kind === 'auth' && e.status === 401, '401 → auth', JSON.stringify(e));
    gh.restore();
  }
  {
    const gh = stubFetch([{ match: /.*/, reply: () => jsonRes({ message: 'rate limited' }, 403, { 'x-ratelimit-remaining': '0' }) }]);
    const e = await githubErrOf(() => getJson('owner/repo', 'recipes.json', 'main', 'tok'));
    check(e?.kind === 'forbidden' && e.message.includes('次数'), '403 限流 → forbidden（限流文案）', e?.message);
    gh.restore();
  }
  {
    const gh = stubFetch([{ match: /.*/, reply: () => jsonRes({ message: 'Forbidden' }, 403) }]);
    const e = await githubErrOf(() => getJson('owner/repo', 'recipes.json', 'main', 'tok'));
    check(e?.kind === 'forbidden' && e.message.includes('权限'), '403 → forbidden（权限文案）', e?.message);
    gh.restore();
  }
  for (const status of [409, 422]) {
    const gh = stubFetch([{ match: /.*/, reply: () => jsonRes({ message: 'Conflict' }, status) }]);
    const e = await githubErrOf(() => getJson('owner/repo', 'recipes.json', 'main', 'tok'));
    check(e?.kind === 'conflict', `${status} → conflict`, JSON.stringify(e));
    gh.restore();
  }
  {
    const gh = stubFetch([{ match: /.*/, reply: () => jsonRes({ message: 'boom' }, 500) }]);
    const e = await githubErrOf(() => getJson('owner/repo', 'recipes.json', 'main', 'tok'));
    check(e?.kind === 'unknown' && e.message === 'boom', '500 → unknown，带上服务端 message', e?.message);
    gh.restore();
  }
  {
    const gh = stubFetch([{ match: /.*/, reply: () => jsonRes({ sha: 'sha-only' }) }]);
    const e = await githubErrOf(() => getJson('owner/repo', 'recipes.json', 'main', 'tok'));
    check(e?.kind === 'unknown' && e.message.includes('太大'), '没有 content 字段 → 提示文件太大');
    gh.restore();
  }
  {
    const gh = stubFetch([{ match: /.*/, reply: () => jsonRes({ sha: 'x', content: utf8b64('not json{') }) }]);
    const e = await githubErrOf(() => getJson('owner/repo', 'recipes.json', 'main', 'tok'));
    check(e?.kind === 'unknown' && e.message.includes('不是合法的 JSON'), '内容非法 JSON → 明确报错', e?.message);
    gh.restore();
  }
  {
    const gh = stubFetch([{ match: /.*/, reply: () => { throw new TypeError('network down'); } }]);
    const e = await githubErrOf(() => getJson('owner/repo', 'recipes.json', 'main', 'tok'));
    check(e?.kind === 'network' && e.message.includes('连不上'), 'fetch 抛错 → network', e?.message);
    gh.restore();
  }
  {
    const gh = stubFetch([
      {
        match: /.*/,
        reply: () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
      },
    ]);
    const e = await githubErrOf(() => getJson('owner/repo', 'recipes.json', 'main', 'tok'));
    check(e?.kind === 'network' && e.message.includes('超时'), 'AbortError → network（超时文案）', e?.message);
    gh.restore();
  }

  console.log('\n[github · images 目录清单]');
  {
    const ds = stubFetch([
      {
        match: /\/git\/trees\//,
        reply: () =>
          jsonRes({
            sha: 'tree',
            tree: [
              { path: 'recipes.json', mode: '100644', type: 'blob', sha: 'sha-r' },
              { path: 'images', mode: '040000', type: 'tree', sha: 'sha-dir' },
              { path: 'images/r1.png', mode: '100644', type: 'blob', sha: 'sha-1' },
              { path: 'images/r2.jpg', mode: '100644', type: 'blob', sha: 'sha-2' },
              { path: 'other/r3.png', mode: '100644', type: 'blob', sha: 'sha-3' },
            ],
            truncated: false,
          }),
      },
    ]);
    const idx = await getImageIndex(FAKE_CFG.repo, 'main', FAKE_CFG.token);
    check(
      idx.size === 2 && idx.get('images/r1.png') === 'sha-1' && idx.get('images/r2.jpg') === 'sha-2',
      '★ 只收 images/ 下的 blob（带 sha）：目录本身与别处的文件不要',
      JSON.stringify([...idx]),
    );
    check(ds.calls[0].url.includes('/git/trees/main?recursive=1'), '一次 recursive 请求拿全，不下载图片正文');
    check(ds.calls[0].method === 'GET', '是个 GET');
    ds.restore();
  }
  {
    /* 空仓库（还没有任何提交）没有树：当「一张图都没有」，不是错误 */
    const ds = stubFetch([{ match: /.*/, reply: () => jsonRes({ message: 'Git Repository is empty.' }, 409) }]);
    check((await getImageIndex(FAKE_CFG.repo, 'main', FAKE_CFG.token)).size === 0, '空仓库 → 空清单');
    ds.restore();
  }
  {
    const ds = stubFetch([{ match: /.*/, reply: () => jsonRes({ message: 'boom' }, 500) }]);
    const e = await githubErrOf(() => getImageIndex(FAKE_CFG.repo, 'main', FAKE_CFG.token));
    check(e !== null, '★ 接口真的坏了 → 抛 GithubError，调用方据此退回逐张查的老办法');
    ds.restore();
  }

  console.log('\n[github · putJson]');
  {
    const gh = stubFetch([{ match: /.*/, method: 'PUT', reply: () => jsonRes({ content: { sha: 'new-sha' } }) }]);
    const sha = await putJson('owner/repo', 'orders.json', 'main', 'tok', { a: 1 }, '手机端更新', 'old-sha');
    const call = gh.calls[0];
    check(call.method === 'PUT' && call.url.endsWith('/repos/owner/repo/contents/orders.json'), 'PUT 到 contents 路径', call.url);
    const body = call.body as { message: string; content: string; branch: string; sha?: string };
    check(body.message === '手机端更新' && body.branch === 'main' && body.sha === 'old-sha', 'payload 带 message/branch/sha');
    check(
      Buffer.from(body.content, 'base64').toString('utf8') === JSON.stringify({ a: 1 }, null, 2),
      'content 是缩进后的 JSON base64',
    );
    check(sha === 'new-sha', '返回新的 sha');
    gh.restore();
  }
  {
    const gh = stubFetch([{ match: /.*/, method: 'PUT', reply: () => jsonRes({ content: { sha: 'x' } }) }]);
    await putJson('owner/repo', 'orders.json', 'main', 'tok', {}, 'msg');
    check(!('sha' in (gh.calls[0].body as object)), '没有旧 sha 时不带 sha 字段');
    gh.restore();
  }
  {
    const gh = stubFetch([{ match: /.*/, method: 'PUT', reply: () => jsonRes({ message: 'Bad credentials' }, 401) }]);
    const e = await githubErrOf(() => putJson('owner/repo', 'orders.json', 'main', 'tok', {}, 'msg'));
    check(e?.kind === 'auth', 'PUT 失败也走同一套错误分类');
    gh.restore();
  }

  console.log('\n[github · verifyRepo]');
  {
    const gh = stubFetch([
      { match: /\/branches\//, reply: () => jsonRes({ name: 'main' }) },
      { match: /\/repos\/owner\/repo$/, reply: () => jsonRes({ full_name: 'owner/repo' }) },
    ]);
    const e = await githubErrOf(() => verifyRepo('owner/repo', 'main', 'tok'));
    check(e === null, '仓库与分支都在 → 通过');
    check(gh.calls.length === 2 && gh.calls[1].url.includes('/branches/main'), '先校验仓库再校验分支', gh.calls.map((c) => c.url).join(' → '));
    gh.restore();
  }
  {
    const gh = stubFetch([{ match: /\/repos\/owner\/repo$/, reply: () => jsonRes({ message: 'Not Found' }, 404) }]);
    const e = await githubErrOf(() => verifyRepo('owner/repo', 'main', 'tok'));
    check(e?.kind === 'notfound', '仓库 404 → notfound');
    gh.restore();
  }
  {
    const gh = stubFetch([
      { match: /\/branches\//, reply: () => jsonRes({ message: 'Not Found' }, 404) },
      { match: /\/repos\/owner\/repo$/, reply: () => jsonRes({ full_name: 'owner/repo' }) },
    ]);
    const e = await githubErrOf(() => verifyRepo('owner/repo', 'dev', 'tok'));
    check(e?.kind === 'notfound' && e.message.includes('dev'), '分支 404 → 明确指出缺哪个分支', e?.message);
    gh.restore();
  }
}

/* ═══════════ helpers / seed 纯函数 ═══════════ */

/* ═══════════ ai.ts（DeepSeek 识别层）═══════════ */

async function aiChecks() {
  console.log('\n[AI · Key 工具]');
  check(maskAiKey(AI_KEY) === 'sk-012••••••••cdef', 'maskAiKey 保留前缀与后四位', `实际「${maskAiKey(AI_KEY)}」`);
  check(maskAiKey('sk-1') === '••••', 'Key 太短时整体打码');
  check(normalizeAiKey(' sk-abc\n def ') === 'sk-abcdef', 'normalizeAiKey 去掉所有空白');
  check(aiKeyShapeError(AI_KEY) === null, '规范的 sk- Key 通过校验');
  check((aiKeyShapeError('') ?? '').includes('请填写'), '空 Key 报错');
  check((aiKeyShapeError('ghp_0123456789abcdef0123') ?? '').includes('sk-'), '不是 sk- 开头 → 提示前缀');
  check((aiKeyShapeError('sk-short') ?? '').includes('没复制全'), '位数不足 → 提示没复制全');

  console.log('\n[AI · 提示词与解析]');
  {
    const msgs = buildAiMessages('一段文案');
    check(msgs[0].role === 'system' && msgs[1].role === 'user', '消息是 system + user 两条');
    check(/json/i.test(aiText(msgs[0])) && /json/i.test(aiText(msgs[1])), '提示词里带 json（json_object 模式的要求）');
    check(aiText(msgs[1]).includes('一段文案'), '用户消息里带上了原文');
    check(/不要编造|绝对不要编造/.test(aiText(msgs[0])), '明确要求不编造');
    check(/只填菜名/.test(aiText(msgs[0])), '提示词要求标题只填菜名');
    check(/西红柿炒鸡蛋/.test(aiText(msgs[0])), '提示词给了「只留菜名」的例子');
    const withPage = buildAiMessages('一段文案', '作者候选: 阿珍');
    check(
      aiText(withPage[1]).includes('阿珍') && aiText(withPage[1]).includes('页面线索'),
      '给了页面线索就一并带上',
    );
    check(/保姆级/.test(aiText(msgs[0])), '提示词点名要去掉「保姆级 / 教程」这类营销词');
    check(/酸甜爽脆的腌萝卜保姆级教程来了/.test(aiText(msgs[0])), '提示词给了「只留菜品名」的具体例子');
    check(/第一条结果/.test(aiText(msgs[0])), '提示词约定：搜索结果页取第一条结果的菜名');
    check(aiText(buildAiMessages('')[1]).includes('只给了一个链接'), '只给链接（没文案）时提示词也读得通');
    check(/截图|图里/.test(aiText(msgs[0])), '提示词交代了截图识图（只抄图里真实出现的字）');

    /* 带截图：content 变成「文字 + 图片」块，走 deepseek-flash 的识图 */
    const SHOT = 'data:image/jpeg;base64,c2hvdA==';
    const withImg = buildAiMessages('', undefined, SHOT);
    const parts = withImg[1].content;
    check(Array.isArray(parts), '带截图时 user 消息的 content 是内容块数组');
    const arr = Array.isArray(parts) ? parts : [];
    const firstPart = arr[0];
    const secondPart = arr[1];
    check(
      firstPart?.type === 'text' && firstPart.text.includes('截图'),
      '第一块是文字说明',
      JSON.stringify(firstPart),
    );
    check(
      secondPart?.type === 'image_url'
        && secondPart.image_url.url === SHOT
        && secondPart.image_url.detail === 'high',
      '★ 第二块把截图以 data URL 交给模型（detail: high，小字也看得清）',
      JSON.stringify(secondPart),
    );
    check(!buildAiMessages('文案').some((m) => Array.isArray(m.content)), '没有截图时仍是纯文本，老路径不变');
  }
  check(JSON.stringify(parseJsonLoose('{"title":"a"}')) === '{"title":"a"}', 'parseJsonLoose 直接解析');
  check(
    (parseJsonLoose('```json\n{"title":"a"}\n```') as { title: string }).title === 'a',
    '解析 ```json 代码块',
  );
  check(
    (parseJsonLoose('好的，结果如下：{"title":"a"} 完毕') as { title: string }).title === 'a',
    '从解释文字里捞出 JSON',
  );
  check(parseJsonLoose('完全不是 JSON') === null, '不是 JSON → null');
  {
    const r = normalizeAiRecipe({ 菜名: '【番茄牛腩】', 作者: ' 阿珍 ', 做法: '1. 焯水', 小贴士: '少放盐' });
    check(
      r.title === '番茄牛腩' && r.author === '阿珍' && r.steps === '1. 焯水' && r.note === '少放盐',
      '中文字段名 / 书名号也能规整',
      JSON.stringify(r),
    );
    check(normalizeAiRecipe({}).title === '' && normalizeAiRecipe(null).steps === '', '缺字段补空串，不编造');
    check(normalizeAiRecipe({ title: 'x'.repeat(80) }).title.length === 20, '菜名裁到 20 字');
    check(
      normalizeAiRecipe({ title: '酸甜爽脆的腌萝卜保姆级教程来了‼️' }).title === '酸甜爽脆的腌萝卜',
      '★ 模型丢来整句视频标题 → 收成菜品名',
      normalizeAiRecipe({ title: '酸甜爽脆的腌萝卜保姆级教程来了‼️' }).title,
    );
  }

  console.log('\n[AI · recognizeRecipe]');
  {
    const ds = stubFetch([
      {
        match: /api\.deepseek\.com\/chat\/completions/,
        method: 'POST',
        reply: () => jsonRes({ choices: [{ message: { content: '{"title":"番茄牛腩","steps":"1. 焯水"}' } }] }),
      },
    ]);
    const r = await recognizeRecipe(AI_KEY, '文案');
    check(r.title === '番茄牛腩' && r.steps === '1. 焯水', '成功路径：解析出菜名与做法');
    check(ds.calls[0].headers.Authorization === `Bearer ${AI_KEY}`, '带上 Bearer Key');
    check(
      (ds.calls[0].body as { response_format?: { type?: string } }).response_format?.type === 'json_object',
      '要求 JSON 输出',
    );
    check(ds.calls[0].url === 'https://api.deepseek.com/chat/completions', '打到 chat/completions 端点', ds.calls[0].url);
    ds.restore();
  }
  {
    /* 识图：没有文案、只给一张截图，也照样走 deepseek-flash 的 image_url */
    const ds = stubFetch([
      {
        match: /api\.deepseek\.com\/chat\/completions/,
        method: 'POST',
        reply: () => jsonRes({ choices: [{ message: { content: '{"title":"红烧肉","steps":"1. 焯水"}' } }] }),
      },
    ]);
    const SHOT = 'data:image/png;base64,c2hvdA==';
    const r = await recognizeRecipe(AI_KEY, '', { image: SHOT });
    const sent = JSON.stringify(ds.calls[0].body);
    check(sent.includes('deepseek-flash') && sent.includes(SHOT), '★ 识图把截图整个交给 deepseek-flash');
    check(sent.includes('"image_url"'), '用的是 image_url 内容块（DeepSeek 识图的要求）');
    check(r.title === '红烧肉', '识图结果同样整理成菜谱', JSON.stringify(r));
    ds.restore();
  }
  {
    const ds = stubFetch([
      { match: /.*/, method: 'POST', reply: () => jsonRes({ choices: [{ message: { content: '' } }] }) },
    ]);
    const e = await aiErrOf(() => recognizeRecipe(AI_KEY, '文案'));
    check(e?.kind === 'format' && e.message.includes('没有返回内容'), '空内容 → format 错误');
    ds.restore();
  }
  {
    const ds = stubFetch([
      { match: /.*/, method: 'POST', reply: () => jsonRes({ choices: [{ message: { content: '不是 JSON' } }] }) },
    ]);
    const e = await aiErrOf(() => recognizeRecipe(AI_KEY, '文案'));
    check(e?.kind === 'format', '返回不是 JSON → format 错误');
    ds.restore();
  }
  {
    const ds = stubFetch([{ match: /.*/, method: 'POST', reply: () => { throw new Error('boom'); } }]);
    const e = await aiErrOf(() => recognizeRecipe(AI_KEY, '文案'));
    check(e?.kind === 'network' && e.message.includes('连不上 DeepSeek'), '网络异常 → network 错误');
    ds.restore();
  }

  console.log('\n[AI · 错误分类]');
  const statusCases: Array<{ status: number; kind: DeepseekError['kind']; hint: string }> = [
    { status: 401, kind: 'auth', hint: 'API Key 无效' },
    { status: 402, kind: 'balance', hint: '余额不足' },
    { status: 429, kind: 'ratelimit', hint: '太频繁' },
    { status: 400, kind: 'badrequest', hint: '拒绝' },
    { status: 500, kind: 'server', hint: '服务端' },
  ];
  for (const c of statusCases) {
    const ds = stubFetch([{ match: /.*/, method: 'POST', reply: () => jsonRes({}, c.status) }]);
    const e = await aiErrOf(() => recognizeRecipe(AI_KEY, '文案'));
    check(
      e?.kind === c.kind && (e?.message ?? '').includes(c.hint),
      `${c.status} → kind=${c.kind}（${c.hint}）`,
      `实际 kind=${e?.kind} message=${e?.message}`,
    );
    ds.restore();
  }
  {
    /* 400 会把 DeepSeek 原话带给用户，比我们自己编的笼统文案更有用 */
    const ds = stubFetch([
      { match: /.*/, method: 'POST', reply: () => jsonRes({ error: { message: 'content is too long' } }, 400) },
    ]);
    const e = await aiErrOf(() => recognizeRecipe(AI_KEY, '文案'));
    check(e?.kind === 'badrequest' && (e?.message ?? '').includes('content is too long'), '400 带上 DeepSeek 的原始说明', e?.message);
    ds.restore();
  }

  console.log('\n[AI · verifyAiKey]');
  {
    const ds = stubFetch([{ match: /api\.deepseek\.com\/models/, reply: () => jsonRes({ object: 'list', data: [] }) }]);
    const e = await aiErrOf(() => verifyAiKey(AI_KEY));
    check(e === null, 'Key 有效 → 测试通过');
    check(ds.calls[0].url === 'https://api.deepseek.com/models' && ds.calls[0].method === 'GET', '测试打的是 /models（不消耗对话额度）');
    ds.restore();
  }
  {
    const ds = stubFetch([{ match: /.*/, reply: () => jsonRes({ error: { message: 'Authentication Fails' } }, 401) }]);
    const e = await aiErrOf(() => verifyAiKey(AI_KEY));
    check(e?.kind === 'auth', 'Key 失效 → auth 错误');
    ds.restore();
  }
}

/** 跑一个必然抛错的 AI 调用，取回 DeepseekError（不是则记为 null） */
async function aiErrOf(fn: () => Promise<unknown>): Promise<DeepseekError | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof DeepseekError ? e : null;
  }
}

/* ═══════════ photo.ts + 仓库里的图片文件 ═══════════ */

async function photoChecks() {
  console.log('\n[照片 · data URL 工具]');
  check(isPhotoDataUrl(SHOT_DATA_URL), '认出图片 data URL');
  check(!isPhotoDataUrl('data:text/plain;base64,AA=='), '不是图片的 data URL 不认');
  check(!isPhotoDataUrl('images/r1.jpg'), '仓库路径不是 data URL');
  check(dataUrlMime(SHOT_DATA_URL) === 'image/png', 'dataUrlMime 取到 MIME');
  check(dataUrlMime('乱七八糟') === 'image/jpeg', '认不出时按 jpeg 兜底');
  check(dataUrlBase64(SHOT_DATA_URL) === SHOT_B64, 'dataUrlBase64 只取正文（去前缀与空白）');
  check(dataUrlBytes(SHOT_DATA_URL) === SHOT_BYTES.length, '★ dataUrlBytes 数得准', String(dataUrlBytes(SHOT_DATA_URL)));
  check(dataUrlBytes('') === 0, '空值算 0 字节');
  check(MAX_PHOTO_BYTES <= 1_000_000, '★ 压完的上限卡在 GitHub contents 的 1 MB 读取线之下', String(MAX_PHOTO_BYTES));
  check(
    imageExtFor('image/png') === 'png'
      && imageExtFor('image/webp') === 'webp'
      && imageExtFor('image/gif') === 'gif'
      && imageExtFor('image/jpeg') === 'jpg'
      && imageExtFor('') === 'jpg',
    'MIME → 扩展名',
  );
  check(
    base64ToBytes(bytesToBase64(SHOT_BYTES)).every((b, i) => b === SHOT_BYTES[i]),
    'base64 往返不丢字节',
  );

  console.log('\n[照片 · 读取与压缩兜底]');
  {
    const file = new window.File([SHOT_BYTES], 'shot.png', { type: 'image/png' });
    const direct = await blobToDataUrl(file);
    check(direct === SHOT_DATA_URL, 'blobToDataUrl 读出的就是文件真实字节', direct);
    check((await photoToDataUrl(file)) === direct, '★ 没有 canvas 2d 时原样返回（不让「加截图」这条路失败）');
    const weird = new window.File([new Uint8Array([1])], 'x.bin', { type: 'application/octet-stream' });
    check((await blobToDataUrl(weird)).startsWith('data:image/jpeg;base64,'), '不是 image/* 的按 jpeg 装（DeepSeek 只认图片）');
  }

  console.log('\n[照片 · 本机缓存]');
  {
    check(cachedPhoto('images/none.jpg') === null, '没缓存过 → null');
    rememberPhoto('images/a.png', SHOT_DATA_URL);
    check(cachedPhoto('images/a.png') === SHOT_DATA_URL, '★ 记下之后取回来还是那张图');
    rememberPhoto('不是 data URL', '图片');
    check(cachedPhoto('不是 data URL') === null, '不是 data URL 的不进缓存');
    const stored = JSON.parse(localStorage.getItem('jishiben-photos-v2') ?? '{}') as Record<
      string,
      { d?: string; up?: boolean }
    >;
    check(stored['images/a.png']?.d === SHOT_DATA_URL, '★ 缓存单独放一个 key（不塞进主库 DB）');
    check(stored['images/a.png']?.up === false, '刚存进来的图还算「没上传」');
    check(isPhotoUploaded('images/a.png') === false, '查询：还没上传');
    markPhotosUploaded(['images/a.png']);
    check(isPhotoUploaded('images/a.png') === true, '★ 标记上传后就知道仓库里有了');
    check(
      (JSON.parse(localStorage.getItem('jishiben-photos-v2') ?? '{}') as Record<string, { up?: boolean }>)['images/a.png']?.up === true,
      '标记也落了盘（重启之后不用重新核对）',
    );
    forgetPhoto('images/a.png');
    check(cachedPhoto('images/a.png') === null, '删掉菜谱后缓存也清干净');
    check(isPhotoUploaded('images/a.png') === false, '忘掉之后标记也没了');
  }
  {
    /* 缓存不够用时，先淘汰「仓库里已经有了」的 —— 还没上传的丢了就真没了 */
    localStorage.clear();
    const mb = (n: number) => `data:image/jpeg;base64,${'A'.repeat(n * 1_400_000)}`;
    rememberPhoto('images/old-pending.png', mb(1)); /* 最老、但还没传上去 */
    rememberPhoto('images/up-1.png', mb(1));
    markPhotosUploaded(['images/up-1.png']);
    rememberPhoto('images/up-2.png', mb(1));
    markPhotosUploaded(['images/up-2.png']);
    rememberPhoto('images/new-pending.png', mb(1)); /* 最新、也还没传上去 */
    const kept = JSON.parse(localStorage.getItem('jishiben-photos-v2') ?? '{}') as Record<string, unknown>;
    check(
      'images/old-pending.png' in kept && 'images/new-pending.png' in kept,
      '★ 还没上传的图不会被挤掉（两张都在）',
      Object.keys(kept).join(' | '),
    );
    check(
      !('images/up-1.png' in kept) || !('images/up-2.png' in kept),
      '★ 放不下时优先淘汰「仓库里已有」的那些（丢了还能取回来）',
      Object.keys(kept).join(' | '),
    );
    forgetPhoto('images/old-pending.png');
    forgetPhoto('images/up-1.png');
    forgetPhoto('images/up-2.png');
    forgetPhoto('images/new-pending.png');
  }

  console.log('\n[照片 · 仓库路径]');
  check(imagePath('r_abc') === 'images/r_abc.jpg', '默认路径 images/<id>.jpg', imagePath('r_abc'));
  check(imagePath('r_abc', 'image/png') === 'images/r_abc.png', '扩展名跟着图片类型走', imagePath('r_abc', 'image/png'));
  check(
    imageMimeOf('images/r_abc.png') === 'image/png'
      && imageMimeOf('images/r_abc.webp') === 'image/webp'
      && imageMimeOf('images/r_abc.gif') === 'image/gif'
      && imageMimeOf('images/r_abc.jpg') === 'image/jpeg',
    '路径 → MIME 读回来还原得对',
  );

  console.log('\n[照片 · 仓库读写]');
  {
    const ds = stubFetch([
      { match: /\/contents\/images\//, reply: () => jsonRes({ sha: 'sha-1', content: SHOT_B64 }) },
    ]);
    const got = await getImage('owner/repo', 'images/r1.png', 'main', 'ghp_x');
    check(got?.sha === 'sha-1' && got.dataUrl === SHOT_DATA_URL, '读图 → data URL + sha（sha 删图要用）', JSON.stringify(got));
    ds.restore();
  }
  {
    const ds = stubFetch([{ match: /.*/, reply: () => jsonRes({ message: 'Not Found' }, 404) }]);
    check((await getImage('owner/repo', 'images/none.jpg', 'main', 'ghp_x')) === null, '图不在仓库 → null（不是报错）');
    check((await getFileSha('owner/repo', 'images/none.jpg', 'main', 'ghp_x')) === null, '读 sha：不存在也是 null');
    ds.restore();
  }
  {
    const ds = stubFetch([{ match: /.*/, reply: () => jsonRes({ sha: 'x', content: '' }) }]);
    const e = await githubErrOf(() => getImage('owner/repo', 'images/big.jpg', 'main', 'ghp_x'));
    check(
      e !== null && e.message.includes('太大'),
      '★ 仓库里的图超过 1 MB（正文为空）→ 明确说「太大了」',
      e?.message,
    );
    ds.restore();
  }
  {
    const ds = stubFetch([{ match: /\/contents\/images\//, method: 'PUT', reply: () => jsonRes({ content: { sha: 'sha-new' } }) }]);
    const sha = await putImage('owner/repo', 'images/r1.png', 'main', 'ghp_x', SHOT_DATA_URL, '记食本：上传菜谱图片');
    const sent = ds.calls[0].body as { content?: string; branch?: string; sha?: string };
    check(sha === 'sha-new', '上传返回新 sha');
    check(
      sent.content === SHOT_B64 && sent.branch === 'main' && sent.sha === undefined,
      '★ 正文是纯 base64（不带 data: 前缀），新建文件不带 sha',
      JSON.stringify(sent),
    );
    ds.restore();
  }
  {
    const ds = stubFetch([{ match: /\/contents\/images\//, method: 'DELETE', reply: () => jsonRes({ content: { sha: 'd' } }) }]);
    await deleteFile('owner/repo', 'images/r1.jpg', 'main', 'ghp_x', 'sha-1', '记食本：删除菜谱图片');
    const del = ds.calls[0];
    check(
      del.method === 'DELETE' && (del.body as { sha?: string }).sha === 'sha-1',
      '★ 删图带上 sha（GitHub 不带 sha 会拒）',
      JSON.stringify(del.body),
    );
    ds.restore();
  }
}

/* ═══════════ reader.ts（读原链接）═══════════ */

async function readerChecks() {
  console.log('\n[读链接 · URL 与请求]');
  check(isFetchableUrl('https://xhslink.com/a/x'), 'http(s) 链接可读');
  check(isFetchableUrl('  http://b23.tv/xyz  '), '首尾空白不影响判断');
  check(!isFetchableUrl('javascript:alert(1)'), 'javascript: 协议拒绝');
  check(!isFetchableUrl('这不是链接'), '不是链接就拒绝');

  {
    /* 非法链接根本不该发请求 */
    const rd = stubFetch([]);
    const e = await readerErrOf(() => readPageHtml('javascript:alert(1)'));
    check(e?.kind === 'badurl', '非法链接 → badurl，且不发请求');
    check(rd.calls.length === 0, '没发任何请求');
    rd.restore();
  }
  {
    const rd = stubFetch([
      { match: /^https:\/\/r\.jina\.ai\//, reply: () => new Response('<html><body>hi</body></html>') },
    ]);
    const html = await readPageHtml('https://xhslink.com/a/x');
    check(html.includes('hi'), '成功路径：返回页面 HTML');
    check(rd.calls[0].url === 'https://r.jina.ai/https://xhslink.com/a/x', '拼到 r.jina.ai 后面', rd.calls[0].url);
    check(rd.calls[0].headers['x-respond-with'] === 'html', '要 HTML（作者名在里面）');
    rd.restore();
  }
  {
    const rd = stubFetch([{ match: /.*/, reply: () => jsonRes({ message: 'blocked' }, 403) }]);
    const e = await readerErrOf(() => readPageHtml('https://xhslink.com/a/x'));
    check(e?.kind === 'http' && (e?.message ?? '').includes('403'), '抓取被拒 → http 错误（带状态码）');
    rd.restore();
  }
  {
    const rd = stubFetch([{ match: /.*/, reply: () => { throw new Error('boom'); } }]);
    const e = await readerErrOf(() => readPageHtml('https://xhslink.com/a/x'));
    check(e?.kind === 'network', '网络异常 → network 错误');
    rd.restore();
  }

  console.log('\n[读链接 · 页面线索压缩]');
  {
    const clues = compactPage(PAGE_HTML, 'https://xhslink.com/a/x');
    check(clues.includes('番茄牛腩 - 小红书'), '抽出页面标题');
    check(clues.includes('酸甜开胃'), '抽出 og:description');
    check(clues.includes('爱做饭的阿珍'), 'meta 作者 / 作者块进了候选');
    check(clues.includes('阿珍的厨房'), '★ 内嵌 JSON 里的昵称也捞得到');
    check(clues.includes('牛腩冷水下锅'), '带上了正文摘录（做法线索）');
    check(clues.includes('链接: https://xhslink.com/a/x'), '带上原链接');
  }
  {
    const clues = compactPage(
      '<html><head></head><body><div class="author-name">登录</div><div class="nickname">关注</div><p>正文</p></body></html>',
    );
    check(!clues.includes('作者候选'), '「登录 / 关注」这类噪音不会被当成作者', clues);
  }
  check(compactPage('<html><body></body></html>') === '', '空页面 → 空线索（不编造）');
}

/** 跑一个必然抛错的读取，取回 ReaderError（不是则记为 null） */
async function readerErrOf(fn: () => Promise<unknown>): Promise<ReaderError | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof ReaderError ? e : null;
  }
}

function helperChecks() {
  console.log('\n[辅助函数 · 称呼与身份]');
  check(partnerOf('a') === 'b' && partnerOf('b') === 'a', 'partnerOf 取另一位');
  check(
    nicknameOf({ a: { nickname: ' 小辉 ', updatedAt: 'x' }, b: { nickname: '', updatedAt: 'x' } }, 'a') === '小辉',
    'nicknameOf 去空白',
  );
  check(nicknameOf(undefined, 'a') === '', 'profiles 缺失时返回空串');
  check(meOf(null) === 'a' && meOf({ me: 'b' } as never) === 'b' && meOf({ me: 'x' } as never) === 'a', 'meOf 兜底为 a');

  console.log('\n[辅助函数 · 订单摘要与状态]');
  const order: Order = {
    id: 'o',
    meal: 'dinner',
    status: 'pending',
    note: '',
    createdAt: '',
    updatedAt: '',
    placedBy: 'a',
    items: [
      { recipeId: 'r1', dishName: '番茄炖牛腩' },
      { recipeId: null, dishName: '手抓饼' },
    ],
  };
  check(orderSummary(order) === '番茄炖牛腩 等 2 道', '多菜单摘要', orderSummary(order));
  check(orderSummary({ ...order, items: [{ recipeId: 'r1', dishName: '番茄炖牛腩' }] }) === '番茄炖牛腩', '单菜单摘要');
  check(orderSummary({ ...order, items: [] }) === '空单', '空单摘要');
  check(
    statusMeta('pending').label === '待接' && statusMeta('accepted').label === '已接' && statusMeta('done').label === '已完成',
    '状态文案',
  );
  check(statusMeta('done').cls === 'done', '状态样式类');
  check(mealLabel('lunch') === '午餐' && mealLabel('dinner') === '晚餐', '餐次文案');
  check(
    srcMeta('red').label === '小红书' &&
      srcMeta('bili').label === 'B站' &&
      srcMeta('douyin').label === '抖音' &&
      srcMeta('generic').label === '网页',
    '来源文案',
  );

  console.log('\n[辅助函数 · 在单检测 / 首字 / 路径]');
  const openOrders: Order[] = [
    { ...order, status: 'accepted' },
    { ...order, id: 'o2', status: 'done', items: [{ recipeId: 'r9', dishName: 'x' }] },
  ];
  check(recipeInOpenOrder(openOrders, 'r1')?.id === 'o', '未完成单里命中');
  check(recipeInOpenOrder(openOrders, 'r9') === null, '只在已完成单里 → 不算在单');
  check(recipeInOpenOrder(openOrders, null) === null, '临时菜（recipeId 为空）不算在单');
  check(initial('番茄炖牛腩') === '番' && initial('') === '菜', '首字占位兜底');
  check(artUrl('a.svg') === '/art/a.svg', '插画路径');

  console.log('\n[seed / migrate 数据契约]');
  check(SCHEMA === 3 && DB_KEY === 'jishiben-db-v1', 'schema 版本与 localStorage key 稳定');
  const s = seed();
  check(s.schema === SCHEMA && s.recipes.length === 6 && s.orders.length === 3, '种子数据规模');
  check(s.logs.length === 4, '种子日志全量保留（不再按 8 条截断）');
  const ep = emptyProfiles();
  check(ep.a.nickname === '' && ep.b.nickname === '', '空档案两栏都为空串');

  /* 点单次数：示例里每道菜都记着，且跟种子订单对得上 */
  const countedFromOrders = new Map<string, number>();
  s.orders.forEach((o) =>
    o.items.forEach((it) => {
      if (it.recipeId) countedFromOrders.set(it.recipeId, (countedFromOrders.get(it.recipeId) ?? 0) + 1);
    }),
  );
  check(
    s.recipes.every((r) => r.orderCount === (countedFromOrders.get(r.id) ?? 0)),
    '★ 种子菜谱的点单次数与实际订单一致',
    s.recipes.map((r) => `${r.id}=${r.orderCount}/${countedFromOrders.get(r.id) ?? 0}`).join(' '),
  );

  /* v1 单菜订单 → v2 items[]（老缓存不炸） */
  const v1 = seed() as unknown as Record<string, unknown>;
  v1.schema = 1;
  (v1.orders as Array<Record<string, unknown>>).forEach((o) => {
    delete o.items;
    o.dishName = '老式单菜';
    o.recipeId = 'r1';
  });
  const migrated = migrate(v1 as unknown as DB);
  check(
    migrated.orders.every((o) => Array.isArray(o.items) && o.items.length === 1 && o.items[0].dishName === '老式单菜'),
    'v1 单菜订单迁移成 items[]',
  );
  check(migrated.schema === SCHEMA, '迁移后 schema 升到当前版本');

  console.log('\n[seed · 规整任意来源的老结构]');
  {
    /* 老版本写进仓库的 profiles.json 是角色形状 */
    const role = normalizeProfiles({
      orderer: { nickname: '小辉', updatedAt: 'x' },
      cook: { nickname: '小红', updatedAt: 'x' },
    });
    check(role.a.nickname === '小辉' && role.b.nickname === '小红', '角色形状 profiles 按 a / b 对号入座');

    /* 缺格 / 字段类型不对 / 整块缺失：一律补空，绝不把 undefined 交给调用方 */
    const half = normalizeProfiles({ a: { nickname: '小辉' } });
    check(half.a.nickname === '小辉' && half.b.nickname === '' && half.b.updatedAt === '—', '缺的那一格补空');
    const junk = normalizeProfiles(null);
    check(junk.a.nickname === '' && junk.b.nickname === '', 'null / 非对象 → 两格都补空');

    const legacyOrder = normalizeOrders([
      { id: 'o', meal: 'lunch', status: 'pending', note: '', createdAt: '', updatedAt: '', placedBy: 'a', dishName: '老式单菜', recipeId: 'r1' },
    ]);
    check(
      legacyOrder[0]?.items?.length === 1 && legacyOrder[0].items[0].dishName === '老式单菜',
      '单菜订单规整成 items[]',
    );
    check(normalizeOrders('不是数组').length === 0 && normalizeOrders([1, null]).length === 2, '订单不是数组时兜底为空');

    /* 老缓存 / 老仓库的菜谱没有点单次数（或不是合法数字）→ 一律补 0 */
    const noCount = normalizeRecipes([
      { id: 'r', title: '老菜谱', source: 'red', url: '', author: '', art: '', steps: '', note: '', createdAt: 'x', updatedAt: 'x' },
      { id: 'r2', orderCount: -3 },
      { id: 'r3', orderCount: 2 },
    ]);
    check(noCount[0].orderCount === 0, '★ 缺 orderCount 的老菜谱补 0', String(noCount[0].orderCount));
    check(noCount[1].orderCount === 0, '★ 负数次数规整成 0', String(noCount[1].orderCount));
    check(noCount[2].orderCount === 2, '已经是合法次数的原样保留', String(noCount[2].orderCount));
    /* 老菜谱没有照片字段（写于加它之前）→ 补空串，别让 Photo 组件读到 undefined */
    check(noCount[0].image === '', '★ 缺 image 的老菜谱补空串', JSON.stringify(noCount[0].image));
    const withImg = normalizeRecipes([{ id: 'r4', image: 'images/r4.png' }]);
    check(withImg[0].image === 'images/r4.png', '已有照片路径的原样保留');
    /* 「来自剪藏」是我们自己写过的「没作者」占位：读到就当成没作者（手写 / 截图识图根本没有剪藏） */
    const legacyAuthor = normalizeRecipes([{ id: 'r5', author: '来自剪藏' }, { id: 'r6', author: '阿珍' }]);
    check(legacyAuthor[0].author === '', '★ 老数据里的「来自剪藏」被清成空串', JSON.stringify(legacyAuthor[0].author));
    check(legacyAuthor[1].author === '阿珍', '真作者原样留着');

    /* 版本号已是最新、但缓存里缺 profiles 的脏数据 —— 只看 schema 会漏 */
    const noProfiles = seed() as unknown as Record<string, unknown>;
    delete noProfiles.profiles;
    const fixed = migrate(noProfiles as unknown as DB);
    check(fixed.profiles.a.nickname === '' && fixed.profiles.b.nickname === '', '★ schema 已最新但缺 profiles → 照样补齐');

    /* schema 已最新、但本机角色缺省（老缓存 / 手改过的配置）→ 补「点单」 */
    const noView = seed() as unknown as Record<string, unknown>;
    delete (noView.config as Record<string, unknown>).view;
    check(migrate(noView as unknown as DB).config?.view === 'order', '★ 配置缺 view → 补为「点单」');
  }
}

/* ═══════════ 四、老数据迁移 ═══════════ */

async function migrationChecks() {
  console.log('\n[老数据迁移 · 角色槽换成两个人]');
  localStorage.clear();
  {
    /* 造一份 v2 结构：昵称在 config.nickname，profiles 按角色存，订单没有方向 */
    const legacy = seed() as unknown as Record<string, unknown>;
    legacy.schema = 2;
    delete legacy.profiles;
    (legacy.orders as Array<Record<string, unknown>>).forEach((o) => delete o.placedBy);
    legacy.configured = true; // 已经连过仓库的老用户
    const legacyCfg = legacy.config as Record<string, unknown>;
    legacyCfg.nickname = '小辉';
    legacyCfg.role = 'orderer';
    legacyCfg.repo = 'owner/repo';
    legacyCfg.token = FAKE_CFG.token;
    localStorage.setItem(DB_KEY, JSON.stringify(legacy));

    let html = '';
    try {
      const m = await mount('/library');
      html = m.html();
      await m.close();
    } catch (e) {
      fail('老数据能正常打开', e instanceof Error ? e.message : String(e));
    }
    if (html) {
      ok('老数据能正常打开，不炸');
      const db = readDb();
      check(db.profiles?.a?.nickname === '小辉', '★ config.nickname 迁移进 profiles.a');
      check(db.config?.me === 'a', '旧角色 orderer → 本机 me=a');
      check(db.config?.view === 'order', '旧角色 orderer → 本机默认角色点单');
      check(
        !('nickname' in (db.config ?? {})),
        '旧字段已从 config 移除（不再有第二份真相）',
        `config 里还有：${Object.keys(db.config ?? {}).join(',')}`,
      );
      check(!('role' in (db.config ?? {})), '旧字段 role 也已移除');
      check(db.orders.every((o) => o.placedBy === 'a'), '老订单补上方向 placedBy');
      check(html.includes('我的菜谱库'), '菜谱数据完好');
    }
  }

  console.log('\n[老数据迁移 · 旧掌勺方身份]');
  localStorage.clear();
  {
    const legacy = seed() as unknown as Record<string, unknown>;
    legacy.schema = 2;
    delete legacy.profiles;
    legacy.configured = true;
    const legacyCfg = legacy.config as Record<string, unknown>;
    legacyCfg.nickname = '小红';
    legacyCfg.role = 'cook';
    legacyCfg.repo = 'owner/repo';
    legacyCfg.token = FAKE_CFG.token;
    localStorage.setItem(DB_KEY, JSON.stringify(legacy));

    const m = await mount('/cook');
    await m.close();
    const db = readDb();
    check(db.profiles?.b?.nickname === '小红', '旧角色 cook → 昵称落进 profiles.b');
    check(db.config?.me === 'b', '本机 me=b');
    check(db.config?.view === 'cook', '★ 旧角色 cook → 本机默认角色掌勺');
    check(db.profiles?.a?.nickname === '', '另一栏留空，等对方设备填');
  }
  localStorage.clear();

  console.log('\n[老数据迁移 · 版本号对得上但 profiles 缺格]');
  localStorage.clear();
  {
    /* 脏缓存：schema 已是 3，却没有 profiles（或只有一格）。
       只按版本号判断会漏掉它，必须在读取时就补齐 —— 否则 joinAs 等取值处会抛错、白屏 */
    const broken = seed() as unknown as Record<string, unknown>;
    broken.configured = true;
    delete broken.profiles;
    localStorage.setItem(DB_KEY, JSON.stringify(broken));

    let html = '';
    try {
      const m = await mount('/library');
      html = m.html();
      await m.close();
    } catch (e) {
      fail('缺 profiles 的缓存能正常打开', e instanceof Error ? e.message : String(e));
    }
    if (html) {
      ok('缺 profiles 的缓存能正常打开，不白屏');
      const db = readDb();
      check(db.profiles?.a?.nickname === '' && db.profiles?.b?.nickname === '', '★ 缺格缓存被补齐成 a / b 两格');
    }
  }
  localStorage.clear();
}

/* ═══════════ 五、首次连接（stub 掉 GitHub API）═══════════ */

async function connectChecks() {
  console.log('\n[首次连接 · 仓库为空 → 推初始内容]');
  localStorage.clear();
  {
    const gh = installFakeGithub({});
    const m = await mount('/setup');
    await fillAndConnect(m);

    const html = m.html();
    check(html.includes('仓库已接管你的菜谱'), '连接成功', html.includes('连接失败') ? '出现了错误横幅' : '');
    check(html.includes('仓库里还没有数据'), '识别为空仓库并推了初始内容');
    const paths = putPaths(gh.calls);
    check(
      paths.join(',') === 'orders.json,profiles.json,recipes.json',
      '空仓库 → 三个文件都写上去（菜谱 / 订单 / 昵称）',
      `实际 PUT：${paths.join(',') || '（无）'}`,
    );

    const db = readDb();
    check(db.configured === true, '★ 配置落库 configured=true（曾因陈旧快照被覆盖）');
    check(db.config?.repo === FAKE_CFG.repo, '★ 配置落库 repo 正确');
    check(db.profiles.a.nickname === '小辉', '我的昵称写进 profiles.a');
    check(db.config?.me === 'a', '本机 me=a');
    await m.close();

    /* 重开一局（新挂载 = 相当于刷新页面）：不该再被向导拦住，token / 仓库还在本机 */
    const again = await mount('/');
    check(!again.html().includes('连接并拉取'), '★ 重开一局不再要求重新填 token / 仓库');
    check(again.html().includes('我的菜谱库'), '直接进菜谱库', again.html().slice(0, 80));
    check(readDb().config?.token === FAKE_CFG.token, '★ Token 还在本机缓存里');
    check(readDb().config?.repo === FAKE_CFG.repo, '仓库名也还在');
    await again.close();
    gh.restore();
  }

  console.log('\n[首次连接 · 同时填了对方昵称]');
  localStorage.clear();
  {
    const gh = installFakeGithub({});
    const m = await mount('/setup');
    await fillAndConnect(m, { partner: '小红' });
    const db = readDb();
    check(db.profiles.a.nickname === '小辉', '我的昵称写入');
    check(db.profiles.b.nickname === '小红', '另一半的昵称写入（对方那栏）');
    await m.close();
    gh.restore();
  }

  console.log('\n[首次连接 · 对方那栏留空，不清掉仓库里已有的名字]');
  localStorage.clear();
  {
    const remoteProfiles = {
      schema: 3,
      updatedAt: 'x',
      profiles: { a: { nickname: '', updatedAt: 'x' }, b: { nickname: '仓库里的小红', updatedAt: 'x' } },
    };
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: [] },
      orders: { schema: 3, updatedAt: 'x', orders: [] },
      profiles: remoteProfiles,
    });
    const m = await mount('/setup');
    await fillAndConnect(m);
    const db = readDb();
    check(db.profiles.a.nickname === '小辉', '我的昵称覆盖上去');
    check(db.profiles.b.nickname === '仓库里的小红', '★ 对方留空 → 保留仓库里已有的名字，没被清掉');
    await m.close();
    gh.restore();
  }

  console.log('\n[首次连接 · 仓库里是老结构也不炸（曾整页白屏）]');
  localStorage.clear();
  {
    /* 老版本写进仓库的存储结构：profiles 还是角色形状（orderer / cook），订单是单菜结构。
       拉下来必须规整成当前 schema —— 否则 joinAs 取 profiles['a'].nickname 会抛错，
       React 卸载整棵树，用户看到的就是白屏（「点完连接并拉取，页面里啥也没有了」）。 */
    const gh = installFakeGithub({
      recipes: { schema: 1, updatedAt: 'x', recipes: [] },
      orders: {
        schema: 1,
        updatedAt: 'x',
        orders: [
          { id: 'o9', meal: 'lunch', status: 'pending', note: '', createdAt: '昨天 10:00', updatedAt: '昨天 10:00', placedBy: 'a', dishName: '老式单菜', recipeId: null },
        ],
      },
      profiles: {
        schema: 2,
        updatedAt: 'x',
        profiles: { orderer: { nickname: '小辉', updatedAt: 'x' }, cook: { nickname: '小红', updatedAt: 'x' } },
      },
    });

    const m = await mount('/setup');
    await fillAndConnect(m);

    const html = m.html();
    check(html.includes('仓库已接管你的菜谱'), '★ 老仓库也能连上（没有白屏）', `DOM 长度 ${html.length}`);
    const db = readDb();
    check(db.profiles.a.nickname === '小辉' && db.profiles.b.nickname === '小红', '★ 角色形状的 profiles 被规整进 a / b');
    check(db.orders[0]?.items?.[0]?.dishName === '老式单菜', '★ 单菜订单被规整成 items[]');
    /* 规整后的内容与「已推送」快照一致：不该把没变的文件重写一遍 */
    check(
      putPaths(gh.calls).length === 0,
      '规整后不会把没变的文件重写一遍',
      `实际 PUT：${putPaths(gh.calls).join(',') || '（无）'}`,
    );
    await m.close();
    gh.restore();
  }

  console.log('\n[首次连接 · 仓库已有数据 → 拉取覆盖本地]');
  localStorage.clear();
  {
    const remote = seed();
    remote.recipes = [remote.recipes[0]];
    remote.recipes[0].title = '远端来的菜';
    remote.orders = [];
    const gh = installFakeGithub({ recipes: remote, orders: { schema: 2, updatedAt: 'x', orders: [] } });

    const m = await mount('/setup');
    await fillAndConnect(m);

    const html = m.html();
    check(html.includes('仓库已接管你的菜谱'), '连接成功');
    check(html.includes('第一次拉取完成 · 1 条菜谱'), '统计行反映的是远端的条数');
    /* 菜谱/订单没变就不该重写（否则改个昵称会在仓库里留一堆无意义提交）；
       昵称是新填的，推它是对的 */
    const paths = putPaths(gh.calls);
    check(
      !paths.includes('recipes.json') && !paths.includes('orders.json'),
      '★ 已有数据时不重写菜谱 / 订单',
      `实际 PUT：${paths.join(',') || '（无）'}`,
    );

    const db = readDb();
    check(db.recipes.length === 1 && db.recipes[0].title === '远端来的菜', '★ 远端数据覆盖了本地');
    check(db.configured === true && db.config?.repo === FAKE_CFG.repo, '★ 拉取没有冲掉刚写入的配置');
    await m.close();
    gh.restore();
  }

  console.log('\n[首次连接 · 失败分支]');
  localStorage.clear();
  {
    const gh = installFakeGithub({ repoStatus: 401 });
    const m = await mount('/setup');
    await fillAndConnect(m);
    const html = m.html();
    check(html.includes('token 无效或已过期'), '401 → 明确指出 token 问题');
    check(readDb().configured === false, '失败时不当成已连接');
    await m.close();
    gh.restore();
  }
  localStorage.clear();
  {
    const gh = installFakeGithub({ repoStatus: 404 });
    const m = await mount('/setup');
    await fillAndConnect(m);
    const html = m.html();
    check(html.includes('找不到仓库'), '404 → 指出仓库不存在或私有仓库无权限');
    await m.close();
    gh.restore();
  }
}

/* ═══════════ 六、同步引擎行为（stub 网络）═══════════ */

async function syncChecks() {
  console.log('\n[同步 · 立即同步拉取远端更新]');
  localStorage.clear();
  {
    const remote = seed();
    remote.recipes = [{ ...remote.recipes[0], title: '远端来的新菜' }];
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: remote.recipes },
      orders: { schema: 3, updatedAt: 'x', orders: remote.orders },
      profiles: { schema: 3, updatedAt: 'x', profiles: remote.profiles },
    });
    useDb();
    const m = await mount('/sync');
    await m.click('.btn-primary'); // 无本地改动 → 拉取
    await m.wait(400);
    const db = readDb();
    check(db.recipes.length === 1 && db.recipes[0].title === '远端来的新菜', '★ 拉取覆盖本地菜谱');
    check(m.html().includes('已同步'), '拉取后状态回到已同步');
    check(
      readDb().config?.repo === 'xiaoman/family-recipes' && (readDb().config?.token.length ?? 0) > 0,
      '拉取没有冲掉本机的仓库 / token 配置',
    );
    await m.close();
    gh.restore();
  }

  console.log('\n[同步 · 本地改动自动推送，且只推变化的那一份]');
  localStorage.clear();
  {
    const base = seed();
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: base.recipes },
      orders: { schema: 3, updatedAt: 'x', orders: base.orders },
      profiles: { schema: 3, updatedAt: 'x', profiles: base.profiles },
    });
    useDb();
    const m = await mount('/sync');
    await m.click('.btn-primary'); // 先拉一次，把「已推送」快照对齐远端
    await m.wait(400);
    const before = gh.calls.length;
    await m.click('#editNamesBtn');
    await m.type('#nickPartner', '大厨老王');
    await m.click('#saveNamesBtn');
    await m.wait(1200); // 700ms 防抖 + 推送
    const puts = gh.calls.slice(before).filter((c) => c.startsWith('PUT'));
    check(
      puts.length === 1 && puts[0].includes('profiles.json'),
      '★ 改昵称只推 profiles.json，不重写菜谱 / 订单',
      `实际 PUT：${puts.join(' | ') || '（无）'}`,
    );
    check(readDb().profiles.b.nickname === '大厨老王', '改动已落库');
    check(m.html().includes('已同步'), '推送后状态为已同步');
    await m.close();
    gh.restore();
  }

  console.log('\n[同步 · 空仓库时立即同步会先拉后推]');
  localStorage.clear();
  {
    const gh = installFakeGithub({});
    useDb();
    const m = await mount('/sync');
    await m.click('.btn-primary');
    await m.wait(600);
    const paths = putPaths(gh.calls);
    check(
      paths.join(',') === 'orders.json,profiles.json,recipes.json',
      '★ 空仓库：拉取为空后把三份内容作为初始内容推上去',
      `实际 PUT：${paths.join(',') || '（无）'}`,
    );
    await m.close();
    gh.restore();
  }

  console.log('\n[同步 · 推送撞车自动重试一次]');
  localStorage.clear();
  {
    const base = seed();
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: base.recipes },
      orders: { schema: 3, updatedAt: 'x', orders: base.orders },
      profiles: { schema: 3, updatedAt: 'x', profiles: base.profiles },
      putFailOnce: 409,
    });
    useDb();
    const m = await mount('/sync');
    await m.click('.btn-primary');
    await m.wait(400);
    const before = gh.calls.length;
    await m.click('#editNamesBtn');
    await m.type('#nickPartner', '重试成功');
    await m.click('#saveNamesBtn');
    await m.wait(1400);
    const retried = gh.calls
      .slice(before)
      .filter((c) => c.startsWith('PUT') && c.includes('profiles.json'));
    check(retried.length === 2, '★ 409 后取回 sha 重试一次并成功', `实际 PUT profiles ${retried.length} 次`);
    check(readDb().profiles.b.nickname === '重试成功', '重试成功后改动落库');
    check(m.html().includes('已同步'), '重试成功后状态回到已同步');
    await m.close();
    gh.restore();
  }

  console.log('\n[同步 · 撞车后取回的是「新」sha，不是拿旧 sha 空撞]');
  localStorage.clear();
  {
    const base = seed();
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: base.recipes },
      orders: { schema: 3, updatedAt: 'x', orders: base.orders },
      profiles: { schema: 3, updatedAt: 'x', profiles: base.profiles },
      putFailOnce: 409,
      /** 撞车的同时「另一台设备」先推了一版：仓库里的 sha 已经不是我们手上那个 */
      shaChangedAfterConflict: true,
      /** 假 GitHub 也像真的一样校验 sha（不校验的话撞车演不出来） */
      validateSha: true,
    });
    useDb();
    const m = await mount('/sync');
    await m.click('.btn-primary');
    await m.wait(400);
    const before = gh.puts.length;
    await m.click('#editNamesBtn');
    await m.type('#nickPartner', '撞车重试');
    await m.click('#saveNamesBtn');
    await m.wait(1400);

    const prof = gh.puts.slice(before).filter((p) => p.path.includes('profiles.json'));
    check(prof.length === 2, '撞车后重推了一次', `实际 ${prof.length} 次`);
    check(prof[0]?.sha === 'sha-profiles', '第一次 PUT 用的是手上的 sha', String(prof[0]?.sha));
    check(
      prof[1]?.sha === 'sha-profiles-v2',
      '★ 重试用的是重新读到的新 sha（不是旧 sha）',
      String(prof[1]?.sha),
    );
    check(readDb().profiles.b.nickname === '撞车重试', '重试成功后改动落库');
    check(m.html().includes('已同步'), '重试成功后状态回到已同步');
    await m.close();
    gh.restore();
  }

  console.log('\n[同步 · 取不回新 sha 时不再拿旧 sha 空撞第二次]');
  localStorage.clear();
  {
    const base = seed();
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: base.recipes },
      orders: { schema: 3, updatedAt: 'x', orders: base.orders },
      profiles: { schema: 3, updatedAt: 'x', profiles: base.profiles },
      putFailOnce: 409,
      getFailAfterConflict: true,
    });
    useDb();
    const m = await mount('/sync');
    await m.click('.btn-primary');
    await m.wait(400);
    const before = gh.puts.length;
    await m.click('#editNamesBtn');
    await m.type('#nickPartner', '读不到新 sha');
    await m.click('#saveNamesBtn');
    await m.wait(1400);

    const prof = gh.puts.slice(before).filter((p) => p.path.includes('profiles.json'));
    check(prof.length === 1, '★ 读不到新 sha → 不空撞第二次', `实际 ${prof.length} 次`);
    check(m.html().includes('刚被改过'), '★ 给出「文件刚被改过」的提示，让用户先同步');
    await m.close();
    gh.restore();
  }

  console.log('\n[同步 · 读仓库一律绕过浏览器 HTTP 缓存]');
  localStorage.clear();
  {
    const base = seed();
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: base.recipes },
      orders: { schema: 3, updatedAt: 'x', orders: base.orders },
      profiles: { schema: 3, updatedAt: 'x', profiles: base.profiles },
    });
    useDb();
    const m = await mount('/sync');
    await m.click('.btn-primary'); /* 拉一次：三份 GET */
    await m.wait(400);
    await m.click('#editNamesBtn');
    await m.type('#nickPartner', '缓存无关');
    await m.click('#saveNamesBtn'); /* 改一下：至少一次 PUT */
    await m.wait(1400);

    const cached = gh.fetches.filter((f) => f.cache !== 'no-store');
    check(
      gh.fetches.length > 0 && cached.length === 0,
      '★ 每个 GitHub 请求都带 cache: no-store（否则拿到的可能是缓存里的旧 sha）',
      cached.map((f) => `${f.method} ${f.path} cache=${String(f.cache)}`).join(' | '),
    );
    check(
      gh.fetches.some((f) => f.method === 'GET') && gh.fetches.some((f) => f.method === 'PUT'),
      '读写两条路都验到了',
    );
    await m.close();
    gh.restore();
  }

  console.log('\n[同步 · 首次推送前先取一次 sha，不靠撞车去救]');
  localStorage.clear();
  {
    /* 新开一局（内存里还没有任何 sha）直接点单：以前会先发一个不带 sha 的 PUT
       撞 422 / 409，然后才靠重试补救 —— 现在推之前先把 sha 读回来。 */
    const base = seed();
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: base.recipes },
      orders: { schema: 3, updatedAt: 'x', orders: base.orders },
      profiles: { schema: 3, updatedAt: 'x', profiles: base.profiles },
      validateSha: true,
    });
    useDb();
    const m = await mount('/order');
    await m.click('.dishgrid .pick:nth-child(1)');
    await m.click('.sendbtn');
    /* 两段等：发送本身要 720ms，推送的 700ms 防抖是这次状态更新之后才挂上的 */
    await m.wait(800);
    await m.wait(1200);

    const recipes = gh.puts.filter((p) => p.path.includes('recipes.json'));
    check(recipes.length === 1, '★ 菜谱只推了一次（不再先空撞一个没有 sha 的 PUT）', `实际 ${recipes.length} 次`);
    check(recipes[0]?.sha === 'sha-recipes', '★ PUT 带的是刚读回来的 sha', String(recipes[0]?.sha));
    check(
      gh.fetches.some((f) => f.method === 'GET' && f.path.includes('recipes.json')),
      '推之前确实先读了一次 sha',
    );
    check(!m.html().includes('刚被改过'), '★ 没有多余的冲突报错');
    await m.close();
    gh.restore();
  }

  console.log('\n[同步 · 照片先上传，再推菜谱；删菜谱顺手删图]');
  localStorage.clear();
  {
    /* 空仓库：加一条带截图的菜谱 → 图先上，菜谱 JSON 后上 */
    const gh = installFakeGithub({});
    useDb();
    const m = await mount('/add');
    await pickPhoto(m, '#photoInput');
    await m.wait(200);
    await m.type('#mTitle', '带图的菜');
    await m.click('.actionbar .btn-primary');
    await m.wait(1000); /* 保存（750ms） */
    await m.wait(1200); /* 推送防抖（700ms）+ 请求 */
    await m.close();

    const added = readDb().recipes[0];
    const imgPath = added.image;
    check(/^images\/.+\.png$/.test(imgPath), '菜谱记住了图片路径', imgPath);
    const imgPut = gh.putBodies.find((p) => p.path.includes(imgPath));
    check(imgPut?.content === SHOT_B64, '★ 图片按纯 base64 传到仓库里', JSON.stringify(imgPut)?.slice(0, 80));
    check(imgPut !== undefined && imgPut.sha === undefined, '新建的图不带 sha（带了反而会被拒）');
    const putOrder = gh.puts.map((p) => p.path).filter((p) => p.includes(imgPath) || p.includes('recipes.json'));
    check(
      putOrder[0]?.includes(imgPath) && putOrder[1]?.includes('recipes.json'),
      '★ 先传图再推菜谱 JSON（对方不会拉到一条引用不存在图片的菜谱）',
      putOrder.join(' | '),
    );

    /* 改一下备注（不动图）：图片不该被重传 */
    const beforePuts = gh.putBodies.length;
    const m2 = await mount(`/recipe/${added.id}`);
    await m2.wait(300);
    await m2.click('#editRecipeBtn');
    await m2.type('#editNote', '改一下备注');
    await m2.click('.editrow .btn-sticker.primary');
    await m2.wait(1400);
    check(
      !gh.putBodies.slice(beforePuts).some((p) => p.path.includes(imgPath)),
      '★ 图片没变就不重复上传（只推变了的菜谱 JSON）',
      gh.putBodies.slice(beforePuts).map((p) => p.path).join(' | '),
    );
    check(readDb().recipes[0].note === '改一下备注', '备注改动照常落库');

    /* 删掉这条菜谱 → 仓库里的旧图顺手删掉，别留孤儿文件 */
    await m2.click('.dang');
    await m2.click('.dang');
    await m2.wait(1500);
    await m2.close();
    check(gh.deletes.includes(imgPath), '★ 删菜谱时仓库里的旧图也删掉（不留孤儿文件）', gh.deletes.join(' | '));
    check(!readDb().recipes.some((r) => r.id === added.id), '本地菜谱也删掉了');
    const lastRecipes = [...gh.putBodies].reverse().find((p) => p.path.includes('recipes.json'));
    const pushedRecipes = (JSON.parse(atob(String(lastRecipes?.content))) as { recipes: Array<{ image: string }> }).recipes;
    check(
      !pushedRecipes.some((r) => r.image === imgPath),
      '★ 最后推上去的菜谱库不再引用这张图',
      JSON.stringify(pushedRecipes.map((r) => r.image)),
    );
    gh.restore();
  }

  console.log('\n[同步 · 本地攒下的图，连上仓库时补传]');
  localStorage.clear();
  {
    /* 先在没有仓库的本机模式下加一条带图的菜谱 */
    const gh = installFakeGithub({});
    useDb((db) => {
      db.config!.repo = '';
      db.config!.token = '';
      db.config!.tokenMask = '';
    });
    const m = await mount('/add');
    await pickPhoto(m, '#photoInput');
    await m.wait(200);
    await m.type('#mTitle', '本地的带图菜');
    await m.click('.actionbar .btn-primary');
    await m.wait(1000);
    await m.close();
    const imgPath = readDb().recipes[0].image;
    check(gh.calls.length === 0, '★ 没连仓库时一个请求都不发（图先留在本机缓存）', gh.calls.join(' | '));
    check(cachedPhoto(imgPath) === SHOT_DATA_URL, '图的字节在本机缓存里等着');

    /* 再去首次设置里连一个空仓库：本机内容（含图）作为初始内容推上去 */
    const s = await mount('/setup');
    await fillAndConnect(s);
    await s.wait(1500);
    check(
      gh.putBodies.some((p) => p.path.includes(imgPath) && p.content === SHOT_B64),
      '★ 连上仓库后把本机攒下的图补传上去',
      gh.putBodies.map((p) => p.path).join(' | '),
    );
    check(gh.putBodies.some((p) => p.path.includes('recipes.json')), '菜谱库也一起推上去');
    await s.close();
    gh.restore();
  }

  console.log('\n[同步 · 照片：确认「在不在仓库」不再下载整张图]');
  localStorage.clear();
  {
    /* 用户实际踩的坑：本机缓存里有图的字节、仓库里也已经有同一张图（上次会话传的），
       于是每次推送都逐张去问「仓库里有没有」—— 那个接口回的正文就是整张图，
       几张截图就几 MB，手机上一次同步拖到超时（重试又快，因为内存里记下了）。
       现在只该拉一次 images/ 目录清单（路径 + sha，不含图）。 */
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: [] },
      orders: { schema: 3, updatedAt: 'x', orders: [] },
      profiles: { schema: 3, updatedAt: 'x', profiles: { a: { nickname: '小辉', updatedAt: 'x' }, b: { nickname: '', updatedAt: '—' } } },
      images: { 'images/r1.png': SHOT_B64, 'images/r2.png': SHOT_B64 },
    });
    useDb((db) => {
      db.recipes = [
        { ...db.recipes[0], id: 'r1', title: '带图的一', image: 'images/r1.png' },
        { ...db.recipes[1], id: 'r2', title: '带图的二', image: 'images/r2.png' },
      ];
    });
    rememberPhoto('images/r1.png', SHOT_DATA_URL);
    rememberPhoto('images/r2.png', SHOT_DATA_URL);

    const m = await mount('/library');
    await m.longPress('.dishrow');
    await m.clickEl(m.$$('.cardlist .dishrow')[0]); /* 长按松手补的那次 click */
    await m.click('.actionbar .btn-danger');
    await m.click('.actionbar .btn-danger');
    await m.wait(800);
    await m.wait(1200);

    const imgReads = gh.calls.filter((c) => c.startsWith('GET') && c.includes('/contents/images/'));
    check(imgReads.length === 0, '★ 不再为了「在不在仓库」下载整张图', imgReads.join(' | '));
    const trees = gh.calls.filter((c) => c.includes('/git/trees/'));
    check(trees.length === 1, '★ 只拉一次 images/ 目录清单', String(trees.length));
    check(
      gh.puts.filter((p) => p.path.includes('images/')).length === 0,
      '★ 仓库里已有的图不会重传（清单里认出来了）',
      gh.puts.map((p) => p.path).join(' | '),
    );
    check(gh.deletes.includes('images/r1.png'), '★ 删掉那张孤儿图');
    check(
      gh.deleteShas.find((d) => d.path === 'images/r1.png')?.sha === 'sha-images/r1.png-init',
      '★ 删图用的 sha 来自目录清单（没有先下载一遍）',
      JSON.stringify(gh.deleteShas),
    );
    check(readDb().recipes.length === 1, '本地也只剩一条', String(readDb().recipes.length));
    await m.close();
    gh.restore();
  }
  {
    /* 拉不到清单（老仓库 / 接口异常）时退回逐张问的老办法，不能让同步整个失败 */
    localStorage.clear();
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: [] },
      images: { 'images/r1.png': SHOT_B64 },
      treeFails: true,
    });
    useDb((db) => {
      db.recipes = [{ ...db.recipes[0], id: 'r1', title: '带图的一', image: 'images/r1.png' }];
    });
    rememberPhoto('images/r1.png', SHOT_DATA_URL);
    /* 删掉唯一一条 → 触发推送：清单拉不到，就退回「逐张读 sha」的老办法 */
    const m = await mount('/library');
    await m.longPress('.dishrow');
    await m.clickEl(m.$$('.cardlist .dishrow')[0]);
    await m.click('.actionbar .btn-danger');
    await m.click('.actionbar .btn-danger');
    check(m.html().includes('已删除 1 道菜'), '删除提示照常');
    await m.wait(800);
    await m.wait(1200);
    check(gh.deletes.includes('images/r1.png'), '清单拉不到也照常删掉那张图');
    check(!m.html().includes('刚被改过'), '★ 没有因为清单失败而报同步冲突');
    check(!readDb().config?.lastSyncError, '本机也没留下同步错误', String(readDb().config?.lastSyncError));
    await m.close();
    gh.restore();
  }
  console.log('\n[同步 · 仓库里缺图时会把本机那张补传上去]');
  localStorage.clear();
  {
    /* 用户实际遇到的情况：仓库 recipes.json 里 3 条菜谱、每条都指着自己的图，
       但 images/ 里只有 2 张（历史上那张没传成功）。本机还留着第三张的字节，
       下一次推送必须把它补上 —— 「recipes.json 里有这个引用」不等于「图已经到了」。 */
    const base = seed();
    const withImages = [
      { ...base.recipes[0], id: 'r1', title: '一道', image: 'images/r1.png' },
      { ...base.recipes[1], id: 'r2', title: '二道', image: 'images/r2.png' },
      { ...base.recipes[2], id: 'r3', title: '三道', image: 'images/r3.png' },
    ];
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: withImages },
      orders: { schema: 3, updatedAt: 'x', orders: [] },
      profiles: {
        schema: 3,
        updatedAt: 'x',
        profiles: { a: { nickname: '小辉', updatedAt: 'x' }, b: { nickname: '', updatedAt: '—' } },
      },
      images: { 'images/r1.png': SHOT_B64, 'images/r2.png': SHOT_B64 },
    });
    useDb((db) => {
      db.recipes = withImages;
    });
    rememberPhoto('images/r3.png', SHOT_DATA_URL);

    const m = await mount('/sync');
    await m.click('.btn-primary'); /* 先拉一次：recipes.json 里三条引用都在 */
    await m.wait(600);
    check(readDb().recipes.length === 3, '拉到三条（引用都在）', String(readDb().recipes.length));

    const before = gh.putBodies.length;
    await m.click('#editNamesBtn');
    await m.type('#nickPartner', '顺手同步一次');
    await m.click('#saveNamesBtn');
    await m.wait(1400);
    const imgPuts = gh.putBodies.slice(before).filter((p) => p.path.includes('images/'));
    check(
      imgPuts.length === 1 && imgPuts[0].path.includes('images/r3.png'),
      '★ 拉过之后照样把仓库里缺的那张补传（已有的两张不重传）',
      imgPuts.map((p) => p.path).join(' | ') || '（没有图片 PUT）',
    );
    check(
      !gh.calls.some((c) => c.startsWith('GET') && c.includes('/contents/images/')),
      '补传时也没下载任何一张图（还是那次目录清单）',
    );
    await m.close();
    gh.restore();
  }
  {
    /* 本机没有、仓库里也没有：这张图是真丢了，要写进日志 + 当场说一句 */
    localStorage.clear();
    const base = seed();
    const gone = [{ ...base.recipes[0], id: 'r1', title: '丢了图的那道', image: 'images/gone.png' }];
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: gone },
      orders: { schema: 3, updatedAt: 'x', orders: [] },
      profiles: {
        schema: 3,
        updatedAt: 'x',
        profiles: { a: { nickname: '小辉', updatedAt: 'x' }, b: { nickname: '', updatedAt: '—' } },
      },
    });
    useDb((db) => {
      db.recipes = gone;
    });
    const m = await mount('/sync');
    await m.click('.btn-primary');
    await m.wait(600);
    await m.click('#editNamesBtn');
    await m.type('#nickPartner', '触发推送');
    await m.click('#saveNamesBtn');
    await m.wait(1400);
    check(
      readDb().logs.some((l) => l.text.includes('本机和仓库里都没有')),
      '★ 写进同步日志，别悄悄带过',
      readDb().logs[0]?.text,
    );
    check(m.html().includes('本机和仓库里都没有'), '也当场提示一句');
    await m.close();
    gh.restore();
  }

  console.log('\n[状态容器 · 日志全量保留]');
  localStorage.clear();
  {
    useDb();
    const seedLogs = readDb().logs.length;
    const m = await mount('/recipe/r5');
    for (let i = 1; i <= 9; i++) {
      await m.click('#editRecipeBtn');
      await m.type('#editNote', `第 ${i} 次备注`);
      await m.click('.editrow .btn-sticker.primary');
    }
    await m.wait(50);
    const db = readDb();
    check(
      db.logs.length === seedLogs + 9,
      '★ 日志全量保留，不再截断到 8 条',
      `实际 ${db.logs.length}（种子 ${seedLogs} + 9）`,
    );
    check(db.logs[0].text.includes('已更新'), '最新一条排在最前');
    check(
      db.logs.filter((l) => l.text.startsWith('r5 ·')).length === 9,
      '九次改动一条都没丢',
      `实际 ${db.logs.filter((l) => l.text.startsWith('r5 ·')).length}`,
    );
    check(db.recipes.find((r) => r.id === 'r5')?.note === '第 9 次备注', '最后一次改动生效');
    await m.close();
  }

  console.log('\n[状态容器 · 切换「我是谁」是本地静默设置]');
  localStorage.clear();
  {
    useDb();
    const local = readDb();
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: local.recipes },
      orders: { schema: 3, updatedAt: 'x', orders: local.orders },
      profiles: { schema: 3, updatedAt: 'x', profiles: local.profiles },
    });
    const m = await mount('/sync');
    await m.click('.btn-primary'); // 拉一次，pushedRev 对齐
    await m.wait(400);
    const before = gh.calls.length;
    await m.clickByText('.idpick', '小红'); // 切到 b
    await m.wait(900);
    check(readDb().config?.me === 'b', '★ 切换「我是谁」落库到本机 config');
    const puts = gh.calls.slice(before).filter((c) => c.startsWith('PUT'));
    check(puts.length === 0, '★ 切身份是本地设置，不触发推送', `实际 PUT：${puts.join(',') || '（无）'}`);
    await m.close();
    gh.restore();
  }

  console.log('\n[状态容器 · 断开需二次确认并清空本地缓存]');
  localStorage.clear();
  {
    useDb();
    const m = await mount('/sync');
    check((m.$('.dang')?.textContent ?? '').includes('断开并清除本地缓存'), '默认显示断开按钮');
    await m.click('.dang');
    check((m.$('.dang')?.textContent ?? '').includes('再点一次'), '第一次点击变成确认文案');
    check(readDb().config !== null, '第一次点击不会真的断开');
    await m.click('.dang');
    await m.wait(100);
    check(readDb().config === null && readDb().configured === false, '★ 二次点击 → 断开并清空配置');
    await m.close();
  }
}

/* ═══════════ 七、组件与界面边界 ═══════════ */

async function edgeChecks() {
  console.log('\n[边界 · 详情找不到菜]');
  localStorage.clear();
  {
    useDb((db) => {
      db.recipes = [];
    });
    const m = await mount('/recipe/r1');
    check(m.html().includes('这道菜不见了'), '菜谱库为空时详情给占位卡');
    check(m.html().includes('回菜谱库'), '占位卡带返回入口');
    await m.close();
  }

  console.log('\n[边界 · 点单随机 / 手输去重 / 长度]');
  useDb();
  {
    const m = await mount('/order');
    const input = m.$('.manualrow input');
    check(input?.getAttribute('maxlength') === '18', '手动菜名限制 18 字', `实际 ${input?.getAttribute('maxlength')}`);

    await m.clickByText('.btn-sticker.solid', '随机加一道');
    check(m.$$('.sel').length === 1, '随机加一道 → 组合器出现 1 道');

    await m.type('.manualrow input', '手抓饼加蛋');
    await m.clickByText('.manualrow .btn-sticker', '加进这顿');
    check(m.$$('.sel').length === 2, '手动加一道进组合器');
    await m.type('.manualrow input', '手抓饼加蛋');
    await m.clickByText('.manualrow .btn-sticker', '加进这顿');
    check(m.$$('.sel').length === 2, '重复的临时菜被去重', `实际 ${m.$$('.sel').length}`);

    await m.type('.manualrow input', '');
    await m.clickByText('.manualrow .btn-sticker', '加进这顿');
    check(m.html().includes('先输入一道菜名'), '空输入 → 提示先输入菜名');
    await m.close();
  }

  console.log('\n[边界 · 点单挑选网格：不显示来源 + 支持搜索]');
  useDb();
  {
    const m = await mount('/order');
    const picks = () => m.$$('.dishgrid .pick');
    const pickTitles = () => picks().map((p) => (p.querySelector('.t')?.textContent ?? '').trim());

    /* 每张卡片只露缩略图 + 菜名，不再挂来源平台 */
    check(picks().length === 6, '挑选网格列出全部 6 道', `实际 ${picks().length}`);
    check(m.$$('.dishgrid .pick .src').length === 0, '★ 挑选网格里没有来源徽章');
    check(m.$$('.dishgrid .pick .s').length === 0, '★ 挑选网格里没有来源小圆点');
    check(
      !picks().some((p) => /小红书|B站|抖音|手动/.test(p.textContent ?? '')),
      '★ 卡片文案里不出现来源平台名',
      picks().map((p) => p.textContent).join(' | '),
    );
    check(
      picks().every((p) => p.querySelector('.pt') !== null && p.querySelector('.t') !== null),
      '缩略图与菜名还在',
    );

    /* 搜索：菜名 / 备注 / 作者都能命中，只过滤可见项 */
    await m.type('.picksearch input', '椰');
    check(pickTitles().join(' / ') === '椰子鸡火锅 / 芒果糯米饭', '★ 搜「椰」→ 只剩 2 道（备注里的椰浆也算）', pickTitles().join(' / '));
    check(m.html().includes('找到 2 道「椰」'), '★ 提示找到 2 道');
    await m.click('.picksearch .sclear');
    check(picks().length === 6, '★ 清除搜索 → 恢复全部 6 道', `实际 ${picks().length}`);

    await m.type('.picksearch input', '海南小厨娘');
    check(pickTitles().join(' / ') === '椰子鸡火锅', '★ 按作者搜得到', pickTitles().join(' / '));
    await m.type('.picksearch input', '九层塔');
    check(pickTitles().join(' / ') === '台式三杯鸡', '按备注也能搜到', pickTitles().join(' / '));

    /* 搜不中：给空态卡，一键清除搜索 */
    await m.type('.picksearch input', 'zzz');
    check(picks().length === 0, '搜不中 → 网格空');
    check(m.html().includes('没找到「zzz」'), '★ 搜不中给「没找到」空态卡');
    await m.clickByText('.dishgrid .grid-empty .btn-sticker', '清除搜索');
    check(picks().length === 6, '空态卡上的「清除搜索」恢复全部', `实际 ${picks().length}`);

    /* 搜索只影响挑选网格，已经选好的菜留在组合器里 */
    await m.clickByText('.pick', '椰子鸡火锅');
    await m.type('.picksearch input', '番茄');
    check(pickTitles().join(' / ') === '番茄炖牛腩', '过滤后网格只剩命中的那道');
    check(
      m.$$('.sel').length === 1 && (m.$('.sel')?.textContent ?? '').includes('椰子鸡火锅'),
      '★ 已选不受搜索影响（还堆在组合器里）',
      m.$('.sel')?.textContent ?? '',
    );
    await m.close();
  }
  useDb((db) => {
    db.recipes = [];
  });
  {
    const m = await mount('/order');
    check(m.$('.picksearch') === null, '★ 菜谱库为空时不摆搜索框');
    check(m.html().includes('菜谱库还是空的'), '空态的「去添加」引导还在');
    await m.close();
  }

  console.log('\n[边界 · 「今日点单」只列我点的]');
  useDb();
  {
    const m = await mount('/order');
    const html = m.html();
    check(html.includes('1 份'), 'me=a → 只数我点的单（1 份）');
    check(!html.includes('少放辣'), '不显示对方点的单（o2 的备注）');
    await m.close();
  }

  console.log('\n[边界 · 今日点单卡片的超长标题不溢出]');
  localStorage.clear();
  {
    /* 单子是剪藏来的话，标题可能是一整句视频标题。以前那个 .ellip 挂在 span 上 ——
       text-overflow 对内联盒不生效，文字直接溢出卡片被裁掉，还压住右边的箭头。 */
    const LONG = '西红柿炒鸡蛋，你就像我这样做，真的很下饭！';
    useDb((db) => {
      db.orders[0].items = [{ recipeId: null, dishName: LONG }]; /* o1：我今天的那单 */
    });
    const m = await mount('/order');
    const t = m.$('.osum .ob .t');
    check(t?.textContent === LONG, '★ 长标题整句留在 DOM 里（截断交给 CSS，不是切字符串）', t?.textContent ?? '');
    check(!t?.classList.contains('ellip'), '★ 不再用对内联盒无效的 .ellip');
    /* 样式那半边：两行截断，冒烟里样式表是空的，只能读文件验 */
    const css = readFileSync('src/styles/screens.css', 'utf8');
    check(
      /\.s-order \.osum \.ob \.t\s*\{[^}]*-webkit-line-clamp:\s*2/.test(css),
      '★ 今日点单标题按两行截断',
    );
    check(/\.s-order \.osum \.ob \.t\s*\{[^}]*overflow:\s*hidden/.test(css), '截断框自己兜住溢出');
    await m.close();
  }

  console.log('\n[边界 · 历史点单默认折叠，只露数量]');
  useDb((db) => {
    db.config!.me = 'b'; // b 点的单：o2 今天、o3 昨天
  });
  {
    const yesterday = readDb().orders.find((o) => o.id === 'o3')!.createdAt;
    const m = await mount('/order');
    const html = m.html();
    check(html.includes('今日点单') && html.includes('历史点单'), '点单页同时有今日与历史两段');
    check(html.includes('1 份'), '今天 1 份 / 历史 1 份都显示数量', `实际片段：${html.length}`);
    check(!html.includes(yesterday), '历史单默认折叠，不铺开卡片');
    await m.clickByText('.morebar', '历史点单');
    check(m.html().includes(yesterday), '点历史条 → 展开昨天的单');
    await m.close();
  }

  console.log('\n[边界 · 已做完默认折叠，只露数量]');
  useDb(); // me=a：掌勺屏看到 o2（待接）+ o3（已做完，昨天）
  {
    const yesterday = readDb().orders.find((o) => o.id === 'o3')!.createdAt;
    const m = await mount('/cook');
    check(m.html().includes('已做完'), '掌勺页有「已做完」折叠条');
    check(!m.html().includes(yesterday), '已完成单默认折叠，不铺开卡片');
    await m.clickByText('.morebar', '已做完');
    check(m.html().includes(yesterday), '点「已做完」→ 展开完成单');
    await m.close();
  }

  console.log('\n[边界 · 同步日志默认折叠 + 滚动懒加载]');
  localStorage.clear();
  {
    useDb((db) => {
      db.logs = Array.from({ length: 45 }, (_, i) => ({
        t: `${dateKey()} 10:${String(i).padStart(2, '0')}`,
        kind: 'ok' as const,
        text: `第 ${i + 1} 条记录`,
      }));
    });
    const m = await mount('/sync');
    check(m.$$('.logrow').length === 0, '★ 日志默认折叠，一条都不铺开');
    check(m.html().includes('最近同步') && m.html().includes('45 条'), '折叠条上显示总条数', m.$('.mb-c')?.textContent ?? '');

    await m.clickByText('.morebar', '最近同步');
    check(m.$$('.logrow').length === 20, '展开 → 先渲染 20 条', `实际 ${m.$$('.logrow').length}`);
    check(m.html().includes('已显示 20 / 45 条'), '给出「已显示 / 总数」进度');

    await m.scroll('.logscroll');
    check(m.$$('.logrow').length === 40, '滚到底 → 再放 20 条', `实际 ${m.$$('.logrow').length}`);
    await m.scroll('.logscroll');
    check(m.$$('.logrow').length === 45, '最后一批只补到 45 条，不越界', `实际 ${m.$$('.logrow').length}`);
    await m.scroll('.logscroll');
    check(m.$$('.logrow').length === 45, '到底后再滚不会重复加载', `实际 ${m.$$('.logrow').length}`);
    check(m.html().includes('已全部加载（共 45 条）'), '到底后提示「已全部加载」');

    await m.clickByText('.morebar', '最近同步');
    check(m.$$('.logrow').length === 0, '再点折叠条 → 收回');
    await m.close();
  }

  console.log('\n[边界 · 掌勺点菜弹出菜品详情]');
  localStorage.clear();
  {
    useDb();
    const m = await mount('/cook');
    check(m.$('.dishsheet') === null, '默认不弹详情');
    check(m.$$('.cc-items .dit').length === 2, '待接的单里有 2 道菜可点', `实际 ${m.$$('.cc-items .dit').length}`);

    await m.clickByText('.cc-items .dit', '溏心蛋葱油拌面');
    const sheet = m.$('.dishsheet');
    check(sheet !== null, '★ 点一道菜 → 弹出菜品详情');
    check(
      sheet?.getAttribute('role') === 'dialog' && sheet?.getAttribute('aria-modal') === 'true',
      '弹窗是对话框语义',
    );
    const html = m.html();
    check(html.includes('我的备注') && html.includes('葱油一次多熬一点'), '★ 详情里带这道菜的备注');
    check(html.includes('深夜食堂阿伟') && html.includes('B站'), '带来源与作者');
    check(html.includes('查看原文') && html.includes('https://b23.tv/scallion-noodle'), '★ 带原文链接');

    await m.click('.ds-close');
    check(m.$('.dishsheet') === null, '点 × 关掉详情');

    await m.clickByText('.cc-items .dit', '溏心蛋葱油拌面');
    await m.click('.ds-mask');
    check(m.$('.dishsheet') === null, '点遮罩也能关');

    await m.clickByText('.cc-items .dit', '溏心蛋葱油拌面');
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    check(m.$('.dishsheet') === null, '按 Esc 也能关');
    await m.close();
  }
  {
    /* 临时加的菜（点单时手输的）菜谱库里没有 → 只给说明，不硬凑原文链接 */
    useDb((db) => {
      const o = db.orders.find((x) => x.id === 'o2')!;
      o.items = [...o.items, { recipeId: null, dishName: '临时加的蛋花汤' }];
    });
    const m = await mount('/cook');
    await m.clickByText('.cc-items .dit', '临时加的蛋花汤');
    check(m.html().includes('这道菜是点单时临时加的'), '★ 临时菜给出说明');
    check(!m.html().includes('查看原文'), '临时菜不显示「查看原文」');
    await m.close();
  }

  console.log('\n[边界 · 今日菜单底部同步提示]');
  useDb();
  {
    const m = await mount('/cook');
    check(m.html().includes('每 1 分钟自动拉取'), 'autoPull + 60s → 每 1 分钟自动拉取');
    await m.close();
  }
  {
    useDb((db) => {
      db.config!.autoPull = false;
      db.config!.intervalSec = 0;
    });
    const m = await mount('/cook');
    check(m.html().includes('仅手动同步'), '关闭自动拉取 → 仅手动同步');
    await m.close();
  }

  console.log('\n[边界 · 走查参数 ?state=error]');
  useDb();
  {
    const m = await mount('/library?state=error');
    check(m.html().includes('菜谱没拉下来'), '?state=error → 菜谱库错误态');
    await m.close();
  }

  console.log('\n[边界 · Toast 最多同时 3 条]');
  useDb();
  {
    const m = await mount('/order');
    for (let i = 0; i < 5; i++) {
      await m.clickByText('.manualrow .btn-sticker', '加进这顿');
    }
    await m.wait(30);
    check(m.$$('.toast').length <= 3, '连续触发 5 次提示，DOM 里最多 3 条', `实际 ${m.$$('.toast').length}`);
    await m.close();
  }

  console.log('\n[边界 · 设置页仓库与分支同一行]');
  localStorage.clear();
  {
    useDb();
    const m = await mount('/sync');
    const rows = m.$$('.kvrow').map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim());
    const repoRow = rows.find((t) => t.includes('当前仓库'));
    check(
      repoRow !== undefined && repoRow.includes('xiaoman/family-recipes') && repoRow.includes('main'),
      '★ 当前仓库与分支显示在同一行',
      repoRow,
    );
    check(!rows.some((t) => t.startsWith('分支')), '分支不再单独占一行');
    await m.close();
  }

  console.log('\n[边界 · 设置格图标反映同步状态]');
  useDb();
  {
    const m = await mount('/library');
    check(m.$('.tabbar .tab.sync-ok') !== null, '★ 已同步 → 设置格图标变绿');
    check(m.$('.tabbar .tab.sync-err') === null, '没出错就不该是红的');
    check(m.$('.pill') === null, '★ 菜谱库顶栏不再出现同步状态');
    await m.close();
  }
  {
    useDb((db) => {
      db.config!.repo = '';
      db.config!.token = '';
    });
    const m = await mount('/library');
    check(
      m.$('.tabbar .tab.sync-ok') === null && m.$('.tabbar .tab.sync-err') === null,
      '★ 未连接 → 设置格图标不染色（也算不上「已同步」）',
    );
    await m.close();
  }
  {
    /* 同步失败 → 设置格图标变红。用真实的失败响应（500）走一遍完整的失败分类。 */
    useDb();
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'boom' }), { status: 500 })) as typeof fetch;
    const m = await mount('/sync');
    check(m.$('.topbar .pill') === null, '★ 设置页顶栏不再挂「已同步」标签');
    const pt = (m.$('.panel.ok .pt')?.textContent ?? '').trim();
    check(SYNC_TIME_RE.test(pt.replace('已同步 · ', '')), '★ 状态面板里的已同步时间精确到秒', pt);
    await m.click('.btn-primary'); /* 立即同步 */
    await m.wait(600);
    check(m.$('.tabbar .tab.sync-err') !== null, '★ 同步失败 → 设置格图标变红');
    check(m.$('.tabbar .tab.sync-ok') === null, '失败时不会同时显示成已同步');
    await m.close();
    globalThis.fetch = prevFetch;
  }
  {
    const m = await mount('/order');
    check(m.$('.tabbar .tab.sync-ok') !== null, '点单屏：图标照样带状态色');
    check(m.$('.pill') === null, '★ 点单屏顶栏也没有同步状态');
    await m.close();
  }

  console.log('\n[边界 · 点第二格会顺手同步一次]');
  localStorage.clear();
  {
    useDb();
    const local = readDb();
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: local.recipes },
      orders: { schema: 3, updatedAt: 'x', orders: local.orders },
      profiles: { schema: 3, updatedAt: 'x', profiles: local.profiles },
    });
    const m = await mount('/library');
    await m.wait(900); /* 挂载后的自动推送先落定，再看点第二格会不会额外拉一次 */
    const before = gh.calls.length;
    await m.clickByText('.tabbar .tab', '点单');
    await m.wait(900);
    const gets = gh.calls.slice(before).filter((c) => c.startsWith('GET'));
    check(gets.length >= 3, '★ 点第二格 → 真的拉了一次仓库（三份文件）', `实际 GET ${gets.length} 次`);
    check(!m.html().includes('同步完成'), '顺手同步不弹「同步完成」提示');
    await m.close();
    gh.restore();
  }
  {
    /* 慢响应把「同步中」这一瞬拉长，才断言得到图标状态 */
    useDb();
    const local = readDb();
    const prevFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) =>
      new Promise<Response>((resolve) => {
        const url = String(input);
        const data = url.includes('recipes.json')
          ? { schema: 3, updatedAt: 'x', recipes: local.recipes }
          : url.includes('orders.json')
            ? { schema: 3, updatedAt: 'x', orders: local.orders }
            : { schema: 3, updatedAt: 'x', profiles: local.profiles };
        window.setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify({ sha: 's', content: utf8b64(JSON.stringify(data)) }), { status: 200 }),
            ),
          400,
        );
      })) as typeof fetch;

    const m = await mount('/library');
    await m.wait(900);
    await m.clickByText('.tabbar .tab', '点单'); /* 触发同步，不等它结束 */
    check(m.$('.tabbar .tab.sync-busy') !== null, '★ 同步中 → 设置格图标高亮闪烁旋转');
    check(m.$('.tabbar .tab.sync-busy svg') !== null, '转的就是那枚图标');
    await m.wait(1200);
    check(m.$('.tabbar .tab.sync-busy') === null, '同步结束 → 不再闪');
    check(m.$('.tabbar .tab.sync-ok') !== null, '同步结束 → 回到「已同步」的绿');
    await m.close();
    globalThis.fetch = prevFetch;
  }
  {
    /* CSS 那半边（冒烟里样式表是空的，只能读文件验） */
    const css = readFileSync('src/styles/app.css', 'utf8');
    check(/\.tab\.sync-busy\s*\{[^}]*syncblink/.test(css), '★ 同步中的图标在闪');
    check(/\.tab\.sync-busy svg\s*\{[^}]*odspin/.test(css), '★ 同步中的图标在转');
    check(/prefers-reduced-motion[^{]*\{[^}]*\.tab\.sync-busy/.test(css), '系统关了动效时不再闪 / 转');
  }

  console.log('\n[边界 · 四个一级页的顶栏结构一致]');
  useDb();
  {
    /* 菜谱库 / 点单 / 掌勺 / 设置共用同一套顶栏：日期行（greeting）+ 标题行（navrow > ptitle）。
       点单 / 掌勺只是把角色开关放进标题行右端，日期与标题的位置 / 间距不该跟着变。
       （样式表在冒烟里是空的，布局约束靠 DOM 结构与样式文件断言一起兜） */
    for (const path of ['/library', '/order', '/cook', '/sync']) {
      const m = await mount(path);
      const topbar = m.$('.topbar');
      const kids = Array.from(topbar?.children ?? []).map((c) => c.className);
      check(
        kids.length === 2 && kids[0].includes('greeting') && kids[1].includes('navrow'),
        `★ ${path} 顶栏 = 日期行 + 标题行`,
        kids.join(' | '),
      );
      check(m.$('.topbar .toprow') === null, `${path} 不再有单独的开关行（曾经把标题顶下去）`);
      check(m.$('.topbar .navrow .ptitle') !== null, `${path} 标题就在 navrow 里`);
      const title = m.$('.ptitle');
      check(
        !/font-size/.test(title?.getAttribute('style') ?? ''),
        `★ ${path} 标题字号不再被单页改小（统一走 .ptitle）`,
        title?.getAttribute('style') ?? '',
      );
      await m.close();
    }
    const o = await mount('/order');
    check(o.$('.topbar .navrow > .rolesw') !== null, '★ 点单：开关挂在标题行右端');
    check(o.$('.topbar > .greeting') !== null, '★ 点单：日期仍是顶栏第一行（位置与设置页一致）');
    await o.close();
    const c = await mount('/cook');
    check(c.$('.topbar .navrow > .rolesw') !== null, '★ 掌勺：开关同样挂在标题行右端');
    check(c.$('.topbar > .greeting') !== null, '★ 掌勺：日期行同样是顶栏第一行');
    await c.close();
  }
  useDb();

  console.log('\n[边界 · 角色切换贴在第二格屏右上角]');
  localStorage.clear();
  {
    useDb();
    const local = readDb();
    const gh = installFakeGithub({
      recipes: { schema: 3, updatedAt: 'x', recipes: local.recipes },
      orders: { schema: 3, updatedAt: 'x', orders: local.orders },
      profiles: { schema: 3, updatedAt: 'x', profiles: local.profiles },
    });

    const m = await mount('/order');
    check(m.$('.topbar .rolesw') !== null, '★ 点单屏右上角有角色开关');
    check(m.$('.topbar > .navrow > .rolesw') !== null, '开关挂在标题行（navrow）的右端');
    check((m.$('.rolesw button.on')?.textContent ?? '') === '点单', '当前角色 → 开关高亮「点单」');
    check((m.$$('.tabbar .tab')[1]?.textContent ?? '').includes('点单'), '点单角色 → 底部第二格是「点单」');

    await m.wait(900); /* 先让挂载后的自动推送落定，再看切角色会不会额外推 */
    const before = gh.calls.length;
    await m.clickByText('.rolesw button', '掌勺');
    await m.wait(900);
    check(readDb().config?.view === 'cook', '★ 切角色落库到本机 config.view');
    check((m.$$('.tabbar .tab')[1]?.textContent ?? '').includes('掌勺'), '★ 切角色后底部第二格立刻变「掌勺」');
    check(m.html().includes('今日菜单'), '★ 在点单屏切角色 → 直接落到掌勺屏');
    const puts = gh.calls.slice(before).filter((c) => c.startsWith('PUT'));
    check(puts.length === 0, '★ 切角色是本地设置，不触发推送', `实际 PUT：${puts.join(',') || '（无）'}`);
    const gets = gh.calls.slice(before).filter((c) => c.startsWith('GET'));
    check(gets.length >= 3, '★ 切角色会顺手同步一次（拉三份文件）', `实际 GET ${gets.length} 次`);
    check(readDb().config?.view === 'cook', '顺手同步不会拿旧配置把刚切的角色冲掉');
    await m.close();

    useDb((db) => {
      db.config!.view = 'cook';
    });
    const m2 = await mount('/cook');
    check(m2.$('.topbar .rolesw') !== null, '掌勺屏右上角也有角色开关');
    check((m2.$('.rolesw button.on')?.textContent ?? '') === '掌勺', '掌勺角色 → 开关高亮「掌勺」');
    check(m2.$('.topbar > .navrow > .rolesw') !== null, '掌勺屏：开关同样挂在标题行的右端');
    await m2.clickByText('.rolesw button', '点单');
    await m2.wait(900);
    check(readDb().config?.view === 'order', '从掌勺屏切回点单');
    check(m2.html().includes('点一顿饭'), '切回点单 → 落到点单屏');
    await m2.close();

    const s = await mount('/sync');
    check(!s.html().includes('当前角色'), '★ 角色切换已从设置页移走');
    await s.close();

    gh.restore();
  }

  console.log('\n[边界 · 掌勺没做完的单在角色开关上有红点]');
  localStorage.clear();
  {
    /* 种子里 me=a：对方点的一单待接（o2）+ 一单已完成（o3）→ 只算没做完的 1 单 */
    useDb();
    const m = await mount('/order');
    const badge = m.$('.rolesw .badge');
    check(badge?.textContent?.trim() === '1', '★ 掌勺有没做完的单 → 开关右上角挂数字红点', `实际「${badge?.textContent ?? '（无）'}」`);
    check(m.$('.rolesw button.on')?.textContent === '点单', '红点不影响原来的高亮态');
    check((badge?.getAttribute('title') ?? '').includes('1 单没做完'), '红点带一句说明');
    await m.close();
  }
  {
    /* 对方那几单全做完 → 红点消失 */
    useDb((db) => {
      db.orders = db.orders.map((o) => (o.placedBy === 'b' ? { ...o, status: 'done' as const } : o));
    });
    const m = await mount('/order');
    check(m.$('.rolesw .badge') === null, '★ 没有没做完的单 → 不显示红点');
    await m.close();
  }
  {
    /* 自己点的单不算掌勺的活；掌勺屏自己也带着这枚红点 */
    useDb();
    const m = await mount('/cook');
    check(m.$('.rolesw .badge')?.textContent?.trim() === '1', '掌勺屏同样带红点（切过去也看得见）');
    check((m.$('.rolesw button[aria-label]')?.getAttribute('aria-label') ?? '').includes('1 单没做完'), '按钮的无障碍名带上单数');
    await m.close();
  }

  console.log('\n[边界 · 时间只在详情页显示]');
  localStorage.clear();
  {
    useDb();
    const r5 = readDb().recipes.find((r) => r.id === 'r5')!;
    const m = await mount('/library');
    const row = m.$$('.cardlist .dishrow')[4]; /* r5 台式三杯鸡 */
    check(m.$('.dishrow .when') === null, '★ 列表行里没有时间栏');
    check(!(row?.textContent ?? '').includes(r5.updatedAt), '★ 列表不显示更新时间', row?.textContent ?? '');
    check(!m.html().includes(r5.updatedAt), '整页都找不到更新时间');
    await m.close();
  }
  {
    useDb();
    const r5 = readDb().recipes.find((r) => r.id === 'r5')!;
    const m = await mount('/recipe/r5');
    check(m.html().includes(`收藏于 ${r5.createdAt}`), '★ 详情页显示收藏时间');
    check(m.html().includes(`更新于 ${r5.updatedAt}`), '★ 详情页显示更新时间');
    check(m.html().includes('做法') && m.html().includes('麻油小火煸姜片到卷边'), '★ 详情页展示做法');
    await m.close();
  }
  {
    /* 改完菜谱：更新时间变成带年月日的当前时刻，收藏时间不动 */
    useDb();
    const r5 = readDb().recipes.find((r) => r.id === 'r5')!;
    const m = await mount('/recipe/r5');
    await m.click('#editRecipeBtn');
    await m.type('#editNote', '改一下备注');
    await m.click('.editrow .btn-sticker.primary');
    await m.wait(200);
    check(m.html().includes(`收藏于 ${r5.createdAt}`), '★ 改完收藏时间不变');
    check(m.html().includes(`更新于 ${dateKey()} `), '★ 改完更新时间变成带年月日的当前时刻');
    check(!m.html().includes('更新于 刚刚'), '★ 更新时间不再只剩「刚刚」');
    await m.close();
  }
  {
    /* 老缓存 / 老仓库里的菜谱没有 createdAt → 规整时拿 updatedAt 顶上 */
    const legacy = {
      id: 'r9',
      title: '老菜谱',
      source: 'red',
      url: 'https://example.com/old',
      author: '旧版本',
      art: '',
      note: '',
      updatedAt: '上周',
    } as unknown as Recipe;
    check(normalizeRecipes([legacy])[0].createdAt === '上周', '★ 缺 createdAt 的老菜谱用 updatedAt 顶上');
    check(normalizeRecipes([legacy])[0].steps === '', '缺做法的老菜谱补空串');
    useDb((db) => {
      db.recipes = [legacy];
    });
    const m = await mount('/recipe/r9');
    check(m.html().includes('收藏于 上周'), '老数据能正常显示收藏时间');
    check(!m.html().includes('undefined'), '页面里不会冒出 undefined');
    await m.close();
  }

  console.log('\n[边界 · 记录时间都必须带年月日]');
  {
    check(DATE_TIME_RE.test(nowStamp()), '★ nowStamp 返回「年-月-日 时:分」', nowStamp());
    check(/^\d{4}-\d{2}-\d{2}$/.test(dateKey()), '★ dateKey 返回完整日期', dateKey());

    /* 示例数据里每一条记录下来的时间都必须带年月日 */
    const s = seed();
    const rows: Array<[string, string]> = [
      ['db.updatedAt', s.updatedAt],
    ];
    s.recipes.forEach((r) => rows.push([`${r.id}.createdAt`, r.createdAt], [`${r.id}.updatedAt`, r.updatedAt]));
    s.orders.forEach((o) => rows.push([`${o.id}.createdAt`, o.createdAt], [`${o.id}.updatedAt`, o.updatedAt]));
    s.logs.forEach((l, i) => rows.push([`logs[${i}].t`, l.t]));
    const bad = rows.filter(([, v]) => !DATE_TIME_RE.test(v));
    check(bad.length === 0, '★ 示例数据里每条记录时间都带年月日', bad.map(([k, v]) => `${k}=${v}`).join('; '));

    /* 同步时间比记录时间更细一档：要精确到秒，设置页那行「已同步 · …」才看得出又同步过 */
    check(SYNC_TIME_RE.test(s.config!.lastPulledAt), '★ 同步时间精确到秒（lastPulledAt）', s.config!.lastPulledAt);
    check(SYNC_TIME_RE.test(s.config!.lastPushedAt), '★ 同步时间精确到秒（lastPushedAt）', s.config!.lastPushedAt);

    /* 新加的菜谱同样带年月日 */
    useDb();
    const m = await mount('/recipe/r5');
    await m.click('#editRecipeBtn');
    await m.type('#editNote', '再看一眼时间');
    await m.click('.editrow .btn-sticker.primary');
    await m.wait(200);
    const edited = readDb().recipes.find((r) => r.id === 'r5')!;
    check(DATE_TIME_RE.test(edited.updatedAt), '★ 改完菜谱的更新时间带年月日', edited.updatedAt);
    await m.close();
  }

  console.log('\n[边界 · 详情页改菜名 / 原文出处 / 备注]');
  localStorage.clear();
  {
    useDb();
    const m = await mount('/recipe/r5');
    await m.click('#editRecipeBtn');
    check(
      m.$('#editTitle') !== null && m.$('#editUrl') !== null && m.$('#editNote') !== null,
      '★ 编辑表单有菜名 / 原文出处 / 备注三个字段',
    );
    check(m.value('#editTitle') === '台式三杯鸡', '带出当前菜名', m.value('#editTitle'));

    /* 菜名清空 → 不保存，并给出提示 */
    await m.type('#editTitle', '   ');
    await m.click('.editrow .btn-sticker.primary');
    await m.wait(300);
    check(readDb().recipes.find((r) => r.id === 'r5')!.title === '台式三杯鸡', '★ 菜名清空不允许保存');
    check(m.html().includes('菜名不能为空'), '给出菜名必填提示');

    await m.type('#editTitle', '三杯鸡（改良版）');
    await m.type('#editUrl', 'https://www.xiachufang.com/recipe/100');
    await m.type('#editNote', '九层塔最后放，关火再拌。');
    await m.click('.editrow .btn-sticker.primary');
    await m.wait(300);
    const r5 = readDb().recipes.find((r) => r.id === 'r5')!;
    check(
      r5.title === '三杯鸡（改良版）' && r5.url === 'https://www.xiachufang.com/recipe/100' && r5.note === '九层塔最后放，关火再拌。',
      '★ 菜名 / 原文出处 / 备注都落库',
      JSON.stringify({ title: r5.title, url: r5.url, note: r5.note }),
    );
    check(m.html().includes('三杯鸡（改良版）'), '改完详情页立刻显示新菜名');
    check(m.html().includes('https://www.xiachufang.com/recipe/100'), '原文出处也跟着更新');
    check(readDb().logs.some((l) => l.text.includes('已更新')), '改菜谱写同步日志');
    await m.close();
  }

  console.log('\n[边界 · 详情页删除菜谱（二次确认）]');
  localStorage.clear();
  {
    useDb();
    const m = await mount('/recipe/r5');
    check(readDb().recipes.length === 6, '删之前 6 条');
    await m.clickByText('.dang', '删除这道菜');
    check(m.html().includes('再点一次'), '第一次点击只是要确认');
    check(readDb().recipes.length === 6, '★ 确认之前不真删');
    await m.clickByText('.dang', '再点一次');
    await m.wait(100);
    check(readDb().recipes.length === 5, '★ 二次确认后删掉', `实际 ${readDb().recipes.length}`);
    check(!readDb().recipes.some((r) => r.id === 'r5'), '删的正是这一条');
    check(readDb().logs.some((l) => l.text.includes('已删除菜谱')), '删除写同步日志');
    check(m.html().includes('我的菜谱库'), '删完回到菜谱库');
    await m.close();
  }

  console.log('\n[边界 · 菜谱库列表行走紧凑布局]');
  {
    /* 列表行调矮：缩略图列 56px、上下内边距 8px，骨架屏跟列表行同尺寸（样式表在冒烟里是空的，只能读文件断言） */
    const css = readFileSync('src/styles/app.css', 'utf8');
    check(/\.dishrow\s*\{[^}]*grid-template-columns:\s*56px 1fr/.test(css), '★ 列表行缩略图列 56px');
    check(/\.dishrow\s*\{[^}]*padding:\s*8px 0/.test(css), '★ 列表行上下内边距收到 8px');
    check(/\.thumb\s*\{[^}]*width:\s*56px; height:\s*56px/.test(css), '★ 菜品图片缩到 56px');
    check(/\.thumb\s*\{[^}]*border-radius:\s*14px/.test(css), '缩略图圆角跟着调小');
    check(/\.sk-row\s*\{[^}]*grid-template-columns:\s*56px 1fr[^}]*padding:\s*9px 0/.test(css), '骨架屏行跟列表行同尺寸');
    check(/\.sk-thumb\s*\{[^}]*width:\s*56px; height:\s*56px/.test(css), '骨架屏缩略图同样 56px');
  }

  console.log('\n[边界 · 菜谱库长按进多选，多选删除]');
  localStorage.clear();
  {
    useDb();
    const m = await mount('/library');
    check(m.$$('.cardlist .dishrow').length === 6, '6 条菜谱', `实际 ${m.$$('.cardlist .dishrow').length}`);
    check(m.$('.selbar') === null && m.$('.actionbar') === null, '默认不在多选模式');

    /* 按一下就松 → 不算长按 */
    await m.pointerDown('.dishrow');
    await m.wait(150);
    await m.pointerUp('.dishrow');
    await m.wait(600);
    check(m.$('.selbar') === null, '★ 短按不进多选');

    await m.longPress('.dishrow');
    check(m.$('.selbar') !== null, '★ 长按 → 进多选模式（不再是悬浮删除气泡）');
    check(m.html().includes('已选 1 项'), '长按的那条已经被勾上', m.text('.selcount'));
    check(m.$('.tip') === null, '★ 不再弹悬浮删除气泡');
    check(m.$('.dishrow.pick.on') !== null, '被勾上的那条有选中态');
    check(m.$('.s-detail') === null, '也没有顺带跳进详情页');

    /* 真机上长按松手会补一次 click：这次要吞掉，别把刚勾上的又取消 */
    await m.clickEl(m.$$('.cardlist .dishrow')[0]);
    check(m.html().includes('已选 1 项'), '长按之后补的那次 click 被吞掉', m.text('.selcount'));

    /* 再点两条 → 多选 */
    await m.clickEl(m.$$('.cardlist .dishrow')[1]);
    await m.clickEl(m.$$('.cardlist .dishrow')[2]);
    check(m.html().includes('已选 3 项'), '★ 逐条点选可多选', m.text('.selcount'));
    /* 再点一次取消勾选 */
    await m.clickEl(m.$$('.cardlist .dishrow')[2]);
    check(m.html().includes('已选 2 项'), '再点一次取消勾选', m.text('.selcount'));
    check(m.$('.s-detail') === null, '多选模式下点条目不进详情');

    /* 全选 / 取消全选 */
    await m.clickByText('.selbar .inlinebtn', '全选');
    check(m.html().includes('已选 6 项'), '★ 「全选」勾上当前列表全部', m.text('.selcount'));
    await m.clickByText('.selbar .inlinebtn', '取消全选');
    check(
      m.$('.selbar') !== null && m.html().includes('已选 0 项'),
      '★ 「取消全选」不退出多选，只是没勾任何一条',
      m.text('.selcount'),
    );
    check(
      (m.$('.actionbar .btn-danger') as HTMLButtonElement).disabled,
      '★ 一条没勾时删除键不可点（但选择模式还在）',
    );

    /* 反选到一条不剩也留在多选模式 */
    await m.clickEl(m.$$('.cardlist .dishrow')[0]);
    check(m.html().includes('已选 1 项'), '点一条勾上', m.text('.selcount'));
    await m.clickEl(m.$$('.cardlist .dishrow')[0]);
    check(
      m.$('.selbar') !== null && m.html().includes('已选 0 项'),
      '★ 反选到一条不剩仍在多选模式',
      m.text('.selcount'),
    );

    /* 删除要二次确认 */
    await m.longPress('.dishrow');
    await m.clickEl(m.$$('.cardlist .dishrow')[0]); /* 长按松手补的那次 click（被吞掉） */
    await m.clickEl(m.$$('.cardlist .dishrow')[1]);
    check(m.html().includes('已选 2 项'), '勾上两条', m.text('.selcount'));
    await m.click('.actionbar .btn-danger');
    check(readDb().recipes.length === 6, '第一次点删除只是变确认文案', String(readDb().recipes.length));
    check(m.html().includes('再点一次，删除 2 道菜'), '按钮变成二次确认');
    await m.click('.actionbar .btn-danger');
    check(readDb().recipes.length === 4, '★ 二次确认后两条一起删掉', String(readDb().recipes.length));
    check(!readDb().recipes.some((r) => r.title === '番茄炖牛腩'), '删的是勾选的那两条之一');
    check(readDb().logs.some((l) => l.text.includes('已删除 2 道菜谱')), '★ 多选删除只写一条日志', readDb().logs[0]?.text);
    check(m.$('.selbar') === null && m.$('.actionbar') === null, '删完退出多选');
    check(m.html().includes('已删除 2 道菜'), '给出删除提示');
    await m.close();
  }
  {
    /* 长按之后紧接着的那次 click 不该把刚勾上的那条又取消掉 */
    useDb();
    const m = await mount('/library');
    await m.pointerDown('.dishrow');
    await m.wait(600);
    await m.clickEl(m.$$('.cardlist .dishrow')[0]);
    check(m.html().includes('已选 1 项'), '★ 长按后那次 click 被吞掉，仍然是勾 1 条', m.text('.selcount'));
    check(m.$('.s-detail') === null && m.$('.s-library') !== null, '页面还在菜谱库（没顺带跳详情）');
    /* 点「退出多选」回到普通列表 */
    await m.click('.selbar .icbtn');
    check(m.$('.selbar') === null && m.html().includes('我的菜谱库'), '★ 退出多选回到「我的菜谱库」');
    await m.close();
  }
  {
    /* 安卓长按链接常常不补 click：下一次正常点按（带 pointerdown）不能被误吞 */
    useDb();
    const m = await mount('/library');
    await m.longPress('.dishrow');
    check(m.html().includes('已选 1 项'), '长按进多选');
    await m.pointerDown('.cardlist .dishrow:nth-child(2)', 'touch');
    await m.pointerUp('.cardlist .dishrow:nth-child(2)');
    await m.clickEl(m.$$('.cardlist .dishrow')[1]);
    check(
      m.html().includes('已选 2 项'),
      '★ 长按没补 click 时，下一次点另一条照常勾上',
      m.text('.selcount'),
    );
    /* 整行都能点：点第二行的备注文字那块（.body）也照样勾选 */
    await m.pointerDown('.cardlist .dishrow:nth-child(3) .body', 'touch');
    await m.pointerUp('.cardlist .dishrow:nth-child(3) .body');
    await m.clickEl(m.$$('.cardlist .dishrow')[2].querySelector('.body') as HTMLElement);
    check(m.html().includes('已选 3 项'), '★ 点条目任意位置（不只那个圈）都能勾选', m.text('.selcount'));
    await m.close();
  }

  console.log('\n[边界 · 今日点单与今日菜单长按删除]');
  localStorage.clear();
  {
    /* 点单页的「今日点单」：短按还是展开，长按才弹删除 */
    useDb();
    const m = await mount('/order');
    check(m.$$('.osum').length === 1, '点单页今天只有 1 张单', `实际 ${m.$$('.osum').length}`);
    check(m.$('.tip') === null, '默认没有删除 tooltip');

    /* 按一下就松 → 不算长按 */
    await m.pointerDown('.osum');
    await m.wait(150);
    await m.pointerUp('.osum');
    await m.wait(600);
    check(m.$('.tip') === null, '★ 点单卡短按不弹删除 tooltip');

    await m.longPress('.osum');
    check(m.$('.tip') !== null, '★ 长按今日点单 → 弹出删除 tooltip');
    check(m.$('.tip .tip-del svg') !== null, 'tooltip 里有删除图标');

    /* 长按之后紧接着的那次 click 被吞掉，不该顺带展开这张单 */
    await m.click('.osum');
    check(m.$('.ocard.open') === null, '★ 长按后不误展开这张单');
    check(m.$('.tip') !== null, 'tooltip 还开着');

    await m.click('.tip-del');
    check(m.$('.tip') === null, '删完收起 tooltip');
    check(!readDb().orders.some((o) => o.id === 'o1'), '★ 今日点单那张从库里删掉');
    check(readDb().logs.some((l) => l.text.includes('已删除点单')), '删除写同步日志');
    check(m.html().includes('已删除「番茄炖牛腩 等 2 道」'), '给出删除提示');
    check(m.html().includes('今天还没下过单'), '★ 删完今日点单回到空态');
    await m.close();
  }
  {
    /* 掌勺页的「今日菜单」：长按卡头弹删除 */
    useDb();
    const m = await mount('/cook');
    check(m.$$('.cookcard').length === 1, '掌勺页先只有 1 张待做的单', `实际 ${m.$$('.cookcard').length}`);
    await m.longPress('.cch');
    check(m.$('.tip') !== null, '★ 长按今日菜单 → 弹出删除 tooltip');
    await m.click('.tip-del');
    check(!readDb().orders.some((o) => o.id === 'o2'), '★ 今日菜单里那张单从库里删掉');
    check(m.$$('.cookcard').length === 0, '删完卡片消失');
    check(m.html().includes('今天清清闲闲'), '★ 删完今日菜单回到空态');
    await m.close();
  }

  console.log('\n[边界 · 添加页备注与详情编辑备注同一套样式]');
  localStorage.clear();
  {
    /* 两处都该是「.field 里一个 label + 一个 textarea」，样式才不会各长各的 */
    useDb();
    const add = await mount('/add');
    const note = add.$('#mNote')!;
    check(
      note.tagName === 'TEXTAREA' && note.closest('.field') !== null,
      '★ 添加页备注 = .field 里的 textarea',
    );
    check(
      note.parentElement?.querySelector('label')?.getAttribute('for') === 'mNote',
      '★ 添加页备注有对应的 label',
    );
    check((note.getAttribute('style') ?? '') === '', '备注不再靠内联样式硬撑高度', note.getAttribute('style') ?? '');
    await add.close();
  }
  {
    useDb();
    const m = await mount('/recipe/r5');
    await m.click('#editRecipeBtn');
    const edit = m.$('#editNote')!;
    check(
      edit.tagName === 'TEXTAREA' && edit.closest('.field') !== null && (edit.getAttribute('style') ?? '') === '',
      '详情编辑的备注也是 .field 里的 textarea（两边结构一致）',
    );
    await m.close();
  }

  console.log('\n[边界 · 菜谱库长按走系统长按事件也进多选]');
  localStorage.clear();
  {
    useDb();
    const m = await mount('/library');
    /* 桌面右键（没有触摸指针）→ 不进多选 */
    await m.contextMenu('.dishrow');
    check(m.$('.selbar') === null, '★ 鼠标右键不进多选');
    /* 安卓长按 <a> 走系统那条路：指针序列可能被取消，平台随后补一个 contextmenu */
    await m.pointerDown('.dishrow', 'touch');
    await m.pointerUp('.dishrow');
    await m.contextMenu('.dishrow');
    check(m.$('.selbar') !== null, '★ 触摸长按的系统长按事件也能进多选');
    check(m.html().includes('已选 1 项'), '而且勾上的就是被长按那条', m.text('.selcount'));
    await m.close();
  }

  console.log('\n[边界 · 长按不选字、不弹系统菜单]');
  localStorage.clear();
  {
    /* 纯函数：输入框里放行，其余一律拦下 */
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const plain = document.createElement('div');
    check(keepsNativeLongPress(input), '输入框里的长按放行（要能选词 / 粘贴）');
    check(keepsNativeLongPress(area), '多行输入框同样放行');
    check(keepsNativeLongPress(editable), 'contenteditable 也放行');
    check(!keepsNativeLongPress(plain), '普通元素上的长按要拦下来');
    check(!keepsNativeLongPress(null), '拿不到目标时按「拦」处理');

    /* 真挂载：页面上的长按菜单被拦，输入框里的不拦 */
    useDb();
    const m = await mount('/library');
    const onRow = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    m.$$('.dishrow')[0].dispatchEvent(onRow);
    check(onRow.defaultPrevented, '★ 长按菜谱条目 → 系统菜单被拦下');
    const onInput = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    m.$('.searchbar input')!.dispatchEvent(onInput);
    check(!onInput.defaultPrevented, '★ 长按搜索框 → 放行，仍能粘贴');
    await m.close();

    /* CSS 兜住「选中文字」那一半（冒烟里样式表是空的，只能读文件断言） */
    const css = readFileSync('src/styles/app.css', 'utf8');
    check(/\*\s*\{[^}]*user-select: none/.test(css), '★ 整页默认不许选中文字');
    check(/input, textarea[^{]*\{[^}]*user-select: text/.test(css), '★ 输入框重新允许选中');
    check(css.includes('-webkit-touch-callout: none'), 'iOS 的长按气泡也一并关掉');
  }

  console.log('\n[边界 · 首次设置：导入配置 JSON]');
  localStorage.clear();
  {
    const m = await mount('/setup');
    await m.type(
      '#importJson',
      JSON.stringify({
        nickname: '小辉',
        partnerNickname: '小红',
        token: FAKE_CFG.token,
        repo: 'owner/repo',
        branch: 'dev',
        intervalSec: 600,
        aiKey: AI_KEY,
      }),
    );
    await m.clickByText('details.adv .btn-sticker.solid', '导入并填充');
    await m.wait(50);
    check(m.value('#fNickname') === '小辉' && m.value('#fPartnerNickname') === '小红', '导入填充两个昵称');
    check(m.value('#fRepo') === 'owner/repo' && m.value('#fBranch') === 'dev', '导入填充仓库与分支');
    check(m.value('#fInterval') === '600', '导入填充拉取间隔', m.value('#fInterval'));
    check(m.value('#fAiKey') === AI_KEY, '导入也填充 DeepSeek Key（可选字段）');
    check(m.html().includes('配置已导入'), '给出导入成功提示');
    await m.close();
  }
  {
    const m = await mount('/setup');
    await m.type('#importJson', '{ 这不是 JSON }');
    await m.clickByText('details.adv .btn-sticker.solid', '导入并填充');
    check(m.html().includes('JSON 格式不对'), '非法 JSON → 明确报错');
    await m.close();
  }
  {
    const m = await mount('/setup');
    await m.type('#importJson', JSON.stringify({ repo: 'owner/repo' }));
    await m.clickByText('details.adv .btn-sticker.solid', '导入并填充');
    check(m.html().includes('配置缺少'), '缺字段 → 报缺少哪些字段');
    await m.close();
  }
  {
    /* aiKey 是可选的，但给了就得是合法形状 */
    const m = await mount('/setup');
    await m.type(
      '#importJson',
      JSON.stringify({ nickname: '小辉', token: FAKE_CFG.token, repo: 'owner/repo', aiKey: 'ghp_wrong' }),
    );
    await m.clickByText('details.adv .btn-sticker.solid', '导入并填充');
    check(m.html().includes('aiKey 格式不对'), '导入里 aiKey 形状不对 → 报错');
    await m.close();
  }

  console.log('\n[边界 · 首次设置：本地模式]');
  localStorage.clear();
  {
    const m = await mount('/setup');
    await m.clickByText('.btn-ghost', '稍后再说（本地模式）');
    await m.wait(50);
    check(m.html().includes('先填一个昵称'), '没填昵称 → 提示先填昵称');
    await m.type('#fNickname', '小辉');
    await m.clickByText('.btn-ghost', '稍后再说（本地模式）');
    await m.wait(250);
    const db = readDb();
    check(db.configured === true && db.config?.repo === '' && db.config?.token === '', '本地模式：configured 但未连仓库');
    check(db.profiles.a.nickname === '小辉', '本地模式：昵称落库到本座');
    check(!m.html().includes('让菜谱跟着仓库走'), '进入菜谱库（离开向导）');
    await m.close();
  }
  {
    /* 本地模式下也能先填好 Key（之后接上仓库就能直接用 AI） */
    const m = await mount('/setup');
    await m.type('#fNickname', '小辉');
    await m.type('#fAiKey', AI_KEY);
    await m.clickByText('.btn-ghost', '稍后再说（本地模式）');
    await m.wait(250);
    const db = readDb();
    check(db.config?.aiKey === AI_KEY && db.config?.repo === '', '★ 本地模式也能把 Key 记下来（不连仓库）');
    await m.close();
  }

  console.log('\n[边界 · 首次设置：可选填 DeepSeek Key]');
  localStorage.clear();
  {
    const gh = installFakeGithub({});
    const m = await mount('/setup');
    const field = m.$('#fAiKey');
    check(field !== null, '高级设置里有 DeepSeek Key 输入框');
    check(field?.closest('details.adv') !== null, '★ 它就在「高级设置」折叠区里');
    check(field?.getAttribute('type') === 'password', 'Key 用密码框');
    check(
      field?.getAttribute('autocapitalize') === 'none' && field?.getAttribute('autocorrect') === 'off',
      '关掉手机键盘自动大写 / 自动更正',
    );
    check(m.html().includes('可留空'), '标注了「可留空」');

    await m.type('#fNickname', '小辉');
    await m.type('#fToken', FAKE_CFG.token);
    await m.type('#fRepo', FAKE_CFG.repo);
    await m.type('#fAiKey', AI_KEY);
    await m.click('button[type="submit"]');
    await m.wait(1500);
    const cfg = readDb().config!;
    check(cfg.aiKey === AI_KEY, '★ 首次设置填的 Key 落到 config（仅本机）', cfg.aiKey);
    check(cfg.aiKeyMask === maskAiKey(AI_KEY), '只存掩码供展示', cfg.aiKeyMask);
    check(cfg.aiOn === true, 'AI 开关默认是开的');
    check(readDb().configured === true && cfg.repo === FAKE_CFG.repo, '连接照常成功');
    await m.close();
    gh.restore();
  }
  {
    /* 可选字段：不填照样能连 */
    const gh = installFakeGithub({});
    const m = await mount('/setup');
    await m.type('#fNickname', '小辉');
    await m.type('#fToken', FAKE_CFG.token);
    await m.type('#fRepo', FAKE_CFG.repo);
    await m.click('button[type="submit"]');
    await m.wait(1500);
    check(readDb().config!.aiKey === '' && readDb().config!.aiKeyMask === '', '★ Key 留空不影响连接');
    check(readDb().configured === true, '照样连上仓库');
    await m.close();
    gh.restore();
  }
  {
    /* 填了就得合法；清空又回到「可选」 */
    const m = await mount('/setup');
    await m.type('#fNickname', '小辉');
    await m.type('#fAiKey', 'ghp_0123456789abcdef012345');
    await m.blur('#fAiKey');
    check(m.html().includes('以 sk- 开头'), '形状不对 → 给出针对性提示', m.html().slice(0, 200));
    check((m.$('#fAiKey')?.closest('.field')?.className ?? '').includes('invalid'), '字段标红');

    await m.type('#fAiKey', '');
    await m.blur('#fAiKey');
    check(!(m.$('#fAiKey')?.closest('.field')?.className ?? '').includes('invalid'), '★ 清空后不再报错（本来就是可选）');
    await m.close();
  }
}

/* ═══════════ 七·五、手机返回键 ═══════════ */

/**
 * 手机物理返回键由 src/lib/back.tsx 接管。真机上它接的是 @capacitor/app 的 backButton
 * 事件，jsdom 里没有原生桥，所以测试直接调同一个入口 pressBack()，走的还是那条路径。
 */
async function backChecks() {
  console.log('\n[返回键 · 决策表]');
  check(backAction({ hasOverlay: true, root: false, level: 1, native: true }) === 'overlay', '有遮罩 → 先关遮罩');
  check(backAction({ hasOverlay: false, root: false, level: 3, native: true }) === 'page', '二级页有来路 → 回上一屏');
  check(backAction({ hasOverlay: false, root: true, level: 1, native: true }) === 'exit', '★ 一级页 → 直接退出应用');
  check(
    backAction({ hasOverlay: false, root: true, level: 4, native: true }) === 'exit',
    '★ 一级页哪怕有历史，也不退回上一次的一级页，照样退出应用',
  );
  check(backAction({ hasOverlay: false, root: false, level: 1, native: true }) === 'home', '二级页没来路（深链）→ 落到菜谱库');
  check(backAction({ hasOverlay: false, root: true, level: 1, native: false }) === 'idle', '网页端不接管（浏览器自己管返回）');

  console.log('\n[返回键 · 一级页判定]');
  check(
    ['/library', '/order', '/cook', '/sync', '/setup', '/'].every(isRootPath),
    '★ 底部四格 + 首次设置（含根路径）都算一级页',
  );
  check(!isRootPath('/recipe/r1') && !isRootPath('/add'), '菜谱详情 / 添加菜谱是二级页');

  console.log('\n[返回键 · 页内返回栈台账]');
  let stack = trackHistory([], 'a', 'POP');
  check(stack.join() === 'a', '首个条目落栈');
  stack = trackHistory(stack, 'b', 'PUSH');
  check(stack.join() === 'a,b', 'push 加深一层', stack.join());
  stack = trackHistory(stack, 'c', 'REPLACE');
  check(stack.join() === 'a,c', 'replace 换掉栈顶、不加深', stack.join());
  stack = trackHistory(stack, 'a', 'POP');
  check(stack.join() === 'a', 'pop 变浅一层', stack.join());
  check(trackHistory(stack, 'x', 'POP').join() === 'a', '已经在根屏上时 pop 不会把栈掏空');

  console.log('\n[返回键 · 菜谱库 → 详情 → 返回]');
  useDb();
  {
    const m = await mount('/library');
    await m.click('.dishrow');
    check(m.$('.s-detail') !== null, '点一道菜 → 进详情页');
    await act(async () => pressBack());
    check(
      m.$('.s-library') !== null && m.$('.s-detail') === null,
      '★ 详情页按返回 → 回菜谱库（不再关掉应用）',
    );
    await act(async () => pressBack());
    check(m.$('.s-library') !== null, '★ 已经在菜谱库上，再按返回不跳走，交给系统退出应用');
    await m.close();
  }

  console.log('\n[返回键 · 添加页]');
  useDb();
  {
    const m = await mount('/library');
    await m.click('.tab.add');
    check(m.$('.s-add') !== null, '点「＋添加」→ 进添加页');
    await act(async () => pressBack());
    check(m.$('.s-add') === null && m.$('.s-library') !== null, '★ 添加页按返回 → 回菜谱库');
    await m.close();
  }

  console.log('\n[返回键 · 遮罩优先：添加页上的大图]');
  useDb();
  {
    const m = await mount('/add');
    await pickPhoto(m, '#photoInput');
    await m.wait(200);
    await m.click('[aria-label="查看大图"]');
    check(m.$('.photoview') !== null, '点封面 → 打开大图');
    await act(async () => pressBack());
    check(m.$('.photoview') === null && m.$('.s-add') !== null, '★ 返回键先关掉大图，不退屏');
    await act(async () => pressBack());
    check(m.$('.s-add') === null && m.$('.s-library') !== null, '★ 再按一次才回菜谱库');
    await m.close();
  }

  console.log('\n[返回键 · 保存完的添加页不留在返回栈里]');
  useDb();
  {
    const m = await mount('/order');
    await m.click('.tab.add');
    await m.type('#mTitle', '返回键测试菜');
    await m.click('.actionbar .btn-primary');
    await m.wait(1600);
    check(m.$('.s-add') === null && m.$('.s-order') !== null, '从点单页进来，存完回到点单页');
    await act(async () => pressBack());
    check(
      m.$('.s-add') === null && m.$('.s-order') !== null,
      '★ 返回键不会退回到一张已经交掉的表单',
    );
    await m.close();
  }

  console.log('\n[返回键 · 遮罩优先：菜谱库的多选模式与点单的删除提示]');
  useDb();
  {
    const m = await mount('/library');
    await m.longPress('.dishrow');
    check(m.$('.selbar') !== null, '长按菜谱 → 进多选模式');
    await act(async () => pressBack());
    check(m.$('.selbar') === null && m.$('.s-library') !== null, '★ 返回键先退出多选，不退应用');
    check(m.html().includes('我的菜谱库'), '退回普通列表（顶栏变回标题）');
    await m.close();
  }
  {
    /* 点单页的删除提示同样是遮罩：返回键先收起它 */
    useDb();
    const m = await mount('/order');
    await m.longPress('.osum');
    check(m.$('.tip') !== null, '长按点单卡 → 弹出删除提示');
    await act(async () => pressBack());
    check(m.$('.tip') === null && m.$('.s-order') !== null, '★ 返回键先收起提示，不退屏');
    await m.close();
  }

  console.log('\n[返回键 · 遮罩优先：掌勺的菜品详情]');
  useDb();
  {
    const m = await mount('/cook');
    await m.click('.dit');
    check(m.$('.dishsheet') !== null, '点一道菜 → 弹出菜品详情');
    await act(async () => pressBack());
    check(m.$('.dishsheet') === null && m.$('.s-cook') !== null, '★ 返回键先关掉菜品详情，不退屏');
    await m.close();
  }

  console.log('\n[返回键 · 遮罩优先：详情页的大图]');
  localStorage.clear();
  {
    const gh = installFakeGithub({ images: { 'images/r1.png': SHOT_B64 } });
    useDb((db) => {
      db.recipes[0].image = 'images/r1.png';
    });
    const m = await mount('/recipe/r1');
    await m.wait(300);
    await m.click('[aria-label="查看大图"]');
    check(m.$('.photoview') !== null, '点封面 → 打开大图');
    await act(async () => pressBack());
    check(m.$('.photoview') === null && m.$('.s-detail') !== null, '★ 返回键先关掉大图，不退屏');
    await act(async () => pressBack());
    check(m.$('.s-detail') === null && m.$('.s-library') !== null, '★ 再按一次才回菜谱库');
    await m.close();
    gh.restore();
  }

  console.log('\n[返回键 · 一级页之间不互相回退]');
  useDb();
  {
    const m = await mount('/library');
    await m.clickByText('.tab', '设置');
    check(m.$('.s-sync') !== null, '点「设置」→ 进设置页');
    await act(async () => pressBack());
    check(
      m.$('.s-sync') !== null && m.$('.s-library') === null,
      '★ 设置页按返回 → 不回菜谱库，直接交给系统退出应用',
    );
    await m.close();
  }
  useDb();
  {
    const m = await mount('/order');
    await act(async () => pressBack());
    check(m.$('.s-order') !== null, '★ 点单页按返回 → 不跳走，直接交给系统退出应用');
    await m.close();
  }

  console.log('\n[返回键 · 从详情跳去点单，点单页上也不退回详情]');
  useDb();
  {
    const m = await mount('/library');
    /* 挑一道当时不在未完成单里的菜（r1 / r2 / r4 / r6 都挂在单上，按钮会是「已在今天单里」） */
    await m.clickByText('.dishrow', '椰子鸡火锅');
    await m.clickByText('.actionbar .btn-primary', '去点单');
    check(m.$('.s-order') !== null, '详情页「去点单 · 带上这道菜」→ 进点单页');
    await act(async () => pressBack());
    check(
      m.$('.s-order') !== null && m.$('.s-detail') === null,
      '★ 点单页按返回 → 不退回详情，直接交给系统退出应用',
    );
    await m.close();
  }

  console.log('\n[返回键 · 做完的首次向导不留在返回栈里]');
  localStorage.clear();
  {
    const m = await mount('/setup');
    await m.type('#fNickname', '小辉');
    await m.clickByText('.btn-ghost', '稍后再说（本地模式）');
    await m.wait(250);
    check(m.$('.s-library') !== null, '向导走完 → 进菜谱库');
    await act(async () => pressBack());
    check(m.$('.s-setup') === null && m.$('.s-library') !== null, '★ 返回键不会退回已经做完的向导');
    await m.close();
  }
}

/* ═══════════ 一·五、错误边界 ═══════════ */

/** 故意在渲染期抛错，用来确认错误边界真的兜住了 */
function Boom(): never {
  throw new Error('测试用的渲染崩溃');
}

async function boundaryChecks() {
  console.log('\n[边界 · 没填作者的菜谱不编出处]');
  localStorage.clear();
  {
    useDb((db) => {
      db.recipes = db.recipes.map((r) => ({ ...r, author: '' }));
    });
    const m = await mount('/recipe/r1');
    check(!m.html().includes('来自剪藏'), '★ 详情页不再显示「来自剪藏」这种假出处');
    check(
      m.$$('.meta-row .meta').every((el) => (el.textContent ?? '').trim() !== ''),
      '★ 也不留一个空的位置（没作者就不摆那格）',
    );
    await m.close();

    const m2 = await mount('/cook');
    await m2.click('.dit');
    const dsMeta = (m2.$('.ds-meta')?.textContent ?? '').trim();
    check(!dsMeta.includes('来自剪藏'), '掌勺的菜品详情同样不编出处', dsMeta);
    check(!dsMeta.includes('·'), '★ 没作者时不留孤零零的分隔点', dsMeta);
    await m2.close();
  }

  console.log('\n[边界 · 浏览器不让存数据时当场说明白]');
  localStorage.clear();
  {
    /* 模拟无痕模式 / 「关闭浏览器就清站点数据」：localStorage 一律写不进去。
       jsdom 的 Storage 拦不住属性改写，所以直接换掉整个 globalThis.localStorage。 */
    const real = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    try {
      const m = await mount('/setup');
      check(
        m.html().includes('不让本站保存数据'),
        '★ 存不了数据时明确提示（token / 仓库 / Key 每次都要重填就是这个原因）',
      );
      check(m.html().includes('每次进来都得重填'), '提示里说清后果');
      await m.close();
    } finally {
      globalThis.localStorage = real;
    }
    localStorage.clear();

    const m2 = await mount('/setup');
    check(!m2.html().includes('不让本站保存数据'), '能正常存数据时不打扰用户');
    await m2.close();
    const m3 = await mount('/sync');
    check(!m3.html().includes('不让本站保存数据'), '设置页同样只在真存不了时才提示');
    await m3.close();
  }

  console.log('\n[组件 · 错误边界兜住渲染异常]');
  localStorage.clear();
  /* React 会把崩溃栈打到 console.error（生产上要留着），测试里静音，别刷屏 */
  const prevErr = console.error;
  let html = '';
  try {
    console.error = () => {};
    let r!: Root;
    await act(async () => {
      r = createRoot(root);
      r.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    });
    html = root.innerHTML;
    await act(async () => {
      r.unmount();
    });
  } catch (e) {
    fail('错误边界兜住渲染异常', e instanceof Error ? e.message : String(e));
  } finally {
    console.error = prevErr;
    root.innerHTML = '';
  }

  if (html) {
    check(html.includes('界面出了点问题'), '★ 渲染期抛错 → 给兜底页，而不是整页白屏');
    check(html.includes('重新加载'), '兜底页有重新加载按钮');
    check(html.includes('测试用的渲染崩溃'), '兜底页带上原始报错，现场能看到原因');
  }
}

/* ═══════════ 八、仓库结构（GitHub Actions 自动打包 + 版本号 / 签名）═══════════ */

/** 工作流本身要 GitHub 的 runner 才跑得起来，这里退一步做静态断言：
    关键步骤（触发分支 / 打包命令 / 产物 / 建 Release / 权限）缺一个就报错，
    免得哪天把自动打包改坏了也没人发现。 */
function workflowChecks() {
  console.log('\n[仓库 · GitHub Actions 自动打包]');
  let yml = '';
  try {
    yml = readFileSync('.github/workflows/android-apk.yml', 'utf8');
  } catch (e) {
    fail('自动打包工作流在仓库里', e instanceof Error ? e.message : String(e));
    return;
  }
  check(yml.includes('branches: [main]'), '★ push 到 main 就触发');
  check(yml.includes('npm run apk'), '★ 跑的就是 npm run apk');
  check(
    yml.includes('android/app/build/outputs/apk/debug/app-debug.apk'),
    '上传 app-debug.apk 作为构建产物',
  );
  check(yml.includes('gh release create') && yml.includes('--latest'), '★ 建 Release 并标 latest');
  check(yml.includes('contents: write'), '给了建 Release 需要的 contents: write');
  check(yml.includes("java-version: '17'"), 'JDK 17（AGP 8.2.1 要求）');
  check(
    yml.includes('JISHIBEN_BUILD: ${{ github.run_number }}'),
    '★ 打包时按 run_number 写版本号（每次 Release 版本都不一样）',
  );

  console.log('\n[仓库 · 版本号与固定签名]');
  const local = resolveVersion('1.2.3', '');
  check(local.code === 100000 && local.name === '1.2.3', '本机打包：versionName 就是 package.json 的 version', JSON.stringify(local));
  const ci = resolveVersion('1.2.3', '42');
  check(ci.code === 100042 && ci.name === '1.2.3-build.42', '★ CI 打包：versionName 带 build 号，versionCode 随之递增', JSON.stringify(ci));
  check(resolveVersion('1.2.3', 'abc').code === 100000, 'build 号不是数字时退回基准值，不写坏 versionCode');
  check(
    applyVersion('  versionCode 1\n  versionName "1.0"', 100042, '1.0.0-build.42').includes('versionCode 100042'),
    '脚本能把版本号写进 build.gradle',
  );

  let gradle = '';
  try {
    gradle = readFileSync('android/app/build.gradle', 'utf8');
  } catch (e) {
    fail('android/app/build.gradle 在仓库里', e instanceof Error ? e.message : String(e));
  }
  if (gradle) {
    check(/versionCode\s+\d+/.test(gradle) && /versionName\s+"[^"]*"/.test(gradle), 'build.gradle 里有可改写的 versionCode / versionName');
    check(gradle.includes("storeFile file('debug.keystore')"), '★ debug 构建显式用仓库里那份 keystore 签名');
    check(gradle.includes('signingConfig signingConfigs.debug'), 'debug buildType 挂上这个签名配置');
    check(existsSync('android/app/debug.keystore'), '★ 固定签名文件随仓库走（CI 与本机同一份，才能覆盖安装）');
  }
}

/* ═══════════ 跑 ═══════════ */

/* 铺一层底：整个套件期间 api.github.com 一律被拦截。
   有些用例会点「发送订单 / 保存备注」，那会触发「提交即同步」的自动推送 ——
   不拦的话离线测试会真的往 api.github.com 发请求（虽然打不到真实仓库，但慢且不该有）。 */
const netGuard = installFakeGithub({});

await renderChecks();
await boundaryChecks();
await interactionChecks();
await parseChecks();
helperChecks();
await githubChecks();
await aiChecks();
await photoChecks();
await readerChecks();
await migrationChecks();
await connectChecks();
await syncChecks();
await edgeChecks();
await backChecks();
workflowChecks();

netGuard.restore();

console.log(failures ? `\n✗ 冒烟测试失败：${failures} 项\n` : '\n✓ 全部通过\n');
process.exit(failures ? 1 : 0);
