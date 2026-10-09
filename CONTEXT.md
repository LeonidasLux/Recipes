# CONTEXT.md · 记食本 功能总览

> 本文件是「记食本」项目的**功能真源**（single source of truth）。
> 任何软件功能变更都必须同步更新本文件，代码必须与本文件保持一致。约束细则见 `AGENTS.md`。

## 1. 项目是什么

记食本（`package.json` name = `jishiben`）是一个**双人协作的菜谱收藏 + 点单**应用，形态为 PWA，并可用 Capacitor 打包成 Android APK。

- 两个人（内部记作 `a` / `b`）：**角色不绑在人身上** —— 谁点单、谁掌勺由每张订单的方向决定，两个人谁都能点单、也都能掌勺，共用同一份数据。
- 收藏来自小红书 / B站 / 抖音等平台的菜谱：粘贴分享文案或链接、或**直接上传一张菜谱截图**，**「识别」可选接入 DeepSeek AI** 把文案 / 截图拆成菜名 / 作者 / 做法（没配 Key 时退回本地启发式解析），写备注，配封面 —— 有上传的截图就用截图，没有就用本地卡通插画。
- 下单的人从菜谱库多选几道菜凑成一单（午餐 / 晚餐）发给对方；收到单的人在「掌勺」里「接下这顿」→「全部做好了」回传状态。
- **数据真源是用户自己的 GitHub 仓库**（三个 JSON 文件 + 一个 `images/` 图片目录）；本地 `localStorage` 只是缓存，换手机、两人共用都不丢。
- **提交即同步**：本地内容改动后自动推送回仓库；后台按间隔轮询拉取对方改动。
- 没有自建后端，浏览器 / Android WebView 直接调用 GitHub Contents API（`api.github.com`）。

**技术栈**：React 19 + TypeScript 5.8 + Vite 6 + react-router-dom 7（HashRouter）+ Capacitor 6（Android，`@capacitor/app` 负责手机返回键，见 §6 / §11）。样式为手写 CSS，无 UI 框架。验证靠自研 jsdom 冒烟脚本与 TypeScript/类名对账。

## 2. 数据模型（`src/data/types.ts`）

- `SourceKey`：`red`（小红书）/ `bili`（B站）/ `douyin`（抖音）/ `generic`（其它网页）/ `manual`（**手动添加，没有来源平台**）。
- `PersonKey`：`a` / `b`（两个人；角色随订单方向而定，不再有 orderer / cook 两个固定身份）；`OrderStatus`：`pending` / `accepted` / `done`；`Meal`：`lunch` / `dinner`；`SyncStatus`：`off` / `idle` / `busy` / `ok` / `err`；`ViewRole`：`order` / `cook`（本机当前角色，只决定底部第二格与默认屏，不改变数据归属）。
- `Recipe`：`id, title, source, url, author, art, image, steps, note, createdAt, updatedAt, orderCount`。`author` 是原作者 / 账号，**没填就是空串**（界面不摆那一格、也不编「来自剪藏」这种假出处，见 §7）；`art` 为本地插画文件名（如 `tomato-beef.svg`），空串则用标题首字占位。`image` 是**用户上传的菜谱照片在仓库里的路径**（如 `images/r_abc.png`），空串 = 没有照片；照片本身是仓库里的一张独立图片文件（**不在 `recipes.json` 里塞 base64**，见 §4），`Cover` 组件按「照片 → 插画 → 首字」三级兜底显示（§8）；详情页里点一下照片能看大图（§7）。`steps` 是**做法**（多行文本，详情页按换行原样展示），手动添加的菜谱主要就靠它；剪藏来的可以留空。`createdAt` 是收藏时间、`updatedAt` 是最后编辑时间，都用统一时间戳（新增 / 编辑时写当前时刻）；两个时间都只在菜谱详情页显示。`orderCount` 是**点单次数**（默认 0，老数据规整时补 0）：下一次含这道菜的单就 +1，删掉那张单再 −1（不低于 0）；临时手输的菜没有菜谱，不计。
- `OrderItem`：`recipeId: string | null, dishName`。`recipeId` 为 `null` 表示**临时手动输入的菜**。
- `Order`：`id, meal, status, items[], note, createdAt, updatedAt, placedBy`（一单多菜；`placedBy` 是下单那个人，做饭的是另一个人）。`createdAt` / `updatedAt` 是统一时间戳（下单、改状态时写当前时刻）。
- `Profile`：`nickname, updatedAt`；`Profiles`：`{ a, b }`（昵称绑人、不绑角色，所以换角色不会串位）。`updatedAt` 是统一时间戳（改名时写当前时刻）；还没设过名字时是占位符 `—`。**两格一定都在**：任何来源的 profiles 都先过 `normalizeProfiles`（缺格补空、角色形状对号入座），因为调用方（`joinAs` / `setProfiles` / 同步页）都直接取 `profiles[人].nickname`。
- `SyncConfig`：`repo, branch, token, tokenMask, aiKey, aiKeyMask, aiOn, me, view, autoPull, intervalSec(0 | 60 | 600), lastPulledAt, lastPushedAt, lastSyncError?`。其中 `token`、`aiKey`/`aiKeyMask`（DeepSeek API Key 及其掩码）、`me`（本机这个人是谁）与 `view`（本机当前角色）**仅存本机，永不入库**；`aiOn` 是「识别时是否走 AI」的本机开关（默认 `true`，没填 Key 时不起作用）。`lastPulledAt` / `lastPushedAt` 是**精确到秒**的时间戳（`2026-10-07 09:40:12`，见下条时间格式）。老缓存缺这几个字段由 `migrate()` 补齐。
- **「仅存本机」= 存本机浏览器的 localStorage**（整个 DB 序列化成一条，key `jishiben-db-v1`，见 §3），而 localStorage 是**按来源（协议 + 主机 + 端口）隔离**的。所以同一个地址下刷新 / 重开浏览器都在；**换了地址就不是同一份存储**：`localhost:5173` ↔ `192.168.x.x:5173`、dev `5173` ↔ preview `4173`、手机上从 Safari 打开 ↔ 「添加到主屏幕」的 PWA（iOS 上是两个容器），各存各的，看起来就像「token / 仓库 / Key 没保存」。dev / preview 都设了 `strictPort`（端口被占用直接报错，不偷偷换到 5174）就是为了不踩这个坑。
- `DB`：`schema(=3), configured, updatedAt, config, profiles, recipes[], orders[], logs[]`。`updatedAt` 是统一时间戳。`logs` **全量保留**（只存本机，不进仓库），每条 `LogEntry.t` 也是统一时间戳；设置页默认折叠，展开后滚动懒加载，每次 20 条。
- 仓库文件形状：`RemoteRecipes { schema, updatedAt, recipes[] }`、`RemoteOrders { schema, updatedAt, orders[] }`、`RemoteProfiles { schema, updatedAt, profiles }`。另有**图片目录 `images/`**：一张菜谱照片一个文件（`images/<菜谱 id>.<png|jpg|webp>`），不属于这三份 JSON。
- **时间字段统一格式**：所有**记录下来的时间字段**（菜谱收藏 / 更新时间、订单下单 / 更新时间、昵称更新时间、同步日志时间、数据库时间戳）一律写成 `YYYY-MM-DD HH:MM`（如 `2026-10-07 09:40`），由 `helpers.ts` 的 `nowStamp()` / `stamp()` 产出，**必须带年月日**，不能只剩下小时和分钟。`dateKey(d)` 给出 `YYYY-MM-DD`，供「是不是今天」这类比较用。占位符 `—` 表示「还没有这个时间」（如未设昵称的档案）。
- **同步时间多一位秒**：`lastPulledAt` / `lastPushedAt` / 同步状态里的 `lastAt` 用 `nowStampSec()` 写成 `YYYY-MM-DD HH:MM:SS`（如 `2026-10-07 09:40:12`）—— 设置页那行「已同步 · …」得看得出确实又同步过一次，分钟精度常常看不出变化。其余记录时间仍到分钟。

## 3. 本地状态容器（`src/data/store.tsx`）

- 基于 `useReducer`。**唯一写入口**是 `{ type: 'mutate', updater, bumpRev }`，`updater` 作用在 reducer 拿到的**当前** `state.db` 上（不能在 dispatch 前用 ref 预计算，否则连续多次改动会基于同一份陈旧快照互相覆盖）。
- `rev` 计数器：**本地内容改动 +1**；拉取远端不 +1。同步引擎据 `rev !== pushedRev` 判断「有本地改动待推送」。
- 两个提交助手：`commit`（`bumpRev=true`，内容改动 → 会触发推送）与 `commitSilent`（`bumpRev=false`，本机设置：我是谁 / 当前角色 / token / 开关 / 时间戳 / `applyRemote`）。
- 持久化到 `localStorage`，key = `jishiben-db-v1`（**菜谱照片不在这个 key 里**，只存路径；图的字节缓存在 `jishiben-photos-v1`，见 §8）；启动时 `loadDb()` → `migrate()`（v1 单菜订单 → v2 `items[]`；v2 角色槽 → v3 两个人：`orderer`/`cook` 映射为 `a`/`b`、`config.role` → `config.me`、旧订单补 `placedBy`；旧的 `config.nickname` 迁入 `profiles`；补齐字段）。**形状规整（`normalizeOrders` / `normalizeProfiles` / `normalizeRecipes`）每次都会跑，不看 `schema` 版本号** —— 仓库里存量的老结构不等于「缓存版本旧」，只按版本号判断会漏掉。
- 对外 API：`addRecipe`（新菜谱 `orderCount = 0`；可以指定 `id` —— 上传截图时图片路径 `images/<id>.<ext>` 得先定下来；`image` 只记路径，图的字节由 `src/lib/photo.ts` 先落本机缓存，推送时同步引擎再上传）、`updateRecipe`（改菜名 / 原文出处 / 照片 / 备注）、`deleteRecipe`（删菜谱；订单里存的是菜名快照，不受影响；仓库里的照片由同步引擎顺手删掉）、`addOrder`（自动带 `placedBy = me`，可带 `note`；单里每道有菜谱的菜 `orderCount + 1`）、`deleteOrder`（删整张单；内容改动，会触发推送；单里每道有菜谱的菜 `orderCount − 1`，不低于 0）、`setOrderStatus`、`setProfiles`（按人槽改昵称）、`setMe`（切「我是谁」）、`setView`（切「当前角色」→ 底部第二格在点单 / 掌勺之间换）、`joinAs`（首次设置：按名字把本机认领到 `a`/`b` 一格并落昵称）、`setConfig`、`patchConfig`、`disconnect`、`applyRemote`、`setSyncState`。
- 派生状态：`needsSetup = !configured`；`connected = 有 repo 且 有 token`；`me`（本机这个人）；`view`（本机当前角色，缺省 `order`）。
- 业务副作用（写日志、改 `updatedAt`）在对应 action 内完成，例如加菜谱 / 下单 / 改状态 / 改昵称都会 `pushLog(..., 'ok', ...)`。
- `applyRemote` 只在远端**确实给了**某一块时才替换该块，避免拉取冲掉本地并发的配置 / 改动；替换前先用 `normalizeOrders` / `normalizeProfiles` 把老仓库里的旧结构（角色形状的 profiles、单菜订单）规整成当前 schema，否则按 `a` / `b` 取值的地方会在渲染期抛错、整页白屏。

## 4. 同步引擎（`src/lib/useSync.tsx` + `src/lib/github.ts`）

GitHub Contents API：

- `getJson(repo, path, branch, token)`：`GET /repos/{repo}/contents/{path}?ref={branch}`，文件不存在返回 `null`。
- `putJson(repo, path, branch, token, data, message, sha?)`：`PUT /repos/{repo}/contents/{path}`，提交前带上 sha 防冲突。
- `getImage(repo, path, branch, token)` / `putImage(...)` / `getFileSha(...)` / `deleteFile(...)`：同一套 Contents API，读写**仓库里的图片文件**（`images/<id>.<ext>`）。读回来是 data URL + sha；写进去的正文就是纯 base64（不带 `data:` 前缀）。
- `verifyRepo`：校验 token 有效、仓库存在、分支存在（连接向导用）。
- 请求头：`Accept: application/vnd.github+json`、`Authorization: Bearer <token>`、`X-GitHub-Api-Version: 2022-11-28`。
- **每个请求都带 `cache: 'no-store'`**：GitHub 的 contents 接口回的是 `Cache-Control: public, max-age=60`，按默认缓存模式读，一分钟内可能拿到旧正文 + 旧 sha —— 拉取会套用过期数据，写入会拿着过期 sha 撞 409，连「取回新 sha 再重试」也会读到同一份旧的，重试等于白重试（这是点单后控制台刷 409 的根因）。
- **UTF-8 安全 base64**（中文菜名不能用裸 `btoa`）。
- 错误分类 `GithubError.kind`：`auth`(401) / `forbidden`(403，含限流识别) / `notfound`(404) / `conflict`(409 或 422) / `network` / `unknown`，每种都带可直接展示的中文 `message`。
- `withTimeout` 默认 15 秒（`connect` 用 20 秒）。
- `maskToken`、`normalizeToken`（去空白）、`tokenShapeError`（形状校验：前缀 `ghp_`/`github_pat_` 等、经典 token 40 位、混合非法字符）。

同步引擎行为：

- 三份 JSON：`recipes.json`、`orders.json`、`profiles.json`；外加**图片目录 `images/`**（一张菜谱照片一个文件）。
- **照片为什么单独成文件、不塞进 `recipes.json` 的 base64**：contents 接口对**超过 1 MB 的文件不回正文**（`content` 为空，`getJson` 会直接报「太大了」），几张手机截图就能把 `recipes.json` 顶过线，那之后连菜谱都读不出来；而且每改一条菜谱都要把整库图片重传一遍。放成独立文件后菜谱库 JSON 一直是小的，只有新增 / 换图才动图片。读取用 JSON 形态，顺便拿到 sha（删图要用）；单张图压到 800 KB 以内，稳在 1 MB 那条线下面。
- **拉取 `doPull`**：并发拉三份，先规整成当前 schema（老仓库里的角色形状 profiles / 单菜订单），再记下各自 sha 与「已推送内容」快照 —— 快照用规整后的内容，才能与本地入库后的 db 对得上，不会把没变的文件重写一遍；三份都不存在 → 返回 `empty`；否则把远端内容交给 `applyRemote` 合并。传入 `cfgOverride` 以避免 `setConfig` 异步导致读到旧配置。
- **推送 `doPush`**：**先补图片**（`pushImages`，自带 30 秒超时），再逐份比对 `lastPushed`，**只推内容真变了的那一份**（改昵称不会重写菜谱/订单）；推之前手上没有这个文件的 sha 就先读一次（没带 sha 的 PUT 会被 GitHub 判 422 / 409，等于白撞一条失败记录）。遇到 `conflict` 重新读一遍三份 sha 再试，最多两轮；连新 sha 都读不回来就直接报错，不拿旧 sha 空撞第二次。
- **图片的推送规则**：本机缓存里有字节、仓库里还没有的图（先 `getImage` 确认一次）就上传上去；**本机没有字节的图（比如对方那台手机传的）不碰**；上传 / 核对过的路径记在内存里，同一张图不重复传。删掉的菜谱、换掉的旧图会变成「不再被任何菜谱引用的孤儿文件」，推送时顺手 `deleteFile` 清掉（没有 sha 就先 `getFileSha` 读一个，读不到就跳过）。挂载时以「本机 DB 里引用的照片」为这批台账的初值 —— 那些认定为仓库里已有。
- **提交即同步**：`connected` 且 `rev !== pushedRev` 时，700ms 防抖自动推送。
- **后台轮询**：`autoPull` 且 `intervalSec > 0` 时定时拉取；有未推改动或正在忙则跳过本次。
- **`syncNow(options?)`**：有本地改动先推，否则拉；拉到 `empty` 则推；全程更新五态。默认成功弹「同步完成」，传 `{ toast: false }` 则成功不弹（失败照旧弹）—— 给「切屏顺手同步一次」用，那种场景的反馈是底部设置格图标的闪烁。**点底部第二格（点单 / 掌勺）、以及切点单 / 掌勺角色**都会调它顺手同步一次（未连接时什么都不做，不会弹「还没连接仓库」）。
- 普通拉取**不动 `config`**（config 是本机设置、仓库里没有；`storeRef` 可能比当前 state 旧，比如刚切完角色就同步，拿旧 cfg 覆盖会把刚改的 `view` / `me` 抹回去）。只有 `connect()` 才把刚填的配置一起落库（`doPull(cfg, { applyConfig: true })`）。
- **`connect(cfg)`**：`verifyRepo` → `setConfig`（`configured=true`）→ `doPull`；空仓库则把本机内容作为初始内容推送（**本机模式攒下的照片这时一并补传**），返回 `{ seeded }`。连接期间 `suppressAutoPush` 挂起自动推送，结束后把 `pushedRev` 对账到当前 `rev`。
- **`pull`**：只拉取。
- **`disconnect`**：清 `config`、`configured=false`，同步状态置 `off`。
- 拉下来的内容视为「已推送」，避免紧接着又被原样写回，制造噪音提交。

## 5. 分享文案解析、AI 识别（含截图识图）、读原链接、封面与照片（`src/lib/share.ts`、`src/lib/ai.ts`、`src/lib/reader.ts`、`src/lib/photo.ts`）

- **默认不抓页面**：小红书 / B站 / 抖音不返回 CORS 头，浏览器读不到页面内容，所以本地解析只吃用户粘贴的分享文案；配了 AI Key 后识别会额外读一次原链接（见下方「读原链接」，走第三方代理）。
- `extractUrl`：取文案里第一个链接。
- `detectSource`：按域名判断来源（`xiaohongshu`/`xhslink` → red；`bilibili`/`b23.tv` → bili；`douyin`/`iesdouyin` → douyin；否则 generic）。
- `parseShare`：先按 `BOILERPLATE` 去平台固定尾巴（**顺序有意义：长而具体的在前**），去掉链接后 **取最长的一行**，再去话题标签 / 表情；抖音文案会顺手用 `看看【xxx的作品】` 捞作者。
- **只贴一条搜索链接时，用链接里的搜索词当标题**：`searchKeyword()` 认 `keyword` / `search_query` / `query` / `q` / `wd` / `word` 这几个查询参数（B站搜索页、YouTube、百度…）。搜「村驴」得到的 `search.bilibili.com/all?keyword=村驴` 标题就是「村驴」——这是链接里写着的词，不算编造。文案里另有文字时仍以文案为准。
- `ParsedShare` 多一个 `fromSearch`：标题取自搜索词时为 `true`。走 AI 时以模型抽出的菜名为准；模型抽不出（返回空）才会保留这个搜索词，不会被清空。
- **标题只留菜名**（本地解析也一样，`toDishName()`）：拿最长的那行再从第一个分隔标点（`，。！？；、|～—·#‼` 等）截断；**反复剥**掉「保姆级教程 / 保姆级 / 超详细 / 手把手 / 零失败 / 一看就会 / 的（做）教程 / 做法 / 食谱 / 配方 / 合集 / 分享 / 来了 / 视频 / vlog」这类营销尾巴（一条标题里常叠着好几个）；去掉 `‼ ❗` 与不可见的变体选择符；再在「汉字 + 空格 + 说明」处截断（英文名里的空格不受影响），最后裁到 20 字。例：「西红柿炒鸡蛋，你就像我这样做，真的很下饭！」→「西红柿炒鸡蛋」；「酸甜爽脆的腌萝卜保姆级教程来了‼️」→「酸甜爽脆的腌萝卜」。这只是启发式，长而不带标点的句子仍会留长，配了 AI 时由模型兜底。
- **只贴一条链接时不编造标题**，标题留空交给用户手填。
- `guessArt(title)`：按标题关键词（番茄牛腩 / 虾 / 椰子鸡 / 芒果糯米饭 / 三杯鸡 / 芝士蛋糕 / 面 等）匹配一张本地卡通插画；猜错只是示意图。
- 解析结果**永远只是预填**，标题 / 作者 / 来源 / 链接四个字段始终可改。

**AI 识别（`src/lib/ai.ts`，DeepSeek）**
- 设置页填了 DeepSeek API Key 且「识别时使用 AI」开着时，「识别」会走 AI：把同一段分享文案（可再带一段「原链接页面线索」，见下）交给 DeepSeek 的 Chat Completions（`https://api.deepseek.com/chat/completions`，`model=deepseek-flash`，`response_format=json_object`，`temperature=0`，`thinking={type:'disabled'}`），让它抽出 **菜名 / 作者 / 做法 / 小贴士** —— 本地启发式只挑得出标题，做法基本靠这一段。
- **模型是 `deepseek-flash`**（老的 `deepseek-chat` 换成它）：文案识别与**截图识图**用同一个模型。`deepseek-flash` 默认开思考模式，识别这种「照着抄」的活儿显式关掉（`thinking: {type:'disabled'}`）—— 快、省 token，`temperature: 0` 也才真正生效（思考模式下该参数被忽略）。
- **截图识图**：用户传了菜谱截图时，请求体里多一个 `image_url` 内容块（`{ url: <data URL>, detail: 'high' }`），`user` 消息的 `content` 变成「文字块 + 图片块」数组（DeepSeek 识图只支持 user 消息）。提示词约定：**只抄图里真实出现的文字**（菜名 / 作者 / 食材用量 / 步骤 / 小贴士），图里没写的一律留空。截图与文案可以一起给：链接与来源照旧以本地解析为准。
- 提示词要求 `title` **只填菜名本身**（2～12 字、最多 20 字），明确点名去掉「保姆级 / 教程 / 配方 / 分享 / 合集 / 来了」这类营销词，并给了两个例子：「西红柿炒鸡蛋，你就像我这样做…」→「西红柿炒鸡蛋」，「酸甜爽脆的腌萝卜保姆级教程来了」→「酸甜爽脆的腌萝卜」。另外约定：**页面线索若是搜索 / 列表页，就取第一条结果里的菜名**。模型万一还是把整句视频标题丢回来，`normalizeAiRecipe` 会用同一套 `toDishName()` 再收一次（裁 20 字、去书名号、剥营销尾巴）。
- **链接与来源永远以本地解析为准**（`extractUrl` / `detectSource` 按域名判断，比模型稳），AI 只补内容字段；备注不覆盖用户已经写下的内容。
- 提示词明确要求**只抄文案里写到的信息、绝不编造**；抽取结果仍只是预填，四个字段都可手改。
- 请求头 `Authorization: Bearer <aiKey>`；`api.deepseek.com` 会回 CORS 头（实测 preflight 放行 `POST` + `authorization,content-type`），所以和 GitHub 一样浏览器直连，无自建后端。
- 错误分类 `DeepseekError.kind`：`auth`(401) / `balance`(402 余额不足) / `ratelimit`(429) / `badrequest`(400·422，优先展示 DeepSeek 原话) / `server`(5xx) / `network`(超时或连不上) / `format`(返回空内容或非 JSON) / `unknown`，每种都带可直接展示的中文 `message`。
- **AI 失败不阻断识别**：报错 toast 之后保留本地解析的预填结果，用户照样能存。
- 响应解析宽容：`choices[0].message.content` 若是 ```json 代码块或前后带解释，会先剥壳再取第一个 `{…}`；字段名兼容中文（菜名 / 作者 / 做法 / 小贴士），菜名去书名号并裁到 20 字。
- `maskAiKey` / `normalizeAiKey`（去空白）/ `aiKeyShapeError`（`sk-` 前缀、长度、不可见字符）与 GitHub token 那套同思路；`verifyAiKey` 走 `GET /models` 只校验 Key、不消耗对话额度（设置页「测试连接」用）。

**菜谱照片（`src/lib/photo.ts` + `src/components/Photo.tsx`）**
- `photoToDataUrl(file)`：把用户选的截图 / 照片读成 data URL —— 先 `blob.arrayBuffer()` 读真实字节（不依赖 `FileReader`），再用 canvas 压：长边收到 1800px 以内、JPEG 质量逐档从 0.85 降到 0.55，压到 **800 KB 以内**就停。**没有 canvas 2d 的环境原样返回原始 data URL** —— 宁可大一点，也不让「加截图」这条路失败。
- 本机缓存：`jishiben-photos-v1`（`路径 → data URL`），单独一个 key、带 3 MB 总量上限，**不塞进主库 `DB`**；超配额时从最早的丢起，用到的图再从仓库取。
- `useRecipePhoto(image, { fetch })`：缓存优先；`fetch: true`（详情页 / 菜品详情那种一次只显示一张的地方）没缓存就去仓库 `getImage` 取一次并写回缓存，取不到就静默退回插画。**`fetch: false`（列表 / 缩略图那种成批出现的地方）只看缓存、绝不发请求** —— 一屏几十条菜谱、每条都拉一张几百 KB 的图，手机流量受不了；想让它显示照片，进一次详情页缓存下来就行。
- `Cover`：照片 → 本地插画 → 标题首字三级兜底（`Thumb` 也走它）。

## 6. 路由与身份（`src/App.tsx`、`src/components/TabBar.tsx`）

- `HashRouter`；`AppShell`（StoreProvider + ToastProvider + SyncProvider + ErrorBoundary + Routes）可脱离 Router 单独挂载，便于测试。`ErrorBoundary` 包住路由：屏内渲染抛错时显示兜底页（人话 + 原始报错 + 重新加载），而不是整页白屏。
- 路由表：
  - `/setup` 首次设置（`needsSetup` 时，其余受保护路由一律重定向到它）。
  - `/` 固定回菜谱库（两人都能点单也能掌勺，不再按身份分叉）。
  - `/library` 菜谱库、`/recipe/:id` 详情、`/add` 添加、`/order` 点单、`/cook` 今日菜单、`/sync` 同步。
  - `*` → `/`。
- **手机返回键（Android 物理返回键 / 手势返回）由 `src/lib/back.tsx` 的 `BackGuard` 统一接管**：决策顺序固定为 **先关遮罩 → 当前屏是一级页就直接 `App.exitApp()` 退出应用 → 二级页有来路就回上一屏（深链进来没来路则落回菜谱库）**。真机接的是 `@capacitor/app` 的 `backButton` 事件（见 §11，约束见 `AGENTS.md` §9）。
  - **一级页 = 底部四格（菜谱库 / 点单 / 掌勺 / 设置）+ 首次设置**（`ROOT_PATHS` / `isRootPath()`）。它们上面按返回一律退出应用 —— **一级页之间不互相回退**：从设置、点单、菜谱库按返回都是回桌面，不会退回「上一次用过的一级页」。四格之间换屏因此走 `replace`（`TabBar` / `RoleSwitch`），不往历史里叠条目。
  - 遮罩 = 用 `useBackClose(open, close)` 登记过的那层（菜谱库长按删除提示、今日点单 / 今日菜单长按删除提示、掌勺的菜品详情、**添加页与菜谱详情里点开的照片大图**），按返回先收它、不退屏。
  - 二级页 = `/recipe/:id`、`/add`。「页内返回栈」按路由 push / pop / replace 记台账：**二级页必须靠 push 进入**，所以它们上面按返回都回上一屏而不是退出应用。
  - 二级页的「返回」按钮与「保存 / 删除」后的收尾走 `usePageBack(兜底路由)`（`src/lib/back.tsx`），与物理返回键同一套判断，也保证返回键不会退回到一张已经交掉的表单。
  - 网页端（PWA）不接管：`Capacitor.isNativePlatform()` 为 false 时返回键交给浏览器自己。
- **底部导航 4 格**：`[菜谱库] [点单 / 掌勺] [＋添加] [设置]`（第四格路由仍是 `/sync`，只是入口叫「设置」）。第二格跟着**本机当前角色**（`config.view`）走：角色是点单 → 第二格「点单」（`/order`）；角色是掌勺 → 第二格「掌勺」（`/cook`）。**点这第二格会顺手 `syncNow({ toast: false })` 同步一次** —— 进到点单 / 掌勺时看到的单子应该是最新的，不必等下一次轮询。角色**不绑在人身上**，只决定这格指向哪块屏；切角色的入口就贴在第二格那块屏（点单 / 掌勺）的**右上角**（`RoleSwitch`，紧凑的「点单 | 掌勺」贴纸开关），切完顺手跳到对应那屏，**并同样顺手同步一次**；角色本身是本地设置、不触发推送（同步那一趟只拉，不写仓库）。**掌勺那边还有没做完的单时**（对方点的、状态不是 `done`），开关右上角挂一枚数字红点（数字就是单数，超过 99 显示 `99+`），停在哪块屏都看得见。四格之间换屏走 `replace`（中间那格「＋添加」是二级页，仍走 push），理由见下条。
- **「设置」格的图标就是同步指示灯**：已同步（`ok` / `idle`）→ 图标绿色；同步失败（`err`）→ 图标红色；**同步中（`busy`）→ 图标高亮成 accent 色、整体一闪一闪（`syncblink`）、图标自己转圈（`odspin`）**，同步结束就回到绿；未连接（`off`）保持默认色。同步状态只在这枚图标和**设置页的五态面板**上体现，其他屏（菜谱库 / 点单 / 掌勺）不挂任何顶栏 pill；设置页顶栏也**不再挂「已同步」标签**（跟下面的面板重复）。系统开了「减少动态效果」时不做闪 / 转（见样式表里的 `prefers-reduced-motion`）。
- 角色与「我是谁」各管一摊：`config.view` 决定底部第二格；`config.me` 决定每块屏上「我 / 对方」是谁。两台设备可以一个选点单、一个选掌勺，数据仍共用同一份（`placedBy` 方向才是真相）。
- 屏的「谁在说话」由**本机这个人**（`config.me`）决定：点单屏是「我」下单、对方掌勺；今日菜单是「对方」点的单、我来做（见 `src/data/useNames.ts`）。
- 昵称显示规则：`nicknameOf(profiles, person)`，没设过退回中性称呼「我 / 对方」，不显示空白。
- 已移除走查参数 `?view=cook|orderer`（不再有按身份分叉的视角）。

## 7. 界面逐屏功能（`src/screens/`）

**通用输入行为（`src/lib/inputs.ts`）**
- `preserveTypedValue(apply, onBlurExtra?)` 返回 `onCompositionEnd` / `onBlur` 两个处理器，都在关键节点拿输入框 DOM 里的**真实值**同步一次 state。
- 为什么需要：手机浏览器 / Android WebView 上，输入框的最终内容未必会补一次 `input` 事件 —— 中文输入法提交候选词时可能只发 `compositionend`，键盘的自动更正 / 自动填充也可能直接把值落进 DOM。React 的受控 `value` 因此拿不到刚打进去的字，失焦时还会把 DOM 回写成 state 里的旧值：表现为「刚填完，一失焦内容就没了」，或界面看着有字但点保存写回去的是旧值。
- **全应用所有文本输入框都挂着它**：菜谱库搜索、点单手动加菜、添加菜谱（分享文案 / 标题 / 作者 / 链接 / 备注）、详情页备注、首次设置的配置 JSON 与全部字段、同步页的 token 与昵称。`apply` 与该框 `onChange` 的写法保持一致（`trimStart` / `normalizeToken` 等一并带上），`onBlurExtra` 用来保留原有的失焦校验（如昵称 1–12 字、token 形状校验），不会把输入框自己的校验顶掉。
- 新增文本输入框时**必须**带上它，否则该框在手机输入法下会丢字（见 §12）。

**长按与选中（`src/styles/app.css` + `src/lib/gestures.ts`）**
- **整页默认不许选中文字**：`app.css` 顶部对 `*` 关掉 `user-select`（含 iOS 的 `-webkit-touch-callout`，长按不弹「拷贝 / 查找」气泡），`img` 关掉 `-webkit-user-drag`。因为这个 App 在手机上用，长按是「删除」手势（见 §7 菜谱库 / 点单 / 掌勺），不是选字。
- **输入框例外**：`input` / `textarea` / `[contenteditable='true']` 重新允许选中，选词、移动光标、粘贴都不受影响。
- **长按的系统菜单也拦掉**：`gestures.ts` 的 `installLongPressGuard()`（`AppShell` 挂载时装一次，见 §6）拦下整页的 `contextmenu` —— 不然在 Android WebView 里长按一条菜谱（`<a>` 行）会先冒出系统的链接菜单，挡着我们的删除气泡。`keepsNativeLongPress(target)` 是纯函数：落在输入框 / 可编辑区里的放行，其余一律拦。
- 新增可长按的条目时不用再做别的，全局那层已经盖住；但如果将来加了 `contenteditable` 区域，记得它会绕过上面这套（属有意放行）。

**Setup 首次设置**
- 四步说明（建空仓库 → 填你和另一半的昵称 → 生成 contents 读写 token → 填 token + 仓库连接）。
- 「导入配置」折叠区：粘贴另一半发来的 JSON（字段 `nickname` / `partnerNickname?` / `token` / `repo` / `branch` / `intervalSec` / `aiKey?`）填充表单，含字段校验。
- 字段与校验：我的昵称 1–12 字；另一半昵称可留空、≤12 字；token 形状校验（`autoCapitalize=none` / `autoCorrect=off` 防手机键盘改写）；仓库须为 `owner/repo`；分支非空。全部输入框走 `preserveTypedValue`（见「通用输入行为」），失焦校验读的是输入框里的真实内容。
- **「高级设置」里还有可选的 DeepSeek API Key**（`#fAiKey`，`sk-` 形状校验，同样关掉自动大写 / 更正）：留空不填就是纯本地解析文案，填了识别就能走 AI；两种都允许连接。填了就随 `setConfig` 一起落到本机 `config`（`aiKey` / `aiKeyMask` / `aiOn=true`），JSON 导入也认 `aiKey`（给了但形状不对会拦下来）。连上之后想改还是去「设置」页。
- 不再选「点菜方 / 掌勺方」。连上仓库后由 `joinAs` 按名字把本机认领到 `a` / `b` 中的一格（本机默认槽已被别人占用时自动换另一格），之后可在设置页改「我是谁」；本机角色（`config.view`）默认是「点单」，在点单 / 掌勺屏的右上角切换。
- 「连接并拉取」→ `sync.connect`；失败时**报错横幅位于提交按钮正上方**（`role=alert`），并按 `GithubError.kind` 给出针对性提示（尤其说明「私有仓库无权限访问时 GitHub 一律回 404」）。
- 「稍后再说（本地模式）」：不连仓库，仅本机使用（需昵称）。
- 连接成功视图：显示 `seeded` 说明、仓库 @ 分支、首次拉取的菜谱/点单条数、开始使用按钮。

**Library 菜谱库**
- 顶栏：日期问候 + 「我的菜谱库」。**同步状态不在这屏显示**（只在设置页与底部「设置」格图标上体现，见 §3 / §7）。
- 搜索框（标题 / 备注 / 作者，子串匹配），有词时显示「找到 N 道」与清除按钮。
- 来源筛选 chips（全部 / 小红书 / B站 / 抖音 / 手动），带计数；数量为 0 的来源不显示。
- **排序条**（有菜谱时才出现）：`排序 [默认] [点单次数] [更新时间]` + 一个方向按钮（`升序` / `降序`，切字段时保留当前方向；选「默认」时不可点）。「默认」= 收藏先后（新加的在前，即 `db.recipes` 的原顺序）；「点单次数」按 `orderCount` 数值排；「更新时间」按 `updatedAt` 的字符串排 —— 时间戳统一是 `YYYY-MM-DD HH:MM`，按字符串比就是按时序比。两种排序都支持升序与降序。
- 进场 520ms 骨架屏。
- 五态：加载 / 错态（`?state=error` 或同步失败且无数据）/ 空态（无菜谱）/ 无搜索结果 / 列表。列表行为缩略图（**有缓存就显示用户传的照片**，否则退回插画或首字 —— 列表不为了缩略图去拉图，见 §8）、标题、来源徽章 + **「点过 N 次」**（该菜的点单次数，没点过显示 0 次）、备注 —— **不显示时间**（收藏 / 更新时间只在详情页看）。**列表行走紧凑布局**（56px 缩略图 + 8px 上下内边距，`src/styles/app.css` 的 `.dishrow` / `.thumb`，骨架屏 `.sk-row` / `.sk-thumb` 同尺寸），一屏能多放几条菜。
- **长按一条菜谱 → 弹出删除气泡**：气泡贴在**条目的右上角**（右对齐、浮在条目上方），左下角伸出一个尖角指向条目；上方放不下时翻到条目下方、尖角跟着朝上。里面是带删除图标的「删除」按钮，点一下直接删（同时 toast + 写同步日志）；点别处 / 滚动列表收起。长按后紧接着的那次 click 会被吞掉，不会顺带跳进详情页；普通点按仍然是进详情。手机返回键也先收起这个提示，而不是退出应用（见 §6）。菜谱库 / 今日点单 / 今日菜单三处共用同一个气泡组件 `src/components/DeleteTip.tsx`。
- **这一行长按有两条触发路**（别的长按目标只有第一条）：① `pointerdown` 后 450ms 的定时器（鼠标长按、以及系统没插手的手势）；② 触摸时的 `contextmenu` —— Android 上长按 `<a>` 走的是**系统的链接长按**，平台可能先按它自己的「按住时长」把指针序列取消掉（用户把无障碍里的按住延迟调短时尤其常见），我们的定时器就永远等不到。系统长按会补一个 `contextmenu`，这里把它接住弹同一个气泡；只有 `pointerType === 'touch'` 才算，**鼠标右键不弹**。

**RecipeDetail 菜谱详情**
- 480ms 骨架屏；封面**优先用菜谱照片**（本机没缓存就去仓库取一张，取到了写回缓存），没有照片才退回插画或标题首字占位。
- **点照片看大图**：有真人上传的照片时，封面整块是个按钮（右下角带一个放大标记），点开弹 `PhotoViewer` —— 整屏压暗 + 居中原图（`object-fit: contain`，右上角白 ×）。点遮罩 / 点 × / 按 Esc / 按手机返回键都能关，返回键是 `useBackClose` 登记的那层遮罩，先关它、不退屏（见 §6）。插画是示意图，不给点。
- 元信息行：来源徽章、作者（**没作者就不显示这一格**）；标题；标题下面是「收藏于 <createdAt> · 更新于 <updatedAt>」（**这两个时间只在这一页显示**，列表页不显示时间）。
- 原文出处卡片：显示 `url` 并有「查看原文」外链。
- 编辑：顶栏右上角「编辑」→ 表单里可改**菜名 / 原文出处 / 菜谱照片 / 做法 / 我的备注**（菜名必填，清空则拒绝保存并 toast），「保存并同步」→ `updateRecipe` + toast。**两个人谁都能编辑**。
- **照片那一栏**（`.photofield`：84px 预览 + 「上传截图 / 换一张」+「移除照片」）：选图就地压成 data URL 预览；保存时**换图会给新图片一条新路径**（`images/<新 id>.<ext>`）、旧图由同步引擎在推送时从仓库删掉，「移除照片」则把 `image` 置空、退回本地插画。草稿里记的是「原路径 / 新 data URL / 空串」三者之一，没动过就保持原路径、不重传。
- 做法卡（有内容才显示）：按换行原样展示 `steps`。
- 备注卡：查看态展示「我的备注」（没写时给引导文案）。
- **删除**：内容区末尾的「删除这道菜」需二次点击确认（第一次变成「再点一次，确认删除这道菜」），确认后 `deleteRecipe` + toast 并离开这一页（回上一屏，回不去时落到菜谱库）。
- 顶栏左上角返回按钮（`aria-label=返回上一屏`）与手机返回键同一套判断：能页内回退就回退，否则落到菜谱库（`usePageBack`，见 §6）。
- 底部 CTA「去点单 · 带上这道菜」**对谁都常驻**（谁都能点单）；若该菜已在未完成单里则按钮禁用并显示「去点单查看」链接。找不到菜时显示占位卡。

**AddRecipe 添加菜谱**
- 版式：**两块卡片 + 一条底部操作栏** —— 上面「贴链接 / 传截图 → 识别」，下面直接就是这条菜谱本身，最底下「保存并同步」。识别结果直接落进下面的字段（不再单开一块「解析结果」预览），字段一直摆着、**不折叠、不按状态显隐**，用户随时知道自己在填什么；界面上不再写「这段文字是干什么的」那种段落，能靠按钮文案和 placeholder 说清楚的就别加说明（原来那几行「AI 识别已开启…」「会先打开原链接补作者…」「解析出来的标题会填到下面」全删了）。
- 输入区（上面那张卡）：`#shareInput`（textarea，placeholder「粘贴小红书 / B站 / 抖音的分享链接或文案」，`Ctrl/Cmd+Enter` 也能触发识别）+ 一行两个按钮：左边虚线次要按钮**「传张截图」**（`#photoInput`，`accept="image/*"`，真机上就是系统相册 / 相机选择器；选了图之后变成「换张截图」，旁边多一个圆形 `×`「移除截图」），右边主按钮**「识别」**（配了 Key 是「AI 识别」，有截图是「AI 识图」，识别中显示 spinner）。**只有没配 Key 时**才在卡片底部挂一行小字提示去设置里填 Key。
- **没有「手动添加」按钮**：手填就是直接填下面那张卡（原来「先点手动添加才展开手填区」那层操作去掉了）。
- **点封面看大图**：选了截图之后，菜谱卡的封面是个按钮（`aria-label=查看大图`），点开弹 `PhotoViewer` 看原图；点遮罩 / 点 × / 按 Esc / 按手机返回键都能关，返回键是 `useBackClose` 登记的那层遮罩，先关它、不退屏（见 §6）。没选截图时封面是插画 / 首字，不给点（示意图放大没意义）。
- 菜谱卡：封面（有截图就显示截图，否则按菜名猜插画、再否则首字）+ **菜名**（必填，字号比别的字段大）+ 做法 + 作者 / 来源 + 原文链接 + 一条分隔线 + 备注。
- **来源不用识别时硬写**：`source = 用户在下拉里挑过的 ?? 按链接 / 文案域名认出来的 ?? 「手动」`。所以只贴小红书链接就是「小红书」，只传截图是「手动」，手写也是「手动」；下拉选项文案与列表徽章一致（手动 / 网页 / 小红书 / B站 / 抖音）。
- **截图这条路**：选完图先压成 data URL 并显示在菜谱卡的封面上，**配了 Key 的话顺手自动识一次图**（toast「截图收到了，AI 正在识图…」），把图里的菜名 / 作者 / 食材 / 步骤读进字段；没配 Key 也能加截图，只是识图没有、菜名自己填（toast 提示去设置里填 Key）。
- **「识别」按设置分两路**：填了 Key 且开着 AI → 先本地解析打底（链接 / 来源），再请求 DeepSeek 补菜名 / 作者 / 做法 / 小贴士（有截图就把截图一起给它），过程中按钮转 spinner（禁用防连点）；没配 Key 或关掉 AI → 只跑本地启发式解析。AI 失败会 toast 原因并保留本地解析结果。
- **识别时会先读一次原链接**（只要走 AI、且文案里有链接）：先经 `r.jina.ai` 抓页面、压成「页面线索」，再连同文案一起交给 AI —— 作者 / 账号主要靠这一步补；抓不到就静默退回只按文案识别，不打断（这一步不写成界面说明）。
- 解析只是预填：菜名 / 做法 / 作者 / 来源下拉 / 原文链接 / 备注 都能改。**作者留空就真的存空串** —— 详情页、菜品详情那一行没作者就不摆那格（以前会兜一句「来自剪藏」，手写 / 截图识图来的菜谱根本没有剪藏这回事，是假出处；`normalizeRecipes` 会把存量数据里这句占位一并清成空串）。
- **保存**：按钮一直可点（不再因为没菜名就变灰）；点了没菜名会当场把「菜名」标红并 toast「先给这道菜起个名字」，不会存半截数据。保存中显示 spinner，成功后离开这一页（回上一屏，回不去时落到菜谱库）—— 存完的添加页不留在返回栈里，按返回不会退回一张已经交掉的表单。顶栏返回按钮（`aria-label=返回上一屏`）与手机返回键同一套判断（`usePageBack`，见 §6）。
- **备注那一栏用「编辑这道菜」里同一套字段样式**：`.field` 包一个 `<label for="noteArea">备注</label>` + `<textarea id="noteArea">`，样式（小标题字号 / 颜色、圆角输入框、`min-height: 92px`、聚焦描边）全部来自共用的 `.field` 规则，不要再写内联样式硬撑高度 —— 两边改一处就一起变。
- 手写时链接可以留空 —— 那就只存菜名 / 做法 / 备注，来源记「手动」。


**Order 点单**
- 午 / 晚餐切换（segmented）。
- 顶部组合器：已选菜 chips（点 × 移除）、**「给掌勺的话」备注输入**（可不填，≤30 字，发送时去掉首尾空格、发送后清空）、发送按钮（无选菜禁用）。发送按钮文案含「发给<对方> · 午餐/晚餐 · N 道」。备注随这一单落库，掌勺屏会以「少放辣」那种提示条显示。
- 从菜谱库多选网格（选中态打勾）：**每张卡片只露缩略图与菜名，不显示来源平台**；网格上方是一个**搜索框**（搜菜名 / 备注 / 作者，与菜谱库同一口径），有词时提示「找到 N 道」并给清除按钮，没命中就换成「没找到「…」」的空态卡（可一键清除搜索）；菜谱库一道菜都没有时不摆搜索框，只留「去添加」引导。搜索只影响这一屏的挑选网格，不改变已选。「随机加一道」（从没选的菜里随机，挑完给提示）。
- 手动输入临时菜（≤18 字，去重，`recipeId=null`）「加进这顿」。
- 「今日点单」只列**我点的、下单日期是今天的单**（`placedBy === me` 且 `isTodayOrder`，按时间戳的日期部分判断）。每张单可展开看每道菜（缩略图 + 菜名 + 来源）、给掌勺的话、状态 chip、以及「<对方>回传状态后自动更新」提示；已完成单显示「<对方>已做完这顿」。**卡头那行摘要（`orderSummary`）按两行截断**（`.s-order .osum .ob .t` 用 `-webkit-line-clamp: 2`）—— 剪藏来的单标题可能是一整句视频标题，不截就会溢出卡片、压住右边的展开箭头。**长按一张单 → 弹出删除气泡**（同菜谱库那套，见上：贴在条目右上角、左下角尖角指向条目；短按仍是展开，长按后那次 click 被吞掉），点「删除」直接删掉这一单。
- 「历史点单」把我点的其余单（昨天及更早）收进一条折叠条，默认折叠、只显示数量（`N 份`），点一下才逐张铺开；展开后的单同样支持长按删除。
- 支持 `?add=<recipeId>` 从详情页预选一道菜（处理后会从 URL 移除该参数）。
- 空态：还没有订单时给引导文案。

**CookToday 今日菜单**
- 只列**对方点的单**（`placedBy !== me`）。顶栏显示「我」的名字与「<对方>点给你的几道菜 · 长按卡片可删除」。
- 未完成单卡片：午/晚餐、道数、下单时间、状态 chip、每道菜、备注；主动作按钮 `pending → 接下这顿`，`accepted → 全部做好了`（点击后 600ms 回传状态并 toast）。**长按卡片头部（标题 / 状态那一行）→ 弹出删除气泡**（同上），点「删除」删掉这一单（今日菜单与「已做完」里的都能删）。
- **点卡片里的一道菜 → 弹出菜品详情**（`DishSheet.tsx`）：大图（**有照片就显示照片**，没缓存会去仓库取一张） / 首字占位、来源徽章 + 作者 + 更新时间、菜名、这道菜的「我的备注」（只读）、「查看原文」外链。点遮罩、点右上角 × 、按 Esc 或按手机返回键关闭（返回键先关这层，不退屏，见 §6）。点单时临时手输的菜（菜谱库里没有）只给菜名 + 一句说明，不给原文链接。
- 「已做完」收进一条折叠条，默认折叠、只显示数量（`N 份`），点一下才逐张铺开完成单；完成单上显示「做完啦，<对方>已收到」。
- 底部提示按 `autoPull` / `intervalSec` 显示「每 N 分钟自动拉取」或「仅手动同步」。
- 空态：今天还没人点单。

**Sync 同步与仓库**（底部入口名「设置」）
- 五态状态面板：未连接 / busy（同步中）/ err（失败，含重试 + 重新填写 token）/ ok（标题行「已同步 · <精确到秒的时间>」+ 文件条数）。面板状态下有「立即同步」。
- 「当前角色」切换**不在这一页**：它贴在点单屏 / 掌勺屏的右上角（见 §3 底部导航）。只改本机 `config.view`，底部第二格随之在「点单 / 掌勺」之间换、并顺手跳到对应那屏；本地设置、不触发推送。两台设备各选各的。
- 仓库信息：**当前仓库与分支在同一行**（仓库名 `owner/repo`，太长就省略号截断；分支做成右边一枚小标签，永远露出来）、Token（掩码 + 修改，含形状校验）。
- **AI 识别（DeepSeek）**：Key（掩码 + 修改，含 `sk-` 形状校验）、「识别时使用 AI」开关（没 Key 时禁用；保存 Key 后自动打开）、「测试连接」（走 `GET /models`，成功 / 失败各给一行结果）。Key 只存本机 `localStorage`（同 token 语义，不进仓库、不外发）；「清除」会把 Key 清空并把开关关回本地解析。
- 后台自动拉取开关（读 `autoPull` / `intervalSec`）。
- 昵称编辑：我 / 另一半两个名字都能改，保存后随仓库同步；清空表示未设置。输入框同样走 `preserveTypedValue`（见「通用输入行为」）。
- 「我是谁」切换（本机是 `a` / `b` 中的哪一位），只改本机身份、随即对调页面上的称呼（不再决定底部菜单）。
- 最近同步日志：**全量保留**（不再截断），默认折叠成一个「最近同步」折叠条（右侧显示总条数）；展开后列表固定高度可滚动，滚到底自动再加载 20 条，给出「已显示 N / 总数」与「已全部加载」提示；err 高亮。
- 已连接时提供「断开并清除本地缓存」（需二次点击确认）；未连接时提供「去首次设置」。

## 8. 组件与样式（`src/components/`、`src/styles/`）

- `Icons.tsx`：内联 SVG path 图标库（逐条转写设计原型）。
- `Bits.tsx`：`SkeletonRows`、`SourceBadge`、`StatusChip`、`Thumb`（转交 `Cover`）、`StateCard`、`StorageWarning`（浏览器不让存本机数据时的提示条，挂在首次设置页与设置页，见 §12）。
- `Photo.tsx`：`useRecipePhoto(image, { fetch })`（缓存优先，必要时去仓库取一张，见 §5）+ `Cover`（照片 → 插画 → 首字三级兜底）。`PhotoViewer.tsx`：点封面弹的看大图遮罩（点遮罩 / × / Esc / 返回键关掉）。菜谱库 / 点单选择网格的缩略图、点单与今日菜单卡片的小图、掌勺菜品详情、详情页封面都走它。相关样式：`.photofield` / `.pthumb` / `.pempty` / `.pacts`（详情页编辑照片那栏）、`.hiddenfile`（藏起来的 file input）。
- `Toast.tsx`：Toast 容器（约 1.7s 显示，最多同时 3 条）；`ErrorBoundary.tsx`：渲染期异常的兜底页（见 §6）。
- `DeleteTip.tsx`：长按条目弹出的删除气泡（`anchorDeleteTip()` 算位置、`DeleteTip` 出界面）。贴在条目右上角、左下角尖角指向条目，上方放不下就翻到下方；菜谱库 / 今日点单 / 今日菜单共用。
- 顶栏同步 pill（`LiveSyncPill.tsx` / `Bits.SyncPill`）**已移除**：设置页顶栏只留标题，同步状态由顶栏下面的五态面板 + 底部「设置」格图标承担（见 §6）。
- `TabBar.tsx`：底部导航（`[菜谱库][点单 / 掌勺][＋添加][设置]`，第二格读 `config.view`）+ `usePreviewState`。`RoleSwitch.tsx`：贴在点单 / 掌勺屏顶栏**标题行右端**的角色开关。原 `DaySwitch.tsx` 的页内切换已移除 —— 角色切换现在就在第二格那块屏上。
- **四个一级页共用同一套顶栏**：`header.topbar > p.greeting + div.navrow > h1.ptitle`（菜谱库 / 设置就是这两行；点单 / 掌勺只在 `navrow` 右端多挂一枚 `RoleSwitch`）。所以日期行的位置、日期到标题的间距、标题字号（统一由 `.ptitle` 给，单页不再用内联 `font-size` 改小）四屏完全一致；曾经那层把开关单独放一行的 `.toprow` 已删除 —— 它会把标题整体顶下去、跟另外两屏错位。
- `src/lib/back.tsx`：手机返回键的接管层。`BackGuard`（包住 `Routes`，见 §6）负责接线与决策，`backAction()` / `trackHistory()` / `isRootPath()`（配 `ROOT_PATHS`，一级页名单）是纯函数，`useBackClose(open, close)` 给遮罩层登记「返回键先关我」，`usePageBack(fallback)` 给二级页的返回按钮 / 保存、删除收尾用，`pressBack()` 是统一入口（真机由 `@capacitor/app` 的 `backButton` 事件触发，冒烟测试直接调它）。
- `src/lib/gestures.ts`：长按手势的统一处理（不让长按选中文字 / 弹系统菜单），`keepsNativeLongPress()` 是纯函数、`installLongPressGuard()` 在 `AppShell` 里装一次（见 §7「长按与选中」）。
- 样式：`src/styles/app.css`（设计系统 token + 卡通组件，移植自原型 `shared/app.css`）+ `src/styles/screens.css`（按 `.s-xxx` 作用域）。`npm run classes` 对账 TSX 用到的 class 在样式表里都有定义。**布局约束**：`.app` 是固定高度（`100dvh`）的纵向 flex，只让 `.scroll` 伸缩；顶栏、搜索框、筛选 chips、底部导航这些固定区域都要写 `flex: 0 0 auto`，否则内容一长（比如菜谱变多、列表溢出视口）它们会被一起压扁，间距跟着数据量变。
- 刻意保留：`.h3` **故意未定义**（原型如此，用于维持观感）。

## 9. 演示 / 走查参数

- `?state=empty`：预演空态（菜谱库 / 点单 / 今日菜单）。
- `?state=error`：预演错态（菜谱库）。
- 例：`http://localhost:5173/#/library?state=empty`。

## 10. 命令与验证（`package.json`）

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（HMR），监听所有网卡（`host: true`）便于手机访问；端口固定 `5173`（`strictPort`，被占用直接报错，不偷偷换端口 —— 换端口 = 换来源 = 看不到原来存的本机配置） |
| `npm run build` | `tsc -b` + Vite 生产构建到 `dist/` |
| `npm run preview` | 预览构建产物（`http://localhost:4173`） |
| `npm run typecheck` | 只跑 TypeScript 检查 |
| `npm run classes` | TSX 用到的 class 与样式表对账 |
| `npm run smoke` | jsdom 冒烟测试：渲染层 + 交互层 + 纯函数 + 同步引擎（真实挂载、真实点击、stub 网络；定时器走虚拟时钟，不空等挂钟） |
| `npm run check` | `typecheck → classes → smoke → build`，提交前跑 |
| `npm run test:live` | 对真实 GitHub 仓库跑同步自检（**会真的写仓库**；需要环境变量 `JISHIBEN_REPO` / `JISHIBEN_TOKEN`） |
| `npm run test:connect` | 端到端跑一遍首次连接（真填表真点击真网络，不写入仓库） |
| `npm run icons` | 重新生成 PWA 图标（纯 Node 写 PNG） |
| `npm run apk` | 写版本号（`scripts/set-version.mjs`）→ 构建 Web → `cap sync android` → `gradlew assembleDebug` |
| `npm run apk:release` | 同上，出 release 包 |

测试防护是强制约束（见 `AGENTS.md` §5）：**每个功能都要有对应测试，功能变更必须同步新增 / 调整测试**。冒烟测试（`scripts/smoke.tsx`）分九段（编号一～八，外加一段手机返回键）。`scripts/register-dom.mjs` 里把 `HTMLCanvasElement.prototype.getContext` 固定成 `null` —— 等价于「这台设备没有 canvas 2d」，图片压缩据此走兜底分支，也免得每张图都刷一屏 jsdom 的「Not implemented」日志。

- 观感一致性：逐个挂载 `/library` `/order` `/cook` `/sync` 断言四个一级页共用同一套顶栏（`greeting` + `navrow > ptitle` 两个子元素、没有多余的开关行、标题字号不被单页内联改小，点单 / 掌勺的 `RoleSwitch` 挂在标题行右端）；菜谱库列表行的紧凑尺寸（56px 缩略图 / 8px 行内边距 / 骨架屏同尺寸）、点单挑选网格（不显示来源平台、按菜名·备注·作者搜索、清除搜索、搜不中给空态卡、已选不受搜索影响）、**今日点单卡片的超长标题按两行截断**（整句留在 DOM 里、不再挂对内联盒无效的 `.ellip`）也各有断言 —— 布局尺寸与截断规则同样静态读样式文件钉住（冒烟里样式表是空的）。
- 渲染层：路由重定向、各屏内容断言、底部导航 4 格（第二格随 `config.view` 在点单 / 掌勺之间变）、详情 CTA 常驻 / 禁用态、空态 / 错态（`?state=error`）/ 本地模式、老缓存 v1→v2 与 v2→v3 迁移、schema 已最新但 profiles 缺格的脏缓存、添加页备注与详情编辑备注都挂在 `.field` 里（label + textarea、不带内联样式），保证两处表单样式一致；同步中图标的 `sync-busy` 闪 / 转是静态读 `src/styles/app.css` 断言的（冒烟里样式表是空的），连 `prefers-reduced-motion` 里关掉动效那条一起钉住。
- 点单次数与菜谱库排序：下单后单里每道菜 +1（没点的不动、临时菜不计）、删掉那张单退回且不为负；菜谱库有排序条、列表行显示「点过 N 次」、默认保持收藏先后、点单次数升 / 降序、更新时间升 / 降序、方向按钮文案跟着变；`normalizeRecipes` 给缺字段 / 负数补 0；种子菜谱的次数与种子订单对得上。
- 长按不选字：`keepsNativeLongPress()` 对输入框 / `contenteditable` 放行、普通元素与拿不到目标时拦下；真实挂载后派发 `contextmenu`，菜谱条目上被 `preventDefault`、搜索框里不被拦；再静态读 `src/styles/app.css` 断言「整页 `user-select: none`、输入框 `user-select: text`、带 `-webkit-touch-callout: none`」没被删掉（冒烟里样式表是空的，CSS 只能读文件验）。
- 交互层：点单组合器（多选 / 手动 / 去重 / 随机 / 长度上限）、点单备注（随单落库、去掉首尾空格、发送后清空）、掌勺状态回传、菜谱编辑（菜名 / 原文出处 / 做法 / 备注一起落库、菜名必填）、时间显示（列表无时间、详情显示收藏 / 更新、改完只动更新时间、缺 `createdAt` 的老数据用 `updatedAt` 顶上；**记录时间都必须带年月日**——`nowStamp()` / `dateKey()` 的格式、示例数据里每条记录时间、新下单与新改昵称的时间戳都断言含 `YYYY-MM-DD`；**同步时间精确到秒**——`config.lastPulledAt` / `lastPushedAt` 断言是 `YYYY-MM-DD HH:MM:SS`）、添加菜谱（粘贴识别：小红书 / B站 / 只贴链接，**标题只留菜名**；**手写：没有「手动添加」按钮，字段一直摆着直接填，来源默认「手动」**，做法落库并在详情页展示、列表能按「手动」筛；**没菜名就点保存 → 当场标红「菜名」并 toast，不落半截数据，保存键不再因为没菜名变灰**；版式上断言「先贴链接 / 传截图、再填菜谱本身」的顺序，以及输入区没有那几段说明文字）、**AI 识别（配 Key → 按钮变「AI 识别」、真的只调一次 DeepSeek 且带 Bearer、用的是 `deepseek-flash` 且 `thinking.type === 'disabled'`、AI 的菜名 / 作者 / 做法 / 小贴士填进表单、链接与来源仍走本地解析、结果能一路存库；Key 失效 → toast 原因并回退本地解析；AI 关掉 → 完全不请求 DeepSeek；设置页填 / 存 / 清除 Key 与 AI 开关）**、**上传截图识图（往真正的 file input 里塞一张假图 → 选完自动识图、请求体里带 `image_url` 内容块且就是那张图的 data URL、识图结果填进字段、只给截图时来源记成「手动」、按钮变「换张截图」且多出「移除截图」、**封面上那张截图点开就能看大图（点 × / 点遮罩关掉且人还在添加页）**、没选截图时封面不套这个按钮、没配 Key 也能连图一起存下来；截图用 data URL 直接显示在封面上）**、**没作者的菜谱不编出处（详情页不出现「来自剪藏」、也不留空的位置；掌勺的菜品详情没作者时不留孤零零的分隔点；`normalizeRecipes` 把老数据里的这句占位清成空串）**、**照片的显示与增删（列表缩略图只看缓存、详情页没缓存就去仓库取一张并写回缓存、缓存过之后列表直接显示照片且不再重复拉；详情页编辑里换图 → 菜谱改指新路径、旧图从仓库删掉；移除照片 → 路径清空）**、**点照片看大图（有照片时封面是个「查看大图」按钮、点开弹遮罩显示的就是那张图，点 × / 点遮罩 / Esc 都能关且人还留在详情页；没上传过照片的菜谱封面不套按钮，插画不给点）**、**读原链接（只要走 AI 且有链接，就真的经 r.jina.ai 抓 `x-respond-with: html`、页面线索里的作者进了给 AI 的提示词并填进作者框；抓取失败照样走 AI；文案里没有链接就不去读；只贴一条 B站搜索链接时标题取搜索词；模型把整句视频标题丢回来时会被收成菜品名）**、搜索筛选、昵称联动、token 形状校验、输入框以 DOM 为准（中文输入法 `compositionend` 之后不补 `input`）—— 每个文本输入框都断言「输入不丢字」且「值真的被用上」。
- 纯函数：`share.ts`（解析 / **标题只留菜名** / **搜索链接取搜索词当标题（`searchKeyword`）** / **营销尾巴剥离（`toDishName`）** / 链接提取 / 来源识别 / 插画猜测）、`ai.ts`（`maskAiKey` / `normalizeAiKey` / `aiKeyShapeError` / 提示词与 JSON 宽容解析（**含「文字 + 图片」内容块**）/ `normalizeAiRecipe` / `recognizeRecipe`（**文案与识图两条路**）/ `verifyAiKey` 及全部错误分类）、`photo.ts`（data URL 工具 / 字节数 / MIME ↔ 扩展名 / base64 往返 / `blobToDataUrl` 读真实字节 / **没有 canvas 2d 时原样返回** / 本机缓存的存取与清理 / 缓存单独一个 key）、`reader.ts`（`isFetchableUrl` / `readPageHtml` 的成功与错误分支 / `compactPage` 的标题·描述·作者候选·内嵌 JSON 昵称·噪音过滤）、`github.ts`（`maskToken` / `normalizeToken` / `tokenShapeError` / `withTimeout` / `getJson` / `putJson` / `verifyRepo` 及全部错误分类 / UTF-8 base64 / **`imagePath` 与 `imageMimeOf`、`getImage`（含「超过 1 MB 读不到正文」的报错）、`putImage`（正文是纯 base64）、`getFileSha`、`deleteFile`**）、`helpers.ts`（称呼 / 摘要 / 状态 / 在单检测）、`seed` / `migrate` 数据契约（**`normalizeRecipes` 给缺 `image` 的老菜谱补空串**）。
- 同步引擎（stub `fetch`，**假 GitHub 会像真的一样校验 sha，也会把 PUT 写进去的正文存下来**）：首次连接（空仓库 / 已有数据 / 失败分支 / **仓库里是老结构**）、立即同步拉取、本地改动自动推送且只推变化的那一份、空仓库先拉后推、**撞车重试取回的是「新」sha**（远端先被别处改过时，重试必须带上重新读到的 sha，不是拿旧 sha 空撞）、**读不回新 sha 时就只撞一次、直接报错**、**每个 GitHub 请求都带 `cache: no-store`**（读写两条路都验）、**首次推送前先读一次 sha**（新开一局直接点单，也只发一次带 sha 的 PUT）、断开二次确认、「我是谁」静默切换、日志全量保留、**点第二格 / 切角色会顺手同步一次**（真的发三份 GET、成功不弹「同步完成」、不额外写仓库，且不会拿旧 config 把刚切的角色冲掉；同步中设置格图标带 `sync-busy`，结束回 `sync-ok`）、**照片走独立文件**（加一条带截图的菜谱 → 图按纯 base64 先传、菜谱 JSON 后传；改备注不改图 → 图片不重传；删菜谱 → 仓库里的旧图也删掉、最后推上去的菜谱库不再引用它；**没连仓库时攒下的图，连上仓库时补传**）。
- 组件与界面边界：详情占位卡、Toast 最多同时 3 条、「设置」格图标随同步状态变绿 / 变红（未连接不染色，同步中带 `sync-busy`）、菜谱库 / 点单 / 掌勺顶栏不再出现同步状态、**设置页顶栏也不再挂「已同步」标签**（同步状态只在下面的五态面板里，标题行「已同步 · <时间>」精确到秒）、**设置页的当前仓库与分支在同一行**（同一个 `.kvrow` 里同时含仓库名与分支标签，不再有单独「分支」那一行）、点单 / 掌勺屏右上角切角色（落库 `config.view`、底部第二格立刻变、顺手跳到对应那屏、不触发推送、设置页已无角色区、掌勺有没做完的单时开关右上角挂数字红点、全做完则不挂）、掌勺点一道菜弹出菜品详情（带备注与原文链接；× / 遮罩 / Esc 都能关；临时菜只给说明不给外链）、菜谱库长按删除（短按不弹、长按弹 tooltip、点删除真删、长按后不误跳详情；**两条触发路都验过**——触摸时系统补的 `contextmenu` 也能弹气泡，鼠标右键不弹）、**今日点单与今日菜单长按删除**（短按仍展开 / 不弹、长按弹 tooltip、点删除真删并写日志、删完回到空态、长按后不误展开那张单）、详情页删除需二次确认、设置页同步日志（默认折叠、展开先 20 条、滚到底每次再 20 条、到底提示已全部加载）、点单页「历史点单」与掌勺页「已做完」默认折叠只露数量、导入配置 JSON、本地模式进入、**首次设置高级设置里的可选 DeepSeek Key（在折叠区内、密码框、可留空连接、填了就落 config、形状不对标红、本地模式也能带上）**、错误边界兜底页（渲染期抛错不白屏）。
- 本机存储：浏览器不让存数据时（测试里把 globalThis.localStorage 换成一个写就抛错的替身）首次设置页与设置页会提示「不让本站保存数据」、能存数据时不提示；首次连接之后**重开一局（重新挂载 = 刷新页面）不再被向导拦住**，	oken / epo 都还在本机缓存里。
- 仓库结构：直接读 `.github/workflows/android-apk.yml`、`android/app/build.gradle` 与 `scripts/set-version.mjs`，断言「`push` 到 `main` 触发、跑的就是 `npm run apk`、带上 `JISHIBEN_BUILD=<run_number>`、上传 `app-debug.apk`、用 `gh release create` 出 Release、声明 `contents: write`」没被删掉；版本号计算（本机 = package.json 的 version、CI = `<version>-build.<n>` 且 `versionCode` 递增、build 号非数字时退回基准值）与「debug 构建显式用仓库里的 `android/app/debug.keystore`、该文件确实在仓库里」也一并钉住（静态断言 + 纯函数，不涉及网络与界面）。
- 手机返回键：`backAction()` 决策表（有遮罩关遮罩 / **一级页直接退出应用，哪怕历史里还压着别的格** / 二级页有来路就回上一屏 / 深链进二级页没来路落到菜谱库 / 网页端不接管）、`isRootPath()` 一级页名单（四格 + 首次设置 + `/`）与 `trackHistory()` 台账（首个条目落栈、push 加深、replace 换顶、pop 变浅、根屏 pop 不掏空栈）；真实挂载后调 `pressBack()`（和真机 `backButton` 事件同一个入口）验证：菜谱库点进详情按返回回菜谱库、再按一次才交给系统退出、添加页按返回回菜谱库、从点单页进的添加页存完回点单页且返回键不会退回那张已交掉的表单、菜谱库 / 今日点单的长按删除提示与掌勺菜品详情都被返回键优先关掉、**详情页与添加页的大图都先被返回键关掉**（再按一次才回上一屏）、**一级页之间不互相回退**（设置页按返回不回菜谱库，从详情跳去的点单页按返回不回详情）、做完的首次向导不留在返回栈里。

`scripts/register-dom.mjs` 用 `node --import` 预加载 jsdom，**不能**改成普通 `import`。它还注入一个**虚拟时钟**（`globalThis.__domClock`）：默认不武装、定时器照常透传真实实现，所以 `dump` / `test:connect` 这类脚本完全不受影响；只有冒烟测试在启动时 `arm()`，之后用 `settle(ms)` 显式推进时间。各屏「进场骨架」（460～520ms）与同步防抖（700ms）因此不再真的空等挂钟 —— 整套冒烟从约 85s 降到约 2s，断言覆盖面不变（未注入时 `settle` 自动回退到真实等待）。

### GitHub Actions 自动打包（`.github/workflows/android-apk.yml`）

- 触发：`push` 到 `main`，外加手动 `workflow_dispatch`。
- 步骤：`actions/setup-node@v4`（Node 20 + npm 缓存）→ `actions/setup-java@v4`（temurin 17 + gradle 缓存）→ `android-actions/setup-android@v3`（装 `platforms;android-34`、`build-tools;34.0.0`）→ `npm ci` → **`npm run apk`**（和本机同一条命令，不另写打包步骤；这一步带 `JISHIBEN_BUILD=<run_number>`，`scripts/set-version.mjs` 据此把 `versionName` 写成 `<package.json version>-build.<run_number>`、`versionCode` 写成 `100000 + run_number`）。
- `package.json` 的 `apk` 脚本是 Windows 写法（`cd android && gradlew assembleDebug`），Linux runner 上要多做一步「让 gradlew 可用」：`android/gradlew` 在仓库里是**权限位 644 + CRLF + 带 BOM**（Windows 上提交的），直接跑会是 bad interpreter —— 工作流先就地 `sed` 成 LF 去 BOM（只改 runner 工作区，不进仓库）再 `chmod +x`，最后把 `$GITHUB_WORKSPACE/android` 追加进 `$GITHUB_PATH`，`sh` 才找得到这个不带扩展名的 wrapper。本机 Windows 走的是 `gradlew.bat`，不受影响。
- 下载源：本机的**腾讯云 Gradle 镜像**只对国内链路有意义，工作流在 runner 上把 `distributionUrl` 的域名换回 `services.gradle.org/distributions/`（同样只改工作区，不进仓库）；Maven 那边仍沿用 `android/build.gradle` 里的阿里云镜像（后面还有 `google()` / `mavenCentral()` 兜底）。
- 产物两条路：① `android/app/build/outputs/apk/debug/app-debug.apk` 作为 run artifact 上传（Actions 页面可下载）；② 用 runner 自带的 `gh` 建一个 Release，tag = `v<package.json version>-build.<run_number>`，附件名 `jishiben-<tag>.apk`，并标为 latest。同一 run 重跑时 tag 已存在，走 `gh release upload --clobber`。
- Release 里挂的是 **debug 签名**的包，而且**签名固定**：debug keystore 就是仓库里的 `android/app/debug.keystore`（口令是工具链默认的 `android` / `androiddebugkey`，`android/app/build.gradle` 的 `signingConfigs.debug` 显式指向它）。固定之前每个 runner 都会现生成一份调试密钥，签名各不相同，手机上覆盖安装会报「与已安装应用签名不同」；现在本机与 CI 的包签名一致，能互相覆盖。**代价**：调试密钥是公开、不防篡改的，拿到它的人可以签出同包名的包；要更强的保护得换正式密钥 + 不入库（见 README「Debug 包 vs Release 包」）。
- 权限：只有 `contents: write`（建 Release 用 `github.token`）；仓库里不落任何 token（见 `AGENTS.md` §6）。

## 11. PWA 与 Android

- PWA：`npm run build` 后把 `dist/` 部署到任意静态托管（HashRouter 无需 rewrite）；Android Chrome / iOS Safari 可「添加到主屏幕」，参数见 `public/manifest.webmanifest` 与 `index.html`。
- Capacitor：应用 ID `com.leonidaslux.jishiben`，应用名「记食本」，`webDir=dist`；Android `minSdk 22 / compileSdk 34 / targetSdk 34`（`android/variables.gradle`）。
- **`@capacitor/app` 是手机返回键的底座**：WebView 自己不处理返回键，装上这个插件、由 `App.addListener('backButton')` 交给 `src/lib/back.tsx` 决策，二级页按返回才是「回上一屏」而不是关掉应用（没接管的旧包表现就是按返回直接回桌面）。插件要在 `android/` 工程里生效，靠 `npx cap sync android`（`npm run apk` 里已经带了）；`android/capacitor.settings.gradle` 与 `android/app/capacitor.build.gradle` 是这条同步的结果，跟着一起提交。
- **签名固定成仓库里那份 debug keystore**（`android/app/debug.keystore`，口令 `android` / 别名 `androiddebugkey`，`android/app/build.gradle` 的 `signingConfigs.debug` 显式指向它）。AGP 默认的调试密钥是**每台机器 / 每个 CI runner 现生成**的，签名各不相同 —— 那正是「下载覆盖安装报签名不同」的原因。固定之后本机与 Release 的包能互相覆盖；**换签名（比如改用正式密钥）时必须先卸载一次旧包**。这份调试密钥是公开、不防篡改的（不是 token，可以入库，见 `AGENTS.md` §6）。
- **版本号每次递增**：`scripts/set-version.mjs` 在打包前改写 `android/app/build.gradle` 的 `versionCode` / `versionName`。本机（无 build 号）= `package.json` 的 version + `versionCode 100000`；CI 带 `JISHIBEN_BUILD=<run_number>` = `<version>-build.<n>` + `versionCode 100000 + n`。`npm run apk` / `apk:release` 里已经带上了这一步。手机上「应用信息」能直接看到版号。
- 国内网络：`android/gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl` 指向腾讯云镜像；`android/build.gradle` 把阿里云镜像放在 `google()` / `mavenCentral()` 之前。这两处是生成产物，删除 `android/` 重新生成后需重做。
- 自动打包：提交到 `main` 后由 `.github/workflows/android-apk.yml` 在 GitHub 上跑 `npm run apk` 并出一个 Release（细节见 §10）；CI 里 Gradle 发行包换回官方源（runner 在境外），Maven 仍走阿里云镜像。
- 图标由 `scripts/make-icons.mjs` 生成（PWA + 各密度 launcher）：**单一来源是首次设置页顶部那张插画 `public/art/sync-pot.svg`** —— 脚本自带一个极简 SVG 光栅化（只认 rect / circle / path 的 M L H V C S Z，遇到别的命令直接报错），把插画烘成 PNG；`public/icon.svg` 直接复制同一张插画。maskable / 圆形图标垫满插画自带的奶油底（`#FFF3DC`）并把图形缩进安全区，自适应图标前景层用透明底 + 去掉插画自带的那块圆角底（背景色由 `values/ic_launcher_background.xml` 提供同样的奶油色），拼起来和原插画一致。

## 12. 已知限制

- 没配 AI Key 时，「识别」就是**纯本地解析分享文案**（不抓页面，平台无 CORS）。
- **读原链接是第三方依赖，且不保证成功**：只要配了 AI Key，识别带链接的文案时就会走这一步 —— 链接与页面内容会发给 `r.jina.ai`，页面片段再发给 DeepSeek；免费额度有限（实测 20 次/分钟）、页面慢时要等几秒；小红书有反爬与登录墙，可能抓不到（抓不到就退回只解析文案，作者会空缺）。B站实测可用（`作者候选` 能拿到 UP 主名）。想完全不外发链接，就别配 AI Key；这一条没有单独的开关（按需求默认就用）。
- 标题「只留菜名」是启发式：带标点的分享文案截得很干净（「西红柿炒鸡蛋，你就像我这样做…」→「西红柿炒鸡蛋」），但**长而不带标点**的句子仍可能留长；配了 AI 时由模型按提示词兜成菜名。
- AI 识别需要用户自备 DeepSeek API Key；没配 Key、关掉 AI、或 AI 请求失败时一律退回本地启发式解析，只拆得出标题那一档。模型会按提示词要求「只抄不编」，但输出仍是概率性的，所以结果只作预填、始终可改。
- DeepSeek Key 与 GitHub token 一样只存 `localStorage`（仅本机语义），设置页里只显示掩码；要更强保护需走原生凭据库（未实现）。识别时文案会发给 `api.deepseek.com` —— 这是 AI 识别的固有代价，介意就别开 AI。
- 同步冲突处理是 **last-write-wins**，没有字段级合并；推送撞车会重新读 sha 自动重试（最多两轮），仍撞车就报错让用户先同步一次。
- Token 存在 `localStorage`（仅本机语义）；要更强保护需走原生凭据库（未实现）。
- **「每次进来都要重填 token / 仓库 / DeepSeek Key」的两种原因**（配置本身是有保存的，见 §2 / §3）：① 浏览器不让本站存数据（无痕窗口、开了「关闭浏览器时清除站点数据」）—— `src/lib/storage.ts` 的探针当场能测出来，首次设置页与设置页会挂一条 `.warnbanner` 说明（`Bits.StorageWarning`）；② **换了地址 / 端口**（localhost ↔ 局域网 IP、5173 ↔ 4173、iOS 上 Safari ↔ 添加到主屏幕的 PWA）—— 那是另一个来源，页面里看不见另一份数据，只能靠「用同一个地址打开」（dev / preview 已用 `strictPort` 避免换端口）。
- 订单的 `createdAt` / `updatedAt` 是**统一时间戳展示串**（`2026-10-07 09:40`），不是独立的数字时间字段。点单页的「今日点单 / 历史点单」按 `createdAt` 的**日期部分是不是今天**来分（`isTodayOrder` 比 `dateKey()`），所以跨天会自动滚动：昨天下的单第二天就落到「历史点单」。老缓存 / 老仓库里遗留的 `今天 09:40` 这类相对旧串仍按「今天」认，避免老单被突然挪进历史。
- 拉取和启动时都过 `normalizeRecipes` / `normalizeOrders` / `normalizeProfiles` 规整形状。`recipes` 补四个字段：`createdAt`（老缓存 / 老仓库没有它，用 `updatedAt` 顶上，免得详情页显示成 undefined）、`steps`（缺了补空串）、`orderCount`（缺了 / 不是合法非负数补 0，所以老菜谱一律从「点过 0 次」起算）和 `image`（缺了补空串，即「没有照片」）；其余字段仍不做补全（缺了只是显示为空，不会崩）。
- **菜谱照片**：图放在仓库的 `images/` 目录里、一张一个文件，`recipes.json` 只记路径。上传前会压到 **800 KB 以内**（长边 ≤1800px 的 JPEG），因为 GitHub contents 接口**对超过 1 MB 的文件不回正文**，读不回来；万一仓库里的图比这更大（比如手工塞进去的），读图会明确报「太大了」，界面退回本地插画。没有 canvas 2d 的环境（很老的 WebView）压缩会跳过，直接存原图，那种图可能超过这条线。
- **照片的显示是「缓存优先」**：本机缓存（`jishiben-photos-v1`，独立的 key、3 MB 上限）里有就直接显示；列表 / 缩略图**只看缓存、不发请求**，所以刚换手机时列表里还是插画，进一次详情页才把照片取回来并缓存 —— 这是为了不在一屏里拉几十张几百 KB 的图。
- **照片的同步依赖仓库**：没连仓库（本地模式）时照片只留在本机缓存里，连上仓库（或下一次推送）时才会补传；本机缓存清掉、而照片又还没传上去，那张图就只剩「路径」了（菜谱还在，封面退回插画）。两个人共用时，一台手机传的图另一台要联网取一次。
- **DeepSeek 识图**走 `deepseek-flash` 的 `image_url` 内容块（data URL），受 DeepSeek 自己的限制约束：支持 JPEG / PNG / GIF / WebP，单张 ≤32 MB、请求体 ≤48 MB（我们压过的图远小于这些），图里字太小或截图模糊时同样可能读错 —— 结果仍只是预填，能手改。
- 输入框的 DOM 兜底（`src/lib/inputs.ts`）靠 `onCompositionEnd` / `onBlur` 补同步；若某个浏览器既不补 `input`、也不在这两个时机把值落进 DOM，仍会丢字（暂未遇到）。
- `.gitignore` 忽略 `.env*` 本地凭证、`dist/`、`.tmp/`、`node_modules/` 等，凭据绝不入库。
- `maskAiKey` / `normalizeAiKey`（去空白）/ `aiKeyShapeError`（`sk-` 前缀、长度、不可见字符）与 GitHub token 那套同思路；`verifyAiKey` 走 `GET /models` 只校验 Key、不消耗对话额度（设置页「测试连接」用）。
- **点单次数跟着订单走，不是历史累计**：`orderCount` 只反映「当前还在订单列表里的单里点过它几次」——删掉一张单，单里菜谱的次数会退回去（不低于 0）；老缓存 / 老仓库的菜谱没有这个字段，规整时一律补 0，所以它们都从「点过 0 次」起算（历史点单次数无法追溯补算）。这也是为了别让「删了单但次数还在」这种对不上的状态出现。

**读原链接（`src/lib/reader.ts`）**
- **直接 fetch 平台页面是不行的**：小红书 / B站 / 抖音都不返回 CORS 头（实测 B站开放接口 `api.bilibili.com/x/web-interface/view` 也没有 `access-control-allow-origin`），浏览器读不到内容 —— 这正是当初「识别只解析文案」的原因。
- 所以走第三方「阅读器代理」`https://r.jina.ai/`：它替我们渲染目标页并把结果返回，**自己带 CORS 头**（实测 preflight 放行 `GET` 与 `x-respond-with`），浏览器可以直接读。请求 `https://r.jina.ai/<原链接>` 并带 `x-respond-with: html` 拿整页 HTML（作者名只在 HTML 里，markdown 摘要里常没有）。
- `compactPage(html, url)` 用 `DOMParser`（不执行脚本）把整页压成一小段「页面线索」：页面标题 / og 标题 / 页面描述 / **作者候选** / 正文摘录（各截断，总长可控）。作者候选来自 `meta[name=author]`、`article:author`、`[class*=author|nickname|username]` 这类块，以及页面里内嵌 JSON 的 `nickname` / `authorName` / `user_name` / `up_name` 字段（小红书、抖音把账号名塞在 state 里）；`登录 / 关注 / 下载` 这类噪音词会被丢掉。
- 只把这一小段线索交给 DeepSeek（不把 1MB 的整页塞进提示词）——省 token 也省时间；提示词里作者以「作者候选」为准。
- **只要走 AI 且文案里有链接，就默认读一次**（没有开关）：读不到（小红书有反爬与登录墙、超时、被限流）就静默退回「只解析文案」，不打断识别。读取与 AI 调用各给 25 秒超时。想完全不外发链接，就别配 AI Key（那样识别是纯本地解析）。
