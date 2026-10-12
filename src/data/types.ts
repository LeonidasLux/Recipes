/* 数据模型 —— 与设计源 recipe-app-plan.md §8 一致 */

/** 两个人：a / b。角色（点菜 / 掌勺）不再绑定到人，而是由每张订单的方向决定 */
export type PersonKey = 'a' | 'b';
export type OrderStatus = 'pending' | 'accepted' | 'done';
/**
 * 餐别：早餐 / 午餐 / 晚餐 / 夜宵。
 * 点单时按**当前时间落在哪个时段**先默认选一个（见 `MEAL_WINDOWS` / `mealForTime`），
 * 用户可以再手动改。
 */
export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'night';
/** 本机当前扮演的角色：决定底部第二格是「点单」还是「掌勺」（本地设置，不进仓库） */
export type ViewRole = 'order' | 'cook';

export interface Recipe {
  id: string;
  title: string;
  url: string;
  /** 本地插画资源名，如 tomato-beef.svg；空串则用首字占位 */
  art: string;
  /**
   * 菜谱照片在仓库里的路径，如 `images/r_xxx.jpg`；空串 = 没有照片。
   * 照片是仓库里的一张独立图片（不在这个 JSON 里塞 base64），
   * 本机只缓存一份 data URL 供离线显示，读图见 `src/lib/photo.ts`。
   */
  image: string;
  /** 原材料：一行一样（「牛腩 500g」这种）；没写就是空串 */
  ingredients: string;
  /** 做法（步骤）。手动加的菜谱主要就靠这一段；剪藏来的可以留空 */
  steps: string;
  note: string;
  /** 收藏时间（第一次存进来的时间）；老数据/老仓库没有，规整时用 updatedAt 顶上 */
  createdAt: string;
  updatedAt: string;
  /** 点单次数：每下一次含这道菜的单就 +1（删掉那张单会 −1）；老数据/老仓库没有，规整时补 0 */
  orderCount: number;
}

/** 一单里的一道菜；recipeId 为空表示临时手动输入的菜 */
export interface OrderItem {
  recipeId: string | null;
  dishName: string;
}

export interface Order {
  id: string;
  meal: Meal;
  /**
   * 这一顿打算哪天吃（`2026-10-12` 这种日期 key，不含时刻）。
   * 点单时能选今天 / 明天 / 后天；老数据（写于加这个字段之前）没有，
   * 规整时按 `createdAt` 那一天补上（见 `orderDay`）。
   */
  dateKey: string;
  status: OrderStatus;
  items: OrderItem[];
  note: string;
  createdAt: string;
  updatedAt: string;
  /** 谁点的这一单；做饭的是另一个人（角色随单而定） */
  placedBy: PersonKey;
  /**
   * 掌勺方对这张单的加减菜记录（一次加减一条、必带原因），老数据 / 老仓库没有这个字段。
   * 点菜方展开那张单就能看到「谁、什么时候、为什么加减了哪道菜」。
   */
  changes?: OrderChange[];
}

/**
 * 掌勺方改菜单的一条记录：**一次改动（一批）一条** —— 这一批减掉了哪几道、加进来哪几道，
 * 以及为什么。一次只减一道时也就是一条（数组里一个菜名）。
 */
export interface OrderChange {
  /** 记录时间，与别的记录时间同一格式（`2026-10-07 09:40`） */
  at: string;
  /** 谁改的（记改的人，不记单的方向） */
  by: PersonKey;
  /** 这一批减掉的菜（菜名，按原来在单里的顺序） */
  removed: string[];
  /** 这一批加进来的菜（菜名，按加进来的顺序） */
  added: string[];
  /** 这次把餐次改成了什么（没动餐次就没有这个字段） */
  meal?: Meal;
  /** 这次把「哪天吃」挪到了哪天（没动日子就没有这个字段；存的是绝对日期 key） */
  date?: string;
  /** 这次把「给掌勺的话」改成了什么（空串 = 清空了；没动过这个字段就没有） */
  note?: string;
  /**
   * 为什么这么改 —— 整批共用这一句。
   * 掌勺方改菜单时**必填**（界面上不填不让提交）；点菜方改自己的单时**可不填**（空串）。
   */
  reason: string;
}

export interface LogEntry {
  t: string;
  kind: 'ok' | 'err';
  text: string;
}

/**
 * 昵称 —— 两个人的名字都进仓库（profiles.json），两台设备共享。
 * 和菜谱/订单一样，两边都能改，冲突按 last-write-wins。
 */
export interface Profile {
  nickname: string;
  updatedAt: string;
}

export interface Profiles {
  a: Profile;
  b: Profile;
}

/** 同步配置：全部只存本机（token、仓库地址、我的身份、拉取策略），不提交仓库 */
export interface SyncConfig {
  repo: string;
  branch: string;
  /** 仅存本机，永不写进仓库 */
  token: string;
  tokenMask: string;
  /** DeepSeek API Key（AI 识别用）；同样只存本机，永不写进仓库 */
  aiKey: string;
  aiKeyMask: string;
  /** 识别时是否走 AI（有 key 才真正生效） */
  aiOn: boolean;
  /** 本机这个人是谁（本地设置，不进仓库） */
  me: PersonKey;
  /** 本机当前角色（本地设置，不进仓库）：决定底部第二格是「点单」还是「掌勺」 */
  view: ViewRole;
  autoPull: boolean;
  intervalSec: 0 | 60 | 600;
  lastPulledAt: string;
  lastPushedAt: string;
  lastSyncError?: string;
}

export interface DB {
  schema: number;
  configured: boolean;
  updatedAt: string;
  config: SyncConfig | null;
  /** 两个人的昵称，随仓库同步 */
  profiles: Profiles;
  recipes: Recipe[];
  orders: Order[];
  logs: LogEntry[];
}

/** 仓库里 recipes.json / orders.json 的形状 */
export interface RemoteRecipes {
  schema: number;
  updatedAt: string;
  recipes: Recipe[];
}

export interface RemoteOrders {
  schema: number;
  updatedAt: string;
  orders: Order[];
}

export interface RemoteProfiles {
  schema: number;
  updatedAt: string;
  profiles: Profiles;
}

export type SyncStatus = 'off' | 'idle' | 'busy' | 'ok' | 'err';
