// Setup file to provide jest-compatible globals in vitest
import { vi } from "vitest";

// Make jest globals available
(globalThis as any).jest = {
  mock: vi.mock,
  fn: vi.fn,
  spyOn: vi.spyOn,
  clearAllMocks: vi.clearAllMocks,
  resetAllMocks: vi.resetAllMocks,
  restoreAllMocks: vi.restoreAllMocks,
};

// Also make it available on global
(global as any).jest = (globalThis as any).jest;

// Second line of defence for the pre-push hook's own `unset` (see
// .husky/pre-push): a GIT_DIR inherited from any git hook/alias would send the
// specs' scratch-repo `git init`/`commit` into the real repo.
for (const name of [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]) {
  delete process.env[name];
}

// Pin the locale: yargs localizes its validation errors from LC_ALL/LANG, so on
// a non-English machine (e.g. LANG=ja_JP.UTF-8) specs asserting yargs' English
// messages ("Unknown argument: …") fail locally while passing on CI.
process.env.LC_ALL = "en_US.UTF-8";
