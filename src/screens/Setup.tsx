import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../data/store';
import { useSync } from '../lib/useSync';
import { useToast } from '../components/Toast';
import { Icon } from '../components/Icons';
import { GithubError, maskToken, normalizeToken, tokenShapeError } from '../lib/github';
import { preserveTypedValue } from '../lib/inputs';
import { partnerOf } from '../data/helpers';
import type { PersonKey, SyncConfig } from '../data/types';

type IntervalSec = 0 | 60 | 600;

/** 按错误类型给出「下一步该改什么」，而不是一句笼统的「访问被拒绝」 */
function hintFor(e: unknown): string {
  if (!(e instanceof GithubError)) return '检查网络后重试。输入内容已保留。';
  switch (e.kind) {
    case 'auth':
      return 'token 无效或已过期。去 GitHub → Settings → Developer settings 重新生成一个。';
    case 'forbidden':
      return 'token 权限不够。需要 contents 的读写权限；如果是 Fine-grained token，还要把这个仓库显式加进仓库列表。';
    case 'notfound':
      return '两种情况：① 仓库名写错了（要写成 用户名/仓库名，完整且区分不了大小写没关系）；② 仓库是私有的，而这个 token 看不到它 —— GitHub 对「无权访问的私有仓库」一律回 404，不会说“无权限”。';
    case 'network':
      return '没能连上 api.github.com。检查手机/电脑的网络。';
    case 'conflict':
      return '仓库里的文件刚被改过，等一下再试。';
    default:
      return '输入内容已保留，改一下再试。';
  }
}

export default function Setup() {
  const { db, setConfig, joinAs } = useStore();
  const sync = useSync();
  const { toast } = useToast();
  const navigate = useNavigate();

  /* 本机默认认领 a 槽；连上仓库后，joinAs 会按名字决定真正的槽位 */
  const [slot] = useState<PersonKey>(db.config?.me === 'b' ? 'b' : 'a');
  const otherSlot = partnerOf(slot);
  const [names, setNames] = useState<Record<PersonKey, string>>({
    a: db.profiles?.a?.nickname ?? '',
    b: db.profiles?.b?.nickname ?? '',
  });
  const myName = names[slot];
  const partnerName = names[otherSlot];
  const setMyName = (v: string) => setNames((s) => ({ ...s, [slot]: v }));
  const setPartnerName = (v: string) => setNames((s) => ({ ...s, [otherSlot]: v }));

  const [token, setToken] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [intervalSec, setIntervalSec] = useState<IntervalSec>(60);

  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [tokenErr, setTokenErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<{ msg: string; hint: string } | null>(null);

  const [importJson, setImportJson] = useState('');
  const [importErr, setImportErr] = useState('');

  const [done, setDone] = useState<{ seeded: boolean; repo: string; branch: string } | null>(null);

  /* ─── 校验（blur 触发，错误保留输入）─── */

  function validateOne(key: string, value: string): boolean {
    const v = value.trim();
    if (key === 'nickname') return v.length >= 1 && v.length <= 12;
    /* 对方昵称是可选的：留空表示「之后再说」，不拦着连接 */
    if (key === 'partner') return v.length <= 12;
    if (key === 'token') return tokenShapeError(v) === null;
    if (key === 'repo') return /^[\w.-]+\/[\w.-]+$/.test(v);
    if (key === 'branch') return v.length > 0;
    return true;
  }

  function blurCheck(key: string, value: string) {
    if (key === 'token') {
      const msg = tokenShapeError(value);
      setTokenErr(msg);
      setInvalid((s) => ({ ...s, token: msg !== null }));
      return;
    }
    setInvalid((s) => ({ ...s, [key]: !validateOne(key, value) }));
  }

  function allValid(): boolean {
    const tokenMsg = tokenShapeError(token);
    setTokenErr(tokenMsg);
    const next = {
      nickname: !validateOne('nickname', myName),
      partner: !validateOne('partner', partnerName),
      token: tokenMsg !== null,
      repo: !validateOne('repo', repo),
      branch: !validateOne('branch', branch),
    };
    setInvalid(next);
    return !Object.values(next).some(Boolean);
  }

  /** 把向导里填的名字落库，并认领「我是谁」（内容改动 → 会随仓库同步） */
  function applyNames() {
    joinAs({ myName, partnerName, preferred: slot });
  }

  /* ─── JSON 导入 ─── */

  function doImport() {
    setImportErr('');
    const raw = importJson.trim();
    if (!raw) {
      setImportErr('先粘贴一条配置 JSON');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setImportErr('JSON 格式不对，检查引号和逗号后再试');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setImportErr('配置要是一个 JSON 对象');
      return;
    }

    const obj = parsed as Record<string, unknown>;
    const cfg = (obj.config && typeof obj.config === 'object' ? obj.config : obj) as Record<string, unknown>;

    const nick = typeof cfg.nickname === 'string' ? cfg.nickname.trim() : '';
    const tk = typeof cfg.token === 'string' ? normalizeToken(cfg.token) : '';
    const rp = typeof cfg.repo === 'string' ? cfg.repo.trim() : '';
    const br = typeof cfg.branch === 'string' && cfg.branch.trim() ? cfg.branch.trim() : 'main';
    const iv = cfg.intervalSec === undefined ? 60 : Number(cfg.intervalSec);

    const missing: string[] = [];
    if (!nick) missing.push('nickname');
    if (!tk) missing.push('token');
    if (!rp) missing.push('repo');
    if (missing.length) {
      setImportErr(`配置缺少：${missing.join('、')}`);
      return;
    }
    if (nick.length > 12) {
      setImportErr('nickname 要填 1–12 个字');
      return;
    }
    if (tk.length < 8) {
      setImportErr('token 至少需要 8 个字符');
      return;
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(rp)) {
      setImportErr('repo 要写成 owner/repo 的格式');
      return;
    }
    if (![0, 60, 600].includes(iv)) {
      setImportErr('intervalSec 只能是 0、60 或 600');
      return;
    }

    const partnerNick = typeof cfg.partnerNickname === 'string' ? cfg.partnerNickname.trim() : '';
    if (partnerNick.length > 12) {
      setImportErr('partnerNickname 最多 12 个字');
      return;
    }

    setNames((s) => {
      const next = { ...s };
      next[slot] = nick;
      if (partnerNick) next[otherSlot] = partnerNick;
      return next;
    });
    setToken(tk);
    setRepo(rp);
    setBranch(br);
    setIntervalSec(iv as IntervalSec);
    setInvalid({});
    toast('配置已导入，检查后连接');
  }

  /* ─── 连接 ─── */

  async function connect() {
    setConnectError(null);
    if (!allValid()) {
      toast('先把标红的项填对', false);
      return;
    }

    const cfg: SyncConfig = {
      repo: repo.trim(),
      branch: branch.trim() || 'main',
      token: normalizeToken(token),
      tokenMask: maskToken(normalizeToken(token)),
      me: slot,
      autoPull: intervalSec > 0,
      intervalSec,
      lastPulledAt: '—',
      lastPushedAt: '—',
    };

    setBusy(true);
    try {
      const { seeded } = await sync.connect(cfg);
      /* 名字在拉取之后落 —— 用户刚填的应当覆盖仓库里的；
         对方那栏留空则保留仓库已有（applyNames 里处理） */
      applyNames();
      setDone({ seeded, repo: cfg.repo, branch: cfg.branch });
    } catch (e) {
      /* 输入全部保留，并把「到底是哪一类失败」原样告诉用户 */
      setConnectError({
        msg: e instanceof Error ? e.message : '连接失败，检查网络后重试。',
        hint: hintFor(e),
      });
      toast('连接失败，看下方原因', false);
    } finally {
      setBusy(false);
    }
  }

  function localMode() {
    if (!validateOne('nickname', myName)) {
      setInvalid((s) => ({ ...s, nickname: true }));
      toast('先填一个昵称', false);
      return;
    }
    const cfg: SyncConfig = {
      repo: '',
      branch: branch.trim() || 'main',
      token: '',
      tokenMask: '',
      me: slot,
      autoPull: false,
      intervalSec: 0,
      lastPulledAt: '—',
      lastPushedAt: '—',
    };
    setConfig(cfg);
    applyNames();
    toast('已进入本地模式，之后可在「同步」里连接');
    navigate('/library');
  }

  /* ─── 已连接视图 ─── */

  if (done) {
    return (
      <div className="app s-setup">
        <main className="scroll wizard">
          <section className="pad" style={{ paddingTop: '8vh' }}>
            <div className="card sticker connectcard">
              <div className="okseal">
                <Icon name="check" />
              </div>
              <p className="greeting" style={{ marginBottom: 6 }}>
                连接成功
              </p>
              <h1 className="ptitle" style={{ fontSize: 26 }}>
                仓库已接管你的菜谱
              </h1>
              <p style={{ margin: '8px 0 18px', color: 'var(--muted)', fontSize: 14 }}>
                {done.seeded
                  ? '仓库里还没有数据，已把本机的内容作为初始内容推了上去。'
                  : '本地缓存已写入，正在把仓库里的 recipes.json 与 orders.json 拉到本机。'}
              </p>
              <div className="repo-chip">
                {done.repo} @ {done.branch}
              </div>
              <p className="meta" style={{ margin: '16px 0 18px' }}>
                第一次拉取完成 · {db.recipes.length} 条菜谱 · {db.orders.length} 条点单
              </p>
              <button
                className="btn-primary"
                onClick={() => navigate('/library')}
              >
                开始使用
              </button>
            </div>
          </section>
        </main>
      </div>
    );
  }

  /* ─── 向导视图 ─── */

  return (
    <div className="app s-setup">
      <main className="scroll wizard">
        <section className="pad stack" style={{ paddingTop: 20 }}>
          <div className="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 14 }}>
            <div className="artframe">
              <img src="/art/sync-pot.svg" alt="锅与云同步插画" />
            </div>
            <div>
              <p className="greeting" style={{ marginBottom: 6 }}>
                STEP 1 · 连接 GitHub 仓库
              </p>
              <h1 className="ptitle" style={{ fontSize: 29 }}>
                让菜谱跟着仓库走
              </h1>
              <p style={{ margin: '10px auto 0', maxWidth: '30ch', color: 'var(--muted)', fontSize: 14, lineHeight: 1.55 }}>
                菜谱、备注和点单都存进你的 GitHub 仓库，换手机、另一半看单都不丢。
              </p>
            </div>
          </div>

          <div className="card sticker" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>四步就好</div>
            <div className="steps">
              <div className="step">
                <span className="no">1</span>
                <p>
                  在 GitHub 建一个<b>空仓库</b>（例如 <em>family-recipes</em>，可设成私有）。
                </p>
              </div>
              <div className="step">
                <span className="no">2</span>
                <p>
                  填<b>你和另一半的昵称</b>。两个人谁都能点单、也都能掌勺，不用再分身份。
                </p>
              </div>
              <div className="step">
                <span className="no">3</span>
                <p>
                  生成一个 <b>Personal access token</b>，只需要 <em>contents</em> 读写权限。
                </p>
              </div>
              <div className="step">
                <span className="no">4</span>
                <p>
                  把 token 和仓库名填到下面，点 <em>连接并拉取</em>。
                </p>
              </div>
            </div>
          </div>

          <details className="adv">
            <summary>导入配置 · 粘贴另一半发来的 JSON</summary>
            <div className="adv-body">
              <div className={`field${importErr ? ' invalid' : ''}`}>
                <label htmlFor="importJson">配置 JSON</label>
                <textarea
                  id="importJson"
                  rows={5}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder='{"nickname":"小辉","partnerNickname":"小红","token":"ghp_xxxxxxxx","repo":"owner/repo","branch":"main","intervalSec":60}'
                  value={importJson}
                  onChange={(e) => {
                    setImportJson(e.target.value);
                    if (importErr) setImportErr('');
                  }}
                  {...preserveTypedValue((v) => {
                    setImportJson(v);
                    if (importErr) setImportErr('');
                  })}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
                />
                <span className="err" role="alert">
                  {importErr}
                </span>
                <span className="hint">
                  字段：nickname（我的）/ partnerNickname（另一半的，可省）/ token / repo / branch / intervalSec
                </span>
              </div>
              <button type="button" className="btn-sticker solid" onClick={doImport}>
                导入并填充
              </button>
            </div>
          </details>

          <form
            className="stack"
            style={{ gap: 14 }}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
          >
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className={`field${invalid.nickname ? ' invalid' : ''}`}>
                <label htmlFor="fNickname">我的昵称</label>
                <input
                  id="fNickname"
                  type="text"
                  autoComplete="nickname"
                  maxLength={12}
                  spellCheck={false}
                  aria-required="true"
                  placeholder="例如：小辉"
                  value={myName}
                  onChange={(e) => setMyName(e.target.value)}
                  {...preserveTypedValue(setMyName, (v) => blurCheck('nickname', v))}
                />
                <span className="err">昵称要填 1–12 个字</span>
                <span className="hint">两个昵称都会随仓库同步，对方换手机也能看到。</span>
              </div>

              <div className={`field${invalid.partner ? ' invalid' : ''}`}>
                <label htmlFor="fPartnerNickname">另一半的昵称（可留空）</label>
                <input
                  id="fPartnerNickname"
                  type="text"
                  autoComplete="off"
                  maxLength={12}
                  spellCheck={false}
                  placeholder="例如：小红"
                  value={partnerName}
                  onChange={(e) => setPartnerName(e.target.value)}
                  {...preserveTypedValue(setPartnerName, (v) => blurCheck('partner', v))}
                />
                <span className="err">最多 12 个字</span>
                <span className="hint">
                  填上之后，页面上的称呼就跟着变（「发给小红」而不是「发给对方」）。留空也可以，之后在「同步 → 昵称」里补。
                </span>
              </div>

              <div className={`field${invalid.token ? ' invalid' : ''}`}>
                <label htmlFor="fToken">GitHub token</label>
                <input
                  id="fToken"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  /* 关键：不关掉这两个，手机键盘的自动大写会把 ghp_ 改成 Ghp_，自动更正还会插字符 */
                  autoCapitalize="none"
                  autoCorrect="off"
                  placeholder="ghp_…"
                  value={token}
                  onChange={(e) => {
                    setToken(normalizeToken(e.target.value));
                    if (tokenErr) setTokenErr(null);
                  }}
                  {...preserveTypedValue(
                    (v) => {
                      setToken(normalizeToken(v));
                      if (tokenErr) setTokenErr(null);
                    },
                    (v) => blurCheck('token', normalizeToken(v)),
                  )}
                />
                <span className="err">{tokenErr ?? 'token 格式不对'}</span>
                <span className="hint">只存在本机（存在浏览器本地存储里），不会写进仓库。</span>
              </div>

              <div className={`field${invalid.repo ? ' invalid' : ''}`}>
                <label htmlFor="fRepo">仓库（owner/repo）</label>
                <input
                  id="fRepo"
                  type="text"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  placeholder="例如 xiaoman/family-recipes"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value.trimStart())}
                  {...preserveTypedValue(
                    (v) => setRepo(v.trimStart()),
                    (v) => blurCheck('repo', v.trimStart()),
                  )}
                />
                <span className="err">仓库名要写成 “用户名/仓库名” 的格式</span>
              </div>

              <details className="adv">
                <summary>高级设置</summary>
                <div className="adv-body">
                  <div className={`field${invalid.branch ? ' invalid' : ''}`}>
                    <label htmlFor="fBranch">分支</label>
                    <input
                      id="fBranch"
                      type="text"
                      spellCheck={false}
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      {...preserveTypedValue(setBranch, (v) => blurCheck('branch', v))}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="fInterval">后台拉取间隔</label>
                    <select
                      id="fInterval"
                      value={String(intervalSec)}
                      onChange={(e) => setIntervalSec(Number(e.target.value) as IntervalSec)}
                    >
                      <option value="60">每 1 分钟</option>
                      <option value="600">每 10 分钟</option>
                      <option value="0">仅手动</option>
                    </select>
                  </div>
                </div>
              </details>
            </div>

            <div className="stack" style={{ gap: 10, paddingBottom: 8 }}>
              {/* 报错贴在触发它的按钮上方：点完就能看到，不用往回翻 */}
              <div className={`errbanner${connectError ? ' show' : ''}`} role="alert">
                <Icon name="alert" />
                <div>
                  <b style={{ fontWeight: 700 }}>连接失败</b>
                  <br />
                  {connectError?.msg}
                  <br />
                  <span style={{ color: 'var(--muted)' }}>{connectError?.hint}</span>
                </div>
              </div>

              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? (
                  <>
                    <span className="spinner" aria-hidden /> 正在校验并拉取…
                  </>
                ) : (
                  '连接并拉取'
                )}
              </button>
              <button type="button" className="btn-ghost" onClick={localMode} disabled={busy}>
                稍后再说（本地模式）
              </button>
              <p className="meta" style={{ textAlign: 'center', margin: 0 }}>
                token 仅存本机，仓库才是真源。
              </p>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
