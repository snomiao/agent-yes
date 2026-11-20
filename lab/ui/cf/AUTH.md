# Google sign-in

The apex Worker mounts Better Auth at `/api/auth/*`; `/auth/` is the sign-in
page. The `www` alias redirects to the apex before serving pages or APIs,
so sign-in and host-only session cookies use one origin. Signing in creates the Google-backed account on first use. Existing
terminal tokens, sharing links, signaling, and exposed applications retain
their existing authorization.

## Deployment configuration

- D1 binding: `AUTH_DB`. Apply `migrations/0001_better_auth.sql` before first use.
- Worker secrets: `BETTER_AUTH_SECRET` (at least 32 random characters),
  `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`. Supply them through the Worker
  secrets interface; never commit their values.
- Public variable: `BETTER_AUTH_URL=https://agent-yes.com`.
- Google OAuth client type: Web application. Register the exact authorized
  redirect URI `https://agent-yes.com/api/auth/callback/google`.

Use Wrangler's D1 migrations command for the configured binding. The Worker
never applies schema migrations during a public request. The migration was
generated against Better Auth 1.7.25 and is checked against its schema in tests.

For local development, set an explicit `BETTER_AUTH_URL=http://localhost:8787`
override and register `http://localhost:8787/api/auth/callback/google` with the
development Google client. Keep local secret values in an ignored development
secrets file. Non-apex production hosts are intentionally not trusted.

Start the local Worker without inferring its request origin from production
custom-domain routes:

```sh
cd lab/ui/cf
wrangler dev --port 8787 --infer-origin-from-routes=false
```

Without that flag, Wrangler rewrites incoming localhost URLs to the production
route's host, and the intentional auth origin check returns 404.

## Browser API

- `POST /api/auth/sign-in/social` with `{ "provider": "google", "callbackURL": "/w/" }`
  starts the OAuth flow and returns its redirect URL.
- `GET /api/auth/get-session` returns `{ user, session }` or `null`.
- `POST /api/auth/sign-out` with `{}` revokes the current session.

POST requests must carry the matching `Origin` header. Browser fetch requests
set it automatically. Responses are `no-store`; cookies on HTTPS use the
`__Host-agent-yes` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, and no Domain
attribute. This prevents exposed subdomains from setting parent-domain auth
cookies. OAuth failures return to `/auth/?error=…`.

Run the local backend checks with:

```sh
bun test tests/auth/backend.bun.spec.ts
```

The tests use synthetic data and an in-memory D1-compatible SQLite fixture;
they do not call Google or a deployed database.

## References

- [Better Auth Cloudflare guide](https://better-auth.com/docs/guides/cloudflare)
- [Better Auth Google provider](https://better-auth.com/docs/authentication/google)
- [Better Auth database schema](https://better-auth.com/docs/concepts/database)
