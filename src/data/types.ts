/* 数据模型 —— 与设计源 recipe-app-plan.md §8 一致 */

/** manual = 手动加的（没有来源平台）；generic = 其他网页 */
export type SourceKey = 'red' | 'bili' | 'douyin' | 'generic' | 'manual';
/** 两个人：a / b。角色（点菜 / 掌勺）不再绑定到人，而是由每张订单的方向决定 */
export type PersonKey = 'a' | 'b';
export type OrderStatus = 'pending' | 'accepted' | 'done';
export type Meal = 'lunch' | 'dinner';
/** 本机当前扮演的角色：决定底部第二格是「点单」还是「掌勺」（本地设置，不进仓库） */
export type ViewRole = 'order' | 'cook';

export interface Recipe {
  id: string;
  title: string;
  source: SourceKey;
  url: string;
  author: string;
  /** 本地插画资源名，如 tomato-beef.svg；空串则用首字占位 */
  art: string;
  /**
   * 菜谱照片在仓库里的路径，如 `images/r_xxx.jpg`；空串 = 没有照片。
   * 照片是仓库里的一张独立图片（不在这个 JSON 里塞 base64），
   * 本机只缓存一份 data URL 供离线显示，读图见 `src/lib/photo.ts`。
   */
  image: string;
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
