import { clearDeviceCopies } from "../w/sync-storage.js";

const API = "/api/auth";

export function safeReturnTo(value, origin = location.origin) {
  if (!value) return "/w/";
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) return "/w/";
    if (url.pathname.startsWith("/api/auth") || url.pathname === "/auth/") return "/w/";
    return url.pathname + url.search;
  } catch {
    return "/w/";
  }
}

export function initials(name) {
  return String(name || "Account")
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] || "")
    .join("")
    .toUpperCase();
}

async function authRequest(path, body) {
  const response = await fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Authentication is temporarily unavailable. Please try again.");
  return data;
}

export async function getSession() {
  const data = await authRequest("/get-session");
  return data?.user && data?.session ? data : null;
}

export async function signInWithGoogle(returnTo) {
  const data = await authRequest("/sign-in/social", {
    provider: "google",
    callbackURL: safeReturnTo(returnTo),
    errorCallbackURL: "/auth/?error=signin_failed",
  });
  if (!data?.url) throw new Error("Google sign-in could not start. Please try again.");
  const url = new URL(data.url, location.origin);
  if (url.protocol !== "https:" || url.hostname !== "accounts.google.com")
    throw new Error("Google sign-in returned an unexpected address. Please try again.");
  location.assign(url.href);
}

export async function signOut() {
  try {
    await authRequest("/sign-out", {});
  } catch {
    throw new Error("Sign-out could not be confirmed. Please try again.");
  }
  clearDeviceCopies();
  localStorage.setItem("ay.peerSignout", String(Date.now()));
  window.dispatchEvent(new Event("ay-auth-changed"));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export async function mountProfile(host) {
  host.classList.add("ay-account");
  const status = element("span", "ay-account-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const content = element("div", "ay-account-content");
  host.replaceChildren(content, status);
  let close = () => {};
  const load = async () => {
    close();
    content.replaceChildren(element("span", "ay-account-loading", "Account…"));
    status.textContent = "";
    let session;
    try {
      session = await getSession();
    } catch {
      const retry = element("button", "ay-account-signin", "Retry account");
      retry.type = "button";
      retry.addEventListener("click", load);
      content.replaceChildren(retry);
      status.textContent = "Account is temporarily unavailable.";
      return;
    }
    if (!session) {
      const link = element("a", "ay-account-signin", "Sign in");
      link.href =
        "/auth/?returnTo=" + encodeURIComponent(safeReturnTo(location.pathname + location.search));
      content.replaceChildren(link);
      return;
    }
    const user = session.user;
    const name = user.name || "Your account";
    const trigger = element("button", "ay-account-trigger");
    trigger.type = "button";
    trigger.setAttribute("aria-label", "Account menu for " + name);
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");
    trigger.append(
      element("span", "ay-account-avatar", initials(name)),
      element("span", "ay-account-label", name),
    );
    const chevron = element("span", "ay-account-chevron", "⌄");
    chevron.setAttribute("aria-hidden", "true");
    trigger.append(chevron);
    const panel = element("div", "ay-account-panel");
    panel.hidden = true;
    const identity = element("div", "ay-account-identity");
    identity.append(
      element("strong", "", name),
      element("span", "ay-account-email", user.email || ""),
    );
    const profile = element("a", "ay-account-item", "Your profile");
    profile.href = "/auth/";
    const logout = element("button", "ay-account-item", "Sign out");
    logout.type = "button";
    panel.append(identity, profile, logout);
    content.replaceChildren(trigger, panel);
    close = () => {
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      panel.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
    };
    trigger.addEventListener("click", () => (panel.hidden ? open() : close()));
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        open();
        profile.focus();
      }
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        (document.activeElement === profile ? logout : profile).focus();
      }
    });
    logout.addEventListener("click", async () => {
      logout.disabled = true;
      logout.textContent = "Signing out…";
      try {
        await signOut();
      } catch (error) {
        status.textContent = error.message;
        logout.disabled = false;
        logout.textContent = "Sign out";
      }
    });
  };
  document.addEventListener("click", (event) => {
    if (!host.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const wasOpen = content.querySelector('[aria-expanded="true"]');
      close();
      if (wasOpen) wasOpen.focus();
    }
  });
  host.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!host.contains(document.activeElement)) close();
    }, 0);
  });
  window.addEventListener("ay-auth-changed", load);
  await load();
}

for (const host of document.querySelectorAll("[data-ay-account]")) mountProfile(host);
