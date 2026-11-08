# Bili Music

B 站收藏夹纯音频播放器 —— 扫码登录后把你的收藏夹（以及本地音乐、B 站链接）当作一个音乐播放器来用。

只取 DASH 音频流，不拉画面，边下边播不落盘。基于 Electron。

## 功能

- **扫码登录**：内置 B 站官方二维码，cookie 只写本地 `.userdata/`，不上传任何服务器
- **收藏夹当歌单**：登录后自动列出全部收藏夹，非音乐分区的视频自动过滤，可手动用 ♪ 标记覆盖
- **纯音频流式播放**：走本地 Range 代理透传 B 站 CDN，支持拖动进度、切音质（64K / 132K / 192K / 杜比 / HiRes），不缓存到磁盘
- **多 P 视频自动拆分**：一个多 P 视频按分 P 拆成独立曲目（`视频标题 · P2 分P名`），每首可单独播放、标记、收藏
- **我的库**
  - 本地音乐：选文件夹扫描，引用原位置不复制，读 ID3 标签（歌名 / 歌手 / 专辑 / 封面 / 时长）
  - 链接收藏：粘贴 B 站链接批量导入，支持短链 / av 号 / 单视频 / 多 P，可勾选只导入指定分 P
- **我喜欢的歌**：本地音乐 / 链接收藏 / 收藏夹三源自动汇总，支持「爱心跟随」（持续同步）和「一次性全量加入」，手移除的记排除表不会复活
- **歌单**：自建歌单、拖拽排序、重命名、导出 / 导入 JSON
- **跨设备同步（不需要服务器）**：与安卓版互相同步歌单 / 曲目 / 爱心。同一 Wi-Fi 下自动发现对端点一下就同步，也可以扫码或复制一段「文本同步码」异网同步。合并用 CRDT（HLC 时间戳 + 分数位置键 + 墓碑），三方乱序交换也收敛
- **后台播放**：关闭 / 最小化可收进托盘继续播，全局媒体键 + Windows 媒体浮层，开机自启开关
- **关闭行为可选**：每次询问 / 收进托盘 / 直接退出

## 运行

```bash
npm install
npm start
```

`npm start` 实际执行 `node scripts/launch.js`：因为在本机上 electron.exe 位于项目目录树下时 Windows 托盘注册会失败（见下方「已知问题」），启动脚本会把 `node_modules/electron/dist` 复制到 `%LOCALAPPDATA%\BiliMusicRuntime` 再从那运行。

## 打包

```bash
npm run dist
```

产物在 `dist/`。当前是 NSIS 安装包，`perMachine: true`（安装时需要管理员权限，因此可以装到任意目录，包括 `D:\`）。

## 测试

```bash
npm run test:e2e       # 真实接口：登录态、元信息、播放地址、代理 Range、封面
npm run test:ui        # 渲染进程 UI 全流程（假数据桩）
npm run test:layout    # 三档窗口尺寸布局审计
npm run test:sync      # 跨设备同步：CRDT 合并 / 编解码 / 双向投影 / 真 HTTP 交换
node scripts/check-dom.js         # 静态检查：app.js 里引用的 DOM id 是否都存在
node scripts/test-sync-ui.js      # 同步面板 UI 冒烟（需 electron 主进程，见文末注意事项）
node scripts/gen-sync-fixture.js  # 重新生成给安卓端用的桌面同步码 fixture
node scripts/test-library.js      # 本地库 + 歌单 + 本地代理
node scripts/test-loved.js        # 「我喜欢的歌」三源汇总与排除表（需登录）
node scripts/test-multipage.js    # 多 P 拆分（真实接口）
node scripts/test-part-audio.js   # 各分 P 音频流可用性
node scripts/test-hidden.js       # 收藏夹条目隐藏
```

## 安卓版

`android/` 是独立的 Kotlin + Compose 工程，功能与桌面端对齐（扫码登录、收藏夹、多 P 拆分、歌单、「我喜欢的歌」、后台播放），并与桌面端**同一套同步协议**互通。配对支持扫桌面端上的二维码（CameraX + zxing）。

```bash
# 需要 Android SDK（platforms;android-35 + build-tools;35.0.0）与 JDK 17+
cd android && gradle :app:assembleRelease
# 产物：android/app/build/outputs/apk/release/app-release.apk

# 单元测试（56 项）：包括 Robolectric 在 SDK 24/34/35 上真实启动 MainActivity
gradle :app:testDebugUnitTest
```

注意四点：

- CameraX 1.6.x 要求 compileSdk 36，工程目前停在 35，所以相机依赖固定在 `1.5.3`。
- `StartupTest` 用 Robolectric 真的把 `App.onCreate` 和 `MainActivity.onCreate` 跑一遍（含 Compose 首帧）。它存在的理由是：没有真机时，属性初始化顺序这类**冷启动必崩**的问题只能靠它发现 —— 实际就抓到过一次（`BiliViewModel._libRev` 声明在 `init` 之后，导致 `refreshLibrary()` 里 NPE）。
- App 内「我的 → 崩溃日志」可以直接查看/复制 `filesDir/crash.log`（最近 5 条，含设备型号与系统版本）。拿不到 adb 时靠它排障。
- 签名密钥 `android/app/bilimusic.jks` 不入库（口令见 `build.gradle.kts`，是公开的调试用密钥）。新克隆的环境没有它时 `assembleRelease` 仍能出包，只是未签名；需要签名就先跑一次：

```bash
cd android/app && keytool -genkeypair -storetype JKS -keystore bilimusic.jks \
  -storepass bilimusic -keypass bilimusic -alias bilimusic \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=BiliMusic, OU=Dev, O=BiliMusic, L=Shanghai, S=Shanghai, C=CN"
```

同步协议的完整说明见 `android/SYNC_DESIGN.md`。

## 已知问题

- **托盘图标与 exe 路径**：electron.exe 若位于本机 `D:\bilibiliMusicPlayer` 目录树下，Windows 托盘注册必定失败（`tray.getBounds()` 恒为 0）。已排除 ACL / 所有者 / token / userData / exe 内容等因素，换到任意其他目录即正常。`scripts/launch.js` 就是为绕开它而写的。
- **SmartScreen**：安装包未做代码签名，Windows 会提示「无法识别的应用」，点「更多信息 → 仍要运行」即可。
- **音频直链有效期约 2 小时**，过期自动重新调 playurl。
- **跑 Electron 测试前要清 `ELECTRON_RUN_AS_NODE`**：某些环境里这个变量自带 `1`，会让 electron.exe 以纯 Node 模式启动，于是 `test-ui.js` / `test-sync-ui.js` 报 `app.setPath is undefined`。先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`（PowerShell）再跑即可。

## 结构

```
main.js              主进程：窗口 / 托盘 / 媒体键 / IPC / 开机自启
preload.js           contextBridge 暴露 window.api
renderer/
  index.html         界面骨架
  style.css          深色主题
  app.js             状态机：登录 / 列表 / 过滤 / 播放 / 歌单 / 弹层
src/
  bili.js            B 站接口：WBI 签名、扫码、收藏夹、playurl、链接解析
  audioProxy.js      本地 Range 代理：B 站音频 / 本地文件 / 封面
  library.js         本地库数据层：曲目、歌单、我喜欢的歌、隐藏表
  localLibrary.js    本地文件扫描 + 标签读取
  store.js           设置持久化
  sync.js            同步原语：HLC / 分数位置 / CRDT 合并 / 二进制编解码
  syncBridge.js      同步桥：库结构 ↔ SyncDoc 双向投影 + 局域网服务 + UDP 发现
android/             安卓版（Kotlin + Compose），同协议同步；SYNC_DESIGN.md 在目录里
fixtures/            双端互通的同步码样本（桌面 ↔ 安卓互相解码的回归输入）
scripts/             启动器、图标生成、各测试
```

## 说明

本项目仅用于个人本地整理与播放自己已收藏的内容，不做下载 / 转存 / 分发。所有请求都带正常浏览器 UA 与 Referer，带节流，音频流不落盘。
