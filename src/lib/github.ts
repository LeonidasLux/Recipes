/* ============================================================
   GitHub 仓库读写 —— 真源就是仓库里的 recipes.json / orders.json

   用 Contents API（api.github.com 允许浏览器跨域直接调用）：
     GET  /repos/{owner}/{repo}/contents/{path}?ref={branch}
     PUT  /repos/{owner}/{repo}/contents/{path}
   提交即同步：本地改动 → 立刻 PUT 回仓库。
   ============================================================ */

import { dataUrlBase64, imageExtFor } from './photo';

const API = 'https://api.github.com';

export const RECIPES_PATH = 'recipes.json';
export const ORDERS_PATH = 'orders.json';
export const PROFILES_PATH = 'profiles.json';
/** 菜谱照片放这个目录，一张图一个文件 */
export const IMAGES_DIR = 'images';

/** 菜谱照片在仓库里的路径：`images/<id>.<ext>`（扩展名跟着图片真实类型走） */
export function imagePath(id: string, mime = 'image/jpeg'): string {
  return `${IMAGES_DIR}/${id}.${imageExtFor(mime)}`;
}

/** 从路径反推 MIME（路径是我们自己生成的，读回来时靠它还原 data URL） */
export function imageMimeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

/* 一律绕过浏览器 HTTP 缓存。GitHub 的 contents 接口回的是
   `Cache-Control: public, max-age=60`，按默认缓存模式读，一分钟内拿到的可能是
   旧正文和旧 sha —— 拉取会套用过期数据，写入则会拿着过期 sha 撞 409，
   连「取回新 sha 重试」也跟着读到同一份旧 sha，重试等于白重试。 */
const NO_CACHE: RequestInit = { cache: 'no-store' };

/** 面向用户的同步错误：message 可直接展示 */
export class GithubError extends Error {
  readonly kind: 'auth' | 'forbidden' | 'notfound' | 'conflict' | 'network' | 'unknown';
  readonly status: number;

  constructor(kind: GithubError['kind'], message: string, status = 0) {
    super(message);
    this.name = 'GithubError';
    this.kind = kind;
    this.status = status;
  }
}

function authHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** UTF-8 安全的 base64 编码（菜名是中文，不能直接用 btoa） */
function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64decode(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function toGithubError(res: Response, repo: string): Promise<GithubError> {
  let detail = '';
  try {
    const body = (await res.json()) as { message?: string };
    detail = body?.message ?? '';
  } catch {
    /* 响应不是 JSON，忽略 */
  }

  if (res.status === 401) {
    return new GithubError('auth', 'token 无效或已过期，重新生成一个再试。', 401);
  }
  if (res.status === 403) {
    const limited = res.headers.get('x-ratelimit-remaining') === '0';
    return limited
      ? new GithubError('forbidden', 'GitHub 接口访问次数用完了，过一会儿再试。', 403)
      : new GithubError('forbidden', 'token 缺少 contents 读写权限，检查一下权限范围。', 403);
  }
  if (res.status === 404) {
    return new GithubError('notfound', `找不到仓库 ${repo}，或分支 / 文件不存在。`, 404);
  }
  if (res.status === 409 || res.status === 422) {
    return new GithubError('conflict', '仓库里这个文件刚被改过，同步一下再提交。', res.status);
  }
  return new GithubError('unknown', detail || `GitHub 返回了 ${res.status}`, res.status);
}

function networkError(e: unknown): GithubError {
  const msg = e instanceof Error && e.name === 'AbortError'
    ? '连接超时，检查网络后重试。'
    : '连不上 GitHub，检查网络后重试。';
  return new GithubError('network', msg);
}

export interface RemoteFile<T> {
  data: T;
  sha: string;
}

/** 读取仓库里的一个 JSON 文件；文件不存在返回 null */
export async function getJson<T>(
  repo: string,
  path: string,
  branch: string,
  token: string,
  signal?: AbortSignal,
): Promise<RemoteFile<T> | null> {
  const url = `${API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  let res: Response;
  try {
    res = await fetch(url, { ...NO_CACHE, headers: authHeaders(token), signal });
  } catch (e) {
    throw networkError(e);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw await toGithubError(res, repo);

  const body = (await res.json()) as { content?: string; sha: string };
  if (!body.content) {
    throw new GithubError('unknown', `${path} 太大了，无法直接读取。`);
  }
  let data: T;
  try {
    data = JSON.parse(b64decode(body.content)) as T;
  } catch {
    throw new GithubError('unknown', `仓库里的 ${path} 不是合法的 JSON。`);
  }
  return { data, sha: body.sha };
}

/** 写入（或新建）仓库里的一个 JSON 文件，返回新的 sha */
export async function putJson(
  repo: string,
  path: string,
  branch: string,
  token: string,
  data: unknown,
  message: string,
  sha?: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${API}/repos/${repo}/contents/${path}`;
  const payload: Record<string, unknown> = {
    message,
    content: b64encode(JSON.stringify(data, null, 2)),
    branch,
  };
  if (sha) payload.sha = sha;

  let res: Response;
  try {
    res = await fetch(url, {
      ...NO_CACHE,
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await toGithubError(res, repo);

  const body = (await res.json()) as { content?: { sha?: string } };
  return body.content?.sha ?? '';
}

/* ─── 菜谱照片：一张图一个文件 ───────────────────
   为什么不把 base64 塞进 recipes.json：GitHub contents 接口对超过 1 MB 的
   文件**不回正文**（`content` 为空），几张手机截图就能把 recipes.json 顶过线，
   那之后连菜谱都读不出来；而且每次改一条菜谱都要把整库图片重传一遍。
   放成独立文件后，菜谱库 JSON 一直是小的，只有新增 / 换图才动图片。

   读取用 JSON 形态（顺便拿到 sha，PUT / DELETE 都要它）。图片自己控制在
   800 KB 以内（见 photo.ts），稳在 1 MB 这条线下面。 */

/** 读仓库里的一张图片，返回 data URL 与 sha；文件不存在返回 null */
export async function getImage(
  repo: string,
  path: string,
  branch: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ dataUrl: string; sha: string } | null> {
  const url = `${API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  let res: Response;
  try {
    res = await fetch(url, { ...NO_CACHE, headers: authHeaders(token), signal });
  } catch (e) {
    throw networkError(e);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw await toGithubError(res, repo);

  const body = (await res.json()) as { content?: string; sha: string };
  if (!body.content) {
    throw new GithubError('unknown', `${path} 太大了，读不出来。`);
  }
  return {
    dataUrl: `data:${imageMimeOf(path)};base64,${body.content.replace(/\s/g, '')}`,
    sha: body.sha,
  };
}

/** 上传（或覆盖）仓库里的一张图片，返回新的 sha */
export async function putImage(
  repo: string,
  path: string,
  branch: string,
  token: string,
  dataUrl: string,
  message: string,
  sha?: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${API}/repos/${repo}/contents/${path}`;
  const payload: Record<string, unknown> = {
    message,
    content: dataUrlBase64(dataUrl),
    branch,
  };
  if (sha) payload.sha = sha;

  let res: Response;
  try {
    res = await fetch(url, {
      ...NO_CACHE,
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await toGithubError(res, repo);

  const body = (await res.json()) as { content?: { sha?: string } };
  return body.content?.sha ?? '';
}

/** 读一个文件的 sha（删图 / 覆盖前要用）；文件不存在返回 null */
export async function getFileSha(
  repo: string,
  path: string,
  branch: string,
  token: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = `${API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  let res: Response;
  try {
    res = await fetch(url, { ...NO_CACHE, headers: authHeaders(token), signal });
  } catch (e) {
    throw networkError(e);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw await toGithubError(res, repo);
  const body = (await res.json()) as { sha?: string };
  return body.sha ?? null;
}

/** 删仓库里的一个文件（菜谱删了 / 换了图，旧图顺手清掉） */
export async function deleteFile(
  repo: string,
  path: string,
  branch: string,
  token: string,
  sha: string,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${API}/repos/${repo}/contents/${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...NO_CACHE,
      method: 'DELETE',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sha, branch }),
      signal,
    });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await toGithubError(res, repo);
}

/** 校验 token + 仓库 + 分支是否可用（连接向导用） */
export async function verifyRepo(
  repo: string,
  branch: string,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API}/repos/${repo}`, { ...NO_CACHE, headers: authHeaders(token), signal });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await toGithubError(res, repo);

  let b: Response;
  try {
    b = await fetch(`${API}/repos/${repo}/branches/${encodeURIComponent(branch)}`, {
      ...NO_CACHE,
      headers: authHeaders(token),
      signal,
    });
  } catch (e) {
    throw networkError(e);
  }
  if (b.status === 404) {
    throw new GithubError('notfound', `仓库里没有 ${branch} 这个分支。`);
  }
  if (!b.ok) throw await toGithubError(b, repo);
}

/** 带超时的 AbortSignal（默认 15 秒） */
export function withTimeout(ms = 15000): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

export function maskToken(token: string): string {
  if (token.length < 8) return '••••';
  return `${token.slice(0, 4)}••••••••${token.slice(-4)}`;
}

/** 去掉所有空白字符：粘贴时被换行/空格截断是常见事故，token 里本来也不该有空白 */
export function normalizeToken(raw: string): string {
  return raw.replace(/\s+/g, '');
}

/**
 * 提交前先做一道「形状」校验，把明显被改坏的 token 拦在本地。
 *
 * 手机上尤其必要：键盘的「首字母自动大写」会把 ghp_ 写成 Ghp_，
 * 自动更正有时还会插入字符 —— 这类问题如果直接发请求，GitHub 只会回一个
 * 401「Bad credentials」，看不出真正原因。
 *
 * @returns 有问题时返回给用户看的中文说明，没问题返回 null
 */
export function tokenShapeError(raw: string): string | null {
  const t = normalizeToken(raw);
  if (!t) return '请填写 token';
  if (/[^\x21-\x7E]/.test(t)) return 'token 里混进了空格或不可见字符，重新复制一次';
  if (!/^(ghp_|gho_|ghu_|ghs_|github_pat_)/.test(t)) {
    return 'token 应以 ghp_ 或 github_pat_ 开头 —— 手机键盘的「首字母自动大写」常把它写成 Ghp_，检查一下';
  }
  if (/^gh[pousr]_/.test(t) && t.length !== 40) {
    return `经典 token 是 40 位，当前 ${t.length} 位，多半是没复制全`;
  }
  return null;
}
