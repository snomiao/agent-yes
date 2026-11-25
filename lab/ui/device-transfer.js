// Each round exchanges one snapshot in each direction. Only connection setup
// uses the account-scoped socket. All snapshot frames stay on the data channel.
export function exchange(snapshot, receive, report, disconnected) {
  const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/api/device-pair");
  const peers = new Map();
  let stopped = false;
  function begin({ peer, round, offer }) {
    peers.get(peer)?.close();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    let iceTimer,
      sent = false;
    const active = () => !stopped && peers.get(peer)?.round === round;
    function close() {
      clearTimeout(timer);
      clearTimeout(iceTimer);
      if (active()) peers.delete(peer);
      pc.close();
    }
    const timer = setTimeout(close, 35000);
    peers.set(peer, { round, pc, close });
    function signal() {
      if (!active() || sent || !pc.localDescription || ws.readyState !== WebSocket.OPEN) return;
      sent = true;
      const { type, sdp } = pc.localDescription;
      ws.send(JSON.stringify({ type, peer, round, sdp }));
    }
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) signal();
      else iceTimer ??= setTimeout(signal, 5000);
    };
    function channel(dc) {
      let buffer = "",
        saved = false,
        acknowledged = false;
      dc.onopen = async () => {
        try {
          const data = JSON.stringify(await snapshot(active));
          if (!active()) return;
          if (data.length > 1024 * 1024) throw Error();
          // 4K UTF-16 units fit below the WebRTC 16 KiB message floor.
          for (let i = 0; i < data.length; i += 4096)
            dc.send(JSON.stringify(data.slice(i, i + 4096)));
          dc.send("end");
        } catch {
          close();
        }
      };
      dc.onmessage = async ({ data }) => {
        try {
          if (!active()) return;
          if (data === "ack") acknowledged = true;
          else if (data === "end") {
            const copy = JSON.parse(buffer);
            buffer = "";
            if (!(await receive(copy, active)) || !active()) return;
            saved = true;
            dc.send("ack");
          } else {
            const part = JSON.parse(data);
            if (
              typeof part !== "string" ||
              part.length > 4096 ||
              buffer.length + part.length > 1024 * 1024
            )
              throw Error();
            buffer += part;
          }
          if (saved && acknowledged) report("Devices are up to date.");
        } catch {
          close();
        }
      };
      dc.onerror = close;
      dc.onclose = close;
    }
    pc.ondatachannel = (e) => channel(e.channel);
    if (offer) {
      channel(pc.createDataChannel("device-sync"));
      return pc.setLocalDescription();
    }
  }
  ws.onmessage = async ({ data }) => {
    let link;
    try {
      const msg = JSON.parse(data);
      if (msg.type === "start") {
        await begin(msg);
        return;
      }
      link = peers.get(msg.peer);
      if (!link || link.round !== msg.round) return;
      await link.pc.setRemoteDescription({ type: msg.type, sdp: msg.sdp });
      if (msg.type === "offer") await link.pc.setLocalDescription();
    } catch {
      link?.close();
    }
  };
  function clear() {
    for (const link of peers.values()) link.close();
    peers.clear();
  }
  ws.onclose = ({ code }) => {
    clear();
    if (!stopped) disconnected(code === 1000);
  };
  return {
    refresh() {
      clear(); // invalidate in-flight snapshots as soon as selection changes
      if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"refresh"}');
    },
    stop() {
      clear();
      stopped = true;
      ws.close();
    },
  };
}
