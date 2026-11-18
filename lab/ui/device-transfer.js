// One opt-in exchange between two browsers. The socket carries only SDP.
// WebRTC encrypts the data channel between the negotiated endpoints.
export function exchange(snapshot, receive, report) {
  const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/api/device-pair");
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  let connected = false,
    ended = false,
    received = false,
    acknowledged = false,
    sent = false;
  let candidateTimer,
    descriptionSent = false;
  const timeout = setTimeout(
    () => finish("Pairing timed out. Start again on both devices."),
    85000,
  );
  function finish(message) {
    if (ended) return;
    ended = true;
    clearTimeout(timeout);
    clearTimeout(candidateTimer);
    pc.close();
    ws.close();
    report(message);
  }
  function channel(dc) {
    dc.onopen = async () => {
      connected = true;
      try {
        const data = JSON.stringify(await snapshot());
        if (ended) return;
        if (
          new TextEncoder().encode(data).length > Math.min(pc.sctp?.maxMessageSize || 65536, 65536)
        )
          throw new Error();
        dc.send(data);
        sent = true;
      } catch {
        finish("Could not send this device’s snapshot.");
      }
    };
    dc.onmessage = async ({ data }) => {
      try {
        if (ended) return;
        if (data === "ack" && sent) acknowledged = true;
        else {
          if (
            received ||
            typeof data !== "string" ||
            data.length > 65536 ||
            new TextEncoder().encode(data).length > 65536
          )
            throw new Error();
          const saved = await receive(JSON.parse(data), () => !ended);
          if (ended || !saved) return;
          received = true;
          dc.send("ack");
        }
        if (received && acknowledged) finish("Both devices saved their copies.");
      } catch {
        finish("Could not save the device snapshot.");
      }
    };
    dc.onclose = () => finish("Device connection closed.");
    dc.onerror = () => finish("Device connection interrupted.");
  }
  pc.ondatachannel = (e) => channel(e.channel);
  function sendDescription() {
    if (descriptionSent || ended || ws.readyState !== WebSocket.OPEN) return;
    descriptionSent = true;
    clearTimeout(candidateTimer);
    ws.send(JSON.stringify(pc.localDescription));
  }
  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) sendDescription();
    // A blocked STUN server can delay ICE completion even when both peers
    // already have usable local addresses. Give it time to find a public one.
    else if (!candidateTimer) candidateTimer = setTimeout(sendDescription, 6000);
  };
  ws.onmessage = async ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "start") {
        channel(pc.createDataChannel("device-sync"));
        await pc.setLocalDescription(await pc.createOffer());
      } else {
        await pc.setRemoteDescription(msg);
        if (msg.type === "offer") await pc.setLocalDescription(await pc.createAnswer());
      }
    } catch {
      finish("Could not connect these devices.");
    }
  };
  ws.onerror = () => finish("Pairing unavailable. Check your sign-in and connection.");
  ws.onclose = () => {
    if (!connected) finish("Pairing closed. Try again on both devices.");
  };
  return () => finish("Sync stopped.");
}
