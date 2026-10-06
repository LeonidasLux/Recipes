/* ============================================================
   读原链接 —— 通过第三方「阅读器代理」把页面抓成可读文本

   为什么不能直接 fetch 小红书 / B站 / 抖音：
   这些站点**不返回 CORS 头**，浏览器读不到页面内容（实测 B站开放接口
   同样没有 access-control-allow-origin）。当初「识别」只解析分享文案，
   就是因为这个。

   要真去读页面，只能借一个「已经替我们抓好的」服务。这里用 r.jina.ai：
   它把目标页渲染后返回正文，并且**自己带 CORS 头**（实测 preflight 放行
   GET 与 x-respond-with），所以浏览器能直接读。

   代价必须说清楚（文档里如实写着，见 CONTEXT §5 / §12）：
     · 你粘贴的链接会交给 r.jina.ai 这个第三方去打开；
     · 免费额度有限（实测 20 次/分钟），页面慢的时候要等几秒；
     · 小红书有反爬与登录墙，未必每次都抓得到 —— 抓不到就退回只解析文案。
   ============================================================ */

export const READER_PREFIX = 'https://r.jina.ai/';

export type ReaderErrorKind = 'badurl' | 'network' | 'http' | 'empty';

/** 面向用户的读取错误：message 可直接展示 */
export class ReaderError extends Error {
  readonly kind: ReaderErrorKind;
  readonly status: number;

  constructor(kind: ReaderErrorKind, message: string, status = 0) {
    super(message);
    this.name = 'ReaderError';
    this.kind = kind;
    this.status = status;
  }
}

/** 只接受 http(s) 链接 —— 别的协议交给阅读器没有意义 */
export function isFetchableUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 抓页面 HTML。返回的是渲染后的整页 HTML（可能很大，交给 compactPage 压缩） */
export async function readPageHtml(url: string, signal?: AbortSignal): Promise<string> {
  if (!isFetchableUrl(url)) {
    throw new ReaderError('badurl', '这个链接不是 http/https，读不了。');
  }

  let res: Response;
  try {
    res = await fetch(`${READER_PREFIX}${url.trim()}`, {
      headers: { 'x-respond-with': 'html' },
      signal,
    });
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError'
      ? '读取原链接超时，稍后重试。'
      : '没能读到原链接，检查网络后重试。';
    throw new ReaderError('network', msg);
  }
  if (!res.ok) {
    throw new ReaderError('http', `打开原链接失败（${res.status}），先只按文案识别吧。`, res.status);
  }

  const html = await res.text();
  if (!html.trim()) throw new ReaderError('empty', '原链接没有返回内容，先只按文案识别吧。');
  return html;
}

/* ─── 把整页 HTML 压成一小段「页面线索」───────────────────── */

/** 页面上到处都有的噪音词，别当成作者名 */
const NOISE = /(登录|注册|下载|打开|首页|关注|粉丝|客户端|广告|更多|评论|分享)/;

function clean(s: string, max = 60): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 从整页 HTML 里抽出「标题 / 描述 / 作者候选 / 正文摘录」。
 *
 * 为什么不用整页喂给模型：一页 HTML 动辄 1MB 以上，token 又贵又慢，
 * 而且关键信息（作者名）散在 meta、作者区块和内嵌 JSON 里 —— 先把这几处
 * 捞出来，模型看着这几行字就够判断了。
 *
 * 全程只用 DOMParser（不会执行脚本），拿不到的部分留空，不猜。
 */
export function compactPage(html: string, url = ''): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const title = clean(doc.querySelector('title')?.textContent ?? '');
  const metaContent = (sel: string, max = 300) =>
    clean(doc.querySelector(sel)?.getAttribute('content') ?? '', max);
  const ogTitle = metaContent('meta[property="og:title"]');
  const ogDesc = metaContent('meta[property="og:description"]') || metaContent('meta[name="description"]');
  const metaAuthor = metaContent('meta[name="author"]') || metaContent('meta[property="article:author"]', 60);

  /* 作者候选：meta 作者、作者样式块、以及页面里内嵌 JSON 的昵称字段 */
  const authors: string[] = [];
  const addAuthor = (raw: string) => {
    const t = clean(raw, 30);
    if (!t || t.length > 30 || NOISE.test(t) || authors.includes(t)) return;
    authors.push(t);
  };
  if (metaAuthor) addAuthor(metaAuthor);

  /* 内嵌 JSON（小红书 / 抖音 把昵称塞在 <script> 的 state 里）——用原始 HTML 扫，
     因为下面会把 script 从文档里摘掉 */
  for (const m of html.matchAll(/"(?:nickname|authorName|user_name|up_name|screen_name)"\s*:\s*"([^"\\]{1,30})"/g)) {
    addAuthor(m[1]);
  }

  doc.querySelectorAll('script,style,noscript,template,svg').forEach((el) => el.remove());
  doc
    .querySelectorAll('[class*="author"],[class*="nickname"],[class*="user-name"],[class*="username"],[rel="author"]')
    .forEach((el) => addAuthor(el.textContent ?? ''));

  const excerpt = clean(doc.body?.textContent ?? '', 1500);

  const lines: string[] = [];
  if (url) lines.push(`链接: ${url}`);
  if (title) lines.push(`页面标题: ${title}`);
  if (ogTitle && ogTitle !== title) lines.push(`og:title: ${ogTitle}`);
  if (ogDesc) lines.push(`页面描述: ${ogDesc}`);
  if (authors.length) lines.push(`作者候选: ${authors.slice(0, 5).join(' | ')}`);
  if (excerpt) lines.push(`正文摘录: ${excerpt}`);
  return lines.join('\n');
}
