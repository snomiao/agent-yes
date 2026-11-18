import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test.skipIf(process.platform === "win32")(
  "schedule list --json exports only timetable metadata",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-timetable-"));
    try {
      const store = path.join(dir, "schedules.json");
      await writeFile(
        store,
        JSON.stringify({
          entries: [
            {
              name: "reminder",
              cron: "5 10 * * *",
              tz: "UTC",
              enabled: false,
              message: "private example",
            },
          ],
        }),
      );
      const command = path.join(dir, "oxmgr");
      const rows = [
        {
          name: "agent-yes-cron-test",
          cron_restart: "0 8 * * *",
          args: ["private example"],
          env: { EXAMPLE: "private example" },
        },
        { name: "other-job", cron_restart: "0 9 * * *" },
      ];
      await writeFile(
        command,
        "#!/bin/sh\n[ \"$*\" = 'list --json' ] || exit 1\nprintf '%s\\n' '" +
          JSON.stringify(rows) +
          "'\n",
        { mode: 0o755 },
      );
      const run = () =>
        Bun.spawn([process.execPath, "ts/cli.ts", "schedule", "list", "--json"], {
          env: {
            ...process.env,
            PATH: dir + path.delimiter + process.env.PATH,
            AY_SCHEDULES_STORE: store,
            TZ: "UTC",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
      const ok = run();
      expect(await new Response(ok.stdout).json()).toEqual([
        {
          name: "agent-yes-cron-test",
          cron: "0 8 * * *",
          tz: "UTC",
          enabled: true,
        },
        { name: "reminder", cron: "5 10 * * *", tz: "UTC", enabled: false },
      ]);
      expect(await ok.exited).toBe(0);
      await writeFile(command, "#!/bin/sh\necho 'private example' >&2\nexit 1\n");
      const failed = run();
      expect(await new Response(failed.stdout).text()).toBe("");
      expect((await new Response(failed.stderr).text()).trim()).toBe("ay schedule: timetable unavailable");
      expect(await failed.exited).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
