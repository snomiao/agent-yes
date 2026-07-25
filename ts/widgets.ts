// Aggregate entry for the agent-yes browser widgets: `import { AyTerminal,
// AyChannel } from "agent-yes/widgets"`.
//
// Named exports only — NO default export. The plural name means "the collection
// of widgets"; each individual widget also ships as its own singular subpath
// (`agent-yes/terminal`, `agent-yes/channels`) which is the tree-shakeable import
// to prefer when you only need one — the terminal widget inlines xterm.js and is
// heavy, so a chat-only page should import `agent-yes/channels` directly rather
// than pull this aggregate. The CDN keeps them as separate files too
// (/w/terminal.js, /w/channels.js).
export { AyTerminal } from "./terminal/browser.ts";
export type { AyTerminalInfo } from "./terminal/browser.ts";
export { AyChannel } from "./channels/browser.ts";
export type { AyChannelInfo } from "./channels/browser.ts";
