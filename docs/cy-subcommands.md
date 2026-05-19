# cy サブコマンド — エージェント一覧・閲覧・送信

`cy`（および `ay` / `agent-yes`）に、稼働中のエージェントを別端末から
操作するためのサブコマンドを追加した。koho の `terminal-ws` の設計思想
（セッション一覧、`@xterm/headless` による描画、キーで識別する入力）を
ファイルベースで再現したもので、デーモンは持たない。

## コマンド一覧

```
cy ls   [keyword] [--all] [--cwd <dir>] [--json]
cy read <keyword> [--latest] [--cwd <dir>]
cy cat  <keyword>                       # read のエイリアス
cy tail <keyword> [-n N] [--latest]     # 既定 N=96
cy head <keyword> [-n N] [--latest]     # 既定 N=96
cy send <keyword> <msg> [--code=enter|esc|ctrl-c|ctrl-y|ctrl-d|ctrl-\|tab|none|raw:0xNN]
cy attach <keyword> [--escape ctrl-\] [--latest] [--cwd <dir>]
cy stop <keyword> [--method=auto|graceful|double-ctrl-c]
```

## キーワード解決順

`<keyword>` は次の順で照合する。最初に一致した条件で確定する。

1. **PID 完全一致**（数字のみ）
2. **CWD の部分一致**（大小無視）
3. **CLI 名の完全一致**（`claude` / `codex` 等、大小無視）
4. **プロンプト本文の部分一致**（大小無視）

`ls` は一致したものを **すべて** 表示する。`read` / `tail` / `head` /
`send` は **複数一致したらエラー** にする（候補を最大 10 件表示）。
`--latest` を渡すと曖昧でも最新のものを採用する。

## レジストリ

`~/.agent-yes/pids.jsonl` を **TS / Rust 共通のグローバルインデックス** と
して使う。Rust 実装はもともとこのファイルに `pid_store` で書いており、
TS 側 `PidStore` も `register` / `updateStatus` 時に同じファイルへ
ミラーするようにした（snake_case スキーマで Rust とラウンドトリップ可
能）。

`cy ls` は次の二系統を読み、`pid` でマージ（後勝ち）する:

- `~/.agent-yes/pids.jsonl`（クロスランタイム）
- `<process.cwd()>/.agent-yes/pid-records.jsonl`（TS 旧来形式、過去の
  TS エージェントを後方互換で拾うため）

死んでいる PID と `status: exited` のレコードは既定で除外する。`--all`
で履歴も含めて表示する。

レジストリは追記専用 JSONL のため、長期間運用するとイベント行が
肥大化する。新しいエージェント起動時に行数が 500 を超えていたら
**自動でコンパクション** が走り、`pid` ごとに 1 行へ畳む（atomic
rename・ロック付き、ベストエフォート）。コンパクション時、`status:
exited` かつ既に死亡している PID はまるごと破棄される。手動で起動
したい場合は `maybeCompactGlobalPids()` を直接呼び出してもよい。

## `cy read|tail|head` の描画

各エージェントは生 PTY 出力を `<pid>.raw.log` に追記している（TS:
`<cwd>/.agent-yes/<pid>.raw.log`、Rust: `~/.agent-yes/<pid>.raw.log`）。
読み出し時には `@xterm/headless` の `Terminal` に丸ごと書き込み、`buffer.active`
を 1 行ずつ `translateToString` で取り出すことで、カーソル移動・行内
更新（Claude のスピナー、進捗表示など）を **最終的な画面状態** として
解決した上で出力する。`tail`/`head` のスクロールバックは要求行数分を
確保するため、長いセッションでも欠落しない。

`@xterm/headless` のロードに失敗した場合は ANSI 制御文字を正規表現で
除去するフォールバックに切り替わる（プラットフォーム互換のため）。

## `cy send` と FIFO IPC

各エージェントは起動時に `~/.agent-yes/fifo/<pid>.stdin`（Rust）あるいは
`<cwd>/.agent-yes/fifo/<pid>.stdin`（TS）に名前付きパイプを作成し、
`PidStore` の `fifo_file` 欄に登録する。`cy send <keyword> <msg>` は
このパスを引いて、メッセージ + 末尾コード（既定 `\r` = Enter）を書き込む。

Rust 側はパイプを **自プロセスで O_RDWR で開いたまま** にしているため、
外部の書き手が close しても EOF が立たず、`cy send` を何度でも繰り返し
呼べる（koho の `terminal-ws-lib.ts` と同じ手法）。受信側ではバイトを
ユーザの stdin と同じ `stdin_tx` チャンネルへ流すため、`/auto` 検出・
`Ctrl+C` 処理・`stdin_ready` ゲートはそのまま適用される。

`--code=` の値:

| 値                                | 送信される末尾バイト       |
| --------------------------------- | -------------------------- |
| `enter`（既定） / `cr` / `return` | `\r`                       |
| `esc` / `escape`                  | `\x1b`                     |
| `ctrl-c`                          | `\x03`                     |
| `ctrl-y`                          | `\x19`                     |
| `ctrl-d`                          | `\x04`                     |
| `ctrl-\` / `ctrl-backslash`       | `\x1c`                     |
| `tab`                             | `\t`                       |
| `none` / 空                       | （何も付けない）           |
| `raw:0xNN`                        | 16 進指定の任意の 1 バイト |

エージェントが `fifo_file` を持たない（`--stdpush` を使わずに起動した
古い TS エージェント、あるいは FIFO 未対応プラットフォームで起動した
Rust エージェント）場合は明示的にエラーになる。

## `cy attach` — 対話的アタッチ

`cy attach <keyword>` は、稼働中のエージェントに対して **双方向の
TTY 接続** を張る。`cy tail -f` がログを単方向で流すだけなのに対し、
`attach` はローカルのキー入力を FIFO 経由でエージェントに転送し、
ターミナルリサイズも伝搬する。オーケストレータ Claude が fan-out で
複数の subagent を回している最中に、人間が 1 つだけ介入したいとき
向けのコマンド。

接続シーケンス:

1. `log_file` の末尾を `@xterm/headless` でリプレイし、現在の画面を
   プレーンテキストで描き直す（フルスクリーン TUI を途中で覗いても
   壊れたフレームを見ずに済む）。
2. 自分の端末サイズを `~/.agent-yes/winsize/<pid>` に書き出し、
   エージェント本体に `SIGWINCH` を送る。Rust 側の SIGWINCH ハンドラは
   このファイルが新しければ（30 秒以内）ローカル ioctl より優先する。
3. ローカルの stdin を raw mode にして FIFO を keep-open でつかむ。
4. `log_file` を `fs.watch` + 100ms ポーリングで追従して stdout へ流す。

`--escape <name>` で離脱キーを指定する（既定 `ctrl-\` → `\x1c`）。
`--code` と同じ名前辞書を共有しているので `esc` / `ctrl-d` / `raw:0x1d`
なども渡せる。離脱してもエージェント本体は **kill されず継続** する。

複数の `attach` クライアントが同時にぶら下がっても問題ない: log file は
multi-reader、FIFO も multi-writer。ただし複数の人間が同時にタイプすると
バイトが **後勝ち / インターリーブ** になる点には注意。

既知の制限:

- フルスクリーン TUI に対する初期画面はリプレイ時点で **色情報が落ちる**
  （`@xterm/headless` の `translateToString(false)` を経由するため）。
  エージェントが次に再描画した瞬間に色は戻る。SIGWINCH 起因の再描画が
  ほとんどの CLI で発火するため実用上は気にならないことが多い。
- リサイズ伝搬は **Unix のみ**。Windows は SIGWINCH が存在しないため
  attach そのものが現状非対応。

## `cy stop` — graceful shutdown

`ay send <pid> "" --code=ctrl-c` で停止しようとするユーザが多いが、
`claude` / `codex` は **単発 Ctrl+C をキャンセル扱い** にして終了しない。
正しい止め方は次のいずれか:

| CLI      | graceful 終了            | 強制終了      |
| -------- | ------------------------ | ------------- |
| `claude` | `/exit` + Enter          | double Ctrl+C |
| `codex`  | `/exit` + Enter          | double Ctrl+C |
| `gemini` | `/quit` + Enter          | double Ctrl+C |
| その他   | （既知の graceful 無し） | double Ctrl+C |

`cy stop <keyword>` はこれを 1 コマンドにまとめる。既定の `--method=auto`
は `record.cli` を見て上の表に従って分岐し、未登録の CLI に対しては
double Ctrl+C にフォールバックする。明示したい場合:

- `--method=graceful` — `/exit` 系を強制（未登録 CLI ではエラー）
- `--method=double-ctrl-c` — 強制 Ctrl+C を 2 回（200ms 間隔）

`cy send <kw> "" --code=ctrl-c` を打った時にも、対象が `claude` /
`codex` / `gemini` ならヒント行が表示されて `ay stop` に誘導される。

## 実装ファイル

- `ts/subcommands.ts` — ルータ、`ls` / `read|tail|head|cat` / `send` の本体
- `ts/globalPidIndex.ts` — `~/.agent-yes/pids.jsonl` 共通リーダー / ライター
- `ts/pidStore.ts` — `register` / `updateStatus` でグローバルへミラー
- `ts/cli.ts` — `--rust` ディスパッチより前にサブコマンドを早期処理
- `rs/src/fifo.rs` — `mkfifo` + RDWR オープン + 後始末
- `rs/src/pid_store.rs` — `fifo_file` フィールド追加 + `register_with_fifo`
- `rs/src/context.rs` — FIFO リーダースレッドを `stdin_tx` へ流す
- `rs/src/main.rs` — エージェント起動前に FIFO 作成、終了時に unlink

## 関連設計メモ

- 計画と代替案の比較: `tmp/cy-multiplex-research.md`
  （Plan A: エージェントごとに HTTP / Plan B: 中央デーモン / Plan C: ファイル
  ベース。Plan C を採用した理由を記載）
- ROADMAP の項目 10「FIFO IPC」がこの変更で Rust 側もカバー済みになる。

## 既知の制限

- Windows ネームドパイプ版は TS のみ実装済み（Rust は未対応）
- TS / Rust の per-cwd / global インデックス併存は当面そのまま、`cy ls`
  読み出し側でマージして対応している。将来的にどちらかへ寄せる可能性あり
- `cy send` の同時呼び出しは POSIX の `PIPE_BUF`（4096 byte）以下なら
  原子的に書ける。それを超える長文を複数端末から同時に送ると混線する
  可能性がある（実用上は十分）
