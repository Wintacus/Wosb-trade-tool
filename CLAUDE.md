# CLAUDE.md — Project Conventions

Read this before doing anything in this repo.

---

## The person you're working with

- **Develops entirely from a phone.** No local dev environment, no terminal, no `npm run dev`. Never tell them to run something locally.
- **Verifies work at a live URL.** Every change must be pushed and auto-deployed to Vercel. If it isn't visible at the deployed URL, it doesn't exist.
- **Wants plain language.** Define technical terms the first time they appear — RLS, upsert, knapsack, EXIF, whatever. Don't assume familiarity, don't over-explain twice.
- **Wants honesty over agreeableness.** If an approach is wrong, say so directly. Flag concerns rather than quietly working around them. Never present a guess with confidence — if you're unsure, say you're unsure.

## Ask before assuming

For any **game design or product decision** — mechanics, UI structure, scope, what a feature should do — ask a clarifying question rather than picking for them. This applies more strictly than normal.

For **implementation details** — file layout, variable naming, which library — just decide and move on.

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

- **Servers are separate economies.** Every price and port-state row is scoped by `server_id`. Mixing NA and EU data produces garbage.
- **Ship rate gates ports both ways.** A ship must satisfy `min_ship_rate` to both depart and arrive.
- **Hold weight is the only cargo constraint.** There is no cargo-slot limit — that was an early wrong assumption, disproven by in-game ship cards.
- **Distance is abstract units, never time.** Wind, sails and load make time unpredictable; converting would be inventing precision.
- **Upgrade modifiers: flat first, then percentage.** This ordering is verified against observed in-game values.

---

## Working style

- **Build in the phase order in SPEC.md.** Don't start a phase before the previous one's "Done when" criteria are met.
- **Calculator before UI.** The math is the product. Test it against known inputs before anything visual exists.
- **Small commits, deploy often.** The user can only verify what's live.
- **When something fails, say what failed.** Don't silently work around a blocker — surface it.

---

## Reference files

| File | Contents |
|---|---|
| `SPEC.md` | Full build specification, phased |
| `data/ports.json` | 42 ports, coordinates, categories, faction definitions |
| `data/ships.json` | 38 ships with verified stats, plus upgrade modifiers |
| `data/goods.json` | 20 trade goods with weights and validation evidence |
| `data/resources.json` | 26 craft materials, 15 special items, crafting recipes |
| `DESIGN_BRIEF.md` | Art direction for Claude Design (not needed for V1 build) |

Each JSON file has a `_meta` block explaining provenance and confidence. Read it before using the data.
