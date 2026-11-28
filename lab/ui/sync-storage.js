// Shared with the account page so signing out also cleans a closed console.
export function clearDeviceCopies() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("ay.peerCopy.") || key === "ay.syncRemovals") localStorage.removeItem(key);
  }
  localStorage.removeItem("ay.peerOwner");
  let rooms;
  try {
    rooms = JSON.parse(localStorage.getItem("ay.rooms") || "{}");
  } catch {
    return;
  }
  if (!rooms || typeof rooms !== "object") return;
  for (const [name, room] of Object.entries(rooms)) {
    if (!room || typeof room !== "object") continue;
    if (room.syncImported) delete rooms[name];
    else if (room.syncId) {
      room.sync = false;
      delete room.syncId;
      delete room.updatedAt;
    }
  }
  if (localStorage.getItem("ay.rooms")) localStorage.setItem("ay.rooms", JSON.stringify(rooms));
}
