import { expect, test } from "bun:test";
import { SEND_MAX, deliveryText } from "../src/deliver.ts";

const hub = "https://example.com/api/chat";
const msg = (text: string, extra = {}) => ({
  id: "m1",
  from: "owner" as const,
  label: "/words Mozilla/5.0 (X11)",
  text,
  at: 0,
  ...extra,
});
const noSpill = () => {
  throw new Error("should not spill");
};

test("a short message: header with the reply command, then the text", () => {
  expect(deliveryText(hub, msg("fix it"), noSpill)).toBe(
    `[liagent m1] the user wrote in the chat box (/words) — reply: liagent say ${hub} "..."\nfix it`,
  );
});

test("a friend's message replies to their thread", () => {
  const t = deliveryText(
    hub,
    msg("hi", { from: "friend", email: "a@x.com", thread: "u1" }),
    noSpill,
  );
  expect(t).toContain("friend a@x.com wrote");
  expect(t).toContain(`liagent say ${hub} --to a@x.com "..."`);
});

test("a long one is spilled to a file and previewed within the send cap", () => {
  const spilled: string[] = [];
  const long = "x".repeat(4000);
  const t = deliveryText(hub, msg(long), (id, text) => {
    spilled.push(`${id}:${text.length}`);
    return "/inbox/m1.txt";
  });
  expect(spilled).toEqual(["m1:4000"]);
  expect(t.length).toBeLessThanOrEqual(SEND_MAX);
  expect(t).toEndWith("… (4000 chars; the whole message: /inbox/m1.txt)");
});
