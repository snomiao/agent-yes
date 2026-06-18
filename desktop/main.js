// agent-yes desktop (Electron) — offline shell around the local HTTP console.
//
// What this does, and why it works offline:
//   The web console at agent-yes.com needs the Cloudflare signaling DO only to
//   rendezvous a browser with a host on ANOTHER machine. On the desktop the
//   browser (this window) and the host (`ay serve`) live on the SAME machine, so
//   no WebRTC and no `s.agent-yes.com` are involved at all: we spawn
//   `ay serve --http` bound to 127.0.0.1 and point the window at it. The page
//   carries the auth token in the URL hash (`#k=<token>`); `ay`'s static routes
//   are unauthenticated (they hold no secrets) and every /api call sends the
//   token. Same UI assets as /w/, served straight from the installed CLI.
//
// Local models: `ay serve` just lists/tails/spawns the agent CLIs you already
// run (claude, codex, …). To run those against a local model, point the CLI at
// an OpenAI-compatible endpoint (LM Studio :1234, Ollama :11434) via env before
// launching this app — see README.md. The desktop shell itself needs no cloud.
const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");

// 127.0.0.1 only — the host must never be reachable off-box from the desktop app.
const HOST = "127.0.0.1";
// Token the page uses on every /api call. Hex like `ay`'s own generator.
const TOKEN = crypto.randomBytes(20).toString("hex");
const STARTUP_TIMEOUT_MS = 20_000;

/** @type {import("node:child_process").ChildProcess | null} */
let serveChild = null;
let serveExited = false;

// Resolve the command that runs the agent-yes CLI. Priority:
//   1. AY_BIN env — an explicit command ("ay", "/path/to/ay", or "bun /…/x.js").
//   2. Bundled copy shipped inside the packaged app (electron-builder
//      extraResources puts the CLI under resources/ay — see package.json build).
//   3. The repo's own dist when running from a source checkout (dev: `npm start`).
//   4. `ay` on PATH (a global `npm i -g agent-yes` / `bun link` install).
function resolveAyCommand() {
  // AY_BIN is the executable, used verbatim so paths with spaces survive; optional
  // AY_BIN_ARGS adds leading args (e.g. AY_BIN=bun AY_BIN_ARGS=/path/agent-yes.js).
  // AY_BIN_ARGS is whitespace-split, so each arg must be space-free — for a script
  // path containing spaces, point AY_BIN at a small wrapper script instead.
  if (process.env.AY_BIN) {
    const extra = (process.env.AY_BIN_ARGS || "").split(" ").filter(Boolean);
    return [process.env.AY_BIN, ...extra];
  }

  const bundled = path.join(process.resourcesPath || "", "ay", "dist", "agent-yes.js");
  if (fs.existsSync(bundled)) return ["bun", bundled];

  const repoDist = path.resolve(__dirname, "..", "dist", "agent-yes.js");
  if (fs.existsSync(repoDist)) return ["bun", repoDist];

  return ["ay"];
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until OUR agent-yes host answers — not merely "something is listening".
// We chose a free port then let go of it, so in the race window another local
// process could grab it. The token rides in the URL fragment (#k=…), which is
// never sent over HTTP but IS readable by JS on whatever page loads — so loading
// a foreign page here would hand it our token. Guard by hitting the
// token-authenticated /api/version: only the real `ay serve` started with THIS
// token returns a JSON {version}. A foreign listener 401s / returns junk and is
// rejected, so we never load (and never leak the token to) anything else.
async function waitForServer(port, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serveExited) return false;
    const ok = await new Promise((resolve) => {
      const req = http.get(
        { host: HOST, port, path: `/api/version?token=${token}`, timeout: 1000 },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return resolve(false);
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => {
            body += c;
            if (body.length > 4096) req.destroy();
          });
          res.on("end", () => {
            try {
              resolve(typeof JSON.parse(body).version === "string");
            } catch {
              resolve(false);
            }
          });
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

function startServe(port) {
  const [cmd, ...pre] = resolveAyCommand();
  const args = [
    ...pre,
    "serve",
    "--http",
    "--host",
    HOST,
    "--port",
    String(port),
    "--token",
    TOKEN,
  ];
  serveChild = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    // Windows resolves ay.cmd/bun.cmd only through a shell. The token is our own
    // hex, so there is nothing user-controlled to inject here.
    shell: process.platform === "win32",
  });
  serveChild.stdout?.on("data", (b) => process.stdout.write(`[ay] ${b}`));
  serveChild.stderr?.on("data", (b) => process.stderr.write(`[ay] ${b}`));
  serveChild.on("exit", (code, sig) => {
    serveExited = true;
    if (!app.isReady() || code === 0 || sig === "SIGTERM") return;
    dialog.showErrorBox(
      "agent-yes host stopped",
      `The local 'ay serve' process exited (code ${code ?? "?"}${sig ? ", " + sig : ""}).\n` +
        `Resolved command: ${[cmd, ...pre].join(" ")}\n\n` +
        `Make sure agent-yes is installed (npm i -g agent-yes) or set AY_BIN.`,
    );
  });
  serveChild.on("error", (err) => {
    serveExited = true;
    dialog.showErrorBox(
      "Could not start agent-yes",
      `Failed to launch '${cmd}': ${err.message}\n\n` +
        `Install the CLI (npm i -g agent-yes) or set AY_BIN to its path.`,
    );
  });
}

function killServe() {
  if (!serveChild || serveExited || serveChild.exitCode !== null) return;
  const pid = serveChild.pid;
  try {
    if (process.platform === "win32" && pid) {
      // On Windows we spawn through a shell (.cmd resolution), so SIGTERM to the
      // child would only kill cmd.exe and orphan bun/ay. taskkill /T kills the
      // whole tree.
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      serveChild.kill("SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: "#0d1117",
    title: "agent-yes",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Loading splash matching the console theme while `ay serve` warms up.
  win.loadURL(
    "data:text/html," +
      encodeURIComponent(
        `<body style="margin:0;background:#0d1117;color:#c9d1d9;font:16px system-ui;` +
          `display:flex;align-items:center;justify-content:center;height:100vh">` +
          `starting agent-yes…</body>`,
      ),
  );

  // Open real external links in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

async function boot() {
  const win = createWindow();
  let port;
  try {
    port = await findFreePort();
  } catch (e) {
    dialog.showErrorBox("agent-yes", `Could not find a free port: ${e.message}`);
    app.quit();
    return;
  }
  startServe(port);
  const up = await waitForServer(port, TOKEN, STARTUP_TIMEOUT_MS);
  if (!up) {
    if (!serveExited) {
      dialog.showErrorBox(
        "agent-yes",
        `The local host did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s.`,
      );
    }
    return;
  }
  if (!win.isDestroyed()) win.loadURL(`http://${HOST}:${port}/#k=${TOKEN}`);
}

// One window owns one `ay serve`; a second launch just focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(boot);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
  });
}

app.on("window-all-closed", () => {
  killServe();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", killServe);
app.on("will-quit", killServe);
process.on("exit", killServe);
