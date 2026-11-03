# dsh-ezpomodoro

A small pomodoro clock for the DeepSeek Harness Web UI.

- **25 / 5**: 25 minutes of focus, 5 minutes of rest, rolling over automatically.
- **Chimes on start and stop**: two rising notes when a run starts, three notes when a phase ends, two falling notes when you pause or reset (synthesised with Web Audio, no audio files).
- **Menu bar countdown (macOS)**: while the clock runs the remaining time also sits in the macOS menu bar as `🍅 24:59` (focus) or `🍵 04:59` (rest). See [Menu bar countdown](#menu-bar-countdown-macos).
- **Bilibili white noise**: during focus an embedded Bilibili player plays the selected source. The source is either one long video or a 收藏夹 (favorites folder); a folder plays its videos one after another, advancing on each video's own duration and looping back at the end. The player is mounted once and made transparent while the panel is collapsed, so the noise keeps playing.

The pill lives at the bottom-right of the window (`shell.overlay`). Click it to open the panel; – collapses it again. The panel holds the clock, the phase progress bar, start/pause, reset, and the white-noise row:

- `♪` toggles white noise without touching the timer.
- the select holds every source, grouped into 视频 and 收藏夹.
- `+` takes a Bilibili link, a bare `BV...` id, a favorites link such as `https://www.bilibili.com/list/ml775016702`, or the bare favorites number.
- `×` removes the selected source.

When a 收藏夹 is selected the panel adds a progress line under the row (`3/25 · title`) with a `下一集` button. Sources, the selection, the folder position and the current run are kept in `localStorage` under `dsh-ezpomodoro/v2`. The keys this plugin used before it was renamed (`dsh-pomodoro/v2`, and `dsh-pomodoro/v1` before that) are still read on first load, so a rename loses no state.

## Menu bar countdown (macOS)

The timer's only source of truth stays in the renderer. The menu bar is a mirror: the Client half pushes the title once per second while the clock runs, and pulls back the rows the user picked. Host plugins cannot reach Electron's main process (the app's own window and tray live in a private class inside `app.asar`), and DSH Desktop 2.0.3+ answers plain HTTP from plugin-spawned processes with 403 — so the chain is renderer → Host route → a small native helper this package compiles and supervises.

```
client.js  --POST /plugin/pomodoro/menubar-->  index.js  --stdin {"cmd":"show",...}-->  menubar/menubar.swift
client.js  <--GET /plugin/pomodoro/menubar/commands--  index.js  <--stdout {"event":"action",...}--  menubar
```

- `POST /plugin/pomodoro/menubar` takes `{ running, title, labels: { toggle, reset, panel } }`. The Host never formats anything: `title` is forwarded verbatim (clipped to 64 characters, labels to 32) as a `show` command, or as `hide` when `running` is false.
- `GET /plugin/pomodoro/menubar/commands` drains the queue of rows the user clicked: `toggle`, `reset` or `panel`. The Client polls it every 500 ms only while the clock runs.
- The item exists only while the clock runs: pausing, resetting or a phase ending removes it. `panel` activates the DSH application (`com.deepseek.dsh`) and then expands the panel.
- Both routes are loopback-only, exactly like the favorites route.

The helper is a single-file Cocoa program (`menubar/menubar.swift`): one `NSStatusItem`, no bundle, no signing, `DispatchSourceRead` on stdin so the run loop stays free, protocol lines on stdout and diagnostics on stderr. It never exits on `hide` — only on `quit` or stdin EOF.

**Requirements and first run.** macOS plus a Swift toolchain (`swiftc` from the Xcode command line tools). The Host compiles the helper on the first request and caches the binary in `$DSH_HOME/storages/dsh-ezpomodoro/menubar` (with its own `swift-module-cache`, because swiftc's default clang module cache can be unwritable). Compilation takes a few seconds and is skipped until `menubar.swift` changes. When it cannot happen the POST answers `{ ok: false, reason, message }` with `reason` one of `unsupported` (not macOS), `no-toolchain`, `compile-failed` or `spawn-failed`, and the clock keeps working without a menu bar item — the Client treats every failure as silent. `DSH_POMODORO_HELPER_BIN` overrides the binary path for troubleshooting.

The helper is spawned as a child of the Host and dies with it, so a Host reload leaves no stale item. Because the clock lives in the renderer, closing the window freezes the menu bar item along with the timer; reopening the app resumes an unfinished run from `localStorage`.

## Why a Host route

`api.bilibili.com` sends no CORS headers, so the page cannot read a favorites folder directly. The Host half registers one loopback-only route:

```
GET /plugin/pomodoro/fav?media_id=<id>
  -> { ok: true, mediaId, title, total, truncated, items: [{ bvid, title, duration }] }
  -> { ok: false, message }
```

It reads up to 100 videos over at most five pages and caches the result in memory for ten minutes.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: the favorites route, plus the menu bar routes, helper compilation and supervision. |
| `client.js` | Browser half: the clock, chimes, player and favorites autoplay, registered into `shell.overlay`; mirrors the clock into the menu bar. |
| `menubar/menubar.swift` | Native menu bar helper, compiled on demand by the Host. |
| `cordis.patch.yml` | Inserts the `dsh-ezpomodoro` row. |
| `locale/zh.json`, `locale/en.json` | Plugin title and description shown in the Plugins page. |
