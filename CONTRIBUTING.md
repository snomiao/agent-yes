# Contributing to agent-yes

Thanks for helping out! This guide applies to **human contributors and coding
agents alike**. If you are an AI agent working in this repository, treat this
file as instructions, together with [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md).

## Language: English only

Everything that lands in this repository or on its GitHub pages is written in
**English**:

- code, identifiers, and code comments
- docs, README sections, help text, and error messages
- commit messages
- pull request titles and bodies, review comments
- issue titles, bodies, and comments

This keeps the project readable for every maintainer and every user. If English
is not your first language, plain and simple English is perfectly fine; a
machine translation is better than no contribution. Coding agents: write
English even when your operator talks to you in another language.

(A few older files and issues predate this rule; you do not need to translate
them, but please do not add new non-English content.)

## Keep it public-safe

This repo is public. Tests, fixtures, comments, docs, commit messages, and
PR/issue bodies must use **synthetic data only**. Never paste real pids, agent
ids, paths, hostnames, share URLs, tokens, names of private projects, people's
names, prompts, or terminal transcripts from your own machines. Use neutral
stand-ins (`pid 1111`, `/repo/alpha`, `alice`) and describe the _mechanism_ of a
bug with a minimal repro instead. See [`CLAUDE.md`](CLAUDE.md) for details.

## Getting started

Prerequisites: [Bun](https://bun.sh) (latest), Node.js 22+, and — only for
changes under `rs/` — a stable Rust toolchain (`cargo`).

```bash
git clone https://github.com/<you>/agent-yes
cd agent-yes
bun install
```

Throwaway scripts, probes, and their output go in `./tmp/` (gitignored), not in
`scripts/` (which ships in the npm package).

## Build and test

```bash
bun run build          # ts/ -> dist/ (tsdown)
bun run typecheck      # tsgo --noEmit
bun run fmt            # oxlint --fix + oxfmt
bun run test           # vitest (unit tests, *.spec.ts)
bun run test:bun       # bun test (*.bun.spec.ts)
```

Rust changes (`rs/`):

```bash
(cd rs && cargo fmt --all --check)
(cd rs && cargo test)
bun run build:rs       # cargo install --path rs
```

To run your local build as the global `ay` / `cy`, use `bun run build && bun link`
(and `bun run build:rs` first for Rust changes). Be careful on a machine where
agents are already running from another checkout: `bun link` re-points the
global binaries for everyone on that machine.

On a busy or shared host, keep the test run light, e.g.
`nice bun run test -- --maxWorkers=1`.

Git hooks (husky) run lint-staged and a build on commit, and the full
`test:coverage` gate on push. CI on the pull request is the authoritative gate.

## liagent (`agent-yes/liagent`)

The chat box, its hub and the `liagent` CLI live in their own repository,
[snolab/liagent](https://github.com/snolab/liagent). agent-yes ships them as
`agent-yes/liagent` (and `/box`, `/client`, `/protocol`, `/hub`,
`/liagent.js`) plus the `liagent` bin. It pins a liagent release tag as a
devDependency, and `bun run build` copies that release's built files into
`dist/liagent/` (`ts/copyLiagent.ts`).

Change liagent itself in snolab/liagent. To ship a new liagent release here,
bump the one pin in a small PR:

```bash
bun add -d github:snolab/liagent#v0.2.0   # the new release tag
bun run build                             # dist/liagent/ from that release
```

## Pull requests

- One focused change per PR. Open an issue first for large or design-level
  changes.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages and PR titles (`feat(ls): …`, `fix(send): …`, `docs: …`).
  Releases are cut automatically from them by semantic-release, so do not bump
  `package.json` / `Cargo.toml` versions or edit `CHANGELOG.md` by hand.
- The TypeScript and Rust runtimes mirror each other in several places (for
  example the subcommand lists in `ts/subcommands.ts` and `rs/src/cli.rs`).
  When you change one, check whether the other needs the same change.

### PR checklist

- [ ] Written in English (title, body, commits, comments, docs)
- [ ] No real fleet data, secrets, tokens, or private names
- [ ] `bun run build`, `bun run typecheck`, and the relevant tests pass
- [ ] New behaviour has tests; bug fixes have a regression test
- [ ] `ay help` / README updated if a user-facing command or flag changed
- [ ] TS/Rust mirrors kept in sync, if applicable
- [ ] The PR body says **what** changed, **why**, and **how it was tested**

## Reporting issues

Please include the `ay --version` output, your OS, the CLI you wrap (claude,
codex, …), and a minimal, synthetic reproduction. Feature requests are welcome;
describe the problem you are trying to solve before the proposed solution.
