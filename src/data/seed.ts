import type { DB, Order, PersonKey, Profile, Profiles, SyncConfig } from './types';

export const SCHEMA = 3;
export const DB_KEY = 'jishiben-db-v1';

/** 还不知道名字时的兜底 —— 首次设置填完就会被真名替换 */
export function emptyProfiles(): Profiles {
  return {
    a: { nickname: '', updatedAt: '—' },
    b: { nickname: '', updatedAt: '—' },
  };
}

/** 首次打开时的示例数据 —— 与设计源 seed() 一致，菜名/作者/备注都是真实内容 */
export function seed(): DB {
  return {
    schema: SCHEMA,
    configured: false,
    updatedAt: '12:05',
    config: {
      repo: '',
      branch: 'main',
      token: '',
      tokenMask: '',
      me: 'a',
      view: 'order',
      autoPull: true,
      intervalSec: 60,
      lastPulledAt: '12:05',
      lastPushedAt: '12:05',
    },
    /* 名字留空：不认识这两个人，界面用「点菜方 / 掌勺方」兜底，首次设置里填 */
    profiles: emptyProfiles(),
    recipes: [
      {
        id: 'r1',
        title: '番茄炖牛腩',
        source: 'red',
        url: 'https://xhslink.com/a/tomato-beef',
        author: '爱做饭的阿珍',
        art: 'tomato-beef.svg',
        note: '高压锅 40 分钟更省事；八角可放可不放，不放汤色更清。',
        updatedAt: '昨天',
      },
      {
        id: 'r2',
        title: '溏心蛋葱油拌面',
        source: 'bili',
        url: 'https://b23.tv/scallion-noodle',
        author: '深夜食堂阿伟',
        art: 'scallion-noodle.svg',
        note: '葱油一次多熬一点，密封冷藏能存两周。',
        updatedAt: '周三',
      },
      {
        id: 'r3',
        title: '椰子鸡火锅',
        source: 'douyin',
        url: 'https://v.douyin.com/coconut-chicken',
        author: '海南小厨娘',
        art: 'coconut-chicken.svg',
        note: '两只椰青取水打底，不用再加一滴清水。',
        updatedAt: '周二',
      },
      {
        id: 'r4',
        title: '巴斯克芝士蛋糕',
        source: 'red',
        url: 'https://xhslink.com/a/basque-cake',
        author: '丸子的烘焙日记',
        art: 'basque-cake.svg',
        note: '奶油奶酪要室温软化，面糊过筛两遍更细腻。',
        updatedAt: '8月30日',
      },
      {
        id: 'r5',
        title: '台式三杯鸡',
        source: 'red',
        url: 'https://xhslink.com/a/three-cup-chicken',
        author: '台味阿宏',
        art: 'three-cup-chicken.svg',
        note: '九层塔要关火再放，香气差很多。',
        updatedAt: '8月26日',
      },
      {
        id: 'r6',
        title: '芒果糯米饭',
        source: 'douyin',
        url: 'https://v.douyin.com/mango-sticky-rice',
        author: '曼谷的夏天',
        art: 'mango-sticky-rice.svg',
        note: '椰浆里加一小撮盐再淋，甜而不腻。',
        updatedAt: '8月21日',
      },
    ],
    orders: [
      {
        id: 'o1',
        meal: 'lunch',
        status: 'accepted',
        createdAt: '今天 08:20',
        updatedAt: '今天 09:02',
        placedBy: 'a',
        note: '',
        items: [
          { recipeId: 'r1', dishName: '番茄炖牛腩' },
          { recipeId: 'r4', dishName: '巴斯克芝士蛋糕' },
        ],
      },
      {
        id: 'o2',
        meal: 'dinner',
        status: 'pending',
        createdAt: '今天 09:40',
        updatedAt: '今天 09:40',
        placedBy: 'b',
        note: '少放辣',
        items: [
          { recipeId: 'r2', dishName: '溏心蛋葱油拌面' },
          { recipeId: 'r6', dishName: '芒果糯米饭' },
        ],
      },
      {
        id: 'o3',
        meal: 'lunch',
        status: 'done',
        createdAt: '昨天 10:15',
        updatedAt: '昨天 12:02',
        placedBy: 'b',
        note: '',
        items: [{ recipeId: 'r3', dishName: '椰子鸡火锅' }],
      },
    ],
    logs: [
      { t: '12:05', kind: 'ok', text: '已拉取 recipes.json + orders.json（6 条菜谱 · 3 份点单）' },
      { t: '11:41', kind: 'ok', text: '晚餐单已推送：溏心蛋葱油拌面 + 芒果糯米饭（等待接单）' },
      { t: '11:40', kind: 'ok', text: '掌勺方已接下今日午餐单：番茄炖牛腩 + 巴斯克芝士蛋糕' },
      { t: '09:41', kind: 'ok', text: 'r1 · 番茄炖牛腩 备注已更新并推送' },
    ],
  };
}

const BLANK: Profile = { nickname: '', updatedAt: '—' };

/**
 * 把任意来源的 profiles 规整成当前 schema 的 `{ a, b }` 两格。
 *
 * 来源可能是老版本缓存、仓库里存量的 profiles.json、或被手动改过的文件：
 *   · v2 的角色形状（orderer / cook）按「先点单后掌勺」对号入座；
 *   · 缺格 / 字段类型不对 / 整块缺失 → 一律补成空格。
 *
 * 不能省这一步：调用方（`joinAs` / `setProfiles` / 同步页）都直接取
 * `profiles[人].nickname`，少一格就会在渲染期抛错，整页白屏。
 */
export function normalizeProfiles(raw: unknown): Profiles {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Partial<Profile> | undefined>;
  const at = (...keys: string[]): Profile => {
    for (const key of keys) {
      const p = src[key];
      if (p && typeof p === 'object') {
        return {
          nickname: typeof p.nickname === 'string' ? p.nickname : '',
          updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '—',
        };
      }
    }
    return { ...BLANK };
  };
  return { a: at('a', 'orderer'), b: at('b', 'cook') };
}

/** 把任意来源的订单规整成 v2+ 的多菜形状（一单一道菜的旧结构补 items[]） */
export function normalizeOrders(raw: unknown): Order[] {
  const orders = Array.isArray(raw) ? (raw as Order[]) : [];
  orders.forEach((o) => {
    if (!o || typeof o !== 'object') return;
    const legacy = o as unknown as { dishName?: string; recipeId?: string | null };
    if (!o.items && typeof legacy.dishName === 'string') {
      o.items = [{ recipeId: legacy.recipeId ?? null, dishName: legacy.dishName }];
    }
    if (!Array.isArray(o.items)) o.items = [];
  });
  return orders;
}

/**
 * 老数据迁移：
 *   v1 每单一道菜 → v2 多道菜 items[]
 *   v2 角色（orderer / cook）→ v3 两个人（a / b）：昵称与订单方向按旧身份对号入座
 *   v3 起「角色」变成底部第二格的本地视图（config.view），沿旧身份给个合理缺省
 *
 * v3 把「角色」从人身上拿掉（两人都能点单也能掌勺），因此旧角色只用来认领人槽。
 * 本项目上线前未投入使用，迁移只求旧缓存不炸，不追求方向语义精确。
 */
export function migrate(db: DB): DB {
  if (!db) return db;

  /* 形状规整每次都要做，而不是只看 schema 版本号：老仓库里存量的 profiles.json
     可能是角色形状，也可能缺格 —— 这类数据不等同于「版本旧」，等不到下一次升级 */
  db.orders = normalizeOrders(db.orders);
  db.profiles = normalizeProfiles(db.profiles);

  /* v2 → v3 */
  if (db.schema !== SCHEMA) {
    const legacyCfg = db.config as
      | (SyncConfig & { role?: 'orderer' | 'cook'; nickname?: string })
      | null;
    const me: PersonKey = legacyCfg?.role === 'cook' ? 'b' : 'a';

    if (legacyCfg) {
      legacyCfg.me = me;
      /* 旧身份顺手当成本机默认角色：掌勺方打开就看到「掌勺」 */
      legacyCfg.view = legacyCfg.role === 'cook' ? 'cook' : 'order';
      delete legacyCfg.role;
      /* 更早的昵称曾是「只存本机」的 config.nickname，搬进自己那个人槽 */
      const legacyNick = typeof legacyCfg.nickname === 'string' ? legacyCfg.nickname.trim() : '';
      if (legacyNick && !db.profiles[me].nickname) db.profiles[me] = { nickname: legacyNick, updatedAt: '—' };
      delete legacyCfg.nickname;
    }

    db.orders.forEach((o) => {
      if (o.placedBy !== 'a' && o.placedBy !== 'b') o.placedBy = me;
    });

    db.schema = SCHEMA;
  }

  /* 本机角色缺省（老缓存 / 被手改过的配置）：一律补「点单」 */
  if (db.config && db.config.view !== 'cook') db.config.view = 'order';

  if (!Array.isArray(db.logs)) db.logs = [];
  return db;
}
