import { appendFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { GlobalPidRecord } from "../globalPidIndex.ts";
import { sendStream } from "./send.ts";

it("waits for this message's replay receipt, including interrupt and multiline framing", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ay-receipt-"));
  const record = { cwd, pid: 1111, log_file: path.join(cwd, "1111.raw.log") } as GlobalPidRecord;
  const file = path.join(cwd, "1111.events.jsonl");
  try {
    await writeFile(file, '{"type":"user","id":"old","text":"hello"}\n');
    let written: any[] = [];
    const receipt = await sendStream(record, "first\nsecond", {
      interrupt: true,
      timeoutMs: 500,
      write: async (payload) => {
        written = payload
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const user = written[1];
        await appendFile(
          file,
          JSON.stringify({ type: "user", id: "unrelated", text: "first\nsecond" }) + "\n",
        );
        setTimeout(
          () =>
            void appendFile(
              file,
              JSON.stringify({ type: "user", id: user.uuid, text: user.message.content }) + "\n",
            ),
          30,
        );
      },
    });
    expect(written[0]).toMatchObject({
      type: "control_request",
      request: { subtype: "interrupt" },
    });
    expect(written[1]).toMatchObject({
      type: "user",
      uuid: receipt,
      message: { content: "first\nsecond" },
    });
    let writes = 0;
    await expect(
      sendStream(record, "hello", {
        timeoutMs: 30,
        write: async () => {
          writes++;
        },
      }),
    ).rejects.toThrow("delivery is unknown");
    expect(writes).toBe(1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
