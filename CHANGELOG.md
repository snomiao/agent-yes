# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## Unreleased

- `ay send` がログの再描画だけで送信成功を報告する問題を修正。今回のメッセージが履歴に移ったことを確認し、自分の本文が入力欄に残る場合だけ Enter を再試行します。未確認は `NOT SUBMITTED`（終了コード 1）、受付済みの処理待ちは `QUEUED`（終了コード 4）として区別します。

### [1.31.41](https://github.com/snomiao/claude-yes/compare/v1.31.40...v1.31.41) (2025-11-08)

### [1.31.40](https://github.com/snomiao/claude-yes/compare/v1.31.39...v1.31.40) (2025-11-07)

### [1.31.39](https://github.com/snomiao/claude-yes/compare/v1.31.38...v1.31.39) (2025-11-07)

### [1.31.38](https://github.com/snomiao/claude-yes/compare/v1.31.37...v1.31.38) (2025-11-07)

### [1.31.37](https://github.com/snomiao/claude-yes/compare/v1.31.36...v1.31.37) (2025-11-07)

### [1.31.36](https://github.com/snomiao/claude-yes/compare/v1.31.35...v1.31.36) (2025-11-07)

### [1.31.35](https://github.com/snomiao/claude-yes/compare/v1.31.34...v1.31.35) (2025-11-07)

### [1.31.34](https://github.com/snomiao/claude-yes/compare/v1.31.33...v1.31.34) (2025-11-07)

### [1.31.33](https://github.com/snomiao/claude-yes/compare/v1.31.32...v1.31.33) (2025-11-07)

### [1.31.32](https://github.com/snomiao/claude-yes/compare/v1.31.31...v1.31.32) (2025-11-07)

### [1.31.31](https://github.com/snomiao/claude-yes/compare/v1.31.30...v1.31.31) (2025-11-07)

### [1.31.30](https://github.com/snomiao/claude-yes/compare/v1.31.29...v1.31.30) (2025-11-07)

### [1.31.29](https://github.com/snomiao/claude-yes/compare/v1.31.26...v1.31.29) (2025-11-07)

### [1.31.28](https://github.com/snomiao/claude-yes/compare/v1.31.26...v1.31.28) (2025-11-07)

### [1.31.27](https://github.com/snomiao/claude-yes/compare/v1.31.26...v1.31.27) (2025-11-07)

### [1.31.26](https://github.com/snomiao/claude-yes/compare/v1.31.25...v1.31.26) (2025-11-07)

### [1.31.25](https://github.com/snomiao/claude-yes/compare/v1.31.24...v1.31.25) (2025-11-07)

### [1.31.24](https://github.com/snomiao/claude-yes/compare/v1.31.23...v1.31.24) (2025-11-07)

### [1.31.23](https://github.com/snomiao/claude-yes/compare/v1.31.22...v1.31.23) (2025-11-07)

### [1.31.22](https://github.com/snomiao/claude-yes/compare/v1.31.21...v1.31.22) (2025-11-07)

### [1.31.21](https://github.com/snomiao/claude-yes/compare/v1.31.20...v1.31.21) (2025-11-07)

### [1.31.20](https://github.com/snomiao/claude-yes/compare/v1.31.19...v1.31.20) (2025-11-07)

### [1.31.19](https://github.com/snomiao/claude-yes/compare/v1.31.18...v1.31.19) (2025-11-07)

### [1.31.18](https://github.com/snomiao/claude-yes/compare/v1.31.17...v1.31.18) (2025-11-07)

### [1.31.17](https://github.com/snomiao/claude-yes/compare/v1.31.16...v1.31.17) (2025-11-07)

### [1.31.6](https://github.com/snomiao/claude-yes/compare/v1.31.5...v1.31.6) (2025-11-07)

### [1.31.16](https://github.com/snomiao/claude-yes/compare/v1.31.14...v1.31.16) (2025-11-07)

### Bug Fixes

- add node-pty fallback to bun for compatibility ([f5281e8](https://github.com/snomiao/claude-yes/commit/f5281e876d5a3d0742491a1284e9604551bd59c8))
- **cli-yes.config.ts:** update regex for enter prompts to match leading spaces for consistency ([4de210c](https://github.com/snomiao/claude-yes/commit/4de210cf12f88111cb6a9af9c21e4e0a105f53bf))
- update shebang to use node and fix CLI args parsing ([abc9b89](https://github.com/snomiao/claude-yes/commit/abc9b89b59729a6a2f9660c72b33437f9810a1b6))

## [1.31.5](https://github.com/snomiao/claude-yes/compare/v1.31.4...v1.31.5) (2025-11-07)

### Bug Fixes

- **cli-yes.config.ts:** update regex for enter prompts to match leading spaces for consistency ([4de210c](https://github.com/snomiao/claude-yes/commit/4de210cf12f88111cb6a9af9c21e4e0a105f53bf))

### [1.31.15](https://github.com/snomiao/claude-yes/compare/v1.31.14...v1.31.15) (2025-11-07)

### Bug Fixes

- **cli-yes.config.ts:** update regex for enter prompts to match leading spaces for consistency ([4de210c](https://github.com/snomiao/claude-yes/commit/4de210cf12f88111cb6a9af9c21e4e0a105f53bf))
- update shebang to use node and fix CLI args parsing ([84cd7d0](https://github.com/snomiao/claude-yes/commit/84cd7d027dd6520b3cd52fc1ac7f7582c140f977))

### [1.31.14](https://github.com/snomiao/claude-yes/compare/v1.31.13...v1.31.14) (2025-11-07)

### [1.31.4](https://github.com/snomiao/claude-yes/compare/v1.31.3...v1.31.4) (2025-11-07)

### [1.31.13](https://github.com/snomiao/claude-yes/compare/v1.31.12...v1.31.13) (2025-11-07)

### [1.31.12](https://github.com/snomiao/claude-yes/compare/v1.31.3...v1.31.12) (2025-11-07)

### [1.31.11](https://github.com/snomiao/claude-yes/compare/v1.31.10...v1.31.11) (2025-11-07)

### Bug Fixes

- escape single quotes in CLI args for Bun runtime ([9550e4a](https://github.com/snomiao/claude-yes/commit/9550e4a24cf066ca015c741ff438d40cf04e66ed))

## [1.31.3](https://github.com/snomiao/claude-yes/compare/v1.31.2...v1.31.3) (2025-11-07)

### Bug Fixes

- CLI args parsing when CLI name detected from script name ([d603cac](https://github.com/snomiao/claude-yes/commit/d603cac47b78dbe35522d5d1a162ffede522aedb))

### [1.31.10](https://github.com/snomiao/claude-yes/compare/v1.31.9...v1.31.10) (2025-11-06)

### [1.31.9](https://github.com/snomiao/claude-yes/compare/v1.31.8...v1.31.9) (2025-11-06)

### [1.31.8](https://github.com/snomiao/claude-yes/compare/v1.31.7...v1.31.8) (2025-11-06)

### [1.31.7](https://github.com/snomiao/claude-yes/compare/v1.31.6...v1.31.7) (2025-11-06)

### [1.31.6](https://github.com/snomiao/claude-yes/compare/v1.31.5...v1.31.6) (2025-11-06)

### [1.31.5](https://github.com/snomiao/claude-yes/compare/v1.31.4...v1.31.5) (2025-11-06)

### [1.31.4](https://github.com/snomiao/claude-yes/compare/v1.31.2...v1.31.4) (2025-11-06)

## [1.31.2](https://github.com/snomiao/claude-yes/compare/v1.31.1...v1.31.2) (2025-11-06)

### Bug Fixes

- **package.json:** update from-node-stream dependency version from 0.1.0 to 0.1.2 to incorporate bug fixes and improvements ([b09a69d](https://github.com/snomiao/claude-yes/commit/b09a69d26a44786154c153017621ee67ecabacc1))

## [1.31.1](https://github.com/snomiao/claude-yes/compare/v1.31.0...v1.31.1) (2025-11-06)

### Bug Fixes

- **package.json:** reorder devDependencies and remove duplicate entries for @types/ms and ms ([d68b20d](https://github.com/snomiao/claude-yes/commit/d68b20db2a605c93c50c64615df1d4c7d93d605d))

# [1.31.0](https://github.com/snomiao/claude-yes/compare/v1.30.0...v1.31.0) (2025-11-06)

### Features

- enhance session management with codex session file parsing and retrieval ([2c92688](https://github.com/snomiao/claude-yes/commit/2c92688e73d0602c247047673e8835e60db257b5))

# [1.30.0](https://github.com/snomiao/claude-yes/compare/v1.29.2...v1.30.0) (2025-11-03)

### Features

- add Dockerfile and docker-compose.yaml for containerized setup ([f9f841f](https://github.com/snomiao/claude-yes/commit/f9f841ff7dbfdf51c8f99dad99ac144f36f386dc))

## [1.29.2](https://github.com/snomiao/claude-yes/compare/v1.29.1...v1.29.2) (2025-10-30)

### Bug Fixes

- **cli.ts:** update import statement for cliYes to use local module path for better compatibility ([7a199e3](https://github.com/snomiao/claude-yes/commit/7a199e357b31c81a1dbe7bf40f99d727e632c3c7))

## [1.29.1](https://github.com/snomiao/claude-yes/compare/v1.29.0...v1.29.1) (2025-10-30)

### Bug Fixes

- **pkg:** keep only module ([932cb3d](https://github.com/snomiao/claude-yes/commit/932cb3d015505beeeb83102269a047b51c3a881f))

# [1.29.0](https://github.com/snomiao/claude-yes/compare/v1.28.1...v1.29.0) (2025-10-30)

### Features

- detect and display sub-agent status using CLAUDE_PPID ([#20](https://github.com/snomiao/claude-yes/issues/20)) ([d0c968b](https://github.com/snomiao/claude-yes/commit/d0c968b02ed345b769444c103f8dce0a3fb53621))

## [1.28.1](https://github.com/snomiao/claude-yes/compare/v1.28.0...v1.28.1) (2025-10-29)

### Bug Fixes

- add from-node-stream as external dependency in build scripts ([3b0d414](https://github.com/snomiao/claude-yes/commit/3b0d414fdf81b22fc48ef40a8f40c53af6b69507))

# [1.28.0](https://github.com/snomiao/claude-yes/compare/v1.27.0...v1.28.0) (2025-10-29)

### Features

- add SKILL.md for Claude Skills integration ([#19](https://github.com/snomiao/claude-yes/issues/19)) ([0f3fa66](https://github.com/snomiao/claude-yes/commit/0f3fa663a39ce80c8711408529a5114e771e4541))

# [1.27.0](https://github.com/snomiao/claude-yes/compare/v1.26.0...v1.27.0) (2025-10-27)

### Features

- implement per-directory session restoration for codex ([4238062](https://github.com/snomiao/claude-yes/commit/423806229c28ebd185c3a8ccbea2603d42016deb))

# [1.26.0](https://github.com/snomiao/claude-yes/compare/v1.25.0...v1.26.0) (2025-10-26)

### Features

- **tests:** add bun test setup file and configuration for bun testing environment ([da53577](https://github.com/snomiao/claude-yes/commit/da5357798b4a194c8bbd0e15fd203a42272888ee))

# [1.25.0](https://github.com/snomiao/claude-yes/compare/v1.24.2...v1.25.0) (2025-10-26)

### Bug Fixes

- add missing semantic-release plugins ([#16](https://github.com/snomiao/claude-yes/issues/16)) ([575a56b](https://github.com/snomiao/claude-yes/commit/575a56b73034d183bf782ff6a3915d0081cd17d7))
- correct README formatting and package names ([#15](https://github.com/snomiao/claude-yes/issues/15)) ([9fab898](https://github.com/snomiao/claude-yes/commit/9fab8985b502383875e372eaa828fd73aa7bc59c))
- fix all failing tests and improve test infrastructure ([a9842c9](https://github.com/snomiao/claude-yes/commit/a9842c9342d0060473ca7bcc70d45297260f6eb0))
- fix: refine CLI args handling and error parsing\n\n- cli-yes.config.ts: treat 'unknown option' as a fatal error by recognizing /^error: unknown option/ in the fatal errors list.\n- ts/cli.ts: adjust argument spawning and dash prompt extraction:\n - only pass CLI args to the spawned process if argv.\_[0] is present; otherwise default to no args.\n - compute dashPrompt only when a dash marker is present; otherwise leave undefined. ([789f5b0](https://github.com/snomiao/claude-yes/commit/789f5b0e3b60711a78d4578981d9df49e30f556e))

### Features

- add multi-CLI support and improve configuration system ([c968ae0](https://github.com/snomiao/claude-yes/commit/c968ae0f4c5243d08bf25ad9b028156d5a3be126))
- **cli-yes.config.ts:** set defaultArgs to prevent opus model overload ([6e72ab3](https://github.com/snomiao/claude-yes/commit/6e72ab373f7ad85199d7c9c7d5a5d3038c926bcc))

# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [0.0.1](https://github.com/snomiao/claude-yes/compare/v1.17.1...v0.0.1) (2025-10-06)

### Features

- add cursor agent bin ([1ce23a9](https://github.com/snomiao/claude-yes/commit/1ce23a996cbdad50f57f39e814518c55843d33f9))
- Add cursor position support for codex ([c787c80](https://github.com/snomiao/claude-yes/commit/c787c80f0306c59a1168424657579426fe5b11bf))
- Add exit-on-idle option ([52ca331](https://github.com/snomiao/claude-yes/commit/52ca331b0acf03a04e99113e0f46a485e3257399))
- **cli:** parse idle durations with enhanced-ms ([1e4ef21](https://github.com/snomiao/claude-yes/commit/1e4ef21c2cbe4498fbf0357e21400bc208336900))
