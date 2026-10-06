/* 数据模型 —— 与设计源 recipe-app-plan.md §8 一致 */

export type SourceKey = 'red' | 'bili' | 'douyin' | 'generic';
/** 两个人：a / b。角色（点菜 / 掌勺）不再绑定到人，而是由每张订单的方向决定 */
export type PersonKey = 'a' | 'b';
export type OrderStatus = 'pending' | 'accepted' | 'done';
export type Meal = 'lunch' | 'dinner';

export interface Recipe {
  id: string;
  title: string;
  source: SourceKey;
  url: string;
  author: string;
  /** 本地插画资源名，如 tomato-beef.svg；空串则用首字占位 */
  art: string;
  note: string;
  updatedAt: string;
}

/** 一单里的一道菜；recipeId 为空表示临时手动输入的菜 */
export interface OrderItem {
  recipeId: string | null;
  dishName: string;
}

export interface Order {
  id: string;
  meal: Meal;
  status: OrderStatus;
  items: OrderItem[];
  note: string;
  createdAt: string;
  updatedAt: string;
  /** 谁点的这一单；做饭的是另一个人（角色随单而定） */
  placedBy: PersonKey;
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
  /** 本机这个人是谁（本地设置，不进仓库） */
  me: PersonKey;
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
