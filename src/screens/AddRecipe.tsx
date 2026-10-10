import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useStore } from '../data/store';
import { useToast } from '../components/Toast';
import { ClearArea, ClearInput } from '../components/ClearInput';
import { Icon } from '../components/Icons';
import { PhotoViewer } from '../components/PhotoViewer';
import { artUrl, initial, newId } from '../data/helpers';
import { imagePath } from '../lib/github';
import { dataUrlMime, photoToDataUrl, rememberPhoto } from '../lib/photo';
import { useBackClose, usePageBack } from '../lib/back';
import { guessArt, parseShare } from '../lib/share';
import { aiTimeout, DeepseekError, recognizeRecipe } from '../lib/ai';
import { preserveTypedValue } from '../lib/inputs';

/** 一条菜谱的草稿字段（单条表单与批量里每一张共用同一套） */
interface RecipeDraft {
  title: string;
  steps: string;
  url: string;
  note: string;
}

/** 批量里的一张截图：识别结果只是「预填」，最终由用户看过、改过才入库 */
interface BatchItem {
  id: string;
  file: File;
  /** 压好的 data URL（识图要发给 AI，入库要当封面） */
  dataUrl: string;
  state: 'wait' | 'busy' | 'ready' | 'fail';
  /** 说明 / 失败原因（认不出菜名也会在这儿提醒一句） */
  error: string;
  draft: RecipeDraft;
}

/** 一次最多认这么多张：再多就该分两批，免得一路认到天荒地老 */
const BATCH_MAX = 9;

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
  const [url, setUrl] = useState('');
  const [steps, setSteps] = useState('');
  const [note, setNote] = useState('');
  /** 点过保存但还没菜名（这时才把「菜名」标红） */
  const [titleBad, setTitleBad] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 用户传上来的菜谱截图（data URL）；存库时它会被传到仓库，路径记进菜谱 */
  const [photo, setPhoto] = useState('');
  /** 正在读 / 压这张图 */
  const [photoBusy, setPhotoBusy] = useState(false);
  /** AI 识别进行中（按钮换成 spinner，避免连点） */
  const [aiBusy, setAiBusy] = useState(false);
  /** 正在看大图的那张 data URL（null = 没打开大图） */
  const [zoom, setZoom] = useState<string | null>(null);
  /** 批量识别（一次选了多张截图）：null = 不在批量流程里 */
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  /** 用户在批量流程里点了「停止」 */
  const batchStop = useRef(false);
  /** 点过批量保存：这时才把缺菜名的那几张标红 */
  const [batchTriedSave, setBatchTriedSave] = useState(false);

  /* 大图是遮罩：手机返回键先关它，而不是退出这一页 */
  useBackClose(zoom !== null, () => setZoom(null));

  /** 批量还在识别中 / 已经认了几张（底部按钮与进度用） */
  const batchBusy = batch?.some((it) => it.state === 'wait' || it.state === 'busy') ?? false;
  const batchDone = batch?.filter((it) => it.state === 'ready' || it.state === 'fail').length ?? 0;

  const cover = guessArt(title);
  /* 设置页填了 DeepSeek Key 且开着 AI，识别才会走联网的 AI */
  const aiKey = db.config?.aiKey ?? '';
  const aiReady = (db.config?.aiOn ?? true) && aiKey !== '';

  /**
   * 选截图：选一张就走「识图 → 在下面确认」，一次选多张就走批量（每张识成一道菜）。
   * `shotArg` 是刚选好的那张 —— setState 是异步的，不能指望 recognize 里读到新值。
   */
  async function onPickPhoto(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    /* 清掉 value：不然连着选同一张图不会再触发 change */
    e.target.value = '';
    if (!files.length) return;
    if (files.length > 1) {
      await runBatch(files);
      return;
    }
    const file = files[0];
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

  /** 只改批量里某一条的草稿字段（用户在卡片上手动改的时候走这里） */
  function patchDraft(id: string, patch: Partial<RecipeDraft>) {
    setBatch((b) =>
      b ? b.map((it) => (it.id === id ? { ...it, draft: { ...it.draft, ...patch } } : it)) : b,
    );
  }

  /** 只改批量里某一条的状态 */
  function patchItem(id: string, patch: Partial<BatchItem>) {
    setBatch((b) => (b ? b.map((it) => (it.id === id ? { ...it, ...patch } : it)) : b));
  }

  /**
   * 批量识图：一次选的每张截图都识成一道菜，但**只做预填、不直接入库** ——
   * 每张图在下面长出一套和单条一样的编辑区，用户逐条看 / 改过，点「保存」才写进菜谱库。
   *
   * 为什么一张接一张（不并发）：一是省得同时撞一堆请求撞上 429，
   * 二是进度按顺序往下走，用户看得明白。Key 失效 / 余额不足这类
   * 后面几张再试也是白试，直接停下，剩下的留白让用户自己填或移除。
   */
  async function runBatch(files: File[]) {
    if (!aiReady) {
      toast('批量识图要先在「设置」里填 DeepSeek Key', false);
      return;
    }
    const picked = files.slice(0, BATCH_MAX);
    if (files.length > BATCH_MAX) toast(`一次最多 ${BATCH_MAX} 张，先认前 ${BATCH_MAX} 张`, false);

    const items: BatchItem[] = picked.map((file) => ({
      id: newId('p'),
      file,
      dataUrl: '',
      state: 'wait',
      error: '',
      draft: { title: '', steps: '', url: '', note: '' },
    }));
    batchStop.current = false;
    setBatchTriedSave(false);
    setBatch(items);

    for (const it of items) {
      if (batchStop.current) {
        patchItem(it.id, { state: 'fail', error: '已停止，自己填吧' });
        continue;
      }
      patchItem(it.id, { state: 'busy' });
      try {
        const dataUrl = it.dataUrl || (await photoToDataUrl(it.file));
        patchItem(it.id, { dataUrl });

        const at = aiTimeout(25000);
        let ai;
        try {
          ai = await recognizeRecipe(aiKey, '', { image: dataUrl, signal: at.signal });
        } finally {
          at.done();
        }
        /* 识别结果只当预填：用户改完再保存（认不出菜名也不算失败，留给他自己填） */
        patchItem(it.id, {
          state: 'ready',
          error: ai.title ? '' : '没认出菜名，自己填一个',
          draft: {
            title: ai.title,
            steps: ai.steps,
            url: '',
            note: ai.note,
          },
        });
      } catch (err) {
        const msg = err instanceof DeepseekError ? err.message : '识别失败，自己填吧';
        patchItem(it.id, { state: 'fail', error: msg });
        if (err instanceof DeepseekError && (err.kind === 'auth' || err.kind === 'balance')) {
          batchStop.current = true;
        }
      }
    }
  }

  /** 批量：用户确认后才写进菜谱库（一张图 = 一条菜谱，各带自己的图片） */
  function saveBatch() {
    if (!batch) return;
    const missing = batch.findIndex((it) => !it.draft.title.trim());
    if (missing !== -1) {
      setBatchTriedSave(true);
      toast(`第 ${missing + 1} 张还缺菜名（或者把它移除）`, false);
      return;
    }
    setSaving(true);
    const items = batch;
    window.setTimeout(() => {
      items.forEach((it) => addRecipe(recipeInputFrom(it.draft, it.dataUrl)));
      toast(`已加入 ${items.length} 道菜`);
      window.setTimeout(() => goBack(), 650);
    }, 750);
  }

  async function recognize(shotArg?: string) {
    const shot = shotArg ?? photo;
    const text = raw.trim();
    setRawInvalid(false);
    if (!text && !shot) {
      setRawInvalid(true);
      return;
    }

    /* 先用本地解析打底：链接交给本地解析抽，永远比 AI 猜得准。 */
    let link = url.trim();
    /* setTitle 是异步的，这里的 toast 判断得用刚解析出来的这份 */
    let localTitle = title.trim();
    if (text) {
      const r = parseShare(text);
      localTitle = r.title;
      setTitle(r.title);
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

    /* 配了 Key 就走 AI：菜名、做法一起拆（有截图就带上截图识图）；
       失败回退到刚打底的本地解析 */
    setAiBusy(true);
    try {
      const at = aiTimeout(25000);
      let ai;
      try {
        ai = await recognizeRecipe(aiKey, text, { image: shot, signal: at.signal });
      } finally {
        at.done();
      }
      /* AI 抽不出来时，本地解析的标题（比如搜索链接的搜索词）不会被清掉 */
      if (ai.title) setTitle(ai.title);
      if (ai.steps) setSteps(ai.steps);
      /* 备注不覆盖用户已经写下的内容 */
      if (ai.note) setNote((n) => (n.trim() ? n : ai.note));
      toast(ai.title || ai.steps ? 'AI 已识别，确认一下' : 'AI 没拆出更多信息，手填一下');
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
    const input = recipeInputFrom({ title, steps, url, note }, photo);
    window.setTimeout(() => {
      addRecipe(input);
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
          {batch ? (
            /* 批量：每张截图长出一套和单条一样的编辑区，纵向排开，用户看过 / 改过再保存 */
            <>
              {batch.map((it, i) => (
                <section className="card sticker stack" key={it.id} style={{ padding: 14 }}>
                  <div className="batch-tag">
                    <span className="bt-n">第 {i + 1} 张</span>
                    <span className="meta">
                      {it.state === 'busy' ? '识别中…' : it.state === 'wait' ? '排队中' : it.error}
                    </span>
                    {batch.length > 1 && (
                      <button
                        className="inlinebtn"
                        onClick={() => setBatch((b) => (b ? b.filter((x) => x.id !== it.id) : b))}
                      >
                        移除这张
                      </button>
                    )}
                  </div>

                  <RecipeFields
                    prefix={`b${i}`}
                    titleInvalid={batchTriedSave && !it.draft.title.trim()}
                    value={it.draft}
                    onChange={(patch) => patchDraft(it.id, patch)}
                    cover={
                      it.dataUrl ? (
                        <button
                          type="button"
                          className="cover photobtn"
                          aria-label={`查看第 ${i + 1} 张大图`}
                          onClick={() => setZoom(it.dataUrl)}
                        >
                          <img src={it.dataUrl} alt="" />
                        </button>
                      ) : (
                        <div className="cover">
                          <span className="spinner" aria-hidden />
                        </div>
                      )
                    }
                  />
                </section>
              ))}
            </>
          ) : (
            <>
          {/* ① 输入：贴一段分享文案，或者传一张截图 —— 两个按钮并排，点完就识别 */}
          <section className="card sticker stack" style={{ padding: 14 }}>
            <div className={`field${rawInvalid ? ' invalid' : ''}`}>
              <ClearArea
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
                onClear={() => {
                  setRaw('');
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
                multiple
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
            <RecipeFields
              prefix="m"
              titleInvalid={titleBad}
              value={{ title, steps, url, note }}
              onChange={(patch) => {
                if (patch.title !== undefined) {
                  setTitle(patch.title);
                  setTitleBad(false);
                }
                if (patch.steps !== undefined) setSteps(patch.steps);
                if (patch.url !== undefined) setUrl(patch.url);
                if (patch.note !== undefined) setNote(patch.note);
              }}
              cover={
                photo ? (
                  /* 选好的截图点一下能看大图；没选图时封面是插画 / 首字，不给点 */
                  <button
                    type="button"
                    className="cover photobtn"
                    aria-label="查看大图"
                    onClick={() => setZoom(photo)}
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
                )
              }
            />
          </section>
            </>
          )}
        </div>
      </main>

      {/* 底部：单条是「保存并同步」；批量是先认（可停）再「保存 N 道菜」，全都由用户点头才入库 */}
      {batch ? (
        <div className="actionbar">
          <div className="row" style={{ gap: 10 }}>
            {batchBusy ? (
              <>
                <button
                  className="btn-ghost"
                  style={{ flex: '0 0 auto', width: 'auto', padding: '0 18px' }}
                  onClick={() => {
                    batchStop.current = true;
                  }}
                >
                  停止
                </button>
                <button className="btn-primary" disabled>
                  <span className="spinner" aria-hidden /> 识别中 {batchDone} / {batch.length}
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn-ghost"
                  style={{ flex: '0 0 auto', width: 'auto', padding: '0 18px' }}
                  onClick={() => setBatch(null)}
                >
                  取消
                </button>
                <button className="btn-primary" disabled={saving} onClick={saveBatch}>
                  {saving ? (
                    <>
                      <span className="spinner" aria-hidden /> 正在推送…
                    </>
                  ) : (
                    <>
                      <Icon name="save" style={{ width: 18, height: 18 }} />
                      <span>保存 {batch.length} 道菜</span>
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
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
      )}

      {/* 看大图：盖在最上层，返回键 / Esc / 点遮罩 / × 都能关（见 useBackClose） */}
      {zoom && (
        <PhotoViewer src={zoom} alt="菜谱截图" onClose={() => setZoom(null)} />
      )}
    </div>
  );
}

/**
 * 一条菜谱的编辑区：单条添加和批量里每一张共用它 —— 字段、校验、样式完全一致，
 * 改一处两边都变。`prefix` 用来给输入框发唯一 id（单条是 `m`，批量是 `b0` / `b1`…）。
 */
function RecipeFields({
  prefix,
  cover,
  value,
  onChange,
  titleInvalid = false,
}: {
  prefix: string;
  cover: ReactNode;
  value: RecipeDraft;
  onChange: (patch: Partial<RecipeDraft>) => void;
  titleInvalid?: boolean;
}) {
  return (
    <>
      <div className="prevrow">
        {cover}
        <div className={`field${titleInvalid ? ' invalid' : ''}`} style={{ minWidth: 0 }}>
          <label htmlFor={`${prefix}Title`}>菜名</label>
          <ClearInput
            id={`${prefix}Title`}
            type="text"
            spellCheck={false}
            placeholder="这道菜叫什么？"
            value={value.title}
            onChange={(e) => onChange({ title: e.target.value })}
            onClear={() => onChange({ title: '' })}
            {...preserveTypedValue((v) => onChange({ title: v }))}
          />
          <span className="err">总得有个名字才能存</span>
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${prefix}Steps`}>做法</label>
        <ClearArea
          id={`${prefix}Steps`}
          placeholder="一步一行，换行分开就行"
          style={{ minHeight: 92 }}
          value={value.steps}
          onChange={(e) => onChange({ steps: e.target.value })}
          onClear={() => onChange({ steps: '' })}
          {...preserveTypedValue((v) => onChange({ steps: v }))}
        />
      </div>

      <div className="field">
        <label htmlFor={`${prefix}Url`}>原文链接</label>
        <ClearInput
          id={`${prefix}Url`}
          type="url"
          spellCheck={false}
          placeholder="https://…"
          value={value.url}
          onChange={(e) => onChange({ url: e.target.value })}
          onClear={() => onChange({ url: '' })}
          {...preserveTypedValue((v) => onChange({ url: v }))}
        />
      </div>

      <div className="sep" />

      <div className="field">
        <label htmlFor={`${prefix}Note`}>备注</label>
        <ClearArea
          id={`${prefix}Note`}
          placeholder="想记的点：少辣、换食材、准备时间…"
          value={value.note}
          onChange={(e) => onChange({ note: e.target.value })}
          onClear={() => onChange({ note: '' })}
          {...preserveTypedValue((v) => onChange({ note: v }))}
        />
      </div>
    </>
  );
}

/**
 * 草稿 → 待入库的菜谱：id 先定下来（图片路径 `images/<id>.<ext>` 要跟着它走），
 * 图的字节先落本机缓存，推送时同步引擎再传到仓库（没连仓库就先只有本机能看）。
 */
function recipeInputFrom(draft: RecipeDraft, dataUrl: string) {
  const id = newId('r');
  const title = draft.title.trim();
  const image = dataUrl ? imagePath(id, dataUrlMime(dataUrl)) : '';
  if (image) rememberPhoto(image, dataUrl);
  return {
    id,
    title,
    url: draft.url.trim(),
    art: guessArt(title),
    image,
    steps: draft.steps.trim(),
    note: draft.note.trim(),
  };
}
