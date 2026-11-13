/** Keep ConPTY's private keyboard protocol local to its PTY boundary.
 * Forwarding DECSET 9001 to an outer Windows console turns VT input bytes
 * into literal-character INPUT_RECORDs, breaking arrows, paste and mouse.
 * This is output negotiation, not an input sanitizer. All app modes survive.
 */
export class ConptyModeFilter {
  private pending = "";
  feed(chunk: string): string {
    const text = this.pending + chunk;
    this.pending = "";
    let out = "",
      i = 0;
    while (i < text.length) {
      const start = text.indexOf("\x1b", i);
      if (start < 0) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, start);
      const rest = text.slice(start);
      if ("\x1b[?".startsWith(rest)) {
        this.pending = rest;
        break;
      }
      if (!rest.startsWith("\x1b[?")) {
        out += "\x1b";
        i = start + 1;
        continue;
      }
      let end = start + 3;
      while (end < text.length && /[0-9;]/.test(text[end])) end++;
      if (end === text.length && end - start < 256) {
        this.pending = rest;
        break;
      }
      const params = text.slice(start + 3, end).split(";");
      if ((text[end] === "h" || text[end] === "l") && params.includes("9001")) {
        const kept = params.filter((p) => p !== "9001");
        if (kept.length) out += "\x1b[?" + kept.join(";") + text[end];
        i = end + 1;
      } else {
        out += text.slice(start, end);
        i = end;
      }
    }
    return out;
  }
  finish(): string {
    const tail = this.pending;
    this.pending = "";
    return tail;
  }
}
