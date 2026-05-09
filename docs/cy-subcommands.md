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
cy send <keyword> <msg> [--code=enter|esc|ctrl-c|ctrl-y|ctrl-d|tab|none|raw:0xNN]
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
| `tab`                             | `\t`                       |
| `none` / 空                       | （何も付けない）           |
| `raw:0xNN`                        | 16 進指定の任意の 1 バイト |

エージェントが `fifo_file` を持たない（`--stdpush` を使わずに起動した
古い TS エージェント、あるいは FIFO 未対応プラットフォームで起動した
Rust エージェント）場合は明示的にエラーになる。

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
