import { describe, expect, it } from "vitest";
import { defaultConnectAlias, parseShareUrl } from "./remotes.ts";
import {
  findTailscaleRoute,
  httpShareUrl,
  pickLanIp,
  planDaemonArgs,
  portlessInstallArgv,
  tailscaleDnsName,
  tailscaleServeArgv,
  tailscaleServeOffArgv,
} from "./shareCore.ts";

describe("planDaemonArgs", () => {
  it("fresh install per mode", () => {
    expect(planDaemonArgs(null, "local")).toEqual(["--port", "7432"]);
    expect(planDaemonArgs(null, "portless")).toEqual([]);
    expect(planDaemonArgs(null, "tailscale")).toEqual(["--port", "7432"]);
    expect(planDaemonArgs(null, "lan")).toEqual(["--port", "7432", "--host", "0.0.0.0"]);
    expect(planDaemonArgs(null, "webrtc")).toEqual(["--webrtc"]);
  });

  it("keeps an existing fitting config unchanged", () => {
    expect(planDaemonArgs(["--port", "9000"], "tailscale")).toEqual(["--port", "9000"]);
    expect(planDaemonArgs(["--share"], "webrtc")).toEqual(["--share"]);
    expect(planDaemonArgs(["--share", "--port", "9000"], "tailscale")).toEqual([
      "--share",
      "--port",
      "9000",
    ]);
  });

  it("adds a way without dropping the existing one", () => {
    // http daemon → also webrtc: keep HTTP on
    expect(planDaemonArgs(["--port", "9000"], "webrtc")).toEqual([
      "--port",
      "9000",
      "--http",
      "--webrtc",
    ]);
    // webrtc-only daemon → tailscale needs HTTP + a fixed port
    expect(planDaemonArgs(["--webrtc"], "tailscale")).toEqual([
      "--webrtc",
      "--http",
      "--port",
      "7432",
    ]);
  });

  it("lan rebinds a loopback host to 0.0.0.0", () => {
    expect(planDaemonArgs(["--host", "127.0.0.1", "--port", "1"], "lan")).toEqual([
      "--port",
      "1",
      "--host",
      "0.0.0.0",
    ]);
    expect(planDaemonArgs(["--host=0.0.0.0", "--port=1"], "lan")).toEqual([
      "--host=0.0.0.0",
      "--port=1",
    ]);
  });
});

describe("portless vs fixed port", () => {
  it("portless is the mode without --port; local pins one", () => {
    expect(planDaemonArgs(["--port", "9000"], "portless")).toEqual([]);
    expect(planDaemonArgs(["--webrtc"], "portless")).toEqual(["--webrtc", "--http"]);
    expect(planDaemonArgs([], "local")).toEqual(["--port", "7432"]);
    expect(planDaemonArgs([], "portless")).toEqual([]);
  });

  it("installs portless with npm, else bun", () => {
    expect(portlessInstallArgv((b) => b === "npm")).toEqual(["npm", "install", "-g", "portless"]);
    expect(portlessInstallArgv((b) => b === "bun")).toEqual(["bun", "add", "-g", "portless"]);
    expect(portlessInstallArgv(() => false)).toBeNull();
  });
});

describe("pickLanIp", () => {
  const iface = (address: string, internal = false) =>
    ({ address, family: "IPv4", internal, netmask: "", mac: "", cidr: null }) as any;
  it("skips loopback and tailscale CGNAT, returns a private address", () => {
    expect(
      pickLanIp({
        lo: [iface("127.0.0.1", true)],
        ts: [iface("100.64.0.9")],
        eth0: [iface("192.168.1.5")],
      }),
    ).toBe("192.168.1.5");
    expect(pickLanIp({ a: [iface("10.0.0.2")] })).toBe("10.0.0.2");
    expect(pickLanIp({ a: [iface("172.20.1.1")] })).toBe("172.20.1.1");
    expect(pickLanIp({ a: [iface("8.8.8.8")] })).toBeNull();
  });
});

describe("tailscale", () => {
  it("reads the MagicDNS name only when running", () => {
    expect(
      tailscaleDnsName({ BackendState: "Running", Self: { DNSName: "box.tailnet.ts.net." } }),
    ).toBe("box.tailnet.ts.net");
    expect(
      tailscaleDnsName({ BackendState: "Stopped", Self: { DNSName: "box.ts.net." } }),
    ).toBeNull();
    expect(tailscaleDnsName(null)).toBeNull();
  });

  const serve = (handlers: Record<string, string>) => ({
    Web: {
      "box.tailnet.ts.net:443": {
        Handlers: Object.fromEntries(Object.entries(handlers).map(([k, v]) => [k, { Proxy: v }])),
      },
    },
  });
  it("finds the /ay route to our port", () => {
    const dns = "box.tailnet.ts.net";
    expect(findTailscaleRoute(serve({ "/ay": "http://127.0.0.1:7432" }), dns, "/ay", 7432)).toEqual(
      {
        status: "ok",
      },
    );
    expect(
      findTailscaleRoute(serve({ "/ay/": "http://127.0.0.1:7432/" }), dns, "/ay", 7432),
    ).toEqual({
      status: "ok",
    });
    expect(findTailscaleRoute(serve({ "/other": "http://127.0.0.1:1" }), dns, "/ay", 7432)).toEqual(
      {
        status: "missing",
      },
    );
    expect(findTailscaleRoute(null, dns, "/ay", 7432)).toEqual({ status: "missing" });
    // wrong port, or a target path the server wouldn't route
    expect(
      findTailscaleRoute(serve({ "/ay": "http://127.0.0.1:1" }), dns, "/ay", 7432).status,
    ).toBe("conflict");
    expect(
      findTailscaleRoute(serve({ "/ay": "http://127.0.0.1:7432/ay" }), dns, "/ay", 7432).status,
    ).toBe("conflict");
  });
});

describe("tailscale commands", () => {
  it("are exactly what the [y/N] prompt shows", () => {
    expect(tailscaleServeArgv("/ay", 7432)).toEqual([
      "tailscale",
      "serve",
      "--bg",
      "--https=443",
      "--set-path=/ay",
      "http://127.0.0.1:7432",
    ]);
    expect(tailscaleServeOffArgv("/ay")).toEqual([
      "tailscale",
      "serve",
      "--https=443",
      "--set-path=/ay",
      "off",
    ]);
  });
});

describe("share URL round trip", () => {
  it("the console link is what ay connect parses", () => {
    const url = httpShareUrl("https://box.tailnet.ts.net/ay", "tok123");
    expect(url).toBe("https://box.tailnet.ts.net/ay/#k=tok123");
    expect(parseShareUrl(url)).toEqual({ url: "https://box.tailnet.ts.net/ay", token: "tok123" });
    expect(parseShareUrl("http://127.0.0.1:7432/#k=t")).toEqual({
      url: "http://127.0.0.1:7432",
      token: "t",
    });
    expect(parseShareUrl("https://h/ay/index.html#k=t")).toEqual({
      url: "https://h/ay",
      token: "t",
    });
  });

  it("accepts the legacy userinfo form and rejects tokenless URLs", () => {
    expect(parseShareUrl("http://tok@192.168.1.5:7432")).toEqual({
      url: "http://192.168.1.5:7432",
      token: "tok",
    });
    expect(parseShareUrl("https://box.ts.net/ay/")).toBeNull();
    expect(parseShareUrl("alias:kw")).toBeNull();
  });

  it("default alias is the host's short name", () => {
    expect(defaultConnectAlias("https://box.tailnet.ts.net/ay/#k=t")).toBe("box");
    expect(defaultConnectAlias("http://192.168.1.5:7432/#k=t")).toBe("192-168-1-5");
  });
});
