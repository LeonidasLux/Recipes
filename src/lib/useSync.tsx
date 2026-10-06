import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useStore } from '../data/store';
import { useToast } from '../components/Toast';
import { SCHEMA, normalizeOrders, normalizeProfiles } from '../data/seed';
import { nowHM } from '../data/helpers';
import type { RemoteOrders, RemoteProfiles, RemoteRecipes, SyncStatus, SyncConfig } from '../data/types';
import {
  GithubError,
  ORDERS_PATH,
  PROFILES_PATH,
  RECIPES_PATH,
  getJson,
  putJson,
  verifyRepo,
  withTimeout,
} from './github';

interface SyncValue {
  /** 'off' 未连接 · 'idle' 待同步 · 'busy' 同步中 · 'ok' 已同步 · 'err' 失败 */
  status: SyncStatus;
  error: string | null;
  lastAt: string;
  /** 立即同步：有本地改动就先推，否则拉 */
  syncNow(): Promise<void>;
  /** 首次设置：校验凭证并接管仓库（空仓库则把本机数据作为初始内容推上去） */
  connect(cfg: SyncConfig): Promise<{ seeded: boolean }>;
  /** 只拉取 */
  pull(): Promise<void>;
}

const SyncCtx = createContext<SyncValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  const { toast } = useToast();

  /* 每次成功读写后记下 sha，PUT 时回传以避免 409 */
  const shaRef = useRef<{ recipes?: string; orders?: string; profiles?: string }>({});
  /** 上一份推上去的内容。只推变了的那份 —— 改个昵称不该把菜谱和订单也重写一遍 */
  const lastPushed = useRef<{ recipes?: string; orders?: string; profiles?: string }>({});
  /** 已推送到的 rev；与 store.rev 不一致 = 有本地改动待推 */
  const pushedRev = useRef(0);
  const busy = useRef(false);
  /** connect() 期间挂起自动推送：写 config 也会让 rev+1，
      若不拦住，推送会抢在首次拉取完成前把本地数据覆盖到远端 */
  const suppressAutoPush = useRef(false);

  const storeRef = useRef(store);
  storeRef.current = store;

  /* ─── 拉取 ─────────────────────────────────── */
  /* cfgOverride：connect() 里刚填的配置不能靠 storeRef 读 ——
     setConfig 是 React 的异步状态更新，storeRef 要等下一次渲染才更新，
     紧接着读会拿到旧配置（repo 为空 → 误判「还没有连接仓库」）。 */
  const doPull = useCallback(async (cfgOverride?: SyncConfig | null): Promise<'ok' | 'empty'> => {
    const cfg = cfgOverride ?? storeRef.current.db.config;
    if (!cfg?.repo || !cfg.token) throw new GithubError('auth', '还没有连接仓库。');

    const { signal, done } = withTimeout();
    try {
      const [rf, of, pf] = await Promise.all([
        getJson<RemoteRecipes>(cfg.repo, RECIPES_PATH, cfg.branch, cfg.token, signal),
        getJson<RemoteOrders>(cfg.repo, ORDERS_PATH, cfg.branch, cfg.token, signal),
        getJson<RemoteProfiles>(cfg.repo, PROFILES_PATH, cfg.branch, cfg.token, signal),
      ]);
      /* 仓库里可能是老版本写下的结构（角色形状的 profiles / 单菜订单）：先规整成当前 schema。
         「已推送」快照要用规整后的内容，才能和本地入库后的 db 对得上，不会白白重写一遍。 */
      const pulledRecipes = rf?.data && Array.isArray(rf.data.recipes) ? rf.data.recipes : undefined;
      const pulledOrders = of?.data && Array.isArray(of.data.orders) ? normalizeOrders(of.data.orders) : undefined;
      const pulledProfiles = pf?.data?.profiles ? normalizeProfiles(pf.data.profiles) : undefined;

      if (rf) shaRef.current.recipes = rf.sha;
      if (of) shaRef.current.orders = of.sha;
      if (pf) shaRef.current.profiles = pf.sha;

      /* 拉下来的内容就等于「已推送」——不然紧接着的推送会把它们原样重写一遍 */
      if (pulledRecipes) lastPushed.current.recipes = JSON.stringify(pulledRecipes);
      if (pulledOrders) lastPushed.current.orders = JSON.stringify(pulledOrders);
      if (pulledProfiles) lastPushed.current.profiles = JSON.stringify(pulledProfiles);

      if (!rf && !of && !pf) return 'empty';

      /* 只交出「远端给了什么」，合并交给 reducer —— 它拿到的才是当前 db。
         显式带上 cfg：connect() 里刚写的配置此时可能还没进 storeRef。 */
      storeRef.current.applyRemote({
        config: cfg,
        recipes: pulledRecipes,
        orders: pulledOrders,
        profiles: pulledProfiles,
      });
      return 'ok';
    } finally {
      done();
    }
  }, []);

  /* ─── 推送 ─────────────────────────────────── */
  const doPush = useCallback(async (attempt = 0, cfgOverride?: SyncConfig | null): Promise<void> => {
    const cfg = cfgOverride ?? storeRef.current.db.config;
    if (!cfg?.repo || !cfg.token) throw new GithubError('auth', '还没有连接仓库。');

    const db = storeRef.current.db;
    const revAtStart = storeRef.current.rev;
    const recipesDoc: RemoteRecipes = { schema: SCHEMA, updatedAt: db.updatedAt, recipes: db.recipes };
    const ordersDoc: RemoteOrders = { schema: SCHEMA, updatedAt: db.updatedAt, orders: db.orders };
    const profilesDoc: RemoteProfiles = { schema: SCHEMA, updatedAt: db.updatedAt, profiles: db.profiles };

    const payload = {
      recipes: JSON.stringify(recipesDoc.recipes),
      orders: JSON.stringify(ordersDoc.orders),
      profiles: JSON.stringify(profilesDoc.profiles),
    };

    const { signal, done } = withTimeout();
    try {
      /* 逐份比对，只推真正变了的那一份 —— 否则改个昵称会在仓库里留下
         「菜谱 + 订单 + 昵称」三条提交，历史全是噪音 */
      if (lastPushed.current.recipes !== payload.recipes) {
        shaRef.current.recipes = await putJson(
          cfg.repo, RECIPES_PATH, cfg.branch, cfg.token,
          recipesDoc, `记食本：更新菜谱库（${db.recipes.length} 条）`, shaRef.current.recipes, signal,
        );
        lastPushed.current.recipes = payload.recipes;
      }
      if (lastPushed.current.orders !== payload.orders) {
        shaRef.current.orders = await putJson(
          cfg.repo, ORDERS_PATH, cfg.branch, cfg.token,
          ordersDoc, `记食本：更新点单（${db.orders.length} 条）`, shaRef.current.orders, signal,
        );
        lastPushed.current.orders = payload.orders;
      }
      if (lastPushed.current.profiles !== payload.profiles) {
        shaRef.current.profiles = await putJson(
          cfg.repo, PROFILES_PATH, cfg.branch, cfg.token,
          profilesDoc, '记食本：更新昵称', shaRef.current.profiles, signal,
        );
        lastPushed.current.profiles = payload.profiles;
      }

      pushedRev.current = revAtStart;
    } catch (e) {
      /* 仓库里文件被别处改过 → 取回新 sha 重试一次 */
      if (e instanceof GithubError && e.kind === 'conflict' && attempt < 1) {
        done();
        await refreshShas();
        return doPush(attempt + 1, cfgOverride);
      }
      throw e;
    } finally {
      done();
    }
  }, []);

  const refreshShas = useCallback(async () => {
    const cfg = storeRef.current.db.config;
    if (!cfg?.repo || !cfg.token) return;
    const { signal, done } = withTimeout();
    try {
      const [rf, of, pf] = await Promise.all([
        getJson<RemoteRecipes>(cfg.repo, RECIPES_PATH, cfg.branch, cfg.token, signal),
        getJson<RemoteOrders>(cfg.repo, ORDERS_PATH, cfg.branch, cfg.token, signal),
        getJson<RemoteProfiles>(cfg.repo, PROFILES_PATH, cfg.branch, cfg.token, signal),
      ]);
      shaRef.current.recipes = rf?.sha;
      shaRef.current.orders = of?.sha;
      shaRef.current.profiles = pf?.sha;
    } catch {
      /* 拿不到就下次再说 */
    } finally {
      done();
    }
  }, []);

  const fail = useCallback((e: unknown) => {
    const msg = e instanceof GithubError ? e.message : '同步失败，稍后再试。';
    storeRef.current.setSyncState('err', msg);
    storeRef.current.patchConfig({ lastSyncError: msg });
    return msg;
  }, []);

  /* ─── 提交即同步：本地有改动就自动推 ────────── */
  useEffect(() => {
    if (!store.connected || suppressAutoPush.current) return;
    if (store.rev === pushedRev.current) return;

    const t = window.setTimeout(() => {
      if (busy.current) return;
      busy.current = true;
      storeRef.current.setSyncState('busy');
      doPush()
        .then(() => {
          storeRef.current.setSyncState('ok', null, nowHM());
          storeRef.current.patchConfig({ lastPushedAt: nowHM(), lastSyncError: undefined });
        })
        .catch((e: unknown) => {
          fail(e);
          toast(e instanceof GithubError ? e.message : '推送失败，稍后重试', false);
        })
        .finally(() => {
          busy.current = false;
        });
    }, 700);

    return () => window.clearTimeout(t);
  }, [store.rev, store.connected, doPush, fail, toast]);

  /* ─── 后台轮询拉取 ─────────────────────────── */
  const intervalSec = store.db.config?.intervalSec ?? 0;
  const autoPull = store.db.config?.autoPull ?? false;

  useEffect(() => {
    if (!store.connected || !autoPull || !intervalSec) return;

    const id = window.setInterval(() => {
      /* 有本地改动没推完就先不拉，避免自己覆盖自己 */
      if (busy.current || storeRef.current.rev !== pushedRev.current) return;
      if (!storeRef.current.connected) return;
      void doPull()
        .then((r) => {
          if (r === 'ok') {
            storeRef.current.setSyncState('ok', null, nowHM());
            storeRef.current.patchConfig({ lastPulledAt: nowHM() });
          }
        })
        .catch(() => {
          /* 轮询失败不打扰用户，状态交给手动同步体现 */
        });
    }, intervalSec * 1000);

    return () => window.clearInterval(id);
  }, [store.connected, autoPull, intervalSec, doPull]);

  const value = useMemo<SyncValue>(() => {
    async function syncNow() {
      const s = storeRef.current;
      if (!s.connected) {
        s.setSyncState('off');
        toast('还没连接仓库，先去设置里连上', false);
        return;
      }
      if (busy.current) return;
      busy.current = true;
      s.setSyncState('busy');
      try {
        if (s.rev !== pushedRev.current) {
          await doPush();
          s.patchConfig({ lastPushedAt: nowHM() });
        } else {
          const r = await doPull();
          if (r === 'empty') {
            await doPush();
          } else {
            s.patchConfig({ lastPulledAt: nowHM() });
          }
        }
        s.setSyncState('ok', null, nowHM());
        s.patchConfig({ lastSyncError: undefined });
        toast('同步完成');
      } catch (e) {
        const msg = fail(e);
        toast(msg, false);
      } finally {
        busy.current = false;
      }
    }

    async function connect(cfg: SyncConfig) {
      const s = storeRef.current;
      s.setSyncState('busy');
      const { signal, done } = withTimeout(20000);
      suppressAutoPush.current = true;
      /* 可能连的是另一个仓库：清掉「已推送」记录，别把新仓库的首次写入误判成没变化 */
      lastPushed.current = {};
      try {
        await verifyRepo(cfg.repo, cfg.branch, cfg.token, signal);
        done();

        s.setConfig(cfg);

        /* 显式把 cfg 传下去：不能靠 storeRef 读 —— setConfig 的 dispatch 是异步的，
           下一行读 storeRef 拿到的还是旧配置 */
        let seeded = false;
        const r = await doPull(cfg);
        if (r === 'empty') {
          /* 仓库还是空的：把本机内容作为初始内容推上去 */
          await doPush(0, cfg);
          seeded = true;
        }

        s.patchConfig({ lastPulledAt: nowHM(), lastPushedAt: nowHM(), lastSyncError: undefined });
        s.setSyncState('ok', null, nowHM());
        return { seeded };
      } catch (e) {
        done();
        fail(e);
        /* 原样抛出：调用方需要 e.kind 才能给出「到底是哪一类失败」的提示 */
        throw e;
      } finally {
        /* 连接期间攒下的 rev 一笔勾销：上面已经明确拉过 / 推过了 */
        pushedRev.current = storeRef.current.rev;
        suppressAutoPush.current = false;
      }
    }

    async function pull() {
      const s = storeRef.current;
      if (!s.connected) return;
      s.setSyncState('busy');
      try {
        await doPull();
        s.patchConfig({ lastPulledAt: nowHM() });
        s.setSyncState('ok', null, nowHM());
      } catch (e) {
        fail(e);
      }
    }

    return { status: store.sync.status, error: store.sync.error, lastAt: store.sync.lastAt, syncNow, connect, pull };
  }, [store.sync.status, store.sync.error, store.sync.lastAt, doPush, doPull, fail, toast]);

  return <SyncCtx.Provider value={value}>{children}</SyncCtx.Provider>;
}

export function useSync(): SyncValue {
  const v = useContext(SyncCtx);
  if (!v) throw new Error('useSync 必须在 <SyncProvider> 内使用');
  return v;
}
