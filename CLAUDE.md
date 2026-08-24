# CLAUDE.md — Project Conventions

Read this before doing anything in this repo.

---

## The person you're working with

- **Develops entirely from a phone.** No local dev environment, no terminal, no `npm run dev`. Never tell them to run something locally.
- **Verifies work at a live URL.** Every change must be pushed and auto-deployed to Vercel. If it isn't visible at the deployed URL, it doesn't exist.
- **Wants plain language.** Define technical terms the first time they appear — RLS, upsert, knapsack, EXIF, whatever. Don't assume familiarity, don't over-explain twice.
- **Wants honesty over agreeableness.** If an approach is wrong, say so directly. Flag concerns rather than quietly working around them. Never present a guess with confidence — if you're unsure, say you're unsure.
- **Wants short answers.** Be concise in every reply. Lead with the result, then anything they must act on, then caveats — briefly. No recaps of work they just watched, no restating a commit message in prose. Length is not thoroughness. This applies to chat only: code comments, commit messages and PR bodies stay as detailed as they need to be.

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

- **Batch independent tool calls into one message.** This is the single biggest lever and it belongs to Claude, not the user. Each extra round trip replays the whole conversation again — about 350,000 tokens per trip at mid-session. The first session batched **1.8%** of its 386 calls and paid full freight for the rest.
- **Start a fresh session at each phase boundary.** A new session begins near 50,000 tokens of context; the first one ended at 774,000, so identical work cost several times more by the end. `PROGRESS.md` plus this file are the handover and they are sufficient. Never begin a phase in the session that finished the previous one.
- **Read the part of `SPEC.md` you need, never the whole file.** It is ~7,900 tokens. Once read it is replayed on every following request for the rest of the session.
- **Run the tests you affected. Run all of them once, before pushing.** A full-suite re-run after each small edit costs a round trip and puts a screenful of output into the context permanently.
- **Keep commit messages to a short paragraph.** They are billed as output and then replayed as context — expensive twice. The first session's essay-length messages were a mistake.
- **Audits are cheapest at the start of a session, aimed at the repository.** "Review everything from the beginning" late in a session re-reads the whole conversation to do it; two such requests were 30.9% of all replayed tokens. The same question in a fresh session reads the code instead — and the code is the truth, not the chat log.

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
| `PROGRESS.md` | Session handover notes — **read first, update as you go** |
| `DESIGN_BRIEF.md` | Art direction for Claude Design (not needed for V1 build) |

Each JSON file has a `_meta` block explaining provenance and confidence. Read it before using the data.
