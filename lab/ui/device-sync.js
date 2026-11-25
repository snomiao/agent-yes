import { exchange } from "./device-transfer.js";
import { clearDeviceCopies } from "./sync-storage.js";

const ownerKey = "ay.peerOwner",
  roomsKey = "ay.rooms",
  removedKey = "ay.syncRemovals";
const copyPrefix = "ay.peerCopy.v2.";
const read = (key) => JSON.parse(localStorage.getItem(key) || "{}");
const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const text = (v, limit) => typeof v === "string" && v.length <= limit;
const stamp = (v) => Number.isSafeInteger(v) && v > 0;
const id = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
function valid(copy) {
  return (
    copy?.version === 2 &&
    /^[0-9a-f-]{36}$/.test(copy.device) &&
    stamp(copy.time) &&
    Array.isArray(copy.removed) &&
    copy.removed.every((r) => r && id(r.id) && stamp(r.at)) &&
    Array.isArray(copy.rooms) &&
    copy.rooms.length <= 16 &&
    copy.rooms.every(
      (r) =>
        r &&
        r.name &&
        text(r.name, 160) &&
        !Object.hasOwn(Object.prototype, r.name) &&
        r.token &&
        text(r.token, 4096) &&
        text(r.host, 300) &&
        /^[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(r.host) &&
        stamp(r.updatedAt) &&
        id(r.syncId) &&
        Array.isArray(r.agents) &&
        r.agents.every((a) => a && Number.isSafeInteger(a.pid) && text(a.status, 64)) &&
        Array.isArray(r.schedules) &&
        r.schedules.every(
          (j) =>
            j && text(j.host, 160) && text(j.name, 200) && text(j.cron, 120) && text(j.tz, 100),
        ) &&
        Array.isArray(r.unavailable) &&
        r.unavailable.every((h) => text(h, 160)),
    )
  );
}

export function mountDeviceSync({
  dialog,
  loadRooms,
  collect,
  connect,
  disconnect,
  compatible,
  changed,
}) {
  let owner,
    transport,
    retry,
    generation = 0,
    delay = 1000;
  const status = dialog.querySelector("[role=status]");
  const list = dialog.querySelector(".checklist"),
    copies = dialog.querySelector(".copies");
  let imported = new Set();
  const report = (msg) => {
    status.textContent = msg;
  };
  const remembers = () => owner && localStorage.getItem(ownerKey) === owner;
  const canSelect = () => remembers() || (!navigator.onLine && !!localStorage.getItem(ownerKey));
  const session = async () => {
    const res = await fetch("/api/auth/get-session", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw Error();
    return (await res.json())?.user?.id || null;
  };
  function render() {
    const rooms = loadRooms();
    for (const name of imported) if (!Object.hasOwn(rooms, name)) disconnect(name);
    imported = new Set(Object.keys(rooms).filter((n) => rooms[n].syncImported));
    changed(!!canSelect());
    if (!dialog.open) return;
    list.replaceChildren();
    for (const name of Object.keys(rooms)) {
      const label = document.createElement("label"),
        box = document.createElement("input");
      box.type = "checkbox";
      box.checked = rooms[name].sync === true;
      box.disabled = !canSelect();
      box.onchange = () => toggle(name, box.checked);
      label.append(box, " Sync · " + name);
      list.append(label);
    }
    if (!list.childElementCount) list.textContent = "No saved rooms on this device.";
    copies.replaceChildren();
    const account = localStorage.getItem(ownerKey);
    if (!account) return;
    for (const key of Object.keys(localStorage).filter((k) =>
      k.startsWith(copyPrefix + account + "."),
    )) {
      const copy = read(key);
      for (const room of copy.rooms) {
        if (!rooms[room.name]?.sync || rooms[room.name].syncId !== room.syncId) continue;
        const section = document.createElement("section");
        const line = (tag, value) => {
          const el = document.createElement(tag);
          el.textContent = value;
          section.append(el);
        };
        line("h3", room.name);
        line("p", "Last synced " + new Date(copy.time).toLocaleString());
        for (const a of room.agents) line("div", "PID " + a.pid + " · " + a.status);
        for (const j of room.schedules)
          line(
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
        for (const h of room.unavailable) line("div", h + " · timetable unavailable");
        copies.append(section);
      }
    }
  }
  function stop() {
    generation++;
    clearTimeout(retry);
    transport?.stop();
    transport = null;
    owner = null;
  }
  function signout() {
    stop();
    clearDeviceCopies();
    render();
    report("Sign in to sync rooms.");
  }
  function retryLater() {
    clearTimeout(retry);
    retry = setTimeout(start, delay);
    delay = Math.min(60000, delay * 2);
  }
  async function start() {
    stop();
    const run = generation;
    try {
      const signed = await session();
      if (run !== generation) return;
      if (!signed) {
        signout();
        return;
      }
      if (localStorage.getItem(ownerKey) !== signed) clearDeviceCopies();
      // Manual-pairing snapshots predate room consent and cannot be republished.
      for (const key of Object.keys(localStorage))
        if (key.startsWith("ay.peerCopy.") && !key.startsWith(copyPrefix))
          localStorage.removeItem(key);
      localStorage.setItem(ownerKey, signed);
      owner = signed;
      const current = async (active) => {
        const signedIn = await session();
        if (generation !== run || !active()) return false;
        if (signedIn !== owner || !remembers()) {
          signout();
          return false;
        }
        return true;
      };
      let device = localStorage.getItem("ay.peerDevice");
      if (!device) localStorage.setItem("ay.peerDevice", (device = crypto.randomUUID()));
      transport = exchange(
        async (active) => {
          const selected = Object.entries(loadRooms()).filter(([, room]) => room.sync === true);
          const collected = await Promise.all(
            selected.map(async ([name, room]) => ({
              name,
              token: room.token,
              host: room.host,
              updatedAt: room.updatedAt,
              syncId: room.syncId,
              ...(await collect(name)),
            })),
          );
          if (!(await current(active))) throw Error();
          // Another tab can uncheck a room while schedules or the session are loading.
          const latest = loadRooms();
          const rooms = collected.filter(
            (r) =>
              latest[r.name]?.sync === true &&
              latest[r.name].syncId === r.syncId &&
              latest[r.name].updatedAt === r.updatedAt,
          );
          const removed = Object.entries(read(removedKey)).map(([id, at]) => ({ id, at }));
          const copy = { version: 2, device, time: Date.now(), rooms, removed };
          if (!valid(copy)) throw Error();
          return copy;
        },
        async (copy, active) => {
          if (!valid(copy) || copy.device === device || !(await current(active))) return false;
          const rooms = loadRooms(),
            removed = read(removedKey),
            incoming = [];
          for (const { id, at } of copy.removed) removed[id] = Math.max(removed[id] || 0, at);
          for (const r of Object.values(rooms)) {
            if (r.sync && removed[r.syncId] >= r.updatedAt) {
              r.sync = false;
              r.updatedAt = removed[r.syncId];
            }
          }
          const summaries = [];
          for (const r of copy.rooms) {
            const old = rooms[r.name];
            if (
              (removed[r.syncId] || 0) >= r.updatedAt ||
              !compatible(r) ||
              (old &&
                (old.token !== r.token ||
                  old.host !== r.host ||
                  (old.updatedAt || 0) > r.updatedAt)) ||
              (!old && Object.keys(rooms).length >= 16)
            )
              continue;
            rooms[r.name] = {
              ...old,
              token: r.token,
              host: r.host,
              ts: old?.ts || Date.now(),
              sync: true,
              syncImported: old ? !!old.syncImported : true,
              syncId: r.syncId,
              updatedAt: r.updatedAt,
            };
            incoming.push(r);
            summaries.push({
              name: r.name,
              syncId: r.syncId,
              agents: r.agents,
              schedules: r.schedules,
              unavailable: r.unavailable,
            });
          }
          write(removedKey, removed);
          write(roomsKey, rooms);
          write(copyPrefix + owner + "." + copy.device, { time: copy.time, rooms: summaries });
          for (const r of incoming) connect(r);
          render();
          return true;
        },
        report,
        (renew) => {
          if (renew) delay = 1000;
          if (run === generation) retryLater();
        },
      );

      report("Sync is on. Open the console on another signed-in device.");
      render();
    } catch {
      if (generation === run) {
        report("Offline · showing copies saved on this device.");
        render();
        retryLater();
      }
    }
  }
  function uncheck(name) {
    const rooms = loadRooms(),
      r = rooms[name];
    if (!r?.sync) return;
    const removed = read(removedKey);
    r.updatedAt = Math.max(Date.now(), r.updatedAt + 1);
    removed[r.syncId] = r.updatedAt;
    r.sync = false;
    write(removedKey, removed);
    write(roomsKey, rooms);
    transport?.refresh();
    render();
  }
  const pendingChecks = new Map();
  async function toggle(name, checked) {
    if (!canSelect()) return;
    const attempt = Symbol();
    pendingChecks.set(name, attempt);
    if (!checked) return uncheck(name);
    const original = loadRooms()[name],
      run = generation;
    if (!original || original.sync) return;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([name, original.host, original.token])),
    );
    const syncId = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    const rooms = loadRooms(),
      r = rooms[name];
    if (
      !canSelect() ||
      generation !== run ||
      pendingChecks.get(name) !== attempt ||
      !r ||
      r.host !== original.host ||
      r.token !== original.token
    )
      return;
    Object.assign(r, {
      sync: true,
      syncId,
      updatedAt: Math.max(Date.now(), (r.updatedAt || 0) + 1, (read(removedKey)[syncId] || 0) + 1),
    });
    write(roomsKey, rooms);
    transport?.refresh();
    render();
  }
  dialog.querySelector(".forget").onclick = () => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("ay.peerCopy.")) localStorage.removeItem(key);
    render();
    report("Offline snapshots cleared. Connected devices can send fresh snapshots.");
  };
  dialog.querySelector(".close").onclick = () => dialog.close();
  window.addEventListener("ay-auth-changed", signout);
  window.addEventListener("online", start);
  window.addEventListener("offline", () => {
    stop();
    report("Offline · showing copies saved on this device.");
    render();
  });
  window.addEventListener("storage", (e) => {
    if (e.key === "ay.peerSignout") {
      stop();
      render();
    } else if (e.key === ownerKey && owner && !remembers()) {
      stop();
      render();
      if (localStorage.getItem(ownerKey)) void start();
    } else if (e.key === roomsKey && e.newValue !== e.oldValue) render();
  });
  render();
  void start();
  return {
    toggle,
    uncheck,
    render,
    open() {
      dialog.showModal();
      render();
    },
  };
}
