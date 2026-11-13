#!/usr/bin/env sh
# Decide how much of the pre-push gate a push needs. Reads git's pre-push ref
# lines on stdin — "<local ref> <local sha> <remote ref> <remote sha>", one per
# ref — and prints a plan: the first line is one of
#
#   deletion   every ref is a deletion (`git push origin :branch`): nothing to test
#   prose      every pushed file is documentation: the test gate can be skipped
#   full       anything else, including "cannot tell": run the full gate
#
# followed by the pushed files, one per line, when they could be established.
# Kept out of .husky/pre-push itself so the classification has a regression
# spec (ts/pushGatePlan.spec.ts); the hook only acts on the plan.
#
# Prose is `docs/**` and `*.md` — EXCEPT `SKILL.md` at ANY depth: ts/index.ts
# walks from the working directory up to the repository root and reads every
# SKILL.md it passes for --use-skills, so `feature/SKILL.md` or `docs/SKILL.md`
# changes runtime behaviour just like the root one. No spec reads any other .md
# file, so the rest cannot change a test result.
#
# When a ref has no comparison base — a brand-new branch with no common ancestor
# with origin/main, or a remote sha this clone does not have — the push's
# contents cannot be established, so the plan is `full`: the tip commit alone
# says nothing about the code shipped by the commits under it, and the safe
# default is to test.
set -e

ZERO=0000000000000000000000000000000000000000
REFS=$(cat) # git's ref lines; empty when the hook is run by hand

if [ -z "$REFS" ]; then
  echo full
  exit 0
fi

# Drop deletions (local sha all zeros) — they ship no code.
LIVE_REFS=$(printf '%s\n' "$REFS" | awk -v z="$ZERO" '$2 != z && $2 != ""')
if [ -z "$LIVE_REFS" ]; then
  echo deletion
  exit 0
fi

# Prints the files each live ref pushes; exits 1 when any ref has no base.
files_for_refs() {
  unknown=0
  while read -r _local_ref local_sha _remote_ref remote_sha; do
    [ -z "$local_sha" ] && continue
    if [ "$remote_sha" = "$ZERO" ] || ! git cat-file -e "$remote_sha" 2>/dev/null; then
      # New branch (or a remote sha we don't have): compare against the default branch.
      base=$(git merge-base "$local_sha" refs/remotes/origin/main 2>/dev/null || true)
    else
      base="$remote_sha"
    fi
    if [ -n "$base" ]; then
      git diff --name-only "$base" "$local_sha"
    else
      unknown=1
    fi
  done
  [ "$unknown" = 0 ]
}

if ! RAW=$(printf '%s\n' "$LIVE_REFS" | files_for_refs); then
  echo full
  exit 0
fi
FILES=$(printf '%s\n' "$RAW" | sort -u)

# Line-based, so paths containing spaces are handled.
NON_PROSE=$(
  printf '%s\n' "$FILES" | grep -vE '^docs/|\.md$' || true
  printf '%s\n' "$FILES" | grep -E '(^|/)SKILL\.md$' || true
)
if [ -n "$FILES" ] && [ -z "$NON_PROSE" ]; then
  echo prose
else
  echo full
fi
printf '%s\n' "$FILES" | grep -v '^$' || true
