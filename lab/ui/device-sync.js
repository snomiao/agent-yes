import { exchange } from "./device-transfer.js";

const prefix = "ay.peerCopy.";
const ownerKey = "ay.peerOwner";
const deviceKey = "ay.peerDevice";
const text = (v, size) => typeof v === "string" && v.length <= size;
function valid(s) {
  return (
    s?.version === 1 &&
    /^[0-9a-f-]{36}$/.test(s.device) &&
    Number.isSafeInteger(s.time) &&
    Array.isArray(s.rooms) &&
    s.rooms.length <= 16 &&
    s.rooms.every(
      (r) =>
        r &&
        text(r.name, 160) &&
        r.name &&
        !Object.hasOwn(Object.prototype, r.name) &&
        text(r.token, 4096) &&
        r.token &&
        text(r.host, 300) &&
        (r.host === "codehost" || /^[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(r.host)) &&
        Number.isSafeInteger(r.ts),
    ) &&
    Array.isArray(s.agents) &&
    s.agents.length <= 2000 &&
    s.agents.every(
      (a) => a && text(a.room, 160) && Number.isSafeInteger(a.pid) && text(a.status, 64),
    ) &&
    Array.isArray(s.schedules) &&
    s.schedules.length <= 512 &&
    s.schedules.every(
      (j) =>
        j &&
        (j.enabled === undefined || typeof j.enabled === "boolean") &&
        text(j.host, 160) &&
        text(j.name, 200) &&
        text(j.cron, 120) &&
        text(j.tz, 100),
    ) &&
    Array.isArray(s.unavailable) &&
    s.unavailable.length <= 512 &&
    s.unavailable.every((h) => text(h, 160))
  );
}

export function mountDeviceSync({ dialog, getLocal, connect }) {
  const status = dialog.querySelector("[role=status]");
  const content = dialog.querySelector(".copies");
  const start = dialog.querySelector(".pair");
  let revision = 0,
    stop;
  const report = (msg) => {
    status.textContent = msg;
  };
  const cancel = () => {
    revision++;
    stop?.();
    stop = undefined;
    start.disabled = false;
  };
  function forget() {
    cancel();
    for (const key of Object.keys(localStorage))
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    localStorage.removeItem(ownerKey);
    content.replaceChildren();
  }
  const session = async () => {
    const res = await fetch("/api/auth/get-session", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw Error();
    return (await res.json())?.user?.id;
  };
  function render(owner) {
    content.replaceChildren();
    if (!owner || localStorage.getItem(ownerKey) !== owner) return;
    for (const key of Object.keys(localStorage).filter((k) => k.startsWith(prefix + owner + "."))) {
      let copy;
      try {
        copy = JSON.parse(localStorage.getItem(key));
      } catch {
        continue;
      }
      if (!valid(copy)) continue;
      const freshRooms = copy.rooms.filter((r) => Date.now() - r.ts <= 90 * 86400000);
      if (freshRooms.length !== copy.rooms.length) {
        copy.rooms = freshRooms;
        localStorage.setItem(key, JSON.stringify(copy));
      }
      const section = document.createElement("section");
      const add = (tag, value) => {
        const el = document.createElement(tag);
        el.textContent = value;
        section.append(el);
        return el;
      };
      add("h3", "Device " + copy.device.slice(0, 8));
      add("p", "Last synced " + new Date(copy.time).toLocaleString());
      for (const r of copy.rooms) {
        const b = add("button", "Connect to " + r.name);
        b.onclick = async () => {
          if (localStorage.getItem(ownerKey) !== owner) return;
          if (await connect(r)) dialog.close();
          else report("A different saved room already uses that name.");
        };
      }
      for (const a of copy.agents) add("div", a.room + " · PID " + a.pid + " · " + a.status);
      for (const j of copy.schedules)
        add(
          "div",
          j.host +
            " · " +
            j.name +
            " · " +
            j.cron +
            " (" +
            j.tz +
            ")" +
            (j.enabled === false ? " · paused" : ""),
        );
      for (const host of copy.unavailable) add("div", host + " · timetable unavailable");
      content.append(section);
    }
  }
  start.onclick = async () => {
    cancel();
    const run = revision;
    start.disabled = true;
    try {
      const owner = await session();
      if (run !== revision) return;
      if (!owner) {
        forget();
        report("Sign in to pair devices.");
        return;
      }
      if (localStorage.getItem(ownerKey) !== owner) {
        for (const key of Object.keys(localStorage))
          if (key.startsWith(prefix)) localStorage.removeItem(key);
      }
      localStorage.setItem(ownerKey, owner);
      let device = localStorage.getItem(deviceKey);
      if (!device) localStorage.setItem(deviceKey, (device = crypto.randomUUID()));
      report("Waiting for your other device. Choose Sync now there too.");
      const current = async () =>
        (await session()) === owner && revision === run && localStorage.getItem(ownerKey) === owner;
      stop = exchange(
        async () => {
          const snapshot = { ...(await getLocal()), version: 1, time: Date.now(), device };
          if (!valid(snapshot) || !(await current())) throw Error();
          return snapshot;
        },
        async (copy, active) => {
          if (!valid(copy) || copy.device === device || !(await current())) throw Error();
          if (!active()) return false;
          localStorage.setItem(prefix + owner + "." + copy.device, JSON.stringify(copy));
          render(owner);
          return true;
        },
        (msg) => {
          if (run === revision) {
            report(msg);
            start.disabled = false;
          }
        },
      );
    } catch {
      if (run === revision) {
        report("Sync unavailable. Your local console is ready to use.");
        start.disabled = false;
      }
    }
  };
  dialog.querySelector(".forget").onclick = () => {
    forget();
    report("Saved device copies cleared.");
  };
  dialog.querySelector(".close").onclick = () => dialog.close();
  dialog.onclose = cancel;
  window.addEventListener("ay-auth-changed", forget);
  window.addEventListener("storage", (e) => {
    if (e.key === ownerKey || e.key === "ay.peerSignout") {
      cancel();
      render(localStorage.getItem(ownerKey));
    }
  });
  return async () => {
    report("");
    content.replaceChildren();
    dialog.showModal();
    const run = revision;
    let owner = localStorage.getItem(ownerKey);
    try {
      const signed = await session();
      if (run !== revision) return;
      if (!signed || (owner && signed !== owner)) {
        forget();
        owner = null;
      }
    } catch {
      if (run === revision) report("Offline · showing copies saved on this device.");
    }
    if (dialog.open) render(owner);
  };
}
