import type { DB, Order, OrderChange, PersonKey, Profile, Profiles, Recipe, SyncConfig } from './types';
import { dayKey, hasChange, isDayKey, isMeal, nowStamp, nowStampSec, orderDay, stamp } from './helpers';
import { guessArt } from '../lib/share';

export const SCHEMA = 4;
export const DB_KEY = 'jishiben-db-v1';

/** 示例数据里的相对时刻：daysAgo 天前的 hh:mm，落成带年月日的完整时间戳 */
function past(daysAgo: number, hh: number, mm: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hh, mm, 0, 0);
  return stamp(d);
}

/** 示例数据里的「哪天吃」：相对今天的第 n 天（负数是过去） */
function day(n: number): string {
  return dayKey(n);
}

/** 还不知道名字时的兜底 —— 首次设置填完就会被真名替换 */
export function emptyProfiles(): Profiles {
  return {
    a: { nickname: '', updatedAt: '—' },
    b: { nickname: '', updatedAt: '—' },
  };
}

/** 首次打开时的示例数据 —— 与设计源 seed() 一致，菜名/备注都是真实内容 */
export function seed(): DB {
  const t = nowStamp();
  return {
    schema: SCHEMA,
    configured: false,
    updatedAt: t,
    config: {
      repo: '',
      branch: 'main',
      token: '',
      tokenMask: '',
      aiKey: '',
      aiKeyMask: '',
      aiOn: true,
      me: 'a',
      view: 'order',
      autoPull: true,
      intervalSec: 60,
      /* 同步时间到秒：设置页那行「已同步 · …」要看得出确实同步过 */
      lastPulledAt: nowStampSec(),
      lastPushedAt: nowStampSec(),
    },
    /* 名字留空：不认识这两个人，界面用「点菜方 / 掌勺方」兜底，首次设置里填 */
    profiles: emptyProfiles(),
    recipes: [
      {
        id: 'r1',
        title: '番茄炖牛腩',
        url: 'https://xhslink.com/a/tomato-beef',
        art: 'tomato-beef.svg',
        image: '',
        note: '高压锅 40 分钟更省事；八角可放可不放，不放汤色更清。',
        ingredients: '牛腩 500g\n番茄 3 个（约 600g）\n姜 3 片\n八角 1 颗\n番茄膏 1 勺\n盐、冰糖适量',
        steps: '1. 牛腩冷水下锅焯水，撇沫捞出。\n2. 番茄去皮切块，一半先炒出沙，一半后放。\n3. 加热水没过牛腩，小火炖 40 分钟。\n4. 收汁前调味，撒葱花。',
        createdAt: past(48, 10, 12),
        updatedAt: past(1, 20, 30),
        orderCount: 1, /* 今天的午餐单里点过它 */
      },
      {
        id: 'r2',
        title: '溏心蛋葱油拌面',
        url: 'https://b23.tv/scallion-noodle',
        art: 'scallion-noodle.svg',
        image: '',
        note: '葱油一次多熬一点，密封冷藏能存两周。',
        ingredients: '小葱 200g\n面条 2 人份\n鸡蛋 2 个\n生抽 2 勺\n老抽 半勺\n糖 1 小勺\n食用油 200ml',
        steps: '1. 葱切段，冷油小火熬到葱变焦黄，滤出葱油。\n2. 水开下面，煮 2 分钟捞出过冰水。\n3. 鸡蛋煮 6 分半，冰水泡过再剥壳。\n4. 面拌葱油、生抽和一点糖，摆上溏心蛋。',
        createdAt: past(49, 21, 5),
        updatedAt: past(6, 12, 40),
        orderCount: 1, /* 明天那张晚餐单里点过它 */
      },
      {
        id: 'r3',
        title: '椰子鸡火锅',
        url: 'https://v.douyin.com/coconut-chicken',
        art: 'coconut-chicken.svg',
        image: '',
        note: '两只椰青取水打底，不用再加一滴清水。',
        ingredients: '椰青 2 只\n三黄鸡 1 只（约 1kg）\n马蹄 6 颗\n姜 3 片\n蘸料：生抽、小米辣、小青柠',
        steps: '1. 两只椰青取水，椰肉挖成条。\n2. 鸡块冷水下锅焯水后洗净。\n3. 椰水加等量清水煮开，下鸡块煮 8 分钟。\n4. 先喝汤，再涮菜。',
        createdAt: past(53, 18, 0),
        updatedAt: past(7, 8, 15),
        orderCount: 1, /* 昨天那张已做完的午餐单 */
      },
      {
        id: 'r4',
        title: '巴斯克芝士蛋糕',
        url: 'https://xhslink.com/a/basque-cake',
        art: 'basque-cake.svg',
        image: '',
        note: '奶油奶酪要室温软化，面糊过筛两遍更细腻。',
        ingredients: '奶油奶酪 250g\n细砂糖 60g\n鸡蛋 2 个\n淡奶油 150g\n低筋面粉 10g',
        steps: '1. 奶油奶酪室温软化，加糖打顺滑。\n2. 分次加蛋液拌匀，再加淡奶油。\n3. 筛入面粉，面糊过筛两遍。\n4. 220℃ 烤 25 分钟，表面焦黑即可，冷藏一夜更好吃。',
        createdAt: past(56, 15, 30),
        updatedAt: past(8, 21, 9),
        orderCount: 1, /* 今天的午餐单里点过它 */
      },
      {
        id: 'r5',
        title: '台式三杯鸡',
        url: 'https://xhslink.com/a/three-cup-chicken',
        art: 'three-cup-chicken.svg',
        image: '',
        note: '九层塔要关火再放，香气差很多。',
        ingredients: '鸡腿 2 只\n老姜 1 块\n蒜瓣 6 粒\n九层塔 1 把\n麻油 3 勺\n酱油 3 勺\n米酒 3 勺\n糖 1 勺',
        steps: '1. 鸡腿切块，用米酒抓一下。\n2. 麻油小火煸姜片到卷边，下蒜瓣。\n3. 下鸡块煎上色，加酱油、米酒、糖。\n4. 收汁后关火，拌入九层塔。',
        createdAt: past(59, 9, 45),
        updatedAt: past(12, 19, 26),
        orderCount: 0, /* 还没被点过 */
      },
      {
        id: 'r6',
        title: '芒果糯米饭',
        url: 'https://v.douyin.com/mango-sticky-rice',
        art: 'mango-sticky-rice.svg',
        image: '',
        note: '椰浆里加一小撮盐再淋，甜而不腻。',
        ingredients: '糯米 150g\n芒果 1 个\n椰浆 200ml\n糖 2 勺\n盐 一小撮',
        steps: '1. 糯米提前泡 4 小时，上锅蒸 25 分钟。\n2. 椰浆加糖和一小撮盐，小火煮化。\n3. 趁热把椰浆拌进糯米，盖上焖 15 分钟。\n4. 配芒果片，淋剩下的椰浆。',
        createdAt: past(63, 14, 0),
        updatedAt: past(17, 10, 21),
        orderCount: 1, /* 明天那张晚餐单里点过它 */
      },
    ],
    orders: [
      {
        id: 'o1',
        meal: 'lunch',
        dateKey: day(0),
        status: 'accepted',
        createdAt: past(0, 8, 20),
        updatedAt: past(0, 9, 2),
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
        /* 明天的一单：说明「今天 / 明天 / 后天」这套是拿来用的，掌勺那边也看得到日子 */
        dateKey: day(1),
        status: 'pending',
        createdAt: past(0, 9, 40),
        updatedAt: past(0, 9, 40),
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
        dateKey: day(-1),
        status: 'done',
        createdAt: past(1, 10, 15),
        updatedAt: past(1, 12, 2),
        placedBy: 'b',
        note: '',
        items: [{ recipeId: 'r3', dishName: '椰子鸡火锅' }],
      },
    ],
    logs: [
      { t: past(0, 12, 5), kind: 'ok', text: '已拉取 recipes.json + orders.json（6 条菜谱 · 3 份点单）' },
      { t: past(0, 11, 41), kind: 'ok', text: '晚餐单已推送：溏心蛋葱油拌面 + 芒果糯米饭（等待接单）' },
      { t: past(0, 11, 40), kind: 'ok', text: '掌勺方已接下今日午餐单：番茄炖牛腩 + 巴斯克芝士蛋糕' },
      { t: past(0, 9, 41), kind: 'ok', text: 'r1 · 番茄炖牛腩 备注已更新并推送' },
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

/**
 * 把任意来源的菜谱规整成当前 schema。补全项只有这几个：
 *   · `createdAt`：老缓存 / 老仓库（写于加这个字段之前）没有，用 `updatedAt` 顶上；
 *   · `steps`（做法）：同样可能缺，补空串。
 *   · `ingredients`（原材料）：写于加它之前的老数据没有，补空串。
 *   · `orderCount`（点单次数）：同样可能缺（或不是数字），补 0。
 * 另外把已经不再记录的 `author` / `source`（来源平台）从存量数据里摘掉 ——
 * 这两个字段连同相关逻辑一起删了，留着只会让老缓存 / 老仓库一路带下去。
 * 其余字段仍然不做补全 —— 缺了只是显示为空，不会崩。
 */
export function normalizeRecipes(raw: unknown): Recipe[] {
  const recipes = Array.isArray(raw) ? (raw as Recipe[]) : [];
  recipes.forEach((r) => {
    if (!r || typeof r !== 'object') return;
    /* 不再记录作者 / 来源平台：读进来就从对象上摘掉，别让它们跟着同步出去 */
    const legacy = r as Recipe & { author?: unknown; source?: unknown };
    delete legacy.author;
    delete legacy.source;
    if (typeof r.createdAt !== 'string' || !r.createdAt) {
      r.createdAt = typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : '—';
    }
    if (typeof r.steps !== 'string') r.steps = '';
    /* 原材料字段写于加它之前的老缓存 / 老仓库没有：补空串（详情页只在有内容时才显示那张卡） */
    if (typeof r.ingredients !== 'string') r.ingredients = '';
    /* 照片字段写于加它之前的老缓存 / 老仓库没有：补空串，别让渲染期读到 undefined */
    if (typeof r.image !== 'string') r.image = '';
    /* 手写 / 早期版本加进来的菜谱 art 常常是空串（只在「添加」那一刻猜过一次）：
       按菜名重猜一张，免得列表里一直是个光秃秃的首字。猜不出来仍是空串（首字占位） */
    if (typeof r.art !== 'string' || !r.art) r.art = guessArt(typeof r.title === 'string' ? r.title : '');
    if (typeof r.orderCount !== 'number' || !Number.isFinite(r.orderCount) || r.orderCount < 0) {
      r.orderCount = 0;
    }
  });
  return recipes;
}

/**
 * 把任意来源的订单规整成当前形状。补全 / 校正的都是「界面会直接读到」的字段：
 *   · 一单一道菜的旧结构（v1）补成 `items[]`；
 *   · 餐别只认早 / 午 / 晚 / 夜宵四种（更早的数据只有午 / 晚，正好都是合法值），
 *     别的值一律当午餐，免得卡片上印出个空餐别；
 *   · `dateKey`（哪天吃）：写于加这个字段之前的老数据没有，按 `createdAt` 那一天补
 *     —— 那时「下单当天吃」是唯一的用法，见 `orderDay`；
 *   · `changes[]`：老单没有这个字段，缺什么补什么（别让界面读到 undefined）。
 *     老形状是「一条只装一道菜」（kind + dishName），而同一批改动当时**共用同一时刻 /
 *     同一人 / 同一句原因** —— 按这三样把老记录并回一批，界面上就成了「一批一行」。
 *     新形状（`removed[]` / `added[]`）原样通过，不参与合并。
 */
export function normalizeOrders(raw: unknown): Order[] {
  const orders = Array.isArray(raw) ? (raw as Order[]) : [];
  orders.forEach((o) => {
    if (!o || typeof o !== 'object') return;
    const legacy = o as unknown as { dishName?: string; recipeId?: string | null };
    if (!o.items && typeof legacy.dishName === 'string') {
      o.items = [{ recipeId: legacy.recipeId ?? null, dishName: legacy.dishName }];
    }
    if (!Array.isArray(o.items)) o.items = [];
    if (!isMeal(o.meal)) o.meal = 'lunch';
    o.dateKey = orderDay(o);
    const rawChanges = Array.isArray(o.changes) ? o.changes.filter((c) => c && typeof c === 'object') : [];
    const merged = new Map<string, OrderChange>();
    const nextChanges: OrderChange[] = [];
    rawChanges.forEach((raw) => {
      const c = raw as OrderChange & { kind?: 'add' | 'remove'; dishName?: string };
      const names = (v: unknown) =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      const removed = names(c.removed);
      const added = names(c.added);
      const isLegacy = !removed.length && !added.length && typeof c.dishName === 'string';
      const entry: OrderChange = {
        at: typeof c.at === 'string' ? c.at : '—',
        by: c.by === 'b' ? ('b' as const) : ('a' as const),
        removed,
        added,
        reason: typeof c.reason === 'string' ? c.reason : '',
      };
      /* 点菜方改单可能还动了餐次 / 日子 / 「给掌勺的话」：只认合法值，别的当没动过 */
      if (isMeal(c.meal)) entry.meal = c.meal;
      if (isDayKey(c.date)) entry.date = c.date;
      if (typeof c.note === 'string') entry.note = c.note;
      if (isLegacy) {
        const bucket = c.kind === 'add' ? entry.added : entry.removed;
        const key = `${entry.at}|${entry.by}|${entry.reason}`;
        const hit = merged.get(key);
        if (hit) {
          hit[c.kind === 'add' ? 'added' : 'removed'].push(c.dishName as string);
          return;
        }
        bucket.push(c.dishName as string);
        merged.set(key, entry);
      }
      /* 什么都没改的（脏数据）直接丢掉，别在界面上留一行空的 */
      if (hasChange(entry)) nextChanges.push(entry);
    });
    o.changes = nextChanges;
  });
  return orders;
}

/**
 * 老数据迁移：
 *   v1 每单一道菜 → v2 多道菜 items[]
 *   v2 角色（orderer / cook）→ v3 两个人（a / b）：昵称与订单方向按旧身份对号入座
 *   v3 起「角色」变成底部第二格的本地视图（config.view），沿旧身份给个合理缺省
 *   v3 → v4 订单多了 `dateKey`（今天 / 明天 / 后天）：老单按 `createdAt` 那天补，
 *        这一步在 `normalizeOrders` 里每次读入都做（仓库里存量的老单也算），
 *        所以不为它单独留一段迁移 —— 但 v2 那段角色搬家**只对 v3 以前的缓存做**，
 *        否则会把 v3 用户已经选好的「我是谁 / 我的角色」冲回默认值。
 *
 * v3 把「角色」从人身上拿掉（两人都能点单也能掌勺），因此旧角色只用来认领人槽。
 * 本项目上线前未投入使用，迁移只求旧缓存不炸，不追求方向语义精确。
 */
export function migrate(db: DB): DB {
  if (!db) return db;

  /* 形状规整每次都要做，而不是只看 schema 版本号：老仓库里存量的 profiles.json
     可能是角色形状，也可能缺格 —— 这类数据不等同于「版本旧」，等不到下一次升级 */
  db.recipes = normalizeRecipes(db.recipes);
  db.orders = normalizeOrders(db.orders);
  db.profiles = normalizeProfiles(db.profiles);

  /* v1 / v2 → v3：旧角色形状的身份与订单方向搬家（只做一次，见上面那段说明） */
  if (!db.schema || db.schema < 3) {
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
  }
  db.schema = SCHEMA;

  /* 本机角色缺省（老缓存 / 被手改过的配置）：一律补「点单」 */
  if (db.config && db.config.view !== 'cook') db.config.view = 'order';

  /* AI 识别的本机设置（写于加这两个字段之前的老缓存没有）：补齐，别让设置页读到 undefined */
  if (db.config) {
    if (typeof (db.config as Partial<SyncConfig>).aiKey !== 'string') db.config.aiKey = '';
    if (typeof (db.config as Partial<SyncConfig>).aiKeyMask !== 'string') db.config.aiKeyMask = '';
    if (typeof (db.config as Partial<SyncConfig>).aiOn !== 'boolean') db.config.aiOn = true;
  }

  if (!Array.isArray(db.logs)) db.logs = [];
  return db;
}
