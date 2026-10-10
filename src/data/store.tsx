import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type {
  DB,
  LogEntry,
  Meal,
  Order,
  OrderItem,
  OrderStatus,
  PersonKey,
  Profiles,
  Recipe,
  SyncConfig,
  SyncStatus,
  ViewRole,
} from './types';
import { DB_KEY, migrate, normalizeOrders, normalizeProfiles, seed } from './seed';
import { meOf, newId, nicknameOf, nowStamp, orderSummary, partnerOf, PERSON_KEYS, viewOf } from './helpers';

/* ============================================================
   状态 = 数据 + 本地改动计数（rev）+ 同步状态
   rev 只在本地改动时 +1，拉取远端不会动它，
   同步引擎据此判断「有本地改动需要推送」。
   ============================================================ */

interface SyncState {
  status: SyncStatus;
  error: string | null;
  lastAt: string;
}

interface State {
  db: DB;
  rev: number;
  sync: SyncState;
}

type Action =
  /**
   * 唯一的写入口。updater 由 reducer 作用在**当前** state.db 上 ——
   * 这是关键：不能在 dispatch 之前用 ref 里的 db 预先算好结果，
   * 因为 ref 只在下次渲染时才更新。一次异步流程里连着改几次 db 时，
   * 预先算好的写法会让每次改动都基于同一份陈旧快照，后一次覆盖前一次。
   */
  | { type: 'mutate'; updater: (db: DB) => DB; bumpRev: boolean }
  | { type: 'sync'; status: SyncStatus; error?: string | null; at?: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'mutate': {
      const db = action.updater(state.db);
      return action.bumpRev ? { ...state, db, rev: state.rev + 1 } : { ...state, db };
    }
    case 'sync':
      return {
        ...state,
        sync: {
          status: action.status,
          error: action.error ?? null,
          lastAt: action.at ?? state.sync.lastAt,
        },
      };
    default:
      return state;
  }
}

/* ─── 读写 localStorage ──────────────────────── */

function loadDb(): DB {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DB;
      if (parsed && Array.isArray(parsed.recipes) && Array.isArray(parsed.orders)) {
        return migrate(parsed);
      }
    }
  } catch {
    /* 隐私模式 / 数据损坏 → 用种子数据 */
  }
  return seed();
}

function saveDb(db: DB): void {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch {
    /* 隐私模式，忽略 */
  }
}

function initialState(): State {
  const db = loadDb();
  return {
    db,
    rev: 0,
    sync: { status: db.config?.repo ? 'idle' : 'off', error: null, lastAt: db.config?.lastPulledAt ?? '—' },
  };
}

/* ─── 对外接口 ───────────────────────────────── */

export interface StoreValue {
  db: DB;
  rev: number;
  sync: SyncState;
  /** 没走过首次设置向导 */
  needsSetup: boolean;
  /** 已连上 GitHub 仓库（有 repo + token） */
  connected: boolean;
  /** 本机这个人是谁 */
  me: PersonKey;
  /** 本机当前角色：决定底部第二格是「点单」还是「掌勺」 */
  view: ViewRole;

  /* 本地改动（提交即同步：每次都会触发推送） */
  addRecipe(input: {
    title: string;
    url: string;
    art: string;
    /** 照片在仓库里的路径（空串 = 没有）；图先让同步引擎上传，路径随菜谱一起落库 */
    image: string;
    steps: string;
    note: string;
    /** 调用方可以指定 id：上传照片时得先知道图片路径（images/<id>.jpg） */
    id?: string;
  }): Recipe;
  /** 改菜谱的菜名 / 原文出处 / 照片 / 做法 / 备注（内容改动，会触发推送） */
  updateRecipe(id: string, patch: { title?: string; url?: string; image?: string; steps?: string; note?: string }): void;
  /** 删菜谱（内容改动，会触发推送）；订单里的菜名是快照，不受影响 */
  deleteRecipe(id: string): void;
  /** 一次删多道菜谱（菜谱库多选删除用）：一次提交、一条日志 */
  deleteRecipes(ids: string[]): void;
  /** 下单（内容改动，会触发推送）；单里的菜各记一次「点单次数」 */
  addOrder(input: { meal: Meal; items: OrderItem[]; note?: string }): Order;
  /** 删订单（内容改动，会触发推送）；点单 / 掌勺两边都会同步消失，单里菜谱的点单次数退回 */
  deleteOrder(id: string): void;
  setOrderStatus(id: string, status: OrderStatus): void;
  /** 改昵称：两个人谁都能改，改完随仓库同步（内容改动，会触发推送） */
  setProfiles(next: Partial<Record<PersonKey, string>>): void;
  /** 切换「本机这个人是谁」（本地设置，不触发推送） */
  setMe(person: PersonKey): void;
  /** 切换「本机当前角色」（本地设置，不触发推送）：底部第二格在「点单 / 掌勺」之间切 */
  setView(view: ViewRole): void;
  /**
   * 首次设置：把自己认领到某一格。
   * 昵称是共享的，所以「我是谁」由名字决定 —— 本机默认格子若已被别人占用，就换另一格。
   */
  joinAs(input: { myName: string; partnerName?: string; preferred: PersonKey }): void;
  setConfig(cfg: SyncConfig): void;
  patchConfig(patch: Partial<SyncConfig>): void;
  disconnect(): void;

  /* 同步引擎用：只交出「从远端拿到了什么」，由 reducer 合并进当前 db，
     避免调用方基于陈旧快照整体替换、把并发写入的配置/数据冲掉 */
  applyRemote(remote: {
    recipes?: Recipe[];
    orders?: Order[];
    profiles?: Profiles;
    config?: SyncConfig;
  }): void;
  /**
   * 往本机同步日志里写一条（只留本机、不触发推送）。
   * 给同步引擎留痕用 —— 比如「有张照片本机和仓库里都没有」这种要让人看见的事。
   */
  logSync(kind: LogEntry['kind'], text: string): void;
  setSyncState(status: SyncStatus, error?: string | null, at?: string): void;
}

const StoreCtx = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  /* 持久化：任何数据变化都写回 localStorage */
  useEffect(() => {
    saveDb(state.db);
  }, [state.db]);

  /* 用 ref 读最新 db，避免把 db 塞进每个 callback 的依赖里 */
  const dbRef = useRef(state.db);
  dbRef.current = state.db;

  /* 克隆在 updater 内部做：这样拿到的永远是 reducer 给的那份当前 db */
  const commit = useCallback((mutate: (db: DB) => DB) => {
    dispatch({ type: 'mutate', bumpRev: true, updater: (db) => mutate(structuredClone(db)) });
  }, []);

  /** 改的是本地设置（身份 / token / 开关 / 同步时间戳），不该产生仓库提交 */
  const commitSilent = useCallback((mutate: (db: DB) => DB) => {
    dispatch({ type: 'mutate', bumpRev: false, updater: (db) => mutate(structuredClone(db)) });
  }, []);

  /** 同步日志全量保留（只存本机，不进仓库）；设置页默认折叠、滚动懒加载 */
  const pushLog = useCallback((db: DB, kind: LogEntry['kind'], text: string) => {
    const t = nowStamp();
    db.logs = [{ t, kind, text }, ...(db.logs ?? [])];
    db.updatedAt = t;
  }, []);

  const value = useMemo<StoreValue>(() => {
    /**
     * 删菜谱：单条与多选共用这一段 —— 一次提交、一条日志。
     * 多选删除不该留下 N 条「已删除菜谱」，同步日志是给人看的，不是流水账。
     */
    const removeRecipes = (ids: string[]) => {
      const gone = new Set(ids);
      if (!gone.size) return;
      commit((db) => {
        const names = db.recipes.filter((x) => gone.has(x.id)).map((x) => x.title);
        if (!names.length) return db;
        db.recipes = db.recipes.filter((x) => !gone.has(x.id));
        pushLog(
          db,
          'ok',
          names.length === 1
            ? `已删除菜谱：${names[0]}`
            : `已删除 ${names.length} 道菜谱${names.length <= 3 ? `：${names.join('、')}` : ''}`,
        );
        return db;
      });
    };

    return {
      db: state.db,
      rev: state.rev,
      sync: state.sync,
      needsSetup: !state.db.configured,
      connected: Boolean(state.db.config?.repo && state.db.config?.token),
      me: meOf(state.db.config),
      view: viewOf(state.db.config),

      addRecipe(input) {
        const rec: Recipe = {
          id: input.id ?? newId('r'),
          title: input.title,
          url: input.url,
          art: input.art,
          image: input.image,
          steps: input.steps,
          note: input.note,
          createdAt: nowStamp(),
          updatedAt: nowStamp(),
          orderCount: 0,
        };
        commit((db) => {
          db.recipes.unshift(rec);
          pushLog(db, 'ok', `${rec.title} 已保存并推送到仓库`);
          return db;
        });
        return rec;
      },

      updateRecipe(id, patch) {
        commit((db) => {
          const r = db.recipes.find((x) => x.id === id);
          if (!r) return db;
          if (patch.title !== undefined) r.title = patch.title;
          if (patch.url !== undefined) r.url = patch.url;
          if (patch.image !== undefined) r.image = patch.image;
          if (patch.steps !== undefined) r.steps = patch.steps;
          if (patch.note !== undefined) r.note = patch.note;
          r.updatedAt = nowStamp();
          pushLog(db, 'ok', `${r.id} · ${r.title} 已更新并推送`);
          return db;
        });
      },

      deleteRecipes: removeRecipes,

      deleteRecipe(id) {
        removeRecipes([id]);
      },

      addOrder(input) {
        const me = meOf(state.db.config);
        const order: Order = {
          id: newId('o'),
          meal: input.meal,
          status: 'pending',
          createdAt: nowStamp(),
          updatedAt: nowStamp(),
          placedBy: me,
          note: input.note ?? '',
          items: input.items.map((it) => ({ recipeId: it.recipeId, dishName: it.dishName })),
        };
        commit((db) => {
          db.orders.unshift(order);
          /* 点单次数：这道菜每被点进一张单就 +1（临时手输的菜没有菜谱，不计） */
          order.items.forEach((it) => {
            const r = it.recipeId ? db.recipes.find((x) => x.id === it.recipeId) : null;
            if (r) r.orderCount = (r.orderCount ?? 0) + 1;
          });
          pushLog(db, 'ok', `已发 ${input.meal === 'dinner' ? '晚餐' : '午餐'}单：${orderSummary(order)}`);
          return db;
        });
        return order;
      },

      setOrderStatus(id, status) {
        commit((db) => {
          const o = db.orders.find((x) => x.id === id);
          if (o) {
            o.status = status;
            o.updatedAt = nowStamp();
            pushLog(
              db,
              'ok',
              `${status === 'accepted' ? '已接下 ' : '已完成 '}${orderSummary(o)}，状态已推送`,
            );
          }
          return db;
        });
      },

      deleteOrder(id) {
        commit((db) => {
          const o = db.orders.find((x) => x.id === id);
          if (!o) return db;
          db.orders = db.orders.filter((x) => x.id !== id);
          /* 单没了，这单给菜谱记的点单次数要退回去（不低于 0） */
          o.items.forEach((it) => {
            const r = it.recipeId ? db.recipes.find((x) => x.id === it.recipeId) : null;
            if (r) r.orderCount = Math.max(0, (r.orderCount ?? 0) - 1);
          });
          pushLog(db, 'ok', `已删除点单：${orderSummary(o)}`);
          return db;
        });
      },

      setProfiles(next) {
        commit((db) => {
          const changed: string[] = [];
          PERSON_KEYS.forEach((p) => {
            const raw = next[p];
            if (typeof raw !== 'string') return;
            const name = raw.trim();
            if (db.profiles[p].nickname === name) return;
            db.profiles[p] = { nickname: name, updatedAt: nowStamp() };
            changed.push(name ? `「${name}」` : '「未设置」');
          });
          if (changed.length) pushLog(db, 'ok', `昵称已更新并推送：${changed.join('、')}`);
          return db;
        });
      },

      setMe(person) {
        commitSilent((db) => {
          if (db.config) {
            db.config.me = person;
          } else {
            /* 断开连接之后改身份：给一份最小的本机配置，别让这一下静默失效 */
            db.config = {
              repo: '', branch: 'main', token: '', tokenMask: '',
              aiKey: '', aiKeyMask: '', aiOn: true,
              me: person, view: 'order', autoPull: false, intervalSec: 0,
              lastPulledAt: '—', lastPushedAt: '—',
            };
          }
          return db;
        });
      },

      setView(view) {
        commitSilent((db) => {
          if (db.config) {
            db.config.view = view;
          } else {
            /* 与本机身份同样兜底：给一份最小配置，别让这一下静默失效 */
            db.config = {
              repo: '', branch: 'main', token: '', tokenMask: '',
              aiKey: '', aiKeyMask: '', aiOn: true,
              me: 'a', view, autoPull: false, intervalSec: 0,
              lastPulledAt: '—', lastPushedAt: '—',
            };
          }
          return db;
        });
      },

      joinAs({ myName, partnerName, preferred }) {
        commit((db) => {
          const mine = myName.trim();
          const theirs = (partnerName ?? '').trim();

          /* 认领人槽：本机默认格子若已写着别人的名字，就换另一格 */
          let slot: PersonKey = preferred;
          const alt = partnerOf(preferred);
          const atSlot = nicknameOf(db.profiles, preferred);
          const atAlt = nicknameOf(db.profiles, alt);
          if (atSlot && atSlot !== mine && (!atAlt || atAlt === mine)) slot = alt;

          const otherSlot = partnerOf(slot);
          const changed: string[] = [];
          if (db.profiles[slot].nickname !== mine) {
            db.profiles[slot] = { nickname: mine, updatedAt: nowStamp() };
            changed.push(`「${mine}」`);
          }
          /* 对方那栏留空就别动 —— 仓库里可能已经有对方自己设的名字 */
          if (theirs && db.profiles[otherSlot].nickname !== theirs) {
            db.profiles[otherSlot] = { nickname: theirs, updatedAt: nowStamp() };
            changed.push(`「${theirs}」`);
          }

          if (db.config) db.config.me = slot;
          else {
            db.config = {
              repo: '', branch: 'main', token: '', tokenMask: '',
              aiKey: '', aiKeyMask: '', aiOn: true,
              me: slot, view: 'order', autoPull: false, intervalSec: 0,
              lastPulledAt: '—', lastPushedAt: '—',
            };
          }

          if (changed.length) pushLog(db, 'ok', `昵称已更新并推送：${changed.join('、')}`);
          return db;
        });
      },

      setConfig(cfg) {
        commitSilent((db) => {
          db.config = cfg;
          db.configured = true;
          return db;
        });
      },

      patchConfig(patch) {
        commitSilent((db) => {
          if (db.config) db.config = { ...db.config, ...patch };
          return db;
        });
      },

      disconnect() {
        commit((db) => {
          db.config = null;
          db.configured = false;
          pushLog(db, 'ok', '已断开仓库连接，本地缓存已清除');
          return db;
        });
        dispatch({ type: 'sync', status: 'off', error: null, at: '—' });
      },

      applyRemote(remote) {
        commitSilent((db) => {
          if (remote.config) db.config = remote.config;
          /* 远端可能来自老仓库（角色形状的 profiles / 单菜订单）：入库前规整成当前 schema，
             否则按 a / b 取值的地方会直接抛错、整页白屏 */
          if (remote.profiles) db.profiles = normalizeProfiles(remote.profiles);
          if (Array.isArray(remote.recipes)) db.recipes = remote.recipes;
          if (Array.isArray(remote.orders)) db.orders = normalizeOrders(remote.orders);
          db.configured = true;
          db.updatedAt = nowStamp();
          return db;
        });
      },

      setSyncState(status, error = null, at) {
        dispatch({ type: 'sync', status, error, at });
      },

      logSync(kind, text) {
        commitSilent((db) => {
          pushLog(db, kind, text);
          return db;
        });
      },
    };
  }, [state.db, state.rev, state.sync, commit, commitSilent, pushLog]);

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(StoreCtx);
  if (!v) throw new Error('useStore 必须在 <StoreProvider> 内使用');
  return v;
}
