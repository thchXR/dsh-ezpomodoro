# dsh-ezpomodoro

[English](README.md) · 中文

给 DeepSeek Harness Web UI 用的小番茄钟。

- **25 / 5**：25 分钟专注、5 分钟休息，到点自动切换。
- **开始与停止都有提示音**：开始时两个上行音、阶段结束时三个音、暂停或重置时两个下行音（全部用 Web Audio 合成，不带音频文件）。
- **菜单栏倒计时（macOS）**：计时进行中，剩余时间同时显示在 macOS 菜单栏上，专注阶段是 `🍅 24:59`，休息阶段是 `🍵 04:59`。详见[菜单栏倒计时](#菜单栏倒计时-macos)。
- **B 站白噪音**：专注期间用内嵌的 B 站播放器播放选定的音源。音源可以是一个长视频，也可以是收藏夹；收藏夹会按每集自身的时长依次播放，播完回到第一集。播放器只挂载一次，面板收起时是透明的而不是卸载，所以噪音不会断。
- **可拖动**：默认在右下角，但你可以把它挪到别处，不必和别的插件抢那个角落。详见[挪动位置](#挪动位置)。

## 用法

胶囊在窗口右下角（`shell.overlay`）。点它展开面板，点 – 收起。面板里有：时钟、阶段进度条、开始/暂停、重置，以及白噪音那一行：

- `♪`：只切换白噪音，不动计时。
- 下拉框里是所有音源，按「视频」「收藏夹」分组。
- `+`：接受 B 站链接、裸 `BV...` 号、形如 `https://www.bilibili.com/list/ml775016702` 的收藏夹链接，或收藏夹的纯数字 id。
- `×`：移除当前选中的音源。

选中收藏夹时，那一行下面会多一条进度（`3/25 · 标题`）和一个「下一集」按钮。音源列表、当前选择、收藏夹进度与正在进行的这一轮，都存在 `localStorage` 的 `dsh-ezpomodoro/v2` 下。改名前用过的键（`dsh-pomodoro/v2`，更早还有 `dsh-pomodoro/v1`）在首次加载时仍会被读取，所以改名不会丢状态。

### 挪动位置

胶囊整体都可以拖；面板展开时，用它的**顶部标题栏**（带标题和 – 的那一行）拖，这样面板里的下拉框、输入框和按钮都还是原来的操作方式。按下后移动不超过几个像素的，仍然算一次点击，会正常展开面板。

位置记在 `dsh-ezpomodoro/position/v1` 下。窗口变小或面板尺寸变化时，坐标会被夹回可视区内，所以你可以把它停到别的插件旁边，但不会把它拖丢在屏幕外。不做边缘吸附：放在哪里就留在哪里。想恢复默认右下角，删掉这个键即可（DevTools → Application → Local Storage）。

## 菜单栏倒计时（macOS）

计时的唯一真源始终在前端渲染进程里，菜单栏只是镜像：计时进行中，客户端每秒推一次标题，同时把用户在菜单栏里点的行拉回来。宿主插件拿不到 Electron 主进程（应用自己的窗口和托盘都在 `app.asar` 里的私有类中），而且 DSH Desktop 2.0.3+ 对插件自拉进程发出的裸 HTTP 请求回 403 —— 所以这条链路是：渲染进程 → Host 路由 → 本包裹自己编译并守护的一个小型原生 helper。

```
client.js  --POST /plugin/pomodoro/menubar-->  index.js  --stdin {"cmd":"show",...}-->  menubar/menubar.swift
client.js  <--GET /plugin/pomodoro/menubar/commands--  index.js  <--stdout {"event":"action",...}--  menubar
```

- `POST /plugin/pomodoro/menubar` 收 `{ running, title, labels: { toggle, reset, panel } }`。Host 不做任何格式化：`title` 原样转发（裁到 64 个字符，labels 裁到 32）成一条 `show` 命令；`running` 为假时转发 `hide`。
- `GET /plugin/pomodoro/menubar/commands` 取走用户点击产生的队列：`toggle`、`reset` 或 `panel`。客户端只在计时进行中每 500 毫秒轮询一次。
- 菜单栏项只在计时进行中存在：暂停、重置或一个阶段结束都会把它移除。`panel` 会先激活 DSH 应用（`com.deepseek.dsh`）再展开面板。
- 两条路由都只允许回环访问，和收藏夹路由一样。

helper 是单文件 Cocoa 程序（`menubar/menubar.swift`）：一个 `NSStatusItem`，无 bundle、无签名，用 `DispatchSourceRead` 读 stdin 以免占住 run loop，协议行走 stdout、诊断信息走 stderr。它在收到 `hide` 时不会退出，只有 `quit` 或 stdin EOF 才退出。

**环境要求与首次运行。** 需要 macOS 和 Swift 工具链（Xcode 命令行工具里的 `swiftc`）。Host 在第一次请求时编译 helper，二进制缓存在 `$DSH_HOME/storages/dsh-ezpomodoro/menubar`（带有自己的 `swift-module-cache`，因为 swiftc 默认的 clang module cache 可能不可写）。编译要花几秒，之后只要 `menubar.swift` 没变就跳过。编译不了时 POST 返回 `{ ok: false, reason, message }`，`reason` 是 `unsupported`（非 macOS）、`no-toolchain`、`compile-failed` 或 `spawn-failed` 之一，此时番茄钟照常工作，只是没有菜单栏项 —— 客户端把所有失败都当静默处理。排查时可用 `DSH_POMODORO_HELPER_BIN` 覆盖二进制路径。

helper 是 Host 的子进程，随 Host 一起结束，所以 Host 重新加载不会留下僵尸菜单栏项。由于计时在前端，关闭窗口会让菜单栏项和计时一起冻结；重新打开应用后会从 `localStorage` 接着跑未完成的一轮。

## 为什么需要一个 Host 路由

`api.bilibili.com` 不返回 CORS 头，页面没法直接读收藏夹。所以 Host 半注册了一条仅回环可用的路由：

```
GET /plugin/pomodoro/fav?media_id=<id>
  -> { ok: true, mediaId, title, total, truncated, items: [{ bvid, title, duration }] }
  -> { ok: false, message }
```

最多读 100 个视频、最多翻 5 页，结果在内存里缓存十分钟。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：收藏夹路由，加上菜单栏路由、helper 的编译与守护。 |
| `client.js` | 浏览器半：时钟、提示音、播放器与收藏夹自动续播，注册进 `shell.overlay`；把时钟镜像到菜单栏，并持有拖动位置。 |
| `menubar/menubar.swift` | 原生菜单栏 helper，由 Host 按需编译。 |
| `cordis.patch.yml` | 插入 `dsh-ezpomodoro` 这一行。 |
| `locale/zh.json`、`locale/en.json` | 插件页里显示的标题与描述。 |
