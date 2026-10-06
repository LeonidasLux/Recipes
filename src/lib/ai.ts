/* ============================================================
   用 DeepSeek 的 Chat Completions 把分享文案「认」成一条菜谱

   为什么要有这一层：分享文案长短不一，小红书的长文案里往往混着食材、
   步骤、话题标签和一堆表情。启发式解析（share.ts）只能挑出标题，做法
   基本抓不到；DeepSeek 能把同一段文案整理成「菜名 / 作者 / 做法 / 小贴士」。

   和 GitHub 那层一样走浏览器直连：api.deepseek.com 会回 CORS 头，
   实测 preflight 也放行（allow-methods: POST）。API Key 只存本机
   localStorage，永不写进仓库、也不会发给 api.deepseek.com 以外的地方。

   抽取原则与 share.ts 一致：**宁可留空，也不编造** —— 提示词里明确要求
   只抄文案里写到的信息。
   ============================================================ */

import { withTimeout } from './github';
import { toDishName } from './share';

export const AI_CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const AI_MODELS_ENDPOINT = 'https://api.deepseek.com/models';
/** DeepSeek 的通用对话模型（服务端会路由到当前可用的 chat 模型） */
export const AI_MODEL = 'deepseek-chat';

export type AiErrorKind =
  | 'auth'
  | 'balance'
  | 'ratelimit'
  | 'badrequest'
  | 'server'
  | 'network'
  | 'format'
  | 'unknown';

/** 面向用户的 AI 错误：message 可直接展示 */
export class DeepseekError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number;

  constructor(kind: AiErrorKind, message: string, status = 0) {
    super(message);
    this.name = 'DeepseekError';
    this.kind = kind;
    this.status = status;
  }
}

/** AI 识别出来的一条菜谱（只含文案里确实写了的内容） */
export interface AiRecipe {
  title: string;
  author: string;
  steps: string;
  note: string;
}

export const SYSTEM_PROMPT = [
  '你是「记食本」的菜谱信息抽取助手。用户会给你一段从社交平台（小红书 / 抖音 / B站）或网页复制来的分享文案。',
  '请只抽取文案里明确写到的信息，整理成一个 JSON 对象返回。文案里没有提到的字段，一律返回空字符串 —— 绝对不要编造食材、用量或步骤。',
  '字段：',
  '- "title"：**只填菜名本身**，2～12 个字，最多 20 个字。去掉描述、口号、话题标签、书名号和 emoji，',
  '  也要去掉「保姆级 / 教程 / 配方 / 食谱 / 分享 / 合集 / 来了」这类营销词。',
  '  例如「西红柿炒鸡蛋，你就像我这样做，真的很下饭！」抽成「西红柿炒鸡蛋」，「【电饭煲卤鸡腿，脱骨那种】」抽成「电饭煲卤鸡腿」，',
  '  「酸甜爽脆的腌萝卜保姆级教程来了」抽成「酸甜爽脆的腌萝卜」。',
  '- "author"：原作者或账号名。若给了「原链接页面线索」，**优先用它里面的「作者候选」** —— 那是链接页面上真实出现的账号名；线索里没有再看文案。都没有才留空。',
  '- "steps"：做法。把文案里写到的食材、用量和步骤整理成多行纯文本，每步一行；没有就空串。',
  '- "note"：文中的小贴士或注意事项（火候、替换食材、保存等）；没有就空串。',
  '若给了「原链接页面线索」，它只是抓来的页面片段、可能有噪音：作者以它为准；菜名 / 做法只在文案没写到时才参考它。仍不要编造。',
  '若「原链接页面线索」是一个搜索 / 列表页（很多条结果），`title` 就取**第一条结果**里的菜名（同样只留菜品名）。',
  '只输出 JSON，不要解释。',
].join('\n');

export function buildAiMessages(
  text: string,
  page?: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const parts = [`下面这段分享文案，请抽取成 json：\n\n${text}`];
  if (!text.trim()) parts[0] = '用户只给了一个链接，没有配任何文案。请抽取成 json：';
  if (page?.trim()) {
    parts.push(`原链接页面线索（第三方抓取的页面片段，可能有噪音，仅作补充）：\n${page.trim()}`);
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/* ─── Key 的掩码 / 去空白 / 形状校验（与 github.ts 的 token 工具同思路）─── */

/** 只保留前缀与后四位，设置页展示用 */
export function maskAiKey(key: string): string {
  if (key.length < 8) return '••••';
  return `${key.slice(0, 6)}••••••••${key.slice(-4)}`;
}

/** 去掉所有空白：粘贴时被换行/空格截断是常见事故 */
export function normalizeAiKey(raw: string): string {
  return raw.replace(/\s+/g, '');
}

/**
 * 提交前先把明显被改坏的 Key 拦在本地。
 * 手机上键盘的自动大写 / 自动更正会把 `sk-` 拼坏，直接发请求只会拿到一句 401。
 *
 * @returns 有问题时返回给用户看的中文说明，没问题返回 null
 */
export function aiKeyShapeError(raw: string): string | null {
  const k = normalizeAiKey(raw);
  if (!k) return '请填写 DeepSeek API Key';
  if (/[^\x21-\x7E]/.test(k)) return 'Key 里混进了空格或不可见字符，重新复制一次';
  if (!k.startsWith('sk-')) return 'DeepSeek 的 Key 以 sk- 开头，检查一下有没有复制全';
  if (k.length < 20) return `Key 看起来没复制全（当前 ${k.length} 位）`;
  return null;
}

/* ─── 请求 / 响应 ────────────────────────────── */

function authHeaders(key: string): HeadersInit {
  return { Authorization: `Bearer ${key}` };
}

async function detailOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body?.error?.message ?? '';
  } catch {
    return '';
  }
}

/** 把 DeepSeek 的状态码翻成用户能照着改的中文 */
async function toDeepseekError(res: Response): Promise<DeepseekError> {
  const detail = await detailOf(res);
  if (res.status === 401) {
    return new DeepseekError('auth', 'DeepSeek 的 API Key 无效或已过期，去设置里重新填一个。', 401);
  }
  if (res.status === 402) {
    return new DeepseekError('balance', 'DeepSeek 账户余额不足，充值后再试。', 402);
  }
  if (res.status === 429) {
    return new DeepseekError('ratelimit', '请求太频繁了，歇一会儿再试。', 429);
  }
  if (res.status === 400 || res.status === 422) {
    return new DeepseekError('badrequest', detail || 'DeepSeek 拒绝了这次请求，换个文案再试。', res.status);
  }
  if (res.status >= 500) {
    return new DeepseekError('server', 'DeepSeek 服务端出错了，稍后重试。', res.status);
  }
  return new DeepseekError('unknown', detail || `DeepSeek 返回了 ${res.status}`, res.status);
}

function networkError(e: unknown): DeepseekError {
  const msg = e instanceof Error && e.name === 'AbortError'
    ? '连接 DeepSeek 超时，检查网络后重试。'
    : '连不上 DeepSeek，检查网络后重试。';
  return new DeepseekError('network', msg);
}

/** 模型有时会把 JSON 裹在 ```json 代码块里，或前后带一句解释 —— 都尽量捞出来 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 模型偶尔会换用中文字段名 / 加书名号，这里一并兜住 */
export function normalizeAiRecipe(raw: unknown): AiRecipe {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  /* 模型偶尔还是会把整句视频标题丢进来，再用同一套规则收成菜名 */
  const title = toDishName(str(o.title) || str(o['菜名']) || str(o['标题']));
  return {
    title,
    author: (str(o.author) || str(o['作者'])).slice(0, 30),
    steps: str(o.steps) || str(o['做法']) || str(o['步骤']),
    note: str(o.note) || str(o['备注']) || str(o['小贴士']),
  };
}

/**
 * 把分享文案（可带一段「原链接页面线索」）交给 DeepSeek，抽成一条结构化菜谱。
 * 页面线索由 `reader.ts` 抓取并压缩，没开「读原链接」时就不传。
 */
export async function recognizeRecipe(
  apiKey: string,
  text: string,
  opts: { page?: string; signal?: AbortSignal } = {},
): Promise<AiRecipe> {
  const payload = {
    model: AI_MODEL,
    messages: buildAiMessages(text, opts.page),
    response_format: { type: 'json_object' },
    stream: false,
    temperature: 0,
  };

  let res: Response;
  try {
    res = await fetch(AI_CHAT_ENDPOINT, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: opts.signal,
    });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await toDeepseekError(res);

  let body: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new DeepseekError('format', 'DeepSeek 回了看不懂的内容，稍后重试。');
  }

  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new DeepseekError('format', 'DeepSeek 没有返回内容，换个文案再试。');
  }
  const parsed = parseJsonLoose(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new DeepseekError('format', 'DeepSeek 返回的不是合法 JSON，稍后重试。');
  }
  return normalizeAiRecipe(parsed);
}

/** 设置页「测试连接」用：GET /models 只校验 Key，不消耗对话额度 */
export async function verifyAiKey(apiKey: string, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(AI_MODELS_ENDPOINT, { headers: authHeaders(apiKey), signal });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await toDeepseekError(res);
}

/** 给识别过程套一个超时（默认 20 秒，AI 出字比 GitHub 慢一些） */
export function aiTimeout(ms = 20000) {
  return withTimeout(ms);
}
