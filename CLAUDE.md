# CLAUDE.md — Project Conventions

Read this before doing anything in this repo.

---

## The person you're working with

- **Works from a phone almost always.** There is a Windows PC with Claude Code on it, but
  they rarely have access to it at the moment a question comes up. So treat a local run as
  a fallback that exists, not a step you may plan around: never make progress depend on
  them being at the PC, and never answer "run this locally" to something you could do
  yourself. (This line used to say they had no computer at all. That was true for the
  first four sessions and it ruled out whole classes of solution without checking — which
  is why it is written as "rarely available" rather than "unavailable".)
- **The product is phone-first regardless.** The app is used on a phone, standing in a
  port, switching to the game and back. Verify at phone viewport, and reload the page.
- **Verifies work at a live URL.** Every change must be pushed and auto-deployed to Vercel. If it isn't visible at the deployed URL, it doesn't exist.
- **Wants plain language.** Define technical terms the first time they appear — RLS, upsert, knapsack, EXIF, whatever. Don't assume familiarity, don't over-explain twice.
- **Wants honesty over agreeableness.** If an approach is wrong, say so directly. Flag concerns rather than quietly working around them. Never present a guess with confidence — if you're unsure, say you're unsure.
- **Wants short answers.** Be concise in every reply. Lead with the result, then anything they must act on, then caveats — briefly. No recaps of work they just watched, no restating a commit message in prose. Length is not thoroughness. This applies to chat only: code comments, commit messages and PR bodies stay as detailed as they need to be.

## Keep them posted — every 15% of the token window

They work from a phone and cannot scroll back through a terminal. A long
stretch of silent work leaves them with no idea what happened or where things
stand, which is the same problem as a fix reported without verification: the
work may be fine, but they have no way to know it.

So every time another **15% of the token window** goes by, before ending the
turn, give a short plain-language summary:

- **what you actually did** since the last one
- **where that leaves the project**
- **what the next step is**

A few lines. Not a document, not a changelog — they can read the commits if
they want detail. If nothing meaningful happened, say that instead of padding.

**This is enforced, not trusted.** `node scripts/status-checkpoint.mjs`
measures real spend from the session's own transcript; the `Stop` hook refuses
to end a turn when a report is overdue. After giving the summary, run
`node scripts/status-checkpoint.mjs --record` to clear it. Do not weaken or
bypass that hook — the same rule written as a plain instruction is exactly
what has failed twice before.

## Ask before assuming

For any **game design or product decision** — mechanics, UI structure, scope, what a feature should do — ask a clarifying question rather than picking for them. This applies more strictly than normal.

For **implementation details** — file layout, variable naming, which library — just decide and move on.

## Do the work yourself

**The only thing to ask of the user is a decision. Never a task.**

If something needs doing, find a way to do it. "I can't, so you do it" is not an
answer — it is the problem to solve. Before handing over any step, exhaust the
alternatives: build a serverless endpoint, write a script, automate it, restructure
so the step disappears. Manual steps for the user are a last resort, and each one
needs a reason why automation was genuinely impossible, not merely more work.

**Before asking the user for a fact, check whether a connector or an endpoint can
answer it.** Measured 2026-08-27: "is `ANTHROPIC_API_KEY` set in Vercel?" was reported
to the user as something only they could check. It was not — merging to `main` put
`GET /api/ocr` on the public production URL, and one call answered it. A question that
*looks* like it needs a human is the exact case worth one call to disprove. The general
form: if the answer lives in a system, go and read it; only a judgement lives with them.

When a one-time setup unavoidably needs a human — a secret only they can see, a
console only they can log into — make it **one action, once**, and make every future
occurrence automatic. Supply every link needed, pre-filled, in the message.

Two consequences worth stating outright:

- **Wait for an explicit go-ahead after asking anything.** Do not ask a question and
  carry on working. Stop, and stay stopped until they answer.
- **Never send them looking for something.** No "go find X in the dashboard" without
  a direct link to exactly that screen.

---

## Hard rules

### 1. Never invent game data
Every value in `/data/*.json` carries a confidence level and a source. If a value is `null`, it is unknown. Do not fill it in with something plausible. Do not default `tax_percent` to 8% because that's the common value — observed real values range 4% to 12%.

### 2. Nothing game-derived is hardcoded
This game is in Early Access, developed by one person, and actively patched. Tax rates, port ownership, ship stats, prices — all live in the database and are user-editable. A hardcoded game value is a bug waiting to happen.

### 3. Money is integers
Store prices in tenths of gold as integers. Never use floating-point for currency anywhere in the codebase.

### 4. Secrets never reach the browser
- `VITE_`-prefixed env vars are bundled into client code. Anything secret must not have that prefix.
- `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY` are server-only, used exclusively inside serverless functions.
- If a secret is ever committed, rotate it. Deleting the line does not remove it from git history.

### 5. Unverified values are labelled in the UI
If the calculator used a value marked unverified (docking fee, faction discount, unknown tax), the result must say so. A confidently-presented wrong number is worse than an honest gap.

### 6. Manual entry must always work
OCR is an accelerator. If OCR is broken, removed, or never finished, the app must remain fully usable.

### 7. Reproduce the reported symptom before you write a single line of fix
**This rule replaced a weaker one that said "verify before reporting". That version failed on the very next round, because verifying is not the hard part — verifying *the right thing* is.**

The actual failure mode, measured across four rounds on 2026-08-26:

1. User reports a symptom in their own words ("it resets the screen").
2. Claude forms a theory about which code causes it.
3. Claude verifies **the theory** — drives the button, watches it work, reports "fixed".
4. The theory was wrong. The symptom is untouched. The user is now angrier and has less reason to trust anything.

Rounds 3 and 4 involved genuine browser testing and still shipped broken, because the wrong thing was under test. The real bug was that **the app lost all state on a page reload** — iOS Safari discards backgrounded tabs, and this tool is used by switching to the game and back constantly. No amount of clicking buttons in a desktop browser reveals that. Reloading the page reveals it in seconds.

So the order is not negotiable:

- **First, reproduce the symptom the user described, in their words, before theorising about causes.** Not the nearest thing you can think of — the actual thing. If they say "it wipes everything", your job is to make something get wiped. If they say "it's cut off", measure what is cut off.
- **If you cannot reproduce it, say so and ask for one more detail.** Do not fix on a theory. A fix aimed at an unreproduced symptom is a guess wearing a lab coat, and it costs a full round-trip every time.
- **Then fix it, then show the same reproduction now passes.** The before and the after must be the same test.
- **Match the user's real conditions, not convenient ones.** Phone viewport, not desktop. Reload the page — they switch apps constantly. Slow network, empty database, a port with no data. Most bugs here have lived in conditions the sandbox does not reach by default.
- **A fixture with no data only ever tests the empty state.** This is not a nicety; it is
  how a *verified* build shipped with every good's name invisible. `verify-ui.mjs` had
  `prices_current: []`, so every row rendered the short "not recorded here" branch and the
  wide populated row — the only one that breaks — was never drawn at all. The check passed
  because the bug could not appear. **A fixture must carry the widest shape the UI can
  take**: every field present, the longest strings, the extra badge, the second line. The
  empty state is one case, not the case.
- A subagent reporting "verified, 427 tests pass" means it checked its own work, not that you have. Re-read its diff and re-run the check yourself before relaying its claim as fact.
- If you truly cannot check, say exactly that — "I could not verify this, here's why" — and never dress it up as done.

**This is enforced mechanically, not on trust.** `npm run verify` drives the real app in a real browser (including a reload) and writes `.verified`. The `Stop` hook in `.claude/settings.json` refuses to end a turn where the watched tree changed without a matching, current `.verified`. It hashes file contents, so "verify, then one more tweak" invalidates it. Do not weaken or bypass that hook; add checks to `scripts/verify-ui.mjs` as new symptoms are found, so each one stays fixed.

**What the gate watches:** `src/`, `api/`, `supabase/` and `scripts/`. The last two were
added on 2026-08-27 after finding they were outside it — which meant a database migration,
the single highest-risk change in this project because it runs against the real database
on deploy, could ship without the app ever being driven. Including `scripts/` also means
editing the verification harness itself invalidates the stamp, which is correct: a changed
harness has not been run. One command computes the hash (`node scripts/tree-hash.mjs`) and
both the hook and `verify-ui.mjs` call it, so the two can never drift apart and silently
stop agreeing on what was checked.

**When a written rule keeps failing, make it a hook.** That has now worked twice here —
verification, and the every-15% status report — and both times only *after* the written
version had failed at least twice. A rule the model must remember to follow is advice; a
gate that runs whether it wants to or not is a rule. If you notice a third instruction
being forgotten repeatedly, do not restate it more forcefully. Mechanise it.

---

## Architecture reminders

- **Schema changes apply on deploy.** The Vercel build runs `scripts/apply-migrations.mjs`, so pushing is the whole workflow. Never ask the user to run SQL, tap an endpoint, or enter the database password for a schema change. Edit `supabase/schema.sql` for new objects; add a file to `supabase/migrations/` to alter something that already exists.
- **Servers are separate economies.** Every price and port-state row is scoped by `server_id`. Mixing NA and EU data produces garbage.
- **Ship rate gates ports both ways.** A ship must satisfy `min_ship_rate` to both depart and arrive.
- **Hold weight is the only cargo constraint.** There is no cargo-slot limit — that was an early wrong assumption, disproven by in-game ship cards.
- **Distance is abstract units, never time.** Wind, sails and load make time unpredictable; converting would be inventing precision.
- **Upgrade modifiers: flat first, then percentage.** This ordering is verified against observed in-game values.

---

## Working style

- **Build in the phase order in SPEC.md.** Don't start a phase before the previous one's "Done when" criteria are met.
- **Calculator before UI.** The math is the product. Test it against known inputs before anything visual exists.
- **Small commits, deploy often.** The user can only verify what's live. Commit and push after each meaningful step — never batch a whole phase into one commit at the end. Uncommitted work is the only thing that can actually be lost.
- **When something fails, say what failed.** Don't silently work around a blocker — surface it.
- **Delegate broad repo searches to the `caveman-explore` agent** (`.claude/agents/`). It reads files in a cheap side channel and reports back only `path:line` citations, so the file contents never land in this conversation. Use it for cold-start orientation, "where is X handled?" across several directories, or a search that already failed once. **Skip it** when the file is already named in this doc or `PROGRESS.md` — reading `src/domain/calculator.ts` directly is cheaper than delegating. It returns locations, never facts: re-read the actual line before quoting any game value from it.

---

## Token discipline

The first session of this project spent 146.8 million tokens. **95.6% of that was re-reading conversation already sent** — the API keeps no memory, so every tool call re-sends the entire conversation. Cost is therefore *requests × context size*, and both grow all session. These are measured rules, not preferences.

- **Write one compound shell command instead of several.** This is the concrete form of
  "batch", and it is the version that actually works. `cat a b c` in one call, not three
  Reads. `cmd1 && cmd2 && cmd3` with `echo` separators, not three Bash calls. Search and
  read in the same call. The abstract instruction to "batch independent tool calls" has
  been in this file since session 1 and measured 1.8%, 0.0%, 0.0% and 4.6% — so state the
  technique, not the goal. Each extra round trip replays the whole conversation: about
  350,000 tokens at mid-session.
- **Start a fresh session at each phase boundary.** A new session begins near 50,000 tokens of context; the first one ended at 774,000, so identical work cost several times more by the end. `PROGRESS.md` plus this file are the handover and they are sufficient. Never begin a phase in the session that finished the previous one.
- **Read the part of `SPEC.md` you need, never the whole file.** It is ~7,900 tokens. Once read it is replayed on every following request for the rest of the session.
- **Run the tests you affected. Run all of them once, before pushing.** A full-suite re-run after each small edit costs a round trip and puts a screenful of output into the context permanently.
- **Keep commit messages to a short paragraph.** They are billed as output and then replayed as context — expensive twice. The first session's essay-length messages were a mistake.
- **End every session with `npm run tokens`, and write the numbers into `PROGRESS.md`.** It reads this session's own transcript and compares requests, context growth and batching rate against the first session's baseline. It is one command and a few seconds. **A batching rate still in single digits means the rule above is not working and needs a different fix — fewer, larger shell commands — not another restatement.** Session 1 had a standing instruction to batch and still managed 2.0%, so treat the measurement as the truth and the rule as an intention.
- **Audits are cheapest at the start of a session, aimed at the repository.** "Review everything from the beginning" late in a session re-reads the whole conversation to do it; two such requests were 30.9% of all replayed tokens. The same question in a fresh session reads the code instead — and the code is the truth, not the chat log.

## Never let the harness wake this session

Measured on 2026-08-26: **26% of an entire session — 51M tokens across 138 requests —
was spent on notification wake-ups that produced nothing.** Every one was a Vercel bot
editing its own comment ("Building" → "Ready") or a CI suite reporting the green it had
already reported. CI was never once red. Each wake replays the whole conversation.

- **Do NOT call `subscribe_pr_activity`.** Ever, on this project. The user reads the
  preview URL themselves and tells you what is wrong; that is the feedback loop that has
  actually found every bug. A PR subscription found none.
- **Do NOT schedule check-ins** (`send_later`, `create_trigger`, `/loop`) to poll a PR,
  a deploy, or CI. If a status genuinely matters, check it once, on demand, when the
  user asks.
- To check CI, use `pull_request_read` with `get_check_runs`. Never `get` — that returns
  the entire PR body, several thousand tokens, and it stays in context for the rest of
  the session.
- **To check a deploy, use the Vercel connector — once, on demand.** It serves the same
  goal as the two rules above by a better route: `list_deployments` for build state,
  `get_deployment_build_logs` for a failure, `get_runtime_logs` for a function error, and
  `web_fetch_vercel_url` to fetch **production** (previews sit behind Vercel
  Authentication and 302 to a login). None of it wakes the session, so it replaces polling
  entirely — but it is still one call when a status matters, never a loop.
  `list_deployments` returns a large payload; ask for it once and read it carefully rather
  than twice. There is no environment-variable tool: `GET /api/ocr` on production is how a
  session learns whether the API key is set.

## Cost is requests x context, and context only grows

Same session, by quarter: median context per request went **132k → 253k → 395k → 507k**.
223 of 613 requests ran above 400k and burned 107M tokens between them. Had every
request run at the first quarter's context, the identical work would have cost **81M
instead of 197M**.

- **Start a fresh session at every real boundary** — a finished phase, a shipped fix, a
  new problem. This is the single biggest lever and it is free. The session that
  measured the numbers above did Phase 2, three rounds of map rebuilding and a test
  harness in one sitting; it should have been four sessions.
- **One compound shell command, not several.** See the technique above. Measured
  batching rate: 0.0% twice, then 4.6%. 213 separate Bash calls in one session, each
  paying a full replay.
- **Two strikes on a failing command.** If the same command fails twice, stop running
  variations of it and spend one call instrumenting instead. Fifteen near-identical
  failed runs went into a problem whose cause was a single word in the command.

## Session continuity

Sessions end unpredictably — usage limits, context running out, the user closing the app. Assume any session may be your last, and leave the repo in a state the next session can resume from.

### Maintain `PROGRESS.md` in the repo root

Create it on your first session. Update it **whenever you complete a meaningful step**, not just when you sense you're running low. Keep it short — it is a handover note, not a diary.

```markdown
# PROGRESS

Last updated: <date> — <what session/phase>

## Done
- [x] Phase 0: Vite scaffold deployed, live URL confirmed
- [x] Phase 1: schema created, RLS enabled and verified

## In progress
- Seed import: ports + ships loaded, goods not yet imported

## Next
- Import goods from data/goods.json and data/resources.json (61 rows total)
- Write the eleven calculator tests from SPEC.md §5.9

## Blocked / needs the user
- Waiting on a decision about X

## Notes for the next session
- Database setup runs from /api/migrate on the deployed site, not by pasting SQL
```

### Starting a session

**Always read `PROGRESS.md` first**, then verify it against the actual repo — the file describes intent, the repo is the truth. If they disagree, trust the repo and correct the file.

Report what's done and what's outstanding **before** writing any new code.

### Ending a session

If you notice you're running low on context, stop and do this rather than starting something new:

1. Commit and push whatever is finished and working
2. Update `PROGRESS.md`
3. Tell the user plainly where things stand and what to say next time

Never leave the repo in a half-broken state to squeeze in one more change.

---

## Reference files

| File | Contents |
|---|---|
| `SPEC.md` | Full build specification, phased |
| `data/ports.json` | 42 ports, coordinates, categories, faction definitions |
| `data/ships.json` | 38 ships with verified stats, plus upgrade modifiers |
| `data/goods.json` | 20 trade goods with weights and validation evidence |
| `data/resources.json` | 26 craft materials, 15 special items, crafting recipes |
| `fixtures/ocr/README.md` | How to add a screenshot + ground-truth pair for `npm run ocr:accuracy` |
| `PROGRESS.md` | Session handover notes — **read first, update as you go** |
| `DESIGN_BRIEF.md` | Art direction for Claude Design (not needed for V1 build) |

Each JSON file has a `_meta` block explaining provenance and confidence. Read it before using the data.
