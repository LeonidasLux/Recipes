# 记食本

收藏别处的菜谱（小红书 / B站 / 抖音链接）、给每道菜写备注、把想吃的凑成一顿「点单」发给另一半；
掌勺方在自己的手机上看到整单，`接下` → `全部做好了` 回传状态。

数据真源是**你自己的 GitHub 仓库**里的两个 JSON 文件，换手机、两个人共用都不丢。

> 本工程由 OpenDesign 原型（`81e66d47-…/screens/*.html` + `shared/app.css` + `shared/app.js`）逐屏移植而来，
> 视觉 token、组件、文案与交互状态与原型一一对应。

---

## 快速开始

```bash
npm install
npm run dev          # → http://localhost:5173
```

手机预览：dev server 启动后会打印 Network 地址（形如 `http://192.168.x.x:5173`），
手机连同一 Wi-Fi 直接打开即可。

> 手机打不开？见下方「手机连不上 dev server 的排查」。

---

## 手机连不上 dev server 的排查

三个地址里只有一个是对的：

| 地址 | 手机上能用吗 |
|---|---|
| `http://localhost:5173/` | ❌ `localhost` 在手机上指**手机自己**，永远打不开 |
| `http://192.168.x.x:5173/` | ✅ 正常情况用这个（手机需连同一 Wi-Fi） |
| `http://100.x.x.x:5173/` | 那是 Tailscale 地址，手机也要登进同一个 tailnet 才行 |

如果 `192.168.x.x` 也打不开，按顺序排查：

**1. 手机和电脑在同一个 Wi-Fi 吗**，手机 IP 是不是同一网段（如电脑 `192.168.5.65`，手机就该是 `192.168.5.x`）。

**2. Windows 防火墙**（最常见）。要点是：规则是按**可执行文件路径**匹配的，而且分「专用/公用」网络——网络被归类为「公用」时，只对「专用」放行的规则不生效。

本机曾踩过的坑：`C:\Program Files\nodejs\node.exe` 的规则**只放行 Private**，而 WLAN 被 Windows 判成 **Public**，于是手机被挡在外面（电脑自己访问自己却正常，因为回环不过防火墙）。

查一下现状：

```powershell
Get-NetConnectionProfile | Select-Object InterfaceAlias, NetworkCategory
Get-NetFirewallRule -Direction Inbound | Where-Object DisplayName -like '*node*' |
  ForEach-Object { $_ | Select-Object DisplayName, Action, Profile, Enabled,
    @{n='Program';e={($_ | Get-NetFirewallApplicationFilter).Program}} }
```

三种修法：

```powershell
# A. 加一条只放行本子网的规则（推荐；需管理员）
New-NetFirewallRule -DisplayName 'jishiben dev server TCP 5173' -Direction Inbound `
  -Protocol TCP -LocalPort 5173 -Action Allow -Profile Any -RemoteAddress LocalSubnet

# 撤销
Remove-NetFirewallRule -DisplayName 'jishiben dev server TCP 5173'

# B. 把当前网络改成「专用」（需管理员；会放宽整个网络的入站策略，公共 Wi-Fi 下别用）
Set-NetConnectionProfile -InterfaceAlias WLAN -NetworkCategory Private
```

```powershell
# C. 不用管理员：用已经有 Public 放行规则的那个 node 来跑 vite
& 'C:\Users\Administrator\.gradle\nodejs\node-v22.0.0-win-x64\node.exe' `
  'node_modules\vite\bin\vite.js' --host --port 5173
```

**3. 路由器开了 AP 隔离 / 客户端隔离**。不少路由器（尤其访客网络）默认禁止设备之间互访，这时只能改用 Tailscale。

---

## 用 Tailscale 从任何地方预览（可选）

电脑上如果已经装了 Tailscale，手机也装一个、登同一账号，就能用 `http://100.x.x.x:5173/` 打开——
不受局域网、防火墙、AP 隔离影响，在外面用流量也能连，而且是加密的。

---

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（HMR），监听所有网卡，方便手机访问 |
| `npm run build` | 类型检查 + 生产构建到 `dist/` |
| `npm run preview` | 本地预览构建产物（`http://localhost:4173`） |
| `npm run typecheck` | 只跑 TypeScript 检查 |
| `npm run classes` | 对账：TSX 里用到的每个 class 在样式表里都有定义 |
| `npm run smoke` | **渲染 + 交互 + 解析 + 连接流程冒烟测试**（jsdom 里真挂载真点击，107 项，全程拦截网络） |
| `npm run check` | typecheck → classes → smoke → build，提交前跑这个 |
| `npm run test:live` | **对真实 GitHub 仓库跑同步自检**（读写真实仓库，可逆；需要环境变量 `JISHIBEN_REPO` / `JISHIBEN_TOKEN`） |
| `npm run test:connect` | **端到端跑一遍首次连接**（真填表真点击真网络，不写入仓库） |
| `npm run icons` | 重新生成 PWA 图标（纯 Node 写 PNG，无第三方依赖） |

### 验证命令

```bash
npm run check        # 一次跑完：类型 + 类名对账 + 33 项冒烟 + 构建
```

冒烟测试分两层，全部在 jsdom 里真实挂载、真实派发事件：

**渲染层**
- 全新安装 → 根路径 / 菜谱库都被重定向到首次设置
- 点菜方 7 屏内容断言（菜谱库 / 详情 / 添加 / 点单 / 预选 / 同步）
- 掌勺方：今日菜单、底部导航只有 3 格、详情为只读
- 边界：已在未完成单里的菜 CTA 禁用、未选菜时发送键禁用
- 空态预览（`?state=empty`）、本地模式（未连仓库）

**交互层**
- 点单：多选 → 切午/晚 → 点胶囊移除 → 手动输一道 → 发送 → 校验落库为「一单两菜、临时菜 `recipeId` 为 null」→ 组合器清空 → 展开订单看每道菜
- 掌勺：`接下这顿` → 状态回传 `accepted` → 按钮变 `全部做好了` → 再点回传 `done` → 校验同步日志
- 备注：进编辑 → 输入 → 保存 → 校验落库与日志
- 添加菜谱：粘贴小红书链接（或传一张菜谱截图）→ 识别出菜名（配了 DeepSeek Key 还能拆做法，
  传了截图就直接识图）→ 保存 → 新菜谱进库
- 搜索：关键词计数、无结果空态、按菜名 / 备注搜
- token 形状校验：自动大写的 `Ghp_`、混入空格的、位数不足的、合法的
- 昵称：两个视角看到的称呼不同（点单屏说「发给小红」、今日菜单说「小辉点给你的」）、
  在同步页改名后所有屏立刻更新、清空后退回「点菜方 / 掌勺方」占位

**分享文案解析**
- 小红书（标题在链接前 / 带话题和表情 / 你给的那种短链）、抖音（剥掉「看看【xx的作品】」尾巴）、B站（【】包裹）、陌生站点
- 只贴链接 → 标题留空不编造、保存键仍可点（点了才提示缺菜名）
- 封面关键词猜测

**连接层（stub 掉 `fetch`，不需要网络）**
- 空仓库 → 推 2 个文件、`configured=true` 落库
- 已有数据 → 只拉不写、远端覆盖本地、**拉取不会冲掉刚写入的配置**
- 401 / 404 → 各自给出针对性的错误文案

> 这一组是补上的：**首次连接那条路径只有真实网络才走得通**，之前所有测试都没覆盖到它，
> 结果藏了一个「连续多次改 db 时，后一次基于陈旧快照覆盖前一次」的 bug
> （表现为连接成功但配置没落库、拉取到的数据被丢弃）。
> 现在 `store.tsx` 的写入口统一走 `{ type: 'mutate', updater }`，由 reducer 作用在**当前** state 上，
> 而不是在 dispatch 前用 ref 预先算好。改这块之前先看懂这个约束。

> `scripts/register-dom.mjs` 用 `node --import` 预加载 jsdom。**不能**改成普通 `import './…'`：
> esbuild 会把那个文件内联进 bundle，于是它变成模块体的一部分，而 ESM 会先求值完所有 import 再跑模块体 ——
> react-dom 会在 `document` 还不存在时完成初始化，导致纯 jsdom 环境下受控 input 的 `onChange` 永不触发。
> 文件顶部有同样的说明，改之前先读。

### 真实 GitHub 同步自检

```bash
JISHIBEN_REPO=owner/repo JISHIBEN_TOKEN=ghp_xxx npm run test:live
```

直接调用 `src/lib/github.ts`（不重写一套），对真实仓库验证：

- `verifyRepo` —— token 有效、仓库与分支存在
- 错误分类 —— 无效 token → `kind=auth`；仓库不存在 → `kind=notfound`；过期 sha → `kind=conflict`
- 写入并回读 —— 中文菜名/备注 UTF-8 往返逐字一致，`items[]` 多菜结构完整
- 可逆性 —— 若仓库里已有 `recipes.json` / `orders.json`，先备份到 `.tmp/`，测完自动还原

**⚠️ 这个脚本会真的写你的仓库**（产生 commit）。跑之前先看清楚它会做什么。

---

## 装到手机上（PWA）

`npm run build` 后把 `dist/` 部署到任意静态托管（需支持 SPA 回退到 `index.html`；
工程用的是 HashRouter，实际不需要额外 rewrite 配置）。

手机浏览器打开后：
- **Android Chrome**：菜单 → 「添加到主屏幕」/「安装应用」
- **iOS Safari**：分享 → 「添加到主屏幕」

装好后是独立窗口、有图标、有启动画面，和原生 App 手感接近。

---

## 打包成 APK（Capacitor）

工程已经配好 [Capacitor](https://capacitorjs.com/)，Web 代码外面套了一层原生 Android 壳，
产出的是可以装到手机上的真 APK。

- 应用 ID：`com.leonidaslux.jishiben`
- 应用名：记食本
- `compileSdk 34 / targetSdk 34 / minSdk 22`（`android/variables.gradle`）

### 一次性准备

需要 **JDK 17** 和 **Android SDK**（`platforms;android-34` + `build-tools` + `platform-tools`）。
SDK 路径写在 `android/local.properties`：

```properties
sdk.dir=C\:\\Users\\Administrator\\AppData\\Local\\Android\\Sdk
```

### 每次改动后重新打包

```bash
npm run apk          # = 构建 Web → 同步进原生工程 → gradlew assembleDebug
```

打包前会先跑 `scripts/set-version.mjs` 写版本号（`android/app/build.gradle` 里的 `versionCode` / `versionName`）：
**`versionName` 就是 `package.json` 的 version**（如 `1.0.1`、`1.1.2`）—— 本机和 CI 一样，不带任何后缀；
只有 `versionCode` 会随 CI 的运行序号递增（本机固定 `100000`），保证覆盖安装不会被拦。
所以**要发新版本，就改 `package.json` 的 `version`**（`package-lock.json` 根包那两处一起改），
手机上「应用信息」里看到的就是这个号。本仓库约定：**每次「提交」都自动把 patch 位 +1**
（`AGENTS.md` §8），所以平时不用手改版本号，想跳版本（`1.1.0` 这种）时明说一句就行。

产出的 APK 在：

```
android/app/build/outputs/apk/debug/app-debug.apk
```

装到手机（两种任选）：

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk   # 数据线连着
```

或者把那个 APK 文件直接发到手机（微信/网盘/数据线都行），在手机上点开安装
（需要允许「安装未知来源应用」）。

### 交给 GitHub 自动打包（不用装 Android SDK）

`.github/workflows/android-apk.yml` 已经配好：**每次 push 到 `main`**（也可以在 Actions 页面手动触发），
GitHub 会用和你本机一样的 `npm run apk` 打一次包，然后：

- 把 `app-debug.apk` 传成这次运行的构建产物（Actions → 对应运行 → Artifacts 下载）；
- 建一个 Release（tag `v<package.json version>`，如 `v1.0.1`），把 APK 作为附件挂上去，手机点开链接就能下。
  同一个版本再推一次不会建重复的 Release，而是把那条 Release 的附件覆盖成最新一次打的包；
  想留升级记录就把 `package.json` 的 `version` 往上加。

Release 里挂的是 debug 签名的包 —— 和本机 `npm run apk` 出来的那份一样，**能直接装、不能上架**。
想自己签名出正式包，见下面的「Debug 包 vs Release 包」。

### 可以直接覆盖安装（签名固定）

`android/app/debug.keystore` 是**随仓库走的固定调试密钥**（口令就是 Android 工具链默认的
`android` / `androiddebugkey`），`android/app/build.gradle` 里 debug 构建显式指向它。
所以本机打的包和 CI 出的 Release **签名一致**，可以互相覆盖安装。

在这之前的版本用的是「每台机器 / 每个 runner 现生成」的调试密钥，签名各不相同，覆盖安装会报
**「与已安装应用签名不同」**。已经装过旧版的话，需要卸载一次再装新版：

1. 先在 App 的「设置」里确认同步是绿的（数据都推到仓库了）；
2. 卸载旧版（会连本机缓存一起清掉，token 也在这里，重装后要重新填）；
3. 装新版，重新走一次连接向导，数据会从仓库拉回来。

之后再升级就能直接覆盖安装了。

固定的是**调试密钥**，它是公开的、不防篡改：拿到这份 keystore 的人能签出同包名的包。
要更强的保护就换成自己的正式密钥并且**不把密钥入库**（见下面的「Debug 包 vs Release 包」）。

### 改了图标之后

```bash
npm run icons        # 同时产出 PWA 图标和 Android 各密度的 launcher 图标
npx cap sync android
npm run apk
```

桌面图标就是**首次设置页顶部那张插画**（`public/art/sync-pot.svg`）：`scripts/make-icons.mjs`
里带了个极简 SVG 光栅化（纯 Node、零依赖，只认这张插画用到的元素与命令），把同一张图烘成
PWA 图标和各密度 launcher 图标 —— 改插画，图标跟着变。自适应图标的前景层是**透明底**、
去掉插画自带的那块圆角底（背景色用同样的奶油色 `#FFF3DC`），图形收在安全区内，
所以圆角 / 圆形 / 方形几种启动器下都不会被裁掉。

### 关于国内网络环境（两处已经改过）

这台机器上踩了两个网络坑，都已经在工程里改好了：

**1. Gradle 本体下载** —— `android/gradle/wrapper/gradle-wrapper.properties` 里的
`distributionUrl` 指向**腾讯云镜像**而不是 `services.gradle.org`。
Gradle wrapper 的下载超时是硬编码的 10 秒，从国内基本必失败。
换网络想改回去，把域名换回 `services.gradle.org/distributions/` 即可。

**2. Maven 依赖下载** —— `android/build.gradle` 里把**阿里云镜像**放在了 `google()` /
`mavenCentral()` 前面。这台机器直连 `repo.maven.apache.org` 时 JVM 的 TLS 握手会被中间人拦掉：

```
Certificate for <repo.maven.apache.org> doesn't match any of the subject
alternative names: [180.178.40.218]
PKIX path building failed
```

有意思的是 curl 走同一个地址是通的 —— 说明拦截发生在 JVM 那条链路上，不是全网封锁。
阿里云镜像代理了 central / google / gradle-plugin 三处，放最前面就能全部命中。

> 两个都是**生成出来的原生工程文件**（`npx cap add android` 的产物）。
> 如果哪天删掉 `android/` 重新生成，这两处都要重做一遍。

### Debug 包 vs Release 包

上面产出的是 **debug 包**：用调试密钥签名，直接能装，适合自己用。
缺点是体积偏大、跑得稍慢，而且**不能上应用商店**。

这里的 debug 密钥是仓库里那份固定的 `android/app/debug.keystore`（见上面「可以直接覆盖安装」），
所以本机与 CI 出的包能互相覆盖；换用下面的正式密钥时，签名会变，**装过旧包的话同样要先卸载一次**。

要出正式包需要自己生成一个签名密钥（**这个文件丢了就再也无法覆盖升级，务必存好**）：

```bash
keytool -genkey -v -keystore jishiben.keystore -alias jishiben \
  -keyalg RSA -keysize 2048 -validity 10000
```

然后在 `android/app/build.gradle` 里配 `signingConfigs`，再 `./gradlew assembleRelease`。

---

## 连接 GitHub 仓库

首次进入会走向导：**① 填昵称 → ② 选身份 → ③ 填 token + 仓库 → ④ 连接并拉取**。

1. 在 GitHub 建一个仓库（可以是私有的），比如 `你的用户名/family-recipes`。
2. 生成 Personal access token，**权限只需要 `contents` 读写**（Fine-grained token 请把仓库范围限定到这一个仓库）。
3. 把 `用户名/仓库名`、分支（默认 `main`）、token 填进向导。

向导的**「高级设置」里还能顺手填一个可选的 DeepSeek API Key**（留空也行）：
填了，「识别」当场就能用 AI（菜名 / 做法一起拆）；不填就是纯本地解析，之后到「设置」里补也一样。

不想一项项手填，也可以把「导入配置」折叠区的 JSON 整段粘进去 —— 它同样认 `aiKey`（可选），
填了就顺手把 DeepSeek Key 那格也带上。示例：

```json
{
  "nickname": "小辉",
  "partnerNickname": "小红",
  "token": "ghp_xxxxxxxxxxxxxxxxxxxx",
  "repo": "owner/repo",
  "branch": "main",
  "intervalSec": 60,
  "aiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

`nickname` / `token` / `repo` 必填，`partnerNickname`、`branch`（默认 `main`）、`intervalSec`（默认 60）、
`aiKey` 都可省；`aiKey` 形状不对（不是 `sk-` 开头）会被拦下来。

连接成功后：

| 情况 | 行为 |
|---|---|
| 仓库里已有 `recipes.json` / `orders.json` | 拉下来覆盖本机缓存 |
| 仓库是空的 | 把本机现有内容作为初始内容推上去 |
| 之后每次增删改 | **提交即同步**：本地改完 0.7 秒内自动推回仓库 |
| 后台轮询 | 按设置的间隔（1 分钟 / 10 分钟 / 仅手动）自动拉取 |
| 推送撞车（文件被别处改过） | 重新读回最新 sha 再推（最多两轮；读不回新 sha 就直接报错，不拿旧 sha 空撞） |
| 拉取与本地改动冲突 | last-write-wins：本地未推的改动优先 |

仓库里的数据长这样（与 `src/data/types.ts` 对应）：

```
recipes.json    { schema, updatedAt, recipes:  Recipe[]   }
orders.json     { schema, updatedAt, orders:   Order[]    }
profiles.json   { schema, updatedAt, profiles: Profiles   }
```

`profiles.json` 存两个人的昵称（点菜方 / 掌勺方各一个），**两台设备共享**：

```jsonc
{ "schema": 2, "updatedAt": "15:05",
  "profiles": {
    "orderer": { "nickname": "小辉", "updatedAt": "15:05" },
    "cook":    { "nickname": "小红", "updatedAt": "15:05" }
  } }
```

推送是**按文件比对**的：只有内容真的变了才写哪一份。所以改个昵称只会在仓库里留一条
`更新昵称` 提交，不会顺带重写菜谱和订单。

**Token 只存在本机**（浏览器 localStorage），不会写进仓库、不会发给除了 `api.github.com` 以外的任何地方。
DeepSeek 的 AI Key 同理，只发给 `api.deepseek.com`；两者都不会出现在仓库文件里（`config` 永远不进仓库，仓库里只有
`recipes.json` / `orders.json` / `profiles.json` 三份 JSON，加上放菜谱照片的 `images/` 目录）。
`schema` 目前是 `3`（订单为「一单多菜」的 `items[]`，人也从固定角色换成了 `a` / `b` 两格）。

> **「怎么每次进来都要重填 token / 仓库 / Key？」** 配置是存了的（整份数据序列化在本机 localStorage，
> key 是 `jishiben-db-v1`），但 localStorage **按「来源」隔离**（协议 + 主机 + 端口），所以：
> ① 浏览器不让本站存数据（无痕窗口、开了「关闭浏览器时清除站点数据」）会每次重填 ——
> 这种情况首次设置页和设置页会挂一条提示说清楚；
> ② **换了地址**就是另一份存储：`localhost:5173` ↔ `192.168.x.x:5173`、`5173` ↔ `4173`、
> iOS 上 Safari ↔ 「添加到主屏幕」的 PWA，各存各的。用同一个地址打开就都在。
> 本地开发时端口固定 `5173`（`strictPort`，被占用直接报错而不是偷偷换到 5174）。

---

## 两个人怎么用

同一份仓库、同一套数据，靠**身份**分成两种视图（向导第 ② 步选，之后在「同步 → 我的身份」随时切换）：

| 底部导航 | 点菜方 | 掌勺方 |
|---|---|---|
| 第 1 格 | 菜谱库 | 菜谱库（**一样**） |
| 第 2 格 | 点单 | 今日菜单 |
| 第 3 格 | ＋添加 | ＋添加（**一样**） |
| 第 4 格 | 同步 | 同步（**一样**） |
| 主动作 | 挑几道菜凑一顿发出去 | 接下这顿 → 全部做好了 |

> 底部导航只有**第 2 格**分角色，其余三格两边完全一致 ——
> 掌勺方同样能收藏菜谱、加菜谱，不是只能看。

各自在自己手机上装一份，连同一个仓库，选各自的身份即可。

**昵称**存在仓库里（`profiles.json`），不在本机：

- 首次设置里可以一次填好「我的昵称」和「对方的昵称」——谁先装都不影响。
  「对方的昵称」留空也可以，界面会退回「点菜方 / 掌勺方」这类占位，不显示空白。
- 之后随时在**「同步 → 昵称」**里改，两个名字都能改（谁先装都能顺手把对方名字填上）。
- 页面上凡是称呼人的地方都读这里：点单页的「发给小红」、掌勺端的「小辉点给你的几道菜」、
  「做完啦，小辉已收到」……改完名字，**所有屏立刻跟着变**。
- 每块屏的视角由**屏自己**决定，不看当前设备切到哪个身份：点单屏永远用掌勺方的名字，
  今日菜单永远用点菜方的名字。切身份时你看到的是另一组屏，称呼自然就换过来了。

---

## 工程结构

```
src/
├── main.tsx                 入口
├── App.tsx                  路由表 + 上下文装配（AppShell 可单独挂载，便于测试）
├── styles/
│   ├── app.css              设计系统：六元 token + 卡通组件（移植自 shared/app.css）
│   └── screens.css          各屏专属样式，按 .s-xxx 作用域隔离
├── data/
│   ├── types.ts             Recipe / Order / SyncConfig / DB 数据模型
│   ├── seed.ts              首次打开的示例数据 + 老数据迁移 + localStorage 读写
│   ├── helpers.ts           订单摘要、状态元数据、时间格式
│   └── store.tsx            状态容器（useReducer）+ 本地持久化 + rev 计数器
├── lib/
│   ├── github.ts            GitHub Contents API 客户端（UTF-8 安全 base64 / 错误分类 / 图片文件读写）
│   ├── share.ts             分享文案解析 + 封面插画猜测
│   ├── ai.ts                DeepSeek Chat Completions 客户端（AI 识别 + 截图识图 + Key 工具）
│   ├── photo.ts             菜谱照片：读文件 → 压成 data URL → 本机缓存
│   ├── photoQueue.ts        照片取图队列：一次最多两路并行、滚到眼前才取、失败冷却
│   └── useSync.tsx          同步引擎：提交即推送、只推变化的文件、轮询拉取、冲突重试
├── components/
│   ├── Icons.tsx            图标库（逐条转写原型 SVG path）
│   ├── Bits.tsx             骨架屏 / 状态 chip / 缩略图 / 五态占位卡
│   ├── Photo.tsx            菜谱照片组件（缓存优先，没有就让取图队列去仓库拿一张）
│   ├── SyncButton.tsx       菜谱库右上角的同步按钮（点一下立刻同步一次）
│   ├── TabBar.tsx           随身份切换的底部导航 + ?view / ?state 演示参数
│   ├── RoleSwitch.tsx       点单 / 掌勺顶栏右端的角色开关
│   └── Toast.tsx            Toast 容器
└── screens/
    ├── Setup.tsx            1 首次设置（昵称 / 身份 / token / 仓库 / JSON 导入）
    ├── Library.tsx          2 菜谱库（搜索 + 排序 + 五态）
    ├── RecipeDetail.tsx     3 菜谱详情（备注编辑 / 掌勺只读）
    ├── AddRecipe.tsx        4 添加菜谱（贴链接识别 / 传截图识图 / 一次多张批量识图 / 直接手写）
    ├── Order.tsx            5 点单（多选组合器 + 随机加一道 + 可展开订单）
    ├── CookToday.tsx        6 掌勺今日菜单（整单接下 / 做完）
    └── Sync.tsx             7 同步与仓库（五态面板 + 身份切换 + 日志）

scripts/                     （开发工具，不参与打包）
├── register-dom.mjs         jsdom 预加载，给冒烟测试用
├── smoke.tsx                渲染 + 交互冒烟测试
├── check-classes.mjs        CSS 类名对账
├── make-icons.mjs           PWA 图标生成
└── dump.tsx                 把某屏的真实 HTML 打出来做结构目检

.github/workflows/android-apk.yml   提交到 main 后自动打包 APK 并出 Release
```

### 设计走查参数

原型里的预览开关都保留了：

- `?view=orderer` / `?view=cook` —— 临时固定视角（不改本机身份），导航也会跟着变
- `?state=empty` —— 预演空态（菜谱库 / 点单 / 今日菜单）
- `?state=error` —— 预演错态（菜谱库）

例：`http://localhost:5173/#/library?state=empty`

---

## 添加菜谱的「识别」是怎么工作的

**不做页面抓取**，而是解析你粘贴进来的**分享文案**。

原因：小红书、B站、抖音都**不返回 CORS 头**，浏览器读不到它们的页面内容。
实测小红书页面确实把标题内嵌在 `window.__INITIAL_STATE__` 里，但那只对服务端可见；
浏览器这边无论怎么发请求都会被跨域挡掉，而且页面还有反爬校验。

而各平台「分享 → 复制链接」复制出来的本来就是**一整段带标题的文字**：

```
西红柿炒鸡蛋，你就像我这样做，真的很下饭！ http://xhslink.com/xxxx
复制本条信息，打开【小红书】App查看精彩内容！
```

把这段整粘进来，标题就是平台自己给的，比抓页面更准、更快，也不需要后端。

- 实现见 `src/lib/share.ts`：抽出第一个链接 → 去掉平台尾巴和话题标签 → 取最长的一行当标题。
- **只贴一个链接时不会编造标题**，直接留空让你手填 —— 解析结果只是预填，菜名 / 原文链接始终可改。
- 封面拿不到真图，`guessArt()` 按标题里的关键词配一张本地卡通插画（`public/art/*.svg`）：
  具体菜排在前面，最后几行是**大类兜底**（饺子·馄饨·包子 / 汤·羹·粥 / 饭·米·炒饭 / 炒·鸡丁·肉丝·家常），
  一个都不命中的才留空、用菜名首字占位；空 `art` 的老菜谱在规整数据时会按菜名重猜一次。猜错只是示意图，不影响数据。

> 原型里这块是**写死的样本**：任何小红书链接都会返回「蒜香黄油虾仁」。
> 那是 prototype 的占位实现，已经删掉了。

### 再进一步：接入 DeepSeek AI（可选）

分享文案里往往还夹着食材和步骤，启发式解析只挑得出标题。为此加了一层**可选的 AI 识别**
（`src/lib/ai.ts`）：在「设置 → AI 识别（DeepSeek）」里填一个自己的 DeepSeek API Key，
「识别」就会把这段文案交给 `deepseek-flash`，让它一次抽出**菜名 / 做法 / 小贴士**。

**截图也是同一条路**：懒得打字就点「传张截图」，选一张手机里的菜谱截图（**一次可以选多张**：那就一张出一套编辑区、纵向排开，
逐张看 / 改完点保存才入库），
`deepseek-flash` 直接识图，把图里的菜名 / 食材 / 步骤读进表单（同一张图会存成这条菜谱的照片）。
截图会先在本机压到 800 KB 以内（长边 ≤1800px 的 JPEG），既能识图也能当封面；
识图请求里带的是 `image_url` 内容块（data URL），识别前会先关掉模型的思考模式（照着抄的活儿用不上）。

- 走 Chat Completions（`https://api.deepseek.com/chat/completions`，`response_format=json_object`），
  `api.deepseek.com` 会回 CORS 头，所以浏览器可以直连，仍然不需要自建后端。
- **链接永远以本地解析为准**；提示词明确要求「只抄文案里写到的信息、绝不编造」，
  结果同样只是预填，菜名 / 做法 / 备注都能改。做法抓不到时留空，而不是让模型编一段。
- **失败不阻断**：没配 Key、关掉开关、或 DeepSeek 报错（Key 失效 / 余额不足 / 限流 / 超时…）
  都会退回原来的本地解析，并把原因用中文 toast 出来。
- Key 与 GitHub token 同级别：**只存本机 `localStorage`**，设置页只显示掩码，
  不进仓库、也不发给 `api.deepseek.com` 以外的任何地方。设置页还有「测试连接」（走 `GET /models`，
  只校验 Key、不消耗对话额度）。

### 标题只留菜名

分享文案常写成「西红柿炒鸡蛋，你就像我这样做，真的很下饭！」，标题要的只是「西红柿炒鸡蛋」。
所以两条路都做了收窄：

- **本地解析**：取最长那行后，从第一个分隔标点截断，**反复剥**掉「保姆级教程 / 超详细 / 手把手 / 的做法 /
  教程 / 配方 / 合集 / 分享 / 来了」这类营销尾巴，再裁到 20 字（`src/lib/share.ts` 的 `toDishName`）。
  例：「酸甜爽脆的腌萝卜保姆级教程来了‼️」→「酸甜爽脆的腌萝卜」。
- **AI**：提示词要求「只填菜名本身，2～12 字」并点名去掉营销词，给了例子；模型万一还是把整句视频标题
  丢回来，`normalizeAiRecipe` 会用同一套 `toDishName()` 再收一次。

另外，**只贴一条搜索链接**（B站 `search.bilibili.com/all?keyword=…`、YouTube、百度…）时，
标题直接取链接里的搜索词（`searchKeyword()`，认 `keyword` / `search_query` / `query` / `q` / `wd` / `word`）
—— 这种链接没有文案可解析，但搜索词能顶上一个标题（AI 抽不出菜名时用它兜底）。

启发式不可能全对（长而不带标点的句子会留长），但配了 AI 时基本都能收成菜名。

---

## 与原型的刻意差异

1. **`.h3` 未定义**。原型 `shared/app.css` 里没有 `.h3` 规则，但它被用在 `<h2>` / `<h3>` / `<p>` / `<div>` 上，
   于是同一个类在不同屏落到不同的浏览器默认样式。为保持**像素级一致**，这里同样没有定义它。
   如果后续想统一标题层级，在 `src/styles/app.css` 补一条 `.h3` 即可 —— 但那会改变现有观感。

2. **昵称从「只存本机」改成「随仓库共享」**。原型里 `config.nickname` 不提交仓库，而且
   「小红 / 小辉」是写死在文案里的。现在两个昵称都进 `profiles.json`，页面上所有称呼都动态读它
   （见上文「两个人怎么用」）。老数据里的 `config.nickname` 会在 `migrate()` 里搬进 `profiles`。

3. **首次设置的字段顺序改为「先选身份、再填昵称」**。原型是 昵称 → 身份。加了「对方昵称」之后，
   两个昵称输入框的标签都依赖所选角色，放前面会出现「改一下身份、输入框里的值莫名换了位置」。

4. **首次设置的报错横幅挪了位置**。原型把 `#errBanner` 放在「导入配置」折叠区和 `<form>` 之间，
   于是连接失败时，报错出现在离「连接并拉取」一整个表单之外的地方，用户得往回翻才看得到。
   这里把它移到**提交按钮正上方**（仍在表单内，`role="alert"` 不变）。
   冒烟测试里有一条 `compareDocumentPosition` 断言锁住这个位置，别改回去。

5. **报错内容具体化**。原型只显示一句固定的「连接失败：仓库拒绝了这次访问」；
   这里改成显示真实原因（`GithubError.kind` 决定文案），尤其是那个容易踩的坑 ——
   **GitHub 对无权访问的私有仓库一律返回 404**，所以「找不到仓库」通常意味着 token 看不到它，而不是仓库名写错。

6. **掌勺方不再只读，导航也只有第 2 格分角色**。原型里掌勺方的菜谱详情是「掌勺浏览模式 · 只读」，
   底部导航也只有 3 格、顺序还和点菜方不同。现在两个身份在菜谱这块完全一致：都能收藏、都能加、都能改备注；
   底部导航是 `[菜谱库] [第2格] [＋添加] [同步]`，**第 1、3、4 格两边相同**，
   只有第 2 格按角色换成 `点单` 或 `今日菜单`。
   详情页唯一保留的角色差异是底部那个 **「去点单 · 带上这道菜」CTA 只给点菜方**。
   `TabBar.tsx` 里用 `CONTENT_TABS` 一处描述这个差异，别再拆成两份独立列表。

---

## 已知限制 / 后续可做

- 没配 AI Key 时「识别」走的是**解析分享文案**，不是抓页面 —— 原因和做法见下方专节。**任何情况下都不会去读原链接**（`r.jina.ai` 这条第三方依赖已随「作者」字段一起删掉），识别只用你粘贴的文案 / 截图。
- 「标题只留菜名」是启发式：带标点的文案收得干净，长而不带标点的会留长（配 AI 时由模型兜）；只贴一条搜索链接时取链接里的搜索词当标题。
- AI 识别要用户自备 DeepSeek API Key；没配 / 关掉 / 失败都退回本地解析。识别时文案会发给 `api.deepseek.com`，介意就别开 AI。
- **菜谱照片**放在仓库的 `images/` 目录里（一张一个文件，`recipes.json` 只记路径），上传前会压到 800 KB 以内；
  详情页点一下照片能看大图（点遮罩 / × / Esc / 手机返回键关掉）。
  列表缩略图缓存优先，没有的照片**滚到眼前时才去仓库取一张**（取图队列一次最多两路并行、同一张只取一次、取不到冷却 60 秒），
  取回来直接换成照片并写进本机缓存 —— 所以新装 / 换手机之后不必逐条点进详情页；
  本机模式（没连仓库）下传的图只留在本机，连上仓库后才补传。
- 冲突处理是 last-write-wins，没有做字段级合并。
- Token 存在 localStorage，等价于原型里「仅存本机」的语义。要更强的保护需要走原生容器（见下）。
- **打包成真正的 Android/iOS App**：这套代码可以直接被 Capacitor 包成原生壳
  （`npx cap add android` → `npx cap sync` → Android Studio 出 APK），
  届时 token 可改存系统凭据库。需要的话可以继续这一步。
