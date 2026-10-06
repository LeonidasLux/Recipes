import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../data/store';
import { useSync } from '../lib/useSync';
import { useToast } from '../components/Toast';
import { TabBar } from '../components/TabBar';
import { LiveSyncPill } from '../components/LiveSyncPill';
import { Icon } from '../components/Icons';
import { maskToken, normalizeToken, tokenShapeError } from '../lib/github';
import { preserveTypedValue } from '../lib/inputs';
import { nicknameOf, partnerOf, PERSON_KEYS } from '../data/helpers';
import type { PersonKey, ViewRole } from '../data/types';

export default function SyncScreen() {
  const { db, connected, patchConfig, setProfiles, setMe, setView, view, disconnect } = useStore();
  const sync = useSync();
  const { toast } = useToast();

  const [editToken, setEditToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const [editNames, setEditNames] = useState(false);
  const [nameDraft, setNameDraft] = useState({ me: '', partner: '' });

  const cfg = db.config;
  const me: PersonKey = cfg?.me === 'b' ? 'b' : 'a';
  const other = partnerOf(me);

  function pickMe(next: PersonKey) {
    if (next === me) return;
    setMe(next);
    toast(`已切换为「${nicknameOf(db.profiles, next) || '未命名'}」`);
  }

  function pickView(next: ViewRole) {
    if (next === view) return;
    setView(next);
    toast(next === 'cook' ? '已切到「掌勺」· 底部第二格换成掌勺' : '已切到「点单」· 底部第二格换成点单');
  }

  function saveToken() {
    const v = normalizeToken(tokenDraft);
    if (!v) {
      setEditToken(false);
      return;
    }
    if (tokenShapeError(v) !== null) {
      setTokenInvalid(true);
      return;
    }
    patchConfig({ token: v, tokenMask: maskToken(v), lastSyncError: undefined });
    setEditToken(false);
    setTokenDraft('');
    setTokenInvalid(false);
    toast('Token 已更新（仍只存本机）');
  }

  function doDisconnect() {
    disconnect();
    setConfirmDisconnect(false);
    toast('已断开，本地缓存已清除');
  }

  function openNameEdit() {
    setNameDraft({
      me: db.profiles[me].nickname,
      partner: db.profiles[other].nickname,
    });
    setEditNames(true);
  }

  function saveNames() {
    const patch: Partial<Record<PersonKey, string>> = {};
    patch[me] = nameDraft.me;
    patch[other] = nameDraft.partner;
    setProfiles(patch);
    setEditNames(false);
    toast('昵称已更新 · 已同步');
  }

  return (
    <div className="app s-sync">
      <header className="topbar">
        <p className="greeting">数据在你自己的仓库里</p>
        <div className="navrow" style={{ alignItems: 'flex-end' }}>
          <h1 className="ptitle" style={{ margin: 0 }}>
            同步与仓库
          </h1>
          <LiveSyncPill />
        </div>
      </header>

      <main className="scroll">
        <div className="pad" style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 20 }}>
          {/* ─── 状态面板（五态）─── */}
          <section className="pad" style={{ padding: 0 }}>
            <StatusPanel
              status={sync.status}
              error={sync.error}
              lastAt={sync.lastAt}
              connected={connected}
              recipes={db.recipes.length}
              orders={db.orders.length}
              onRetry={() => void sync.syncNow()}
              onFixToken={() => setEditToken(true)}
            />
          </section>

          <button className="btn-primary" style={{ minHeight: 52 }} onClick={() => void sync.syncNow()}>
            <Icon name="sync" style={{ width: 18, height: 18 }} />
            <span>立即同步</span>
          </button>

          {/* ─── 仓库与 token ─── */}
          <section className="card sticker" style={{ padding: '2px 16px' }}>
            <div className="kvrow">
              <span className="k">当前仓库</span>
              <span className="v ellip" title={cfg?.repo || ''}>
                {cfg?.repo || '未连接'}
              </span>
            </div>
            <div className="kvrow">
              <span className="k">分支</span>
              <span className="v">{cfg?.branch || '—'}</span>
            </div>
            <div className="kvrow">
              <span className="k">Token（仅存本机）</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="v">{cfg?.tokenMask || '—'}</span>
                <button id="editTokenBtn" className="inlinebtn" onClick={() => setEditToken((v) => !v)}>
                  修改
                </button>
              </span>
            </div>

            <div className={`editrow${editToken ? ' show' : ''}`}>
              <div className={`field${tokenInvalid ? ' invalid' : ''}`}>
                <label htmlFor="tokenInput">新的 token</label>
                <input
                  id="tokenInput"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  placeholder="ghp_…"
                  value={tokenDraft}
                  onChange={(e) => {
                    setTokenDraft(normalizeToken(e.target.value));
                    setTokenInvalid(false);
                  }}
                  {...preserveTypedValue(
                    (v) => {
                      setTokenDraft(normalizeToken(v));
                      setTokenInvalid(false);
                    },
                    (v) => {
                      const n = normalizeToken(v);
                      setTokenInvalid(n.length > 0 && tokenShapeError(n) !== null);
                    },
                  )}
                />
                <span className="err">token 格式不对（应形如 ghp_ 开头、共 40 位）</span>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <button
                  className="btn-sticker"
                  onClick={() => {
                    setEditToken(false);
                    setTokenDraft('');
                    setTokenInvalid(false);
                  }}
                >
                  取消
                </button>
                <button id="saveTokenBtn" className="btn-sticker primary" onClick={saveToken}>
                  保存
                </button>
              </div>
            </div>

            <div className="kvrow" style={{ alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>后台自动拉取</div>
                <div className="meta" style={{ fontSize: 11, marginTop: 1 }}>
                  {cfg?.autoPull ? `每 ${(cfg.intervalSec || 60) >= 60 ? `${(cfg.intervalSec || 60) / 60} 分钟` : `${cfg.intervalSec} 秒`}` : '仅手动'}
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={cfg?.autoPull ?? false}
                  disabled={!cfg}
                  onChange={(e) => {
                    patchConfig({ autoPull: e.target.checked });
                    toast(e.target.checked ? '已开启后台自动拉取' : '已改为仅手动同步');
                  }}
                />
                <span className="track" />
                <span className="thumb" />
              </label>
            </div>
          </section>

          {/* ─── 昵称（两个人谁都能改，随仓库同步）─── */}
          <section className="card sticker" style={{ padding: '2px 16px' }}>
            <div className="kvrow">
              <span className="k">昵称（随仓库同步）</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="v tagval" style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {editNames ? '编辑中' : '两台设备共用'}
                </span>
                <button
                  id="editNamesBtn"
                  className="inlinebtn"
                  onClick={() => (editNames ? setEditNames(false) : openNameEdit())}
                >
                  {editNames ? '收起' : '修改'}
                </button>
              </span>
            </div>

            <div className="kvrow">
              <span className="k">我</span>
              <span className="v tagval">{db.profiles[me].nickname || '未设置'}</span>
            </div>
            <div className="kvrow">
              <span className="k">另一半</span>
              <span className="v tagval">{db.profiles[other].nickname || '未设置'}</span>
            </div>

            <div className={`editrow${editNames ? ' show' : ''}`}>
              <div className="field">
                <label htmlFor="nickMe">我的昵称</label>
                <input
                  id="nickMe"
                  type="text"
                  maxLength={12}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="例如：小辉"
                  value={nameDraft.me}
                  onChange={(e) => setNameDraft((s) => ({ ...s, me: e.target.value }))}
                  {...preserveTypedValue((v) => setNameDraft((s) => ({ ...s, me: v })))}
                />
              </div>
              <div className="field">
                <label htmlFor="nickPartner">另一半的昵称</label>
                <input
                  id="nickPartner"
                  type="text"
                  maxLength={12}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="例如：小红"
                  value={nameDraft.partner}
                  onChange={(e) => setNameDraft((s) => ({ ...s, partner: e.target.value }))}
                  {...preserveTypedValue((v) => setNameDraft((s) => ({ ...s, partner: v })))}
                />
              </div>
              <span className="hint" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                两个名字都能改：谁先装就能顺手把对方的名字填上。清空表示「未设置」，界面会退回「我 / 对方」。
              </span>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <button className="btn-sticker" onClick={() => setEditNames(false)}>
                  取消
                </button>
                <button id="saveNamesBtn" className="btn-sticker primary" onClick={saveNames}>
                  保存并同步
                </button>
              </div>
            </div>
          </section>

          {/* ─── 当前角色（本机本地设置，不进仓库）─── */}
          <section className="card sticker" style={{ padding: '14px 16px' }}>
            <div className="row-between" style={{ marginBottom: 10 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>当前角色</h2>
                <p className="meta" style={{ fontSize: 11 }}>
                  决定底部第二格是「点单」还是「掌勺」 · 两台设备各选各的
                </p>
              </div>
              <span className="pill syncing" style={{ fontSize: 11 }}>
                <span>{view === 'cook' ? '掌勺' : '点单'}</span>
              </span>
            </div>

            <div className="idgrid" role="group" aria-label="选择角色">
              <button
                type="button"
                className={`idpick${view === 'order' ? ' on' : ''}`}
                aria-pressed={view === 'order'}
                onClick={() => pickView('order')}
              >
                <span className="ic">
                  <Icon name="roleOrderer" />
                </span>
                <span>
                  <b>点单</b>
                  <small>{view === 'order' ? '底部第二格就是点单' : '我来点，对方掌勺'}</small>
                </span>
              </button>
              <button
                type="button"
                className={`idpick${view === 'cook' ? ' on' : ''}`}
                aria-pressed={view === 'cook'}
                onClick={() => pickView('cook')}
              >
                <span className="ic">
                  <Icon name="roleCook" />
                </span>
                <span>
                  <b>掌勺</b>
                  <small>{view === 'cook' ? '底部第二格就是掌勺' : '对方点，我来做'}</small>
                </span>
              </button>
            </div>
          </section>

          {/* ─── 我是谁 ─── */}
          <section className="card sticker" style={{ padding: '14px 16px' }}>
            <div className="row-between" style={{ marginBottom: 10 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>我是谁</h2>
                <p className="meta" style={{ fontSize: 11 }}>
                  这台设备代表哪一位 · 决定页面上叫你什么
                </p>
              </div>
              <span className="pill synced" style={{ fontSize: 11 }}>
                <span>{nicknameOf(db.profiles, me) || '我'}</span>
              </span>
            </div>

            <div className="idgrid" role="group" aria-label="选择我是谁">
              {PERSON_KEYS.map((k, i) => (
                <button
                  key={k}
                  className={`idpick${me === k ? ' on' : ''}`}
                  aria-pressed={me === k}
                  onClick={() => pickMe(k)}
                >
                  <span className="ic">
                    <Icon name={i === 0 ? 'roleOrderer' : 'roleCook'} />
                  </span>
                  <span>
                    <b>{nicknameOf(db.profiles, k) || `第 ${i + 1} 位`}</b>
                    <small>{me === k ? '就是这台设备上的我' : '另一半'}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>

          {/* ─── 同步日志 ─── */}
          <section>
            <div className="row-between" style={{ margin: '2px 2px 4px' }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>最近同步</h2>
              <span className="meta">日志只留最近 8 条</span>
            </div>
            <div className="cardlist cut">
              {db.logs.length ? (
                db.logs.map((l, i) => (
                  <div className={`logrow${l.kind === 'err' ? ' err' : ''}`} key={`${l.t}-${i}`}>
                    <div className="ticon">
                      <Icon name={l.kind === 'err' ? 'alert' : 'check'} />
                    </div>
                    <div>
                      <div className="lt">{l.t}</div>
                      <p className="lx">{l.text}</p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="meta" style={{ textAlign: 'center', padding: '12px 0' }}>
                  还没有同步记录
                </p>
              )}
            </div>
          </section>

          {connected ? (
            <button
              className="dang"
              style={{ margin: '0 auto', display: 'block' }}
              onClick={() => (confirmDisconnect ? doDisconnect() : setConfirmDisconnect(true))}
              onBlur={() => setConfirmDisconnect(false)}
            >
              {confirmDisconnect ? '再点一次，确认断开并清除本地缓存' : '断开并清除本地缓存'}
            </button>
          ) : (
            <Link className="btn-sticker solid" style={{ margin: '0 auto' }} to="/setup">
              去首次设置
            </Link>
          )}
        </div>
      </main>

      <TabBar active="sync" />
    </div>
  );
}

/* ─── 五态状态面板 ──────────────────────────── */

function StatusPanel({
  status,
  error,
  lastAt,
  connected,
  recipes,
  orders,
  onRetry,
  onFixToken,
}: {
  status: ReturnType<typeof useSync>['status'];
  error: string | null;
  lastAt: string;
  connected: boolean;
  recipes: number;
  orders: number;
  onRetry: () => void;
  onFixToken: () => void;
}) {
  if (!connected) {
    return (
      <div className="panel empty">
        <div className="prow">
          <div className="picon">
            <Icon name="repo" />
          </div>
          <div style={{ flex: 1 }}>
            <p className="pt">还没有连接仓库</p>
            <p className="pd">数据只在本地。连上 GitHub 仓库后，菜谱和点单才会开始自动同步。</p>
            <div className="pa">
              <Link className="btn-sticker solid" to="/setup">
                去首次设置
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'busy') {
    return (
      <div className="panel busy">
        <div className="prow">
          <div className="picon">
            <Icon name="sync" />
          </div>
          <div style={{ flex: 1 }}>
            <p className="pt">正在与仓库同步…</p>
            <p className="pd">同步中，稍等。超过 15 秒会提示网络异常。</p>
            <div className="spark" style={{ marginTop: 10 }}>
              <span />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'err') {
    return (
      <div className="panel err">
        <div className="prow">
          <div className="picon">
            <Icon name="alert" />
          </div>
          <div style={{ flex: 1 }}>
            <p className="pt">同步失败</p>
            <p className="pd">{error || '仓库拒绝了这次请求：token 可能已失效，或缺少 contents 权限。'}</p>
            <div className="pa">
              <button className="btn-sticker" onClick={onRetry}>
                重试
              </button>
              <button className="btn-sticker solid" onClick={onFixToken}>
                重新填写 token
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel ok">
      <div className="prow">
        <div className="picon">
          <Icon name="check" />
        </div>
        <div style={{ flex: 1 }}>
          <p className="pt">已同步 · {lastAt}</p>
          <p className="pd">
            recipes.json 与 orders.json 已一致：{recipes} 条菜谱 · {orders} 条点单。
          </p>
        </div>
      </div>
    </div>
  );
}
