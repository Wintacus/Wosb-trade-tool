#!/usr/bin/env bash
#
# Refuses to let a turn end when the UI changed but was never driven.
#
# WHY THIS IS A HOOK AND NOT A SENTENCE IN CLAUDE.md
#
# CLAUDE.md already said "verify before reporting". It was added as hard rule
# 7 after two rounds of a fix being reported as working when it was not. It
# then failed again on the very next round. Written instructions are advice
# the model may or may not follow; a hook is a gate that runs whether it wants
# to or not. Three failures of the honour system is enough.
#
# WHAT IT CHECKS
#
# If the working tree has changes under src/ or api/, then .verified must
# exist and must record the same tree state. `npm run verify` writes .verified
# after driving the real app in a real browser (scripts/verify-ui.mjs), so a
# stale or missing stamp means the running app was never actually looked at.
#
# Editing a file after verifying changes the tree hash and invalidates the
# stamp, which is the point: you cannot verify, then "just one more tweak",
# then report success.
#
# Exit 0 allows the turn to end. Exit 2 blocks it and sends the message on
# stderr back to Claude.

set -uo pipefail
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

# Nothing touched in the app or the API: nothing to drive.
CHANGES="$(git status --porcelain=v1 -- src api 2>/dev/null)"
[ -z "$CHANGES" ] && exit 0

# Hash the CONTENT of every source file, not `git status` output. Status only
# lists filenames and flags, so editing an already-modified file leaves it
# identical -- which would let a post-verification edit slip through the gate.
CURRENT="$(find src api -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) -print0 2>/dev/null | sort -z | xargs -0 sha1sum 2>/dev/null | sha1sum | awk '{print $1}')"

if [ ! -f .verified ]; then
  cat >&2 <<EOF
BLOCKED: src/ or api/ changed but the app was never driven.

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
  cat >&2 <<EOF
BLOCKED: src/ or api/ changed since the last verification run.

.verified was written against a different working tree, so it says nothing
about the code as it stands now.

Run:  npm run verify

Re-verify after every edit. "I verified, then made one small change" is
exactly how a broken build gets reported as working.
EOF
  exit 2
fi

exit 0
