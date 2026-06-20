# Auth, Identity & Fine-Grained Permissions (design draft)

> Status: **design only — not implemented.** Captures the thinking from a design
> discussion (incl. a codex brainstorm) so we can resume later. Open decisions
> are marked **DEFERRED**. The companion map is [`lab/architecture.html`](../lab/ui/architecture.html)
> — this doc fleshes out its "④ Trust & discovery" plane.

## Problem

Today `ay serve` authenticates with a **single bearer token** (`ts/serve.ts`
`loadOrCreateToken` / `checkAuth`). It is all-or-nothing: anyone holding it has
full **read + write + spawn + kill** over **every** agent on the machine. For the
WebRTC path there is also an E2E secret `S` (the `#room:secret` fragment) — but
`S` only buys you into the encrypted channel; once in, you are an admin.

That is a fine bootstrap for "share my own console with myself across devices."
It is the wrong primitive the moment you want to share with **another person**:

- You cannot hand someone **view-only** access (watch, don't touch).
- You cannot hand someone **one agent** without exposing the whole machine.
- You cannot say **"only this Google account may sign in."**
- You cannot **revoke** one share without rotating the token for everyone.
- A leaked link is a full compromise, not a scoped one.

The goal: **the owner controls precisely who can read stdout, who can write
stdin, and who can kill / restart / spawn** — while keeping the "one link" UX and
the zero-knowledge relay, and **without bloating agent-yes core**. Much of the
richest policy (org RBAC, an identity provider) likely does **not** belong inside
agent-yes; it belongs in a host system that _embeds_ agent-yes. So the real
deliverable is the right **seam** plus a sane default.

## North star

> **agent-yes core owns the _mechanism_; the host owns the _policy_.**

Core owns: the verb taxonomy, the path→verb mapping, a pluggable `Authorizer`
checked inside the one `apiFetch` handler, capability verification, and
channel-binding primitives — plus a minimal default that covers the solo +
small-share cases. A larger host system (a SaaS, a team dashboard, an internal
tool) supplies identity + policy by replacing the `Authorizer`, and reuses
everything else (PTY, fabric, transports, E2E, console). That is what lets
agent-yes "become a lib/dep of other systems."

## Scenarios to support

The concrete situations this design must eventually cover (recorded now; not all
in the first cut):

1. **View-only share.** Send a link that can `ls` + `tail`/`read` but cannot send
   input or spawn/kill. (Demo a run; let a teammate watch.)
2. **Steer share.** Read **and** write stdin (answer a prompt, nudge the agent),
   but no spawn/kill. The everyday "help me drive this" link.
3. **Admin share.** Full control incl. spawn/kill — explicit and visually scary
   in the UI; not the default.
4. **Per-agent / per-repo scoping.** Share _one_ running agent (or every agent
   under one repo/cwd), not the whole machine. This should be the **default**
   scope of a shared link, not `machine`.
5. **Account-bound share (OAuth).** `snomiao@gmail.com` shares an agent such that
   **only** `ki.shouzet@gmail.com` (verified via Google) may sign in. Optionally a
   Google Workspace hosted-domain (`hd=acme.com`) instead of a single address.
6. **Time-boxed + revocable.** A link that expires (TTL) and/or can be revoked
   now (`ay shares revoke <id>`) without disturbing other shares.
7. **Multi-viewer, single-driver.** Several people watch; one holds the "steer"
   token; optional soft-lock / takeover so two people don't fight the stdin.
8. **Constrained spawn.** Allow spawning, but only into approved repos/cwds, only
   certain CLIs, with a max concurrency / TTL — never "spawn anything anywhere."
9. **Embedded host.** A separate product embeds agent-yes and authorizes via its
   own SSO + database; agent-yes contributes the transport/PTY API, not identity.
10. **Audit.** The owner can see _who did what_ (principal, action, target, time)
    without tokens appearing in logs.

## Capability model

**Atomic permissions** map directly to the `apiFetch` endpoint families:

| Permission     | Endpoints                                   | Risk                       |
| -------------- | ------------------------------------------- | -------------------------- |
| `agent:list`   | `GET /api/ls`, `/api/ls/subscribe`          | reveals existence/metadata |
| `agent:read`   | `GET /api/tail`, `/api/read`, `/api/status` | read PTY output/history    |
| `agent:write`  | `POST /api/send`                            | inject stdin / keystrokes  |
| `agent:resize` | `POST /api/resize`                          | low, but session control   |
| `agent:kill`   | `POST /api/kill`                            | stop a running agent       |
| `agent:spawn`  | `POST /api/spawn`                           | **create new processes**   |

**Roles** are just named permission sets:

- **viewer** = `list` + `read`
- **operator** = viewer + `write` + `resize`
- **admin** = operator + `kill` (+ `spawn`, see below)

**`spawn` is deliberately not folded into `operator`.** It is materially more
dangerous than steering one existing agent: it starts arbitrary tools, picks
cwd/model/env, multiplies cost/load, and creates a fresh privilege surface. It
requires either `machine` scope or an explicit **spawn template** scope.

**Scope** narrows _which_ agents a grant applies to:

```ts
type Permission =
  | "agent:list"
  | "agent:read"
  | "agent:write"
  | "agent:resize"
  | "agent:kill"
  | "agent:spawn";

type Scope =
  | { kind: "machine" } // every agent (== today's token)
  | { kind: "agent"; agentId: string } // one running agent  ← default for links
  | { kind: "repo"; root: string } // any agent whose cwd is in this repo
  | { kind: "cwd"; root: string } // any agent under a path subtree
  | {
      // constraints for agent:spawn
      kind: "spawn";
      cwdRoots: string[]; // allowed spawn dirs (canonicalized)
      agentKinds?: string[]; // e.g. ["claude","codex"]
      maxConcurrent?: number;
      ttlSec?: number;
    };

interface CapabilityGrant {
  permissions: Permission[];
  scope: Scope;
  expiresAt?: number; // unix seconds
  jti?: string; // id, for the revocation denylist
  caveats?: Record<string, unknown>; // e.g. { oidcEmail: "ki.shouzet@gmail.com" }
}
```

Opinionated defaults: a shared URL is **per-agent**, **viewer or operator**;
`admin`/`spawn` links are explicit. **`repo`/`cwd` scopes must canonicalize and
reject symlink/`..` traversal** — the easiest place to under-enforce.

## Keeping the "simple URL"

The capability rides in the **`#fragment`**, exactly where `S` already lives — so
the relay still learns nothing and the link is self-describing:

```
today:   https://agent-yes.com/w/#<room>:<secret>
future:  https://agent-yes.com/w/#ay1:<room>.<secret>.<capabilityToken>
```

**Pattern A (recommended): keep room-secret and capability separate, packaged in
one fragment.** The browser uses `secret` to join + derive E2E keys as today;
_after_ the encrypted channel is up it presents `capabilityToken` to `apiFetch`,
which verifies it locally. (Pattern B — derive room keys _and_ authz from one
secret via HKDF — is elegant but couples transport crypto to authorization;
**DEFERRED**, avoid early.)

What each party sees:

- **Relay / signaling DO:** room-match material + SDP/ICE ciphertext only. **No
  role, no agent id, no identity, no endpoint usage** — a viewer link and an admin
  link are indistinguishable on the wire.
- **Host:** the decrypted request + the capability token → authorizes per-verb.

**Viewer vs steer differ only inside the channel and at the boundary:** a viewer
_can_ send `POST /api/send` bytes, and the host returns **403**. Enforcement is at
`apiFetch`, never in the UI. The browser decodes the fragment locally only to
_hide_ controls it won't be allowed to use (UX, not security).

HTTP path keeps working: `Authorization: Bearer <token>` and `?token=` for SSE
stay accepted; add `Authorization: AY-Cap <capabilityToken>` (or reuse `Bearer`)
for the new envelope. Treat the legacy token as a root capability:

```ts
legacyBearer ⇒ { permissions: ["*"], scope: { kind: "machine" } }
```

## The pluggable authorizer seam

The seam sits **at the transport-agnostic `apiFetch` boundary** — the same place
both `Bun.serve` (HTTP) and the WebRTC bridge already converge (`ts/serve.ts`,
`ts/share.ts`). Authorization must **not** live in the HTTP layer, or the
in-process WebRTC bridge would bypass it.

```ts
type TransportKind = "http" | "webrtc";

interface AuthContext {
  transport: TransportKind;
  request: Request;
  now: number;
  credentials: Credential[]; // extracted from header/query/channel
  session?: { id: string; peerId?: string; e2e: boolean; transcriptHash?: Uint8Array };
  identity?: VerifiedIdentity; // filled in after OIDC, if any
}

type Credential =
  | { kind: "legacyBearer"; token: string }
  | { kind: "capability"; token: string }
  | { kind: "oidc"; idToken: string };

interface AccessRequest {
  // produced by a static route→(action,resource) map
  action: Permission;
  resource: {
    kind: "agent" | "machine" | "spawn";
    agentId?: string;
    cwd?: string;
    repoRoot?: string;
    agentKind?: string;
    command?: string[];
  };
}

interface Decision {
  allow: boolean;
  reason?: string;
  status?: number;
  principal?: Principal;
  audit?: Record<string, unknown>;
}

interface Authorizer {
  authenticate(ctx: AuthContext): Promise<Principal | null>;
  authorize(p: Principal | null, ar: AccessRequest, ctx: AuthContext): Promise<Decision>;
}
```

`apiFetch` becomes:

```ts
const ar = classify(req); // method+path → action + resource  (audited, deny-by-default)
const ctx = extractAuthContext(req, session);
const principal = await authorizer.authenticate(ctx);
const d = await authorizer.authorize(principal, ar, ctx);
if (!d.allow) return new Response(d.reason ?? "Forbidden", { status: d.status ?? 403 });
// ... existing handler ...
```

**Default impl** shipped by core (`DefaultAuthorizer`): accepts the legacy bearer
token as machine-admin; accepts capability tokens minted by `ay share` (signed by
a local serve key); optional loopback-without-auth for the desktop case; optional
in-memory/`jti` denylist. **No OAuth, no user DB, no orgs.** An embedding host
swaps the whole thing:

```ts
createAgentYesApi({ registry, ptyManager, authorizer: myCompanySso, auditLogger });
```

This is the library payoff: **core owns the agent transport/process API; the host
owns identity + policy.**

## Identity binding (OAuth / OIDC)

The E2E channel is **anonymous at connect time**; identity is proven _after_ the
channel exists, so the relay never sees it.

1. Owner mints a link with an allowlist caveat: `oidcIssuer=accounts.google.com`,
   `email=ki.shouzet@gmail.com` (or `hd=acme.com`).
2. Browser opens the link, establishes the E2E DataChannel (anonymous).
3. **Host** sends an encrypted `auth.challenge` over the channel: `{ nonce,
audience, allowedIssuers }`. The `nonce` is bound to the channel transcript.
4. Browser does Google sign-in (PKCE; ID-token only, no client secret needed).
5. Browser returns the `idToken` **over the E2E channel** (never to the relay).
6. **Host verifies** the ID token: JWKS signature, `iss`, `aud` (client id),
   `exp`, `nonce` (== channel nonce), `email`, `email_verified`, optional `hd`.
7. Host binds `session.identity = { issuer, subject, email }`; `authorize()` now
   requires **both** a valid capability **and** an identity matching the allowlist.

**Who verifies?** The **host machine**, always — the browser is the subject, not
an authorizer; a relay/broker verifying would leak the participant's identity and
couple auth to agent-yes.com infra. The host needs Google's JWKS (fetch + cache;
offline works while cached keys still validate).

**Where does the OAuth client live?** Two options (`DEFERRED` which is default):

- **A — agent-yes.com owns the OAuth client.** Easiest UX; Google sees a sign-in
  to "agent-yes.com", not the agent's contents; host checks `aud` == the known
  agent-yes client id. Good default for the hosted console.
- **B — host system provides its own OAuth client.** Required for orgs/embedded
  use. More setup. The `OidcProvider` is configurable.

Core supports generic OIDC verification; the console can default to (A); embedded
hosts configure (B). **Never** send identity to the signaling DO; **never** reuse
the room auth token as identity.

## Token formats

For _capabilities_ (host-issued, scoped, possibly attenuated):

| Format      | Fit for this use case                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- |
| Signed JWT  | Ubiquitous; great for **identity** (OIDC is JWT). Alg/aud footguns; attenuation unnatural.  |
| PASETO (v4) | JWT-without-footguns; simple signed scoped grants. **Good default** for local caps.         |
| Macaroons   | **Offline attenuation** + caveats ("share but narrowed"); HMAC → host-verifies; niche.      |
| Biscuit     | Public-key verify + Datalog caveats; most expressive; larger tokens; heavier for a default. |
| UCAN        | Built for user→user delegation (snomiao→ki.shouzet); DIDs/chains get big for URLs.          |

**Pick:** start with a **simple signed capability envelope (PASETO or equivalent)**
signed by the local serve key; adopt **macaroons/biscuit** later _if_ offline
attenuation ("recipient narrows a link without contacting the host") is wanted;
use **OIDC JWT only as an identity proof**, never as the capability itself.

```jsonc
// capability envelope (signed by the local ay-serve key, carried in the #fragment)
{
  "v": 1,
  "iss": "ay-local",
  "jti": "cap_8f2…",
  "role": "viewer",
  "perms": ["agent:list", "agent:read"],
  "scope": { "kind": "agent", "agentId": "…" },
  "exp": 1790000000,
  "oidc": { "iss": "https://accounts.google.com", "email": "ki.shouzet@gmail.com" },
}
```

## Threat model deltas

**Better than today:** a leaked viewer link can't write; an operator link can't
spawn/kill; a per-agent link doesn't expose the machine; OIDC-bound links are
useless without the account; the relay still can't read/inject if E2E holds.

**Top 3 ways this goes wrong:**

1. **Authz enforced in the UI, not `apiFetch`.** Hidden buttons but raw
   `POST /api/send` still works. → Every endpoint maps to an action and calls the
   `Authorizer`; deny by default.
2. **`spawn` treated like `write`.** An operator of one session spins up arbitrary
   agents anywhere. → `agent:spawn` is separate and needs explicit spawn
   constraints.
3. **Identity verified by the wrong party / bound weakly.** Browser self-asserts
   an email, or an ID token is replayed across sessions. → Host verifies the OIDC
   token and binds `nonce` to the E2E session; require `email_verified` + `aud`.

**Other deltas:** revocation is harder with self-contained links → short TTLs +
`jti` denylist + key rotation. Audit matters more → log principal/cap-id/action/
resource, **never full tokens**. `?token=` in URLs is legacy-risky (referrers,
logs) → keep for SSE compat, prefer header/channel for new flows. **E2E does not
protect against an _authorized_ malicious user** — `agent:write` can drive the
agent to run destructive commands; that is the wrapped CLI's sandbox's job, not
auth's.

## Phased rollout

- **Phase 1 — internal model, legacy-compatible (the keystone).** Add the
  `Authorizer` interface; normalize the old token → machine-admin principal; add
  the route→action map; enforce inside `apiFetch`. No user-facing change, but the
  seam now exists. _Highest value-to-complexity ratio._
- **Phase 2 — local capability links.** `ay share --agent <id> --role viewer|operator|admin
[--ttl 1h]` mints a signed `#ay1:…` link; `apiFetch` accepts old token **and**
  new cap.
- **Phase 3 — UI reflects capability.** Console decodes the fragment to hide
  unavailable controls (read-only terminal for viewers, etc.). Server still
  enforces.
- **Phase 4 — revocation & TTLs.** `ay shares list` / `ay shares revoke <id>`;
  `jti` denylist; default TTLs.
- **Phase 5 — OIDC-bound shares.** `ay share … --oidc-issuer … --email …`; the
  challenge/verify/bind flow above.
- **Phase 6 — library/host mode.** Stabilize `createAgentYesApi({ registry,
ptyManager, authorizer, auditLogger })` so external systems supply org RBAC /
  SSO / DB-backed invites / centralized audit. Core stays small.

## What stays out of agent-yes core

Explicitly **not** core (belongs to an embedding host, plugged in via the
`Authorizer` / `OidcProvider` seams):

- A user/identity **database**, org/team/group **RBAC**, invite flows, admin UI.
- Being an **identity provider** (core _consumes_ OIDC; it does not issue logins).
- Long-term **audit/compliance** storage and policy engines.

Core **does** own the verb taxonomy, the route→action map, the `Authorizer` seam

- minimal default, capability verification, and channel-binding primitives — the
  mechanism that makes all of the above _possible_ without prescribing an org model.

## Open questions (DEFERRED)

- Default OAuth client: agent-yes.com-owned (A) vs host-provided (B)?
- Capability format for v1: plain signed envelope vs PASETO vs macaroon?
- Multi-driver coordination (scenario 7): soft-lock, takeover, or just last-writer?
- Should `agent:list` leak cwd/repo/titles to a viewer, or a redacted subset?
- Where to persist shares/denylist under `~/.agent-yes/` (one file vs per-share)?

## Related

- [`lab/architecture.html`](../lab/ui/architecture.html) — the system map; this is its
  Trust & discovery plane.
- `ts/serve.ts` — `apiFetch`, `checkAuth`, `loadOrCreateToken` (today's token).
- `ts/share.ts`, `lab/ui/e2e.js`, `lab/ui/cf/worker.ts` — the E2E + signaling the
  fragment-borne capability must not regress.
- `lab/ui/blog/e2ee-share-links/index.html` — how the current E2E secret works.
- [`docs/provisioning.md`](./provisioning.md) — spawn/cwd resolution that
  `agent:spawn` scoping must cooperate with.
