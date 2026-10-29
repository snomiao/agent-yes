import { describe, expect, it } from "vitest";
import { fillRoomAlias, roomAliasPlaceholder } from "./roomReplyAlias.ts";

const fleet = (room: string) => (room === "r1" ? "fleet" : undefined);

describe("fillRoomAlias", () => {
  it("fills the receiver's alias for the room into the header only", () => {
    const msg =
      `<ay-msg ab from claude — reply: ay send ${roomAliasPlaceholder("r1")}:worker-d:fc59 "...">\n` +
      `body mentions ${roomAliasPlaceholder("r1")} literally\n</ay-msg ab>`;
    const out = fillRoomAlias(msg, fleet);
    expect(out.split("\n")[0]).toContain(`reply: ay send fleet:worker-d:fc59 "..."`);
    expect(out).toContain(`body mentions <alias-for-room-r1> literally`);
  });

  it("leaves unknown rooms and non-envelope text alone", () => {
    const msg = `<ay-msg ab — reply: ay send <alias-for-room-r2>:m:1 "...">\nhi`;
    expect(fillRoomAlias(msg, fleet)).toBe(msg);
    expect(fillRoomAlias("<alias-for-room-r1>", fleet)).toBe("<alias-for-room-r1>");
  });
});
