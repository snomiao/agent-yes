// Minimal preload. The console is a plain web app talking to the local /api over
// http, so it needs nothing from Node here — we only expose a tiny, read-only
// marker so the page can tell it is running inside the desktop shell if it ever
// wants to (e.g. to hide "open in browser" affordances). Keep this surface small:
// contextIsolation is on and nodeIntegration is off by design.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("agentYesDesktop", {
  isDesktop: true,
  platform: process.platform,
});
