# Performance HUD & surfacing — archive

> 状态记录（2026-08-17）。本文归档 agent-yes 里「性能 HUD / agent 实时状态」相关改动与分支的归属、落地状态，避免以后反复翻。

## 1. Opt-in live performance HUD（`.perfhud`）

- 引入 commit：`9f7323d feat(ui): opt-in live performance HUD in the console`
- 状态：**已在 main**（`lab/ui/index.html`）
- 内容：浮动的 `.perfhud` div，按 `⋯` 菜单切换，显示 fps / echo / keys / out / jank 每秒快照。背后的 `window.__ayPerf` 环形数据 + `perfFrameLoop` 常驻采样，与 opt-in 开关解耦。

## 2. Surface live agent activity（`status_text`）

- 提交：孤儿 commit `844bf2c feat(ui): surface live agent activity`（2026-07-14，13 文件 / 1540 insertions，其中混进了一个 887 行的 room-client vendor 重构）。
- 核心 feature：从 agent 渲染后的终端屏幕抽取「正在做什么」的 spinner 状态行，展示在控制台左侧面板，不必打开终端。
  - `ts/statusText.ts` — `parseStatusText()`：从屏幕尾部向上扫，匹配 spinner 前缀行（Unicode spinner 字符，排除 esc/ctrl/enter 键提示），截前 220 字符。
  - `ts/serve.ts` — `logStatusText()`（按 size+mtime 缓存）+ `/api/ls` 返回 `status_text` 字段。
- 状态：**已在 main**（经 `97d2493` mobile-a11y 那条线落地），`statusText.ts` / 测试 / `status_text` 字段齐全。孤儿 commit 是文字等价但基于旧 base 的重复副本，无独立价值，可忽略。

## 3. Performance beacon

- 提交：`69016fa feat: perf beacon — slow viewers report to the daemon's perf-beacons.jsonl (#294)`
- 状态：**已在 main**。每分钟汇总 perf 环里超出慢阈值的窗口，POST 到 `/api/perf-beacon`，daemon 落在 `~/.agent-yes/perf-beacons.jsonl`（纯本地），供 headless watcher/cron 学习慢端。

## 4. 服务端 perf 分支（已全部合并，无遗留）

| 分支                    | 内容                                                       | main 落点                          |
| ----------------------- | ---------------------------------------------------------- | ---------------------------------- |
| `perf/edges-backscan`   | エッジ走査時刻窓打ち切り + `/api/ls` メタ収集並列化        | `ee6917a #422`                     |
| `perf/raw-log-gc`       | 旧版書き手の raw ログ daemon 回収 + log_tasks 再計算間引き | `9ad6aed #425`                     |
| `perf/raw-log-read-cap` | cap raw PTY log reads/size + compact-in-place              | `18b100e/ad58931` → `a672f91 #264` |
| `perf-w-startup`        | web console 启动加速                                       | 已合并                             |

> 这些本地分支与 worktree 已于 2026-08-17 清理（内容已全在 main）。远程 `origin/perf/*` 分支是 PR 来源，保留即可。

## 5. `.perfhud` → `.ctip-perf`（连接 pill 下拉）迁移 — 未完成

- 起源：PID 4443（perf agent）曾尝试把浮动 `.perfhud` 迁移进连接 pill 的 hover 下拉（`.ctip`），CSS 类从 `.perfhud` 改为 `.ctip-perf`。
- 状态：**悬空 WIP，未实现**。该改动在 2026-08-17 tidy 时被 unstage/revert（当时它和另一个 agent 的语法错中间态纠缠）。无独立分支/commit 可 harvest。
- 若需启用，得从零重建（见 `lab/ui/index.html` 的 `connTipHtml` / `.ctip` 结构与 `.perfhud` 渲染逻辑）。

## 结论

「harvest the perf hud branch」的实际结果是：**几乎所有 perf 工作已在 main**；唯一真正未落地的是第 5 条的 `.ctip-perf` 迁移（悬空 WIP）。
