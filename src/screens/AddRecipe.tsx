import { useState } from 'react';
import { useStore } from '../data/store';
import { useToast } from '../components/Toast';
import { SourceBadge } from '../components/Bits';
import { Icon } from '../components/Icons';
import { artUrl, initial } from '../data/helpers';
import { usePageBack } from '../lib/back';
import { detectSource, guessArt, parseShare } from '../lib/share';
import { aiTimeout, DeepseekError, recognizeRecipe } from '../lib/ai';
import { compactPage, isFetchableUrl, readPageHtml } from '../lib/reader';
import { preserveTypedValue } from '../lib/inputs';
import type { SourceKey } from '../data/types';

export default function AddRecipe() {
  const { addRecipe, db } = useStore();
  const { toast } = useToast();

  /* 返回按钮与手机物理返回键共用同一套判断：能回上一屏就回，回不去才落到菜谱库 */
  const goBack = usePageBack('/library');

  /** 粘贴进来的原文（链接或整段分享文案） */
  const [raw, setRaw] = useState('');
  const [rawInvalid, setRawInvalid] = useState(false);
  /** 已经解析过一次 —— 解析结果只作预填，下面几个字段始终可改 */
  const [parsed, setParsed] = useState(false);

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [source, setSource] = useState<SourceKey>('generic');
  const [url, setUrl] = useState('');
  const [steps, setSteps] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  /** AI 识别进行中（按钮换成 spinner，避免连点） */
  const [aiBusy, setAiBusy] = useState(false);

  const cover = guessArt(title);
  const canSave = title.trim().length > 0 && !saving;
  /* 设置页填了 DeepSeek Key 且开着 AI，识别才会走联网的 AI */
  const aiKey = db.config?.aiKey ?? '';
  const aiReady = (db.config?.aiOn ?? true) && aiKey !== '';

  async function recognize() {
    const text = raw.trim();
    setRawInvalid(false);
    if (!text) {
      setRawInvalid(true);
      return;
    }

    /* 先用本地解析打底：链接与来源按域名判断，永远比 AI 猜得准 */
    const r = parseShare(text);
    setTitle(r.title);
    setAuthor(r.author);
    setSource(r.source);
    setUrl(r.url);
    setParsed(true);

    if (!aiReady) {
      if (r.title) toast('已从文案里拆出标题，确认一下');
      else if (r.url) toast('认出链接了，标题手填一下', false);
      else toast('没找到链接，当普通笔记存吧', false);
      return;
    }

    /* 配了 Key 就走 AI：菜名、作者、做法一起拆；失败回退到刚打底的本地解析 */
    setAiBusy(true);
    try {
      /* 文案里有链接就先抓一次页面，作为作者 / 账号的补充线索（抓不到就跳过） */
      let page = '';
      if (isFetchableUrl(r.url)) {
        const rt = aiTimeout(25000);
        try {
          page = compactPage(await readPageHtml(r.url, rt.signal), r.url);
        } catch {
          /* 抓不到（反爬 / 登录墙 / 超时）就只按文案识别，不打断 */
        } finally {
          rt.done();
        }
      }

      const at = aiTimeout(25000);
      let ai;
      try {
        ai = await recognizeRecipe(aiKey, text, { page, signal: at.signal });
      } finally {
        at.done();
      }
      /* AI 抽不出来时，本地解析的标题（比如搜索链接的搜索词）不会被清掉 */
      if (ai.title) setTitle(ai.title);
      if (ai.author) setAuthor(ai.author);
      if (ai.steps) setSteps(ai.steps);
      /* 备注不覆盖用户已经写下的内容 */
      if (ai.note) setNote((n) => (n.trim() ? n : ai.note));
      toast(ai.author ? 'AI 已识别（含作者），确认一下' : ai.title || ai.steps ? 'AI 已识别，确认一下' : 'AI 没拆出更多信息，手填一下');
    } catch (e) {
      toast(e instanceof DeepseekError ? e.message : 'AI 识别失败，已用本地解析', false);
    } finally {
      setAiBusy(false);
    }
  }

  /* 跳过「粘贴 → 识别」：直接手写一条，来源记成「手动」 */
  function startManual() {
    setRawInvalid(false);
    setSource('manual');
    setParsed(true);
    toast('手动添加：填个标题就能存');
  }

  function save() {
    if (!title.trim()) return;
    setSaving(true);
    window.setTimeout(() => {
      addRecipe({
        title: title.trim(),
        source,
        url: url.trim(),
        author: author.trim() || '来自剪藏',
        art: cover,
        steps: steps.trim(),
        note: note.trim(),
      });
      toast('已保存 · 已同步');
      /* 存完就离开这一页：返回键不该再退回到一张已经交掉的表单 */
      window.setTimeout(() => goBack(), 650);
    }, 750);
  }

  const canDetect = detectSource(raw) !== null;

  return (
    <div className="app s-add">
      <div className="sheetbar">
        <button
          className="icbtn ghost"
          aria-label="返回上一屏"
          style={{ borderRadius: 16 }}
          onClick={goBack}
        >
          <Icon name="back" />
        </button>
        <h1 className="title" style={{ flex: 1, textAlign: 'center' }}>
          添加菜谱
        </h1>
        <span style={{ width: 44 }} />
      </div>

      <main className="scroll">
        <div className="pad stack" style={{ paddingTop: 6, paddingBottom: 14 }}>
          <section className="card sticker" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <p className="greeting" style={{ marginBottom: 4 }}>
                粘贴分享文案
              </p>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.35 }}>
                把「分享 → 复制链接」那一整段粘进来
              </p>
            </div>

            <div className={`field${rawInvalid ? ' invalid' : ''}`}>
              <textarea
                id="shareInput"
                rows={3}
                spellCheck={false}
                autoComplete="off"
                aria-label="分享文案或链接"
                placeholder="例如：西红柿炒鸡蛋，你就像我这样做，真的很下饭！ http://xhslink.com/xxxx 复制本条信息，打开【小红书】App查看精彩内容！"
                style={{ minHeight: 84, fontSize: 14 }}
                value={raw}
                onChange={(e) => {
                  setRaw(e.target.value);
                  setRawInvalid(false);
                }}
                {...preserveTypedValue((v) => {
                  setRaw(v);
                  setRawInvalid(false);
                })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    recognize();
                  }
                }}
              />
              <span className="err">先粘一段文案或链接</span>
              <span className="hint">
                标题会从文案里自动拆出来。只贴一个链接也行，但那种情况拿不到标题（浏览器读不了小红书的页面），会直接留给你手填。
              </span>
            </div>

            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button id="manualBtn" className="btn-sticker" onClick={startManual}>
                手动添加
              </button>
              <button
                id="recognizeBtn"
                className="btn-sticker primary"
                disabled={aiBusy}
                onClick={() => void recognize()}
              >
                {aiBusy ? (
                  <>
                    <span className="spinner" aria-hidden /> AI 识别中…
                  </>
                ) : aiReady ? (
                  'AI 识别'
                ) : (
                  '识别'
                )}
              </button>
            </div>

            <p className="meta" style={{ margin: 0 }}>
              {aiReady
                ? 'AI 识别已开启（DeepSeek）：会先打开原链接补作者 / 账号，再拆菜名和做法；结果仍可手改。'
                : '在「设置」里填 DeepSeek API Key，识别就能连 AI 一起拆出做法和作者。'}
            </p>
          </section>

          <section>
            <div className={`preview${parsed ? ' loaded' : ''}`}>
              {!parsed && (
                <div className="phint">
                  <Icon name="image" />
                  解析出来的标题、作者会填到下面的输入框里，保存前随时可改。
                </div>
              )}

              {parsed && (
                <div className="prevrow">
                  <div className="cover">
                    {cover ? (
                      <img src={artUrl(cover)} alt={title || '封面'} />
                    ) : (
                      <span className="mono">{initial(title)}</span>
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <SourceBadge source={source} />
                    <p style={{ margin: '6px 0 2px', fontSize: 16, fontWeight: 600 }}>
                      {title || '还没填标题'}
                    </p>
                    <p className="meta" style={{ margin: 0 }}>
                      {author || '未署名'}
                    </p>
                  </div>
                </div>
              )}

              {/* 解析只是预填，这几个字段始终可改 —— 启发式解析不可能次次都对 */}
              <div className={`manual${parsed ? ' show' : ''}`}>
                <div className={`field${parsed && !title.trim() ? ' invalid' : ''}`}>
                  <label htmlFor="mTitle">标题</label>
                  <input
                    id="mTitle"
                    type="text"
                    spellCheck={false}
                    placeholder="这道菜叫什么？"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    {...preserveTypedValue(setTitle)}
                  />
                  <span className="err">填个标题才能保存</span>
                </div>

                <div className="field">
                  <label htmlFor="mSteps">做法（可留空）</label>
                  <textarea
                    id="mSteps"
                    placeholder="一步一步写，换行分开就行。手动添加的菜谱主要就靠这一段。"
                    style={{ minHeight: 96 }}
                    value={steps}
                    onChange={(e) => setSteps(e.target.value)}
                    {...preserveTypedValue(setSteps)}
                  />
                </div>

                <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label htmlFor="mAuthor">作者 / 账号（可留空）</label>
                    <input
                      id="mAuthor"
                      type="text"
                      spellCheck={false}
                      placeholder="原作者"
                      value={author}
                      onChange={(e) => setAuthor(e.target.value)}
                      {...preserveTypedValue(setAuthor)}
                    />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label htmlFor="mSource">来源平台</label>
                    <select
                      id="mSource"
                      value={source}
                      onChange={(e) => setSource(e.target.value as SourceKey)}
                    >
                      <option value="manual">手动添加（无来源）</option>
                      <option value="generic">其他网页</option>
                      <option value="red">小红书</option>
                      <option value="bili">B站</option>
                      <option value="douyin">抖音</option>
                    </select>
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="mUrl">原文链接（可留空）</label>
                  <input
                    id="mUrl"
                    type="url"
                    spellCheck={false}
                    placeholder="https://…"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    {...preserveTypedValue(setUrl)}
                  />
                  <span className="hint">
                    {canDetect ? '已从文案里认出链接。' : '没认出链接 —— 也可以先存着，以后补。'}
                  </span>
                </div>

              </div>
            </div>
          </section>

          <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label htmlFor="noteArea" style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
              备注 <span className="meta" style={{ fontWeight: 400 }}>（可选）</span>
            </label>
            <textarea
              id="noteArea"
              placeholder="例如：少辣、替换食材、准备时间…"
              style={{ minHeight: 74 }}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              {...preserveTypedValue(setNote)}
            />
          </section>
        </div>
      </main>

      <div className="actionbar">
        <div className="stack" style={{ gap: 8 }}>
          <button className="btn-primary" disabled={!canSave} onClick={save}>
            {saving ? (
              <>
                <span className="spinner" aria-hidden /> 正在推送…
              </>
            ) : (
              <>
                <Icon name="save" style={{ width: 18, height: 18 }} />
                <span>保存并同步到仓库</span>
              </>
            )}
          </button>
          <p className="saveline">保存后立即推送到仓库，列表顶部会出现新条目。</p>
        </div>
      </div>
    </div>
  );
}
