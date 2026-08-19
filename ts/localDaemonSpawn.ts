import { readFile, rename, unlink, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import { agentYesHome } from "./agentYesHome.ts";

type Discovery = { pid: number; port: number; spool?: string };

export type DaemonSpawnRequest = {
  cli: string;
  cwd: string;
  prompt?: string;
  yes?: boolean;
};

export type DaemonSpawnResult = {
  pid: number;
  cli: string;
  cwd: string;
};

function validDiscovery(value: unknown): value is Discovery {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Discovery>;
  return (
    Number.isInteger(v.pid) &&
    Number.isInteger(v.port) &&
    Number(v.pid) > 1 &&
    Number(v.port) > 0 &&
    Number(v.port) <= 65535 &&
    (v.spool === undefined ||
      (typeof v.spool === "string" && path.isAbsolute(v.spool)))
  );
}

async function spawnViaSpool(
  discovery: Discovery,
  token: string,
  request: DaemonSpawnRequest,
  timeoutMs: number,
): Promise<DaemonSpawnResult | null> {
  if (!discovery.spool) return null;
  const id = `${process.pid}-${randomUUID()}`;
  const requestPath = path.join(discovery.spool, `${id}.request.json`);
  const partialPath = `${requestPath}.tmp`;
  const responsePath = path.join(discovery.spool, `${id}.response.json`);
  try {
    await writeFile(partialPath, JSON.stringify({ token, request }), {
      mode: 0o600,
    });
    await rename(partialPath, requestPath);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = JSON.parse(await readFile(responsePath, "utf8")) as {
          status?: number;
          body?: string;
        };
        if (response.status !== 200 || typeof response.body !== "string")
          return null;
        const value = JSON.parse(response.body) as Partial<DaemonSpawnResult>;
        if (!Number.isInteger(value.pid) || Number(value.pid) <= 1) return null;
        return {
          pid: Number(value.pid),
          cli: typeof value.cli === "string" ? value.cli : request.cli,
          cwd: typeof value.cwd === "string" ? value.cwd : request.cwd,
        };
      } catch {
        await Bun.sleep(50);
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await Promise.allSettled([
      unlink(partialPath),
      unlink(requestPath),
      unlink(responsePath),
    ]);
  }
}

/**
 * Ask the installed ayrs daemon to spawn an agent outside the caller's sandbox.
 *
 * Returns null when no healthy daemon endpoint is discoverable. Callers then
 * preserve the historical direct-spawn fallback.
 */
export async function spawnViaLocalDaemon(
  request: DaemonSpawnRequest,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<DaemonSpawnResult | null> {
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 1500;
  try {
    const [rawDiscovery, rawToken] = await Promise.all([
      readFile(path.join(agentYesHome(), "ayrs-http.json"), "utf8"),
      readFile(path.join(agentYesHome(), ".serve-token"), "utf8"),
    ]);
    const discovery: unknown = JSON.parse(rawDiscovery);
    if (!validDiscovery(discovery)) return null;
    const token = rawToken.trim();
    if (!token) return null;

    const spoolResult = await spawnViaSpool(
      discovery,
      token,
      request,
      timeoutMs,
    );
    if (spoolResult) return spoolResult;

    const response = await fetchFn(
      `http://127.0.0.1:${discovery.port}/api/spawn`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) return null;
    const value = (await response.json()) as Partial<DaemonSpawnResult>;
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 1) return null;
    return {
      pid: Number(value.pid),
      cli: typeof value.cli === "string" ? value.cli : request.cli,
      cwd: typeof value.cwd === "string" ? value.cwd : request.cwd,
    };
  } catch {
    return null;
  }
}
