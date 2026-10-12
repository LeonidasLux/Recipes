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
  OrderChange,
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
import {
  changeText,
  dayKey,
  dayTag,
  diffItems,
  hasChange,
  isDayKey,
  isMeal,
  mealLabel,
  meOf,
  newId,
  nicknameOf,
  nowStamp,
  orderChanges,
  orderDay,
  orderItems,
  orderSummary,
  partnerOf,
  PERSON_KEYS,
  viewOf,
} from './helpers';

/**
 * 数一张单里每道菜谱各点了几道（临时手输的菜没有菜谱 id，不计）。
 * 改单时拿前后两份对差，给菜谱的「点单次数」加减 —— 同一道菜点两次就算两次。
 */
function countItemIds(items: OrderItem[]): Map<string, number> {
  const m = new Map<string, number>();
  items.forEach((it) => {
    if (!it.recipeId) return;
    m.set(it.recipeId, (m.get(it.recipeId) ?? 0) + 1);
  });
  return m;
}

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
    /** 原材料（一行一样；没写就是空串） */
    ingredients: string;
    steps: string;
    note: string;
    /** 调用方可以指定 id：上传照片时得先知道图片路径（images/<id>.jpg） */
    id?: string;
  }): Recipe;
  /** 改菜谱的菜名 / 原文出处 / 照片 / 原材料 / 做法 / 备注（内容改动，会触发推送） */
  updateRecipe(id: string, patch: { title?: string; url?: string; image?: string; ingredients?: string; steps?: string; note?: string }): void;
  /** 删菜谱（内容改动，会触发推送）；订单里的菜名是快照，不受影响 */
  deleteRecipe(id: string): void;
  /** 一次删多道菜谱（菜谱库多选删除用）：一次提交、一条日志 */
  deleteRecipes(ids: string[]): void;
  /**
   * 下单（内容改动，会触发推送）；单里的菜各记一次「点单次数」。
   * `dateKey` 是打算哪天吃（今天 / 明天 / 后天，见 `dayKey`）。
   */
  addOrder(input: { dateKey: string; meal: Meal; items: OrderItem[]; note?: string }): Order;
  /**
   * 改一张**还没做完**的单（内容改动，会触发推送）：餐次 / 哪天吃 / 菜 / 给掌勺的话都能改。
   * 换菜按「道次」的差把点单次数加上 / 退回来；已经「已接」的单改完退回「待接」，
   * 掌勺方得再看一眼新菜单（已完成的不给改，见 §2）。
   * 改了什么也会记一条 `order.changes`（`reason` 可不填 —— 点菜方改自己的单，不必解释），
   * 掌勺那边展开这张单就看得到。
   */
  updateOrder(
    id: string,
    patch: { meal?: Meal; dateKey?: string; items?: OrderItem[]; note?: string; reason?: string },
  ): void;
  /**
   * 把一张「已完成」的单恢复成没做完（内容改动，会触发推送）：
   * 退回「已接」—— 也就是掌勺方点「全部做好了」之前那一格，两边都不用重新接一次单。
   * 「已完成」点错了（其实还没做完、手滑点了），或者点菜方觉得这顿没结束，都走这里。
   */
  restoreOrder(id: string): void;
  /**
   * 掌勺方改一张「已接」单的菜单（内容改动，会触发推送）：一次可以减几道、加几道，
   * **整批共用一句原因**（`reason` 必填），每道菜各记一条 `order.changes`（都挂这句原因）。
   * 状态保持「已接」（掌勺方自己接的单，不用重接）；改完至少留一道（想清空就去删整单）。
   */
  changeOrderDishes(id: string, input: { add: OrderItem[]; remove: number[]; reason: string }): void;
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
          ingredients: input.ingredients,
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
          if (patch.ingredients !== undefined) r.ingredients = patch.ingredients;
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
        /* 餐别 / 日子都兜一道底：界面上给的就是合法值，脏值（被手改过的调用方）不让落库 */
        const meal = isMeal(input.meal) ? input.meal : 'lunch';
        const dateKey = isDayKey(input.dateKey) ? input.dateKey : dayKey(0);
        const order: Order = {
          id: newId('o'),
          meal,
          dateKey,
          status: 'pending',
          createdAt: nowStamp(),
          updatedAt: nowStamp(),
          placedBy: me,
          note: input.note ?? '',
          items: input.items.map((it) => ({ recipeId: it.recipeId, dishName: it.dishName })),
          changes: [],
        };
        commit((db) => {
          db.orders.unshift(order);
          /* 点单次数：这道菜每被点进一张单就 +1（临时手输的菜没有菜谱，不计） */
          order.items.forEach((it) => {
            const r = it.recipeId ? db.recipes.find((x) => x.id === it.recipeId) : null;
            if (r) r.orderCount = (r.orderCount ?? 0) + 1;
          });
          pushLog(db, 'ok', `已发${dayTag(dateKey)}${mealLabel(meal)}单：${orderSummary(order)}`);
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

      updateOrder(id, patch) {
        commit((db) => {
          const o = db.orders.find((x) => x.id === id);
          /* 已完成的不给改：界面也不给入口，这里再兜一层（拉回来的单可能刚好被掌勺方标完） */
          if (!o || o.status === 'done') return db;

          const itemsBefore = orderItems(o);
          const itemsAfter = patch.items
            ? patch.items.map((it) => ({ recipeId: it.recipeId, dishName: it.dishName }))
            : itemsBefore;
          const mealAfter = isMeal(patch.meal) ? patch.meal : o.meal;
          const dayAfter = isDayKey(patch.dateKey) ? patch.dateKey : orderDay(o);
          const noteAfter = patch.note !== undefined ? patch.note : o.note ?? '';

          /* 改了什么记一条 —— 掌勺那边得看得见菜单 / 餐次 / 日子 / 备注动过。
             原因可不填（点菜方改自己的单，不必解释）：空着就只写「改了什么」。 */
          const diff = diffItems(itemsBefore, itemsAfter);
          const record: OrderChange = {
            at: nowStamp(),
            by: meOf(db.config),
            removed: diff.removed,
            added: diff.added,
            reason: (patch.reason ?? '').trim(),
          };
          if (dayAfter !== orderDay(o)) record.date = dayAfter;
          if (mealAfter !== o.meal) record.meal = mealAfter;
          if (noteAfter !== (o.note ?? '')) record.note = noteAfter;
          /* 一处都没改（比如进改单模式又原样保存）：不记记录、不写日志、连更新时间都不动 */
          if (!hasChange(record)) return db;

          if (patch.items) {
            /* 点单次数按「道次」的差算：丢掉的那道退回来、新加的那道记一次，剩下的原样不动 */
            const before = countItemIds(itemsBefore);
            const after = countItemIds(itemsAfter);
            new Set([...before.keys(), ...after.keys()]).forEach((rid) => {
              const delta = (after.get(rid) ?? 0) - (before.get(rid) ?? 0);
              if (!delta) return;
              const r = db.recipes.find((x) => x.id === rid);
              if (r) r.orderCount = Math.max(0, (r.orderCount ?? 0) + delta);
            });
            o.items = itemsAfter;
          }
          o.meal = mealAfter;
          o.dateKey = dayAfter;
          o.note = noteAfter;
          o.changes = [...orderChanges(o), record];
          /* 掌勺方已经接下这张单了：菜单一变就退回「待接」，让对方再看一眼 */
          const backToPending = o.status === 'accepted';
          if (backToPending) o.status = 'pending';
          o.updatedAt = record.at;
          pushLog(
            db,
            'ok',
            `已修改点单：${orderSummary(o)} · ${dayTag(o.dateKey)}${mealLabel(o.meal)}${
              backToPending ? ' · 菜单变了，已退回待接' : ''
            }${record.reason ? `（${record.reason}）` : ''}`,
          );
          return db;
        });
      },

      restoreOrder(id) {
        commit((db) => {
          const o = db.orders.find((x) => x.id === id);
          /* 只恢复「已完成」的单：没做完的本来就没做完，不用动 */
          if (!o || o.status !== 'done') return db;
          o.status = 'accepted';
          o.updatedAt = nowStamp();
          pushLog(db, 'ok', `已恢复成没做完：${orderSummary(o)}，状态已推送`);
          return db;
        });
      },

      changeOrderDishes(id, input) {
        commit((db) => {
          const o = db.orders.find((x) => x.id === id);
          /* 只动「已接」的单：还没接的先接下，已经做完的去点「恢复成没做完」 */
          if (!o || o.status !== 'accepted') return db;
          /* 原因必填（界面也拦一道）：它是要给点菜那边看的，空着不如不记 */
          const reason = input.reason.trim();
          if (!reason) return db;

          const items = orderItems(o);
          const gone = new Set(input.remove);
          const kept: OrderItem[] = [];
          const removed: OrderItem[] = [];
          items.forEach((it, i) => (gone.has(i) ? removed : kept).push(it));

          /* 要加的：单里还剩的、以及这一批里已经在的要加的，都不再加第二遍 */
          const added: OrderItem[] = [];
          input.add.forEach((raw) => {
            const it: OrderItem = { recipeId: raw.recipeId, dishName: raw.dishName };
            const same = (k: OrderItem) =>
              it.recipeId ? k.recipeId === it.recipeId : k.dishName === it.dishName;
            if (kept.some(same) || added.some(same)) return;
            added.push(it);
          });

          /* 空改动不提交；一次也不能减空（加了菜算数：减两样换两样是常见用法） */
          if (!removed.length && !added.length) return db;
          if (kept.length + added.length < 1) return db;

          o.items = [...kept, ...added];
          /* 点单次数跟点单那套一个口径：减掉的退回来、加上的记一次，都不低于 0 */
          const bump = (it: OrderItem, delta: number) => {
            const r = it.recipeId ? db.recipes.find((x) => x.id === it.recipeId) : null;
            if (r) r.orderCount = Math.max(0, (r.orderCount ?? 0) + delta);
          };
          removed.forEach((it) => bump(it, -1));
          added.forEach((it) => bump(it, 1));

          /* 一批改动**只记一条**：减了哪几道、加了哪几道都在这条里，共用这一句原因 */
          const record: OrderChange = {
            at: nowStamp(),
            by: meOf(db.config),
            removed: removed.map((it) => it.dishName),
            added: added.map((it) => it.dishName),
            reason,
          };
          o.changes = [...orderChanges(o), record];
          o.updatedAt = record.at;
          pushLog(db, 'ok', `改了菜单：${changeText(record)}（${reason}）`);
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
