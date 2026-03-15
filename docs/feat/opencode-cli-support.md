# Opencode CLI support

## Goal

Add opencode CLI support alongside existing agents and keep CLI entrypoints consistent.

## Options considered

1. Minimal config + entrypoint

- Pros: smallest change set, low risk, keeps CLI list consistent, fast to ship.
- Cons: no extra validation or runtime diagnostics; assumes CLI is installed and behaves as expected.
- Best when: repo already relies on external CLIs and just needs a new entrypoint.

2. Config + entrypoint + runtime validation

- Pros: clearer errors when opencode is missing or misconfigured.
- Cons: more code paths and tests to maintain.
- Best when: users frequently misconfigure CLIs or need stronger guidance.

3. Separate plugin module for opencode

- Pros: clean separation, easier to extend with advanced behaviors.
- Cons: higher complexity, new module wiring, more refactors.
- Best when: multiple CLI variants need per-CLI behavior changes.

## Decision

Go with option 1. The codebase already treats CLIs as config-driven, so a minimal config + bin entrypoint fits existing patterns with minimal disruption.

## What changed

- Added opencode CLI config (install/help fields) in `agent-yes.config.ts`.
- Added `opencode-yes` bin entrypoint in `package.json`.
- Bumped `terminal-render` in `bun.lock` to align dependency expectations.
- Cleaned unused imports and a small stream callback ordering in `ts/index.ts`.

## Notes

- Pre-commit runs lint, build, and tests; all passed after fixing lint errors.
