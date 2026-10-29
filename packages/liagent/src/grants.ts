// The CLI's saved grant tokens (~/.config/liagent/grants.json), one per hub
// and scope, and its inbox of long messages. Both hold secrets or private
// text, so the directory is created 0700 and every file is written 0600 from
// the start — never readable by others, not even briefly.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Scope = "chat" | "eval";
type Grants = Record<string, { token: string; until: string }>;

/** Create `dir` (and parents) 0700, and tighten it if it already existed. */
export function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Write `text` to `path` as 0600, created that way (and tightened if it existed). */
export function privateWrite(path: string, text: string) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** One grant per hub and scope: chat keys are the hub URL alone (as before), eval ones "<hub> eval". */
const grantKey = (hub: string, scope: Scope) => (scope === "chat" ? hub : `${hub} eval`);

export function grantStore(file: string) {
  const read = (): Grants => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Grants;
    } catch {
      return {};
    }
  };
  const write = (g: Grants) => {
    privateDir(dirname(file));
    privateWrite(file, JSON.stringify(g, null, 2));
  };
  return {
    load: (hub: string, scope: Scope) => read()[grantKey(hub, scope)]?.token,
    save(hub: string, scope: Scope, token: string, until: number) {
      write({ ...read(), [grantKey(hub, scope)]: { token, until: new Date(until).toISOString() } });
    },
    forget(hub: string, scope: Scope) {
      const g = read();
      const k = grantKey(hub, scope);
      if (!(k in g)) return;
      delete g[k];
      write(g);
    },
  };
}

/** Save a long message to `<dir>/<id>.txt` (0600 in a 0700 dir) and return the path. */
export function spillTo(dir: string, id: string, text: string): string {
  privateDir(dir);
  const path = join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
  privateWrite(path, text);
  return path;
}
