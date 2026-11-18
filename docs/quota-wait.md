# Quota wait (`quota-wait` state)

Some CLIs end a turn with an account quota banner and then just sit at their
prompt. agy (Antigravity CLI) prints:

```text
⚠ Individual quota reached. Please upgrade your subscription to increase your
limits. Resets in 4m56s.
Error ID: 0000aaaa-1111-2222-3333-444455556666-1234
```

The request is dropped, and nothing asks for it again. With `quotaWait: true`
in a CLI's config (on for agy in `default.config.yaml`), the Rust runtime waits
the cap out instead:

1. **Detect.** A banner whose Error ID it has not seen before starts the wait.
   The line must start with the `⚠` glyph, so a message that only quotes the
   banner does not count. The same banner left on screen is not a new failure.
2. **Read `/usage`.** It types `/usage` once per wait and reads each
   `… Limit Remaining` percentage and its `Refreshes in` time, then closes the
   panel with Esc. When a limit is spent (under 0.5% left), its refresh time
   replaces the banner's `Resets in` if it is later. A spent weekly limit can
   outlast the banner's reset by days.
3. **Back off.** It resends the interrupted input after 1, 2, 4, 8 … minutes.
   No single wait runs past the expected reset. Once the reset time has
   passed, it resends every 30 s. Each new banner moves to the next step. A
   resend with no new banner for 30 s counts as recovered.
4. **Resend the interrupted input.** This is the last non-empty line sent to
   the agent (typed, or delivered by `ay send`), resent byte for byte. A bare
   Enter does not replace it. If that line went out more than 10 minutes before
   the banner, the cap hit mid-task, so a short "continue" line is sent
   instead of replaying a request that already ran. The launch prompt counts
   as input sent at start-up.
5. **Publish.** While the wait lasts, the pid record carries
   `quota_wait: { until, next_at, attempt }` (unix ms). `ay ls` and
   `ay status` show the `quota-wait` state and put the expected recovery
   time in the prompt column:
   `⏳ quota cap, back ~15:20 (next resend 15:02)`. The record is cleared on
   recovery and on exit. `ay status --wait` does not return on `quota-wait`,
   because the agent resumes by itself.
6. **Tell the sender.** When the wait starts, after reading `/usage`, it sends
   one `ay send` to the reply address in the latest `<ay-msg>` envelope (or in
   the launch prompt): `配额撞顶，预计 HH:MM 恢复 (…)`, which means "quota cap
   hit, expected back around HH:MM". The message keeps this wording because
   the operator asked for it.

The tracker in `rs/src/quota_wait.rs` is pure: time is passed in as arguments.
Its unit tests cover screen parsing, the backoff ladder and a full wait.
`rs/src/context.rs` carries out the keystrokes and the notice. The TS runtime
does not implement the wait. agy runs on the Rust runtime.
