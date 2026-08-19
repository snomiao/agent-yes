import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnViaLocalDaemon } from "./localDaemonSpawn.ts";

describe("spawnViaLocalDaemon", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-daemon-spawn-"));
    previousHome = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = home;
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".serve-token"), "secret\n");
    await writeFile(
      path.join(home, "ayrs-http.json"),
      '{"pid":123,"port":31545}',
    );
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it("posts an authenticated plain-cwd spawn", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const result = await spawnViaLocalDaemon(
      { cli: "claude", cwd: "/work", prompt: "task" },
      {
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          seen = { url: String(url), init };
          return Response.json({
            ok: true,
            pid: 4242,
            cli: "claude",
            cwd: "/work",
          });
        }) as typeof fetch,
      },
    );
    expect(result?.pid).toBe(4242);
    expect(seen?.url).toBe("http://127.0.0.1:31545/api/spawn");
    expect(seen?.init?.headers).toMatchObject({
      authorization: "Bearer secret",
    });
    expect(JSON.parse(String(seen?.init?.body))).toEqual({
      cli: "claude",
      cwd: "/work",
      prompt: "task",
    });
  });

  it("uses the filesystem spool when sandbox networking is disabled", async () => {
    const spool = path.join(home, "spawn");
    await mkdir(spool);
    await writeFile(
      path.join(home, "ayrs-http.json"),
      JSON.stringify({ pid: 123, port: 31545, spool }),
    );
    const watcher = (async () => {
      for (let i = 0; i < 20; i++) {
        const requestName = (await readdir(spool)).find((name) =>
          name.endsWith(".request.json"),
        );
        if (requestName) {
          const request = JSON.parse(
            await readFile(path.join(spool, requestName), "utf8"),
          );
          expect(request.token).toBe("secret");
          expect(request.request.prompt).toBe("task");
          await writeFile(
            path.join(
              spool,
              requestName.replace(".request.json", ".response.json"),
            ),
            JSON.stringify({
              status: 200,
              body: JSON.stringify({
                ok: true,
                pid: 5252,
                cli: "claude",
                cwd: "/work",
              }),
            }),
          );
          return;
        }
        await Bun.sleep(20);
      }
      throw new Error("spool request did not appear");
    })();
    const result = await spawnViaLocalDaemon(
      { cli: "claude", cwd: "/work", prompt: "task" },
      {
        timeoutMs: 1000,
        fetch: (() => {
          throw new Error("network fallback must not run");
        }) as unknown as typeof fetch,
      },
    );
    await watcher;
    expect(result?.pid).toBe(5252);
  });

  it("falls back cleanly when discovery is missing or the daemon rejects", async () => {
    await rm(path.join(home, "ayrs-http.json"));
    await expect(
      spawnViaLocalDaemon(
        { cli: "claude", cwd: "/work" },
        {
          fetch: (() => {
            throw new Error("must not fetch");
          }) as unknown as typeof fetch,
        },
      ),
    ).resolves.toBeNull();

    await writeFile(
      path.join(home, "ayrs-http.json"),
      '{"pid":123,"port":31545}',
    );
    await expect(
      spawnViaLocalDaemon(
        { cli: "claude", cwd: "/work" },
        {
          fetch: (async () =>
            new Response("no", { status: 503 })) as unknown as typeof fetch,
        },
      ),
    ).resolves.toBeNull();
  });
});
