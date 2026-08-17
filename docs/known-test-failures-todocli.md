# Known test failures (todoCli.spec.ts)

> 记录于 2026-08 系统负载调查期间。这些失败与当时的修复无关，属于既有问题，留待后续单独处理。

## 范围

`ts/todoCli.spec.ts` 有 3 个测试在某基线（`acdfd81`）失败，`todoCli.spec.ts` 自该基线后未改动，故为环境/既有问题而非回归。

## 失败 1：yargs 18 本地化错误文案

**失败测试**：`an unknown verb fails with a clear error …`、`dep rejects a malformed invocation …`

**根因**：yargs 18 的错误信息按系统 locale 输出日文（`y18n` / `os-locale` 读取 macOS 的 `AppleLocale`），而断言期待英文文案。`LANG` / `LC_ALL` 环境变量无法覆盖 AppleLocale，因此是环境依赖的失败。

## 失败 2：todo tree JSON 字段形状

**失败测试**：`tree --format json emits the actual nested structure …`

**根因**：`--format json` 输出的字段形状与断言期望值差一个字段。

## 处理立场

这两类失败都与 agent-yes 本体逻辑无关（分别为 yargs 上游本地化、JSON 序列化字段差异），建议在独立分支分别修正断言或适配上游行为，不混入其它改动。
