import { useState, type ChangeEvent } from 'react';
import { useStore } from '../data/store';
import { useToast } from '../components/Toast';
import { Icon } from '../components/Icons';
import { PhotoViewer } from '../components/PhotoViewer';
import { artUrl, initial, newId } from '../data/helpers';
import { imagePath } from '../lib/github';
import { dataUrlMime, photoToDataUrl, rememberPhoto } from '../lib/photo';
import { useBackClose, usePageBack } from '../lib/back';
import { detectSource, guessArt, parseShare } from '../lib/share';
import { aiTimeout, DeepseekError, recognizeRecipe } from '../lib/ai';
import { compactPage, isFetchableUrl, readPageHtml } from '../lib/reader';
import { preserveTypedValue } from '../lib/inputs';
import type { SourceKey } from '../data/types';

/**
 * 添加菜谱 —— 只有两块卡片：上面「贴链接 / 传截图 → 识别」，下面就是这条菜谱本身。
 *
 * 版式上的取舍：识别结果直接落在下方的字段里（不再单开一块「解析结果」预览），
 * 字段也一直摆着、不折叠 —— 少一层展开收起，用户随时知道自己在填什么。
 * 界面上不再写「这一段文字是干什么的」那种说明，能靠按钮文案和 placeholder
 * 讲清楚的就别加段落。
 */
export default function AddRecipe() {
  const { addRecipe, db } = useStore();
  const { toast } = useToast();

  /* 返回按钮与手机物理返回键共用同一套判断：能回上一屏就回，回不去才落到菜谱库 */
  const goBack = usePageBack('/library');

  /** 粘贴进来的原文（链接或整段分享文案） */
  const [raw, setRaw] = useState('');
  const [rawInvalid, setRawInvalid] = useState(false);

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [url, setUrl] = useState('');
  const [steps, setSteps] = useState('');
  const [note, setNote] = useState('');
  /** 用户自己挑过的来源；没挑过就按链接 / 文案自动认 */
  const [sourcePicked, setSourcePicked] = useState<SourceKey | null>(null);
  /** 点过保存但还没菜名（这时才把「菜名」标红） */
  const [titleBad, setTitleBad] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 用户传上来的菜谱截图（data URL）；存库时它会被传到仓库，路径记进菜谱 */
  const [photo, setPhoto] = useState('');
  /** 正在读 / 压这张图 */
  const [photoBusy, setPhotoBusy] = useState(false);
  /** AI 识别进行中（按钮换成 spinner，避免连点） */
  const [aiBusy, setAiBusy] = useState(false);
  /** 点封面上的截图看大图（没选截图时不会打开） */
  const [zoom, setZoom] = useState(false);

  /* 大图是遮罩：手机返回键先关它，而不是退出这一页 */
  useBackClose(zoom, () => setZoom(false));

  const cover = guessArt(title);
  /**
   * 来源：用户挑过就听用户的，否则按链接认（小红书 / B站 / 抖音 / 网页）；
   * 既没链接也没挑过 = 手写的，记「手动」。所以这里不需要在识别时再手动 setSource。
   */
  const detected = detectSource(url.trim()) ?? detectSource(raw.trim());
  const source: SourceKey = sourcePicked ?? detected ?? 'manual';
  /* 设置页填了 DeepSeek Key 且开着 AI，识别才会走联网的 AI */
  const aiKey = db.config?.aiKey ?? '';
  const aiReady = (db.config?.aiOn ?? true) && aiKey !== '';

  /**
   * 选一张截图 / 照片：先压小，再（配了 Key 的话）顺手识一次图。
   * `shotArg` 是刚选好的那张 —— setState 是异步的，不能指望 recognize 里读到新值。
   */
  async function onPickPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    /* 清掉 value：不然连着选同一张图不会再触发 change */
    e.target.value = '';
    if (!file) return;
    setPhotoBusy(true);
    try {
      const dataUrl = await photoToDataUrl(file);
      setPhoto(dataUrl);
      if (aiReady) {
        toast('截图收到了，AI 正在识图…');
        await recognize(dataUrl);
      } else {
        toast('截图已加，填个标题就能存；识图要先在「设置」里填 DeepSeek Key', false);
      }
    } catch {
      toast('这张图读不出来，换一张试试', false);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function recognize(shotArg?: string) {
    const shot = shotArg ?? photo;
    const text = raw.trim();
    setRawInvalid(false);
    if (!text && !shot) {
      setRawInvalid(true);
      return;
    }

    /* 先用本地解析打底：链接与来源按域名判断，永远比 AI 猜得准。
       只给了一张截图时没有文案可解析，来源按「手动」记（见上面的 source）。 */
    let link = url.trim();
    /* setTitle 是异步的，这里的 toast 判断得用刚解析出来的这份 */
    let localTitle = title.trim();
    if (text) {
      const r = parseShare(text);
      localTitle = r.title;
      setTitle(r.title);
      setAuthor(r.author);
      setUrl(r.url);
      link = r.url;
      setTitleBad(false);
    }

    if (!aiReady) {
      if (!text && shot) toast('截图先存着，标题手填一下（识图要配 DeepSeek Key）', false);
      else if (localTitle) toast('已从文案里拆出标题，确认一下');
      else if (link) toast('认出链接了，标题手填一下', false);
      else toast('没找到链接，当普通笔记存吧', false);
      return;
    }

    /* 配了 Key 就走 AI：菜名、作者、做法一起拆（有截图就带上截图识图）；
       失败回退到刚打底的本地解析 */
    setAiBusy(true);
    try {
      /* 文案里有链接就先抓一次页面，作为作者 / 账号的补充线索（抓不到就跳过） */
      let page = '';
      if (isFetchableUrl(link)) {
        const rt = aiTimeout(25000);
        try {
          page = compactPage(await readPageHtml(link, rt.signal), link);
        } catch {
          /* 抓不到（反爬 / 登录墙 / 超时）就只按文案识别，不打断 */
        } finally {
          rt.done();
        }
      }

      const at = aiTimeout(25000);
      let ai;
      try {
        ai = await recognizeRecipe(aiKey, text, { page, image: shot, signal: at.signal });
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

  function save() {
    if (!title.trim()) {
      /* 按钮一直可点，点了没名字就明说哪里缺，而不是给个点不动的灰按钮 */
      setTitleBad(true);
      toast('先给这道菜起个名字', false);
      return;
    }
    setSaving(true);
    /* id 先定下来：照片路径（images/<id>.jpg）要跟着这条菜谱走。
       图的字节先落在本机缓存里 —— 推送时同步引擎会把它传到仓库，
       没连仓库就先只有本机能看，连上之后再传。 */
    const id = newId('r');
    const path = photo ? imagePath(id, dataUrlMime(photo)) : '';
    if (path) rememberPhoto(path, photo);
    window.setTimeout(() => {
      addRecipe({
        id,
        title: title.trim(),
        source,
        url: url.trim(),
        /* 作者留空就真的留空：界面上不占位，别拿「来自剪藏」这种假出处顶替 */
        author: author.trim(),
        art: cover,
        image: path,
        steps: steps.trim(),
        note: note.trim(),
      });
      toast('已保存 · 已同步');
      /* 存完就离开这一页：返回键不该再退回到一张已经交掉的表单 */
      window.setTimeout(() => goBack(), 650);
    }, 750);
  }

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
        <div className="pad stack" style={{ paddingTop: 10, paddingBottom: 14 }}>
          {/* ① 输入：贴一段分享文案，或者传一张截图 —— 两个按钮并排，点完就识别 */}
          <section className="card sticker stack" style={{ padding: 14 }}>
            <div className={`field${rawInvalid ? ' invalid' : ''}`}>
              <textarea
                id="shareInput"
                rows={3}
                spellCheck={false}
                autoComplete="off"
                aria-label="分享文案或链接"
                placeholder="粘贴小红书 / B站 / 抖音的分享链接或文案"
                style={{ minHeight: 76, fontSize: 14 }}
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
            </div>

            <div className="shotrow">
              <label className="btn-sticker capture" htmlFor="photoInput">
                <Icon name="image" />
                {photoBusy ? '处理中…' : photo ? '换张截图' : '传张截图'}
              </label>
              {photo && !photoBusy && (
                <button className="icbtn ghost" aria-label="移除截图" onClick={() => setPhoto('')}>
                  <Icon name="x" />
                </button>
              )}
              <input
                id="photoInput"
                className="hiddenfile"
                type="file"
                accept="image/*"
                aria-label="选择菜谱截图"
                onChange={(e) => void onPickPhoto(e)}
              />
              <button
                id="recognizeBtn"
                className="btn-primary"
                disabled={aiBusy || photoBusy}
                onClick={() => void recognize()}
              >
                {aiBusy ? (
                  <>
                    <span className="spinner" aria-hidden /> 识别中…
                  </>
                ) : aiReady && photo ? (
                  'AI 识图'
                ) : aiReady ? (
                  'AI 识别'
                ) : (
                  '识别'
                )}
              </button>
            </div>

            {/* 只有没配 Key 时才需要说这一句；配了的话按钮自己就叫「AI 识别」 */}
            {!aiReady && (
              <p className="hintline">
                在「设置」里填 DeepSeek Key：识别能自动拆菜名和做法，也能直接读截图。
              </p>
            )}
          </section>

          {/* ② 这条菜谱本身：识别结果直接填在这些字段里，随时可改 */}
          <section className="card sticker stack" style={{ padding: 14 }}>
            <div className="prevrow">
              {photo ? (
                /* 选好的截图点一下能看大图；没选图时封面是插画 / 首字，不给点 */
                <button
                  type="button"
                  className="cover photobtn"
                  aria-label="查看大图"
                  onClick={() => setZoom(true)}
                >
                  <img src={photo} alt="菜谱截图" />
                </button>
              ) : (
                <div className="cover">
                  {cover ? (
                    <img src={artUrl(cover)} alt="封面" />
                  ) : (
                    <span className="mono">{initial(title)}</span>
                  )}
                </div>
              )}
              <div className={`field${titleBad ? ' invalid' : ''}`} style={{ minWidth: 0 }}>
                <label htmlFor="mTitle">菜名</label>
                <input
                  id="mTitle"
                  type="text"
                  spellCheck={false}
                  placeholder="这道菜叫什么？"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleBad(false);
                  }}
                  {...preserveTypedValue((v) => {
                    setTitle(v);
                    setTitleBad(false);
                  })}
                />
                <span className="err">总得有个名字才能存</span>
              </div>
            </div>

            <div className="field">
              <label htmlFor="mSteps">做法</label>
              <textarea
                id="mSteps"
                placeholder="一步一行，换行分开就行"
                style={{ minHeight: 92 }}
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
                {...preserveTypedValue(setSteps)}
              />
            </div>

            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="mAuthor">作者</label>
                <input
                  id="mAuthor"
                  type="text"
                  spellCheck={false}
                  placeholder="可不填"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  {...preserveTypedValue(setAuthor)}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="mSource">来源</label>
                <select
                  id="mSource"
                  value={source}
                  onChange={(e) => setSourcePicked(e.target.value as SourceKey)}
                >
                  <option value="manual">手动</option>
                  <option value="generic">网页</option>
                  <option value="red">小红书</option>
                  <option value="bili">B站</option>
                  <option value="douyin">抖音</option>
                </select>
              </div>
            </div>

            <div className="field">
              <label htmlFor="mUrl">原文链接</label>
              <input
                id="mUrl"
                type="url"
                spellCheck={false}
                placeholder="https://…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                {...preserveTypedValue(setUrl)}
              />
            </div>

            <div className="sep" />

            <div className="field">
              <label htmlFor="noteArea">备注</label>
              <textarea
                id="noteArea"
                placeholder="想记的点：少辣、换食材、准备时间…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                {...preserveTypedValue(setNote)}
              />
            </div>
          </section>
        </div>
      </main>

      <div className="actionbar">
        <button className="btn-primary" disabled={saving} onClick={save}>
          {saving ? (
            <>
              <span className="spinner" aria-hidden /> 正在推送…
            </>
          ) : (
            <>
              <Icon name="save" style={{ width: 18, height: 18 }} />
              <span>保存并同步</span>
            </>
          )}
        </button>
      </div>

      {/* 看大图：盖在最上层，返回键 / Esc / 点遮罩 / × 都能关（见 useBackClose） */}
      {zoom && photo && (
        <PhotoViewer src={photo} alt={title.trim() || '菜谱截图'} onClose={() => setZoom(false)} />
      )}
    </div>
  );
}
