#!/usr/bin/env bash
#
# Two things the user asked for that an honour system kept failing to deliver.
#
# WHY THESE ARE HOOKS AND NOT SENTENCES IN CLAUDE.md
#
# CLAUDE.md already said "verify before reporting". It was added as hard rule 7
# after two rounds of a fix being reported as working when it was not. It then
# failed again on the very next round. Written instructions are advice the
# model may or may not follow; a hook is a gate that runs whether it wants to
# or not. Three failures of the honour system is enough.
#
# 1. VERIFICATION. If the working tree has changes under src/, api/, supabase/
#    or scripts/, then .verified must exist and record the same tree state. `npm run verify`
#    writes it after driving the real app in a real browser, so a stale or
#    missing stamp means the running app was never actually looked at. Editing
#    a file after verifying changes the hash and invalidates the stamp, which
#    is the point: no "verify, then just one more tweak, then report success".
#
# 2. STATUS REPORTS. The user asked for a brief plain-language summary every
#    time another 15% of the token window goes by. They work from a phone and
#    cannot scroll back through a terminal, so a long silent stretch leaves
#    them with no idea where the project stands.
#
# Exit 0 allows the turn to end. Exit 2 blocks it and sends stderr to Claude.

set -uo pipefail
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

# --- 1. the app must have been driven since it was last changed -------------
#
# WHAT IS WATCHED: src, api, supabase, scripts. The last two were added
# 2026-08-27 after noticing they sat outside the gate -- which meant a database
# migration, the riskiest change in this project because it runs against the
# real database during the deploy, could ship without the app being driven
# once. Watching scripts/ also means editing the harness invalidates the stamp,
# which is right: a changed harness has not been run.
CHANGES="$(git status --porcelain=v1 -- src api supabase scripts 2>/dev/null)"

if [ -n "$CHANGES" ]; then
  # Hash the CONTENT of every watched file, not `git status` output. Status only
  # lists filenames and flags, so editing an already-modified file leaves it
  # identical -- which would let a post-verification edit slip through.
  #
  # ONE command computes this, shared with scripts/verify-ui.mjs. When the hook
  # and the harness each had their own copy of a find|sha1sum pipeline, any
  # drift between them would leave the gate passing while checking something
  # else entirely -- a silent failure of the thing whose whole job is to stop
  # silent failures.
  CURRENT="$(node scripts/tree-hash.mjs 2>/dev/null)"

  if [ -z "$CURRENT" ]; then
    echo "BLOCKED: could not compute the source hash (node scripts/tree-hash.mjs failed)." >&2
    exit 2
  fi

  if [ ! -f .verified ]; then
    cat >&2 <<'EOF'
BLOCKED: watched source changed but the app was never driven.

Run:  npm run verify

That boots the real app in a real browser at phone size and checks what a
person would check -- including a page RELOAD, which is what iOS does to a
backgrounded tab and which no unit test in this repo performs.

Passing unit tests are not evidence the app works. That assumption has now
cost three rounds of telling the user something was fixed when it was not.
Do not report anything as working until this passes.
EOF
    exit 2
  fi

  RECORDED="$(grep -o '"treeHash": *"[^"]*"' .verified | sed 's/.*"\([^"]*\)"$/\1/')"

  if [ "$RECORDED" != "$CURRENT" ]; then
    cat >&2 <<'EOF'
BLOCKED: watched source changed since the last verification run.

.verified was written against a different working tree, so it says nothing
about the code as it stands now.

Run:  npm run verify

Re-verify after every edit. "I verified, then made one small change" is
exactly how a broken build gets reported as working.
EOF
    exit 2
  fi
fi

# --- 2. a status report is owed every 15% of the window ---------------------
# Runs regardless of whether code changed: a long stretch of investigation with
# no edits still leaves the user in the dark, which is the thing being fixed.
if ! STATUS_MSG="$(node scripts/status-checkpoint.mjs --check 2>&1)"; then
  printf '%s\n' "$STATUS_MSG" >&2
  exit 2
fi

exit 0
