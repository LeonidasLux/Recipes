# CONTEXT.md · 记食本 功能总览

> 本文件是「记食本」项目的**功能真源**（single source of truth）。
> 任何软件功能变更都必须同步更新本文件，代码必须与本文件保持一致。约束细则见 `AGENTS.md`。

## 1. 项目是什么

记食本（`package.json` name = `jishiben`）是一个**双人协作的菜谱收藏 + 点单**应用，形态为 PWA，并可用 Capacitor 打包成 Android APK。

- 两个人（内部记作 `a` / `b`）：**角色不绑在人身上** —— 谁点单、谁掌勺由每张订单的方向决定，两个人谁都能点单、也都能掌勺，共用同一份数据。
- 收藏来自小红书 / B站 / 抖音等平台的菜谱：粘贴分享文案或链接，写备注，配本地卡通插画封面。
- 下单的人从菜谱库多选几道菜凑成一单（午餐 / 晚餐）发给对方；收到单的人在「掌勺」里「接下这顿」→「全部做好了」回传状态。
- **数据真源是用户自己的 GitHub 仓库**（三个 JSON 文件）；本地 `localStorage` 只是缓存，换手机、两人共用都不丢。
- **提交即同步**：本地内容改动后自动推送回仓库；后台按间隔轮询拉取对方改动。
- 没有自建后端，浏览器 / Android WebView 直接调用 GitHub Contents API（`api.github.com`）。

**技术栈**：React 19 + TypeScript 5.8 + Vite 6 + react-router-dom 7（HashRouter）+ Capacitor 6（Android）。样式为手写 CSS，无 UI 框架。验证靠自研 jsdom 冒烟脚本与 TypeScript/类名对账。

## 2. 数据模型（`src/data/types.ts`）

- `SourceKey`：`red`（小红书）/ `bili`（B站）/ `douyin`（抖音）/ `generic`（其它网页）。
- `PersonKey`：`a` / `b`（两个人；角色随订单方向而定，不再有 orderer / cook 两个固定身份）；`OrderStatus`：`pending` / `accepted` / `done`；`Meal`：`lunch` / `dinner`；`SyncStatus`：`off` / `idle` / `busy` / `ok` / `err`；`ViewRole`：`order` / `cook`（本机当前角色，只决定底部第二格与默认屏，不改变数据归属）。
- `Recipe`：`id, title, source, url, author, art, note, updatedAt`。`art` 为本地插画文件名（如 `tomato-beef.svg`），空串则用标题首字占位。
- `OrderItem`：`recipeId: string | null, dishName`。`recipeId` 为 `null` 表示**临时手动输入的菜**。
- `Order`：`id, meal, status, items[], note, createdAt, updatedAt, placedBy`（一单多菜；`placedBy` 是下单那个人，做饭的是另一个人）。
- `Profile`：`nickname, updatedAt`；`Profiles`：`{ a, b }`（昵称绑人、不绑角色，所以换角色不会串位）。**两格一定都在**：任何来源的 profiles 都先过 `normalizeProfiles`（缺格补空、角色形状对号入座），因为调用方（`joinAs` / `setProfiles` / 同步页）都直接取 `profiles[人].nickname`。
- `SyncConfig`：`repo, branch, token, tokenMask, me, view, autoPull, intervalSec(0 | 60 | 600), lastPulledAt, lastPushedAt, lastSyncError?`。其中 `token`、`me`（本机这个人是谁）与 `view`（本机当前角色）**仅存本机，永不入库**。
- `DB`：`schema(=3), configured, updatedAt, config, profiles, recipes[], orders[], logs[]`。`logs` **全量保留**（只存本机，不进仓库）；设置页默认折叠，展开后滚动懒加载，每次 20 条。
- 仓库文件形状：`RemoteRecipes { schema, updatedAt, recipes[] }`、`RemoteOrders { schema, updatedAt, orders[] }`、`RemoteProfiles { schema, updatedAt, profiles }`。

## 3. 本地状态容器（`src/data/store.tsx`）

- 基于 `useReducer`。**唯一写入口**是 `{ type: 'mutate', updater, bumpRev }`，`updater` 作用在 reducer 拿到的**当前** `state.db` 上（不能在 dispatch 前用 ref 预计算，否则连续多次改动会基于同一份陈旧快照互相覆盖）。
- `rev` 计数器：**本地内容改动 +1**；拉取远端不 +1。同步引擎据 `rev !== pushedRev` 判断「有本地改动待推送」。
- 两个提交助手：`commit`（`bumpRev=true`，内容改动 → 会触发推送）与 `commitSilent`（`bumpRev=false`，本机设置：我是谁 / 当前角色 / token / 开关 / 时间戳 / `applyRemote`）。
- 持久化到 `localStorage`，key = `jishiben-db-v1`；启动时 `loadDb()` → `migrate()`（v1 单菜订单 → v2 `items[]`；v2 角色槽 → v3 两个人：`orderer`/`cook` 映射为 `a`/`b`、`config.role` → `config.me`、旧订单补 `placedBy`；旧的 `config.nickname` 迁入 `profiles`；补齐字段）。**形状规整（`normalizeOrders` / `normalizeProfiles`）每次都会跑，不看 `schema` 版本号** —— 仓库里存量的老结构不等于「缓存版本旧」，只按版本号判断会漏掉。
- 对外 API：`addRecipe`、`updateRecipe`（改菜名 / 原文出处 / 备注）、`deleteRecipe`（删菜谱；订单里存的是菜名快照，不受影响）、`addOrder`（自动带 `placedBy = me`）、`setOrderStatus`、`setProfiles`（按人槽改昵称）、`setMe`（切「我是谁」）、`setView`（切「当前角色」→ 底部第二格在点单 / 掌勺之间换）、`joinAs`（首次设置：按名字把本机认领到 `a`/`b` 一格并落昵称）、`setConfig`、`patchConfig`、`disconnect`、`applyRemote`、`setSyncState`。
- 派生状态：`needsSetup = !configured`；`connected = 有 repo 且 有 token`；`me`（本机这个人）；`view`（本机当前角色，缺省 `order`）。
- 业务副作用（写日志、改 `updatedAt`）在对应 action 内完成，例如加菜谱 / 下单 / 改状态 / 改昵称都会 `pushLog(..., 'ok', ...)`。
- `applyRemote` 只在远端**确实给了**某一块时才替换该块，避免拉取冲掉本地并发的配置 / 改动；替换前先用 `normalizeOrders` / `normalizeProfiles` 把老仓库里的旧结构（角色形状的 profiles、单菜订单）规整成当前 schema，否则按 `a` / `b` 取值的地方会在渲染期抛错、整页白屏。

## 4. 同步引擎（`src/lib/useSync.tsx` + `src/lib/github.ts`）

GitHub Contents API：

- `getJson(repo, path, branch, token)`：`GET /repos/{repo}/contents/{path}?ref={branch}`，文件不存在返回 `null`。
- `putJson(repo, path, branch, token, data, message, sha?)`：`PUT /repos/{repo}/contents/{path}`，提交前带上 sha 防冲突。
- `verifyRepo`：校验 token 有效、仓库存在、分支存在（连接向导用）。
- 请求头：`Accept: application/vnd.github+json`、`Authorization: Bearer <token>`、`X-GitHub-Api-Version: 2022-11-28`。
- **UTF-8 安全 base64**（中文菜名不能用裸 `btoa`）。
- 错误分类 `GithubError.kind`：`auth`(401) / `forbidden`(403，含限流识别) / `notfound`(404) / `conflict`(409 或 422) / `network` / `unknown`，每种都带可直接展示的中文 `message`。
- `withTimeout` 默认 15 秒（`connect` 用 20 秒）。
- `maskToken`、`normalizeToken`（去空白）、`tokenShapeError`（形状校验：前缀 `ghp_`/`github_pat_` 等、经典 token 40 位、混合非法字符）。

同步引擎行为：

- 三份文件：`recipes.json`、`orders.json`、`profiles.json`。
- **拉取 `doPull`**：并发拉三份，先规整成当前 schema（老仓库里的角色形状 profiles / 单菜订单），再记下各自 sha 与「已推送内容」快照 —— 快照用规整后的内容，才能与本地入库后的 db 对得上，不会把没变的文件重写一遍；三份都不存在 → 返回 `empty`；否则把远端内容交给 `applyRemote` 合并。传入 `cfgOverride` 以避免 `setConfig` 异步导致读到旧配置。
- **推送 `doPush`**：逐份比对 `lastPushed`，**只推内容真变了的那一份**（改昵称不会重写菜谱/订单）。遇到 `conflict` 自动 `refreshShas` 后重试一次。
- **提交即同步**：`connected` 且 `rev !== pushedRev` 时，700ms 防抖自动推送。
- **后台轮询**：`autoPull` 且 `intervalSec > 0` 时定时拉取；有未推改动或正在忙则跳过本次。
- **`syncNow`**：有本地改动先推，否则拉；拉到 `empty` 则推；全程更新五态并 toast。
- **`connect(cfg)`**：`verifyRepo` → `setConfig`（`configured=true`）→ `doPull`；空仓库则把本机内容作为初始内容推送，返回 `{ seeded }`。连接期间 `suppressAutoPush` 挂起自动推送，结束后把 `pushedRev` 对账到当前 `rev`。
- **`pull`**：只拉取。
- **`disconnect`**：清 `config`、`configured=false`，同步状态置 `off`。
- 拉下来的内容视为「已推送」，避免紧接着又被原样写回，制造噪音提交。

## 5. 分享文案解析与封面（`src/lib/share.ts`）

- **不做页面抓取**：小红书 / B站 / 抖音不返回 CORS 头，浏览器读不到页面内容；改为解析用户粘贴的分享文案。
- `extractUrl`：取文案里第一个链接。
- `detectSource`：按域名判断来源（`xiaohongshu`/`xhslink` → red；`bilibili`/`b23.tv` → bili；`douyin`/`iesdouyin` → douyin；否则 generic）。
- `parseShare`：先按 `BOILERPLATE` 去平台固定尾巴（**顺序有意义：长而具体的在前**），去掉链接后 **取最长的一行当标题**，再去话题标签 / 表情、裁到 40 字；抖音文案会顺手用 `看看【xxx的作品】` 捞作者。
- **只贴一条链接时不编造标题**，标题留空交给用户手填。
- `guessArt(title)`：按标题关键词（番茄牛腩 / 虾 / 椰子鸡 / 芒果糯米饭 / 三杯鸡 / 芝士蛋糕 / 面 等）匹配一张本地卡通插画；猜错只是示意图。
- 解析结果**永远只是预填**，标题 / 作者 / 来源 / 链接四个字段始终可改。

## 6. 路由与身份（`src/App.tsx`、`src/components/TabBar.tsx`）

- `HashRouter`；`AppShell`（StoreProvider + ToastProvider + SyncProvider + ErrorBoundary + Routes）可脱离 Router 单独挂载，便于测试。`ErrorBoundary` 包住路由：屏内渲染抛错时显示兜底页（人话 + 原始报错 + 重新加载），而不是整页白屏。
- 路由表：
  - `/setup` 首次设置（`needsSetup` 时，其余受保护路由一律重定向到它）。
  - `/` 固定回菜谱库（两人都能点单也能掌勺，不再按身份分叉）。
  - `/library` 菜谱库、`/recipe/:id` 详情、`/add` 添加、`/order` 点单、`/cook` 今日菜单、`/sync` 同步。
  - `*` → `/`。
- **底部导航 4 格**：`[菜谱库] [点单 / 掌勺] [＋添加] [设置]`（第四格路由仍是 `/sync`，只是入口叫「设置」）。第二格跟着**本机当前角色**（`config.view`）走：角色是点单 → 第二格「点单」（`/order`）；角色是掌勺 → 第二格「掌勺」（`/cook`）。角色**不绑在人身上**，只决定这格指向哪块屏；切角色的入口就贴在第二格那块屏（点单 / 掌勺）的**右上角**（`RoleSwitch`，紧凑的「点单 | 掌勺」贴纸开关），切完顺手跳到对应那屏；是本地设置、不触发推送。**掌勺那边还有没做完的单时**（对方点的、状态不是 `done`），开关右上角挂一枚数字红点（数字就是单数，超过 99 显示 `99+`），停在哪块屏都看得见。
- **「设置」格的图标就是同步指示灯**：已同步（`ok` / `idle`）→ 图标绿色；同步失败（`err`）→ 图标红色；未连接（`off`）与同步中（`busy`）保持默认色。同步状态只在**设置页**和这枚图标上体现，其他屏（菜谱库 / 点单 / 掌勺）不再挂顶栏 pill。
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

**Setup 首次设置**
- 四步说明（建空仓库 → 填你和另一半的昵称 → 生成 contents 读写 token → 填 token + 仓库连接）。
- 「导入配置」折叠区：粘贴另一半发来的 JSON（字段 `nickname` / `partnerNickname?` / `token` / `repo` / `branch` / `intervalSec`）填充表单，含字段校验。
- 字段与校验：我的昵称 1–12 字；另一半昵称可留空、≤12 字；token 形状校验（`autoCapitalize=none` / `autoCorrect=off` 防手机键盘改写）；仓库须为 `owner/repo`；分支非空。全部输入框走 `preserveTypedValue`（见「通用输入行为」），失焦校验读的是输入框里的真实内容。
- 不再选「点菜方 / 掌勺方」。连上仓库后由 `joinAs` 按名字把本机认领到 `a` / `b` 中的一格（本机默认槽已被别人占用时自动换另一格），之后可在设置页改「我是谁」；本机角色（`config.view`）默认是「点单」，在点单 / 掌勺屏的右上角切换。
- 「连接并拉取」→ `sync.connect`；失败时**报错横幅位于提交按钮正上方**（`role=alert`），并按 `GithubError.kind` 给出针对性提示（尤其说明「私有仓库无权限访问时 GitHub 一律回 404」）。
- 「稍后再说（本地模式）」：不连仓库，仅本机使用（需昵称）。
- 连接成功视图：显示 `seeded` 说明、仓库 @ 分支、首次拉取的菜谱/点单条数、开始使用按钮。

**Library 菜谱库**
- 顶栏：日期问候 + 「我的菜谱库」。**同步状态不在这屏显示**（只在设置页与底部「设置」格图标上体现，见 §3 / §7）。
- 搜索框（标题 / 备注 / 作者，子串匹配），有词时显示「找到 N 道」与清除按钮。
- 来源筛选 chips（全部 / 小红书 / B站 / 抖音），带计数；数量为 0 的来源不显示。
- 进场 520ms 骨架屏。
- 五态：加载 / 错态（`?state=error` 或同步失败且无数据）/ 空态（无菜谱）/ 无搜索结果 / 列表。列表行为缩略图（插画或首字）、标题、来源徽章、备注、更新时间。
- **长按一条菜谱 → 弹出删除 tooltip**：tooltip 贴在那条附近，里面是带删除图标的「删除」按钮，点一下直接删（同时 toast + 写同步日志）；点别处 / 滚动列表收起。长按后紧接着的那次 click 会被吞掉，不会顺带跳进详情页；普通点按仍然是进详情。

**RecipeDetail 菜谱详情**
- 480ms 骨架屏；封面用插画或标题首字占位。
- 元信息行：来源徽章、作者、更新时间；标题。
- 原文出处卡片：显示 `url` 并有「查看原文」外链。
- 编辑：顶栏右上角「编辑」→ 表单里可改**菜名 / 原文出处 / 我的备注**（菜名必填，清空则拒绝保存并 toast），「保存并同步」→ `updateRecipe` + toast。**两个人谁都能编辑**。
- 备注卡：查看态展示「我的备注」（没写时给引导文案）。
- **删除**：内容区末尾的「删除这道菜」需二次点击确认（第一次变成「再点一次，确认删除这道菜」），确认后 `deleteRecipe` + toast 并回菜谱库。
- 底部 CTA「去点单 · 带上这道菜」**对谁都常驻**（谁都能点单）；若该菜已在未完成单里则按钮禁用并显示「去点单查看」链接。找不到菜时显示占位卡。

**AddRecipe 添加菜谱**
- 粘贴分享文案（或仅链接）→「识别」→ 预填标题 / 作者 / 来源 / 链接，并显示封面预览与详情提示；识别前手动区隐藏。
- 解析只是预填：标题 / 作者（可留空，默认「来自剪藏」）/ 来源下拉 / 链接 都可改。
- 备注（可选）；「保存并同步到仓库」需标题非空，保存中显示 spinner，成功后回菜谱库。

**Order 点单**
- 午 / 晚餐切换（segmented）。
- 顶部组合器：已选菜 chips（点 × 移除）、发送按钮（无选菜禁用）。发送按钮文案含「发给<对方> · 午餐/晚餐 · N 道」。
- 从菜谱库多选网格（选中态打勾）、「随机加一道」（从没选的菜里随机，挑完给提示）。
- 手动输入临时菜（≤18 字，去重，`recipeId=null`）「加进这顿」。
- 「今日点单」只列**我点的、时间戳是「今天」的单**（`placedBy === me` 且 `isTodayOrder`）。每张单可展开看每道菜（缩略图 + 菜名 + 来源）、给掌勺的话、状态 chip、以及「<对方>回传状态后自动更新」提示；已完成单显示「<对方>已做完这顿」。
- 「历史点单」把我点的其余单（昨天及更早）收进一条折叠条，默认折叠、只显示数量（`N 份`），点一下才逐张铺开。
- 支持 `?add=<recipeId>` 从详情页预选一道菜（处理后会从 URL 移除该参数）。
- 空态：还没有订单时给引导文案。

**CookToday 今日菜单**
- 只列**对方点的单**（`placedBy !== me`）。顶栏显示「我」的名字与「<对方>点给你的几道菜」。
- 未完成单卡片：午/晚餐、道数、下单时间、状态 chip、每道菜、备注；主动作按钮 `pending → 接下这顿`，`accepted → 全部做好了`（点击后 600ms 回传状态并 toast）。
- **点卡片里的一道菜 → 弹出菜品详情**（`DishSheet.tsx`）：大图 / 首字占位、来源徽章 + 作者 + 更新时间、菜名、这道菜的「我的备注」（只读）、「查看原文」外链。点遮罩、点右上角 × 或按 Esc 关闭。点单时临时手输的菜（菜谱库里没有）只给菜名 + 一句说明，不给原文链接。
- 「已做完」收进一条折叠条，默认折叠、只显示数量（`N 份`），点一下才逐张铺开完成单；完成单上显示「做完啦，<对方>已收到」。
- 底部提示按 `autoPull` / `intervalSec` 显示「每 N 分钟自动拉取」或「仅手动同步」。
- 空态：今天还没人点单。

**Sync 同步与仓库**（底部入口名「设置」）
- 五态状态面板：未连接 / busy（同步中）/ err（失败，含重试 + 重新填写 token）/ ok（已同步 + 文件条数）。面板状态下有「立即同步」。
- 「当前角色」切换**不在这一页**：它贴在点单屏 / 掌勺屏的右上角（见 §3 底部导航）。只改本机 `config.view`，底部第二格随之在「点单 / 掌勺」之间换、并顺手跳到对应那屏；本地设置、不触发推送。两台设备各选各的。
- 仓库信息：当前仓库、分支、Token（掩码 + 修改，含形状校验）。
- 后台自动拉取开关（读 `autoPull` / `intervalSec`）。
- 昵称编辑：我 / 另一半两个名字都能改，保存后随仓库同步；清空表示未设置。输入框同样走 `preserveTypedValue`（见「通用输入行为」）。
- 「我是谁」切换（本机是 `a` / `b` 中的哪一位），只改本机身份、随即对调页面上的称呼（不再决定底部菜单）。
- 最近同步日志：**全量保留**（不再截断），默认折叠成一个「最近同步」折叠条（右侧显示总条数）；展开后列表固定高度可滚动，滚到底自动再加载 20 条，给出「已显示 N / 总数」与「已全部加载」提示；err 高亮。
- 已连接时提供「断开并清除本地缓存」（需二次点击确认）；未连接时提供「去首次设置」。

## 8. 组件与样式（`src/components/`、`src/styles/`）

- `Icons.tsx`：内联 SVG path 图标库（逐条转写设计原型）。
- `Bits.tsx`：`SkeletonRows`、`SourceBadge`、`SourceDot`、`StatusChip`、`Thumb`、`StateCard`、`SyncPill`。
- `Toast.tsx`：Toast 容器（约 1.7s 显示，最多同时 3 条）；`ErrorBoundary.tsx`：渲染期异常的兜底页（见 §6）。
- `LiveSyncPill.tsx`：同步状态 pill，直接反映真实状态机（未连接显示「本地模式」）。**只在设置页顶栏出现**；其他屏的同步状态由底部「设置」格图标的颜色承担（见 §3）。
- `TabBar.tsx`：底部导航（`[菜谱库][点单 / 掌勺][＋添加][设置]`，第二格读 `config.view`）+ `usePreviewState`。`RoleSwitch.tsx`：贴在点单 / 掌勺屏右上角的角色开关。原 `DaySwitch.tsx` 的页内切换已移除 —— 角色切换现在就在第二格那块屏上。
- 样式：`src/styles/app.css`（设计系统 token + 卡通组件，移植自原型 `shared/app.css`）+ `src/styles/screens.css`（按 `.s-xxx` 作用域）。`npm run classes` 对账 TSX 用到的 class 在样式表里都有定义。**布局约束**：`.app` 是固定高度（`100dvh`）的纵向 flex，只让 `.scroll` 伸缩；顶栏、搜索框、筛选 chips、底部导航这些固定区域都要写 `flex: 0 0 auto`，否则内容一长（比如菜谱变多、列表溢出视口）它们会被一起压扁，间距跟着数据量变。
- 刻意保留：`.h3` **故意未定义**（原型如此，用于维持观感）。

## 9. 演示 / 走查参数

- `?state=empty`：预演空态（菜谱库 / 点单 / 今日菜单）。
- `?state=error`：预演错态（菜谱库）。
- 例：`http://localhost:5173/#/library?state=empty`。

## 10. 命令与验证（`package.json`）

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（HMR），监听所有网卡，便于手机访问 |
| `npm run build` | `tsc -b` + Vite 生产构建到 `dist/` |
| `npm run preview` | 预览构建产物（`http://localhost:4173`） |
| `npm run typecheck` | 只跑 TypeScript 检查 |
| `npm run classes` | TSX 用到的 class 与样式表对账 |
| `npm run smoke` | jsdom 冒烟测试：渲染层 + 交互层 + 纯函数 + 同步引擎（真实挂载、真实点击、stub 网络；定时器走虚拟时钟，不空等挂钟） |
| `npm run check` | `typecheck → classes → smoke → build`，提交前跑 |
| `npm run test:live` | 对真实 GitHub 仓库跑同步自检（**会真的写仓库**；需要环境变量 `JISHIBEN_REPO` / `JISHIBEN_TOKEN`） |
| `npm run test:connect` | 端到端跑一遍首次连接（真填表真点击真网络，不写入仓库） |
| `npm run icons` | 重新生成 PWA 图标（纯 Node 写 PNG） |
| `npm run apk` | 构建 Web → `cap sync android` → `gradlew assembleDebug` |
| `npm run apk:release` | 同上，出 release 包 |

测试防护是强制约束（见 `AGENTS.md` §5）：**每个功能都要有对应测试，功能变更必须同步新增 / 调整测试**。冒烟测试（`scripts/smoke.tsx`）分七段：

- 渲染层：路由重定向、各屏内容断言、底部导航 4 格（第二格随 `config.view` 在点单 / 掌勺之间变）、详情 CTA 常驻 / 禁用态、空态 / 错态（`?state=error`）/ 本地模式、老缓存 v1→v2 与 v2→v3 迁移、schema 已最新但 profiles 缺格的脏缓存。
- 交互层：点单组合器（多选 / 手动 / 去重 / 随机 / 长度上限）、掌勺状态回传、菜谱编辑（菜名 / 原文出处 / 备注一起落库、菜名必填）、添加菜谱（小红书 / B站 / 只贴链接）、搜索筛选、昵称联动、token 形状校验、输入框以 DOM 为准（中文输入法 `compositionend` 之后不补 `input`）—— 每个文本输入框都断言「输入不丢字」且「值真的被用上」。
- 纯函数：`share.ts`（解析 / 链接提取 / 来源识别 / 插画猜测）、`github.ts`（`maskToken` / `normalizeToken` / `tokenShapeError` / `withTimeout` / `getJson` / `putJson` / `verifyRepo` 及全部错误分类 / UTF-8 base64）、`helpers.ts`（称呼 / 摘要 / 状态 / 在单检测）、`seed` / `migrate` 数据契约。
- 同步引擎（stub `fetch`）：首次连接（空仓库 / 已有数据 / 失败分支 / **仓库里是老结构**）、立即同步拉取、本地改动自动推送且只推变化的那一份、空仓库先拉后推、409 自动重试一次、断开二次确认、「我是谁」静默切换、日志全量保留。
- 组件与界面边界：详情占位卡、Toast 最多同时 3 条、「设置」格图标随同步状态变绿 / 变红（未连接不染色）、菜谱库 / 点单 / 掌勺顶栏不再出现同步状态（设置页仍显示）、点单 / 掌勺屏右上角切角色（落库 `config.view`、底部第二格立刻变、顺手跳到对应那屏、不触发推送、设置页已无角色区、掌勺有没做完的单时开关右上角挂数字红点、全做完则不挂）、掌勺点一道菜弹出菜品详情（带备注与原文链接；× / 遮罩 / Esc 都能关；临时菜只给说明不给外链）、菜谱库长按删除（短按不弹、长按弹 tooltip、点删除真删、长按后不误跳详情）、详情页删除需二次确认、设置页同步日志（默认折叠、展开先 20 条、滚到底每次再 20 条、到底提示已全部加载）、点单页「历史点单」与掌勺页「已做完」默认折叠只露数量、导入配置 JSON、本地模式进入、错误边界兜底页（渲染期抛错不白屏）。

`scripts/register-dom.mjs` 用 `node --import` 预加载 jsdom，**不能**改成普通 `import`。它还注入一个**虚拟时钟**（`globalThis.__domClock`）：默认不武装、定时器照常透传真实实现，所以 `dump` / `test:connect` 这类脚本完全不受影响；只有冒烟测试在启动时 `arm()`，之后用 `settle(ms)` 显式推进时间。各屏「进场骨架」（460～520ms）与同步防抖（700ms）因此不再真的空等挂钟 —— 整套冒烟从约 85s 降到约 2s，断言覆盖面不变（未注入时 `settle` 自动回退到真实等待）。

## 11. PWA 与 Android

- PWA：`npm run build` 后把 `dist/` 部署到任意静态托管（HashRouter 无需 rewrite）；Android Chrome / iOS Safari 可「添加到主屏幕」，参数见 `public/manifest.webmanifest` 与 `index.html`。
- Capacitor：应用 ID `com.leonidaslux.jishiben`，应用名「记食本」，`webDir=dist`；Android `minSdk 22 / compileSdk 34 / targetSdk 34`（`android/variables.gradle`）。
- 国内网络：`android/gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl` 指向腾讯云镜像；`android/build.gradle` 把阿里云镜像放在 `google()` / `mavenCentral()` 之前。这两处是生成产物，删除 `android/` 重新生成后需重做。
- 图标由 `scripts/make-icons.mjs` 生成（PWA + 各密度 launcher，自适应图标前景透明、图形收在安全区内）。

## 12. 已知限制

- 「识别」是**解析分享文案**，不是抓页面（平台无 CORS）。
- 同步冲突处理是 **last-write-wins**，没有字段级合并；推送撞车只自动重试一次。
- Token 存在 `localStorage`（仅本机语义）；要更强保护需走原生凭据库（未实现）。
- 订单没有真实时间戳字段，`createdAt` 是「今天 09:40」「昨天 10:15」这类展示串；点单页的「今日点单 / 历史点单」按 `createdAt` 是否以「今天」开头来分（`isTodayOrder`）。跨天不滚动：一条昨天下的单若时间戳仍写着「今天」，就还会落在「今日点单」里。
- 拉取时只规整 `orders` / `profiles` 的形状（单菜订单、角色形状昵称）；`recipes` 的字段不做补全 —— 缺字段只是显示为空，不会崩。
- 输入框的 DOM 兜底（`src/lib/inputs.ts`）靠 `onCompositionEnd` / `onBlur` 补同步；若某个浏览器既不补 `input`、也不在这两个时机把值落进 DOM，仍会丢字（暂未遇到）。
- `.gitignore` 忽略 `.env*` 本地凭证、`dist/`、`.tmp/`、`node_modules/` 等，凭据绝不入库。
