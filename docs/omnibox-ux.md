# Console omnibox — UX spec

Status: agreed design, not yet built (2026-11-01). Merges the console's filter
box and its Cmd+K palette into ONE input.

Today there are two input surfaces in `lab/ui/index.html`:

| surface | what it is |
| --- | --- |
| `#q` (`:2219`) | always-visible filter box in the left header, `autofocus`. Grammar lives in `matchesQuery` (`lab/ui/console-logic.js:460`): space = AND, bare tokens match a haystack (pid / cli / cwd / status / host / room / dirty), plus `key:value` tags — `room:`, `device:`/`dev:`, `user:`, and dynamic ones like `repo:`. Persisted in `localStorage` under `ay.filter` (`:6280`). |
| `#omni` (`:2547`) | Cmd+K modal palette: free-text agent search with workspace rows mixed in, `↑↓` preview that swaps the terminal to the highlighted agent (restoring on Esc), `⏎` open, `⌘⏎` spawn here. Slash commands `/restart`, `/kill` (both act on `omniAnchor()` — the agent open when the palette launched, deliberately pinned so arrowing around does not move the target), `/fork [topic]`, `/ws`, `/new`, `/filter [tokens…]` (`:7507`, writes its args into `#q`). Unknown `/foo` already falls through to search. |

This spec collapses them. It is a presentation change: **the filter grammar in
`matchesQuery` does not change**, so `tests/ui-logic/console-logic.spec.ts`
stays valid throughout.

## The problem being solved

The two boxes hold different kinds of state. The palette is **transient** (type,
jump, gone). The filter is **persistent** (stays until cleared). One input has to
represent both, and that — not the keybinding — is the design problem.

Resolution: **a committed filter leaves the text field.** Typing is always
transient; committing pins the filter as a chip and empties the box, so the input
is never occupied by state you have finished typing.

```
┌──────────────────────────────────────────────────┐
│ ⌕  claude                                        │  bare text (transient)
│ ⦿ repo:agent-yes ×                               │  pinned chips, AND-ed
├──────────────────────────────────────────────────┤
│  ⇑⇓ preview   ⏎ open   ⌥⏎ pin as filter          │  mode-specific footer
└──────────────────────────────────────────────────┘
      left list narrows to 4 / 27 as you type
```

## Grammar: the first character picks the mode

| prefix | mode | behaviour |
| --- | --- | --- |
| _(none)_ | search / jump | narrows the left list live **and** drives jump + terminal preview |
| `?` | filter | same tokens as the box takes today; `⏎` pins a chip |
| `/` | command | `/filter`, `/ws`, `/new`, `/restart`, `/kill`, `/fork` |

Bare text keeps narrowing the list, because typing a repo name to narrow is the
most-used gesture in the console and must not regress. `?` is only needed to make
a filter outlive the keystrokes.

`?` is the right sigil because it never starts a path, a repo name, or a pid.

### Path rule

`/repo/alpha/tree/main` is a normal thing to type when filtering by path, and it
parses as command `alpha`. So: **if the text after `/` contains another `/`, it
is a path — skip command mode entirely.** Without this, typing a path flickers an
empty palette. (The existing unknown-command fallback is not enough; it only
helps after the whole word is typed.)

## Keys

| key | search (bare) | filter (`?`) | command (`/`) |
| --- | --- | --- | --- |
| `⏎` | open highlighted | pin chip | run |
| `⌥⏎` | pin what you typed as a chip | — | — |
| `⌘⏎` | spawn here (unchanged) | — | — |
| `⇑⇓` | move highlight + terminal preview | — | move |
| `Esc` | revert preview, clear text, then blur | revert narrow, keep chips | close |
| `Backspace` in an empty box | pop last chip | pop last chip | — |
| `Tab` | — | complete tag key (`?re` → `?repo:`) | complete command |

`⌘K` / `Ctrl+K` focuses the box and selects all; pressing it again while focused
blurs back to the terminal, preserving today's toggle feel. **Keep the
capture-phase listener (`:8118`) exactly as it is** — stealing focus back from
xterm is the entire reason the shortcut exists.

`⌥⏎` is load-bearing: it promotes the text you already typed into a chip without
making you go back and insert a `?`.

Chips are removed only by `×`, `Backspace`, or `/filter clear` — never by `Esc`,
which must stay safe to hit.

## Saved filters

```
?                    → saved: ?mine  ?stuck  ?dirty  ?needs
?mine                → expands: user:alice status:needs-input   (shown in the preview)
?status:idle         → literal tokens
/filter save stuck   → saves the current chips as ?stuck
/filter clear        → drops all chips
```

- **Collision rule.** A saved name wins only when the text after `?` is exactly
  one word that exactly matches a saved name. The preview always shows the
  expansion, so the active reading is visible. `/filter <tokens>` is the
  always-literal escape hatch.
- **Pinning a saved filter explodes it into its tokens as chips**, not one opaque
  chip. That keeps a single mental model (chips are AND-ed tokens) and lets you
  drop half of it. Cost: the chip row does not remember which saved filter it
  came from.
- **Ship built-ins** (`?stuck`, `?needs`, `?dirty`, `?mine`) so `?` is useful
  before anything has been saved, and teaches the tag vocabulary by example.
- **Storage:** `localStorage` under `ay.filters`, migrating the existing
  `ay.filter` string. Per-browser. Syncing saved filters across devices via the
  daemon would be nicer but needs an API — deferred.

## Preview, per mode

- **filter** — the left list _is_ the preview: it narrows while you type and the
  row shows the count delta (`27 → 4`). `Esc` reverts to the pinned set.
- **search** — reuse what exists: `⇑⇓` swaps the terminal to the highlighted
  agent, `Esc` restores the original (`omniReturnSel` / `omniPreviewing`).
- **command** — the row's title and description plus the resolved target
  (`/kill → claude #1111 /repo/alpha`); for `/fork`, the slug it would create.

## Drop the modal

In search mode the modal renders its own agent list while the left panel shows
the same agents. Once the box lives in the header, **the left list is the result
surface**: `⇑⇓` moves its highlight and previews, which is exactly today's
behaviour minus the overlay. The dropdown under the box then holds only things
that are not agents — command rows, `/ws` workspaces, provision rows, the
pin-preview row, the saved-filter list. Smaller surface, and mobile stops being a
special case (no full-screen overlay fighting the list).

**The dropdown opens on input or `⌘K`, never on bare focus** — otherwise
`autofocus` pops a panel on every page load.

## Sharing a filtered view

Use a `?q=` query param. **Not the fragment**: it already carries `#k=<share
token>`, `#xfer=`, and selection deep-linking (`:6303`, `:6440`). A filter is not
secret, unlike the token, which must stay out of server-visible URL parts.

## Prerequisite refactor

`$("q").value` is read or written in four places today — `:6174`, `:7738`,
`:8010` (the `/filter` row), `:8674` (the room badge writing `room:<name>`).
With chips, the filter is no longer "the text in the box", so those must collapse
into one accessor pair (`filterTokens()` / `setFilter()`) before anything else.
The room badge becomes "pin a `room:<name>` chip".

## Sharp edges

- Chip row wrapping eats vertical space on phones — cap visible chips with a
  `+2` overflow.
- `/` and `?` both need Shift on some keyboard layouts, so `⌘K`-then-sigil must
  stay viable. Do not bind bare `/` as a global hotkey.
- Keystrokes typed while an agent is previewed must not reach xterm (already
  handled by the capture-phase listener; keep it).

## Phasing

1. **Merge + chips + `?literal`.** Accessor refactor, header box grows a
   dropdown, `⌘K` focuses it, `⌥⏎` pins. Modal stays as a fallback.
2. **Saved filters.** `?name`, `/filter save`, built-ins, `ay.filters`
   migration.
3. **Delete the modal.** Left list becomes the search surface; the dropdown
   keeps only non-agent rows.
