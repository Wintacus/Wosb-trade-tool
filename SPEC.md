# World of Sea Battle Trading Tool — Build Specification

> **Working name:** WOSB Trade Tool (placeholder — final name TBD)
> **Status:** Ready to build
> **Audience:** Claude Code

---

## 0. Read This First

### What this is
A web app that tells a World of Sea Battle player **what cargo to buy, and where to sail it, to make the most gold**. The player picks an origin port, a destination port, and a ship. The app returns the optimal mix of goods to fill the hold with, ranked by four different profit metrics.

### Non-negotiable principles

1. **Never invent data.** Every number in the seed files carries a confidence level and a source. Values marked unverified default to zero/off and must be visibly labelled as unverified in the UI. Do not "helpfully" fill them in.
2. **Everything game-derived is editable.** This game is in Early Access by a solo developer. Tax rates, port ownership, ship stats and prices all change. Nothing game-related is hardcoded — it lives in the database and users can correct it.
3. **The app must be fully usable if OCR never works.** Manual entry is the guaranteed path. OCR is an accelerator, not a dependency.
4. **Money math uses integers.** Never floating-point for currency. See §5.
5. **Phases ship independently.** Do not start a phase before the previous one's "Done when" criteria are met.

### Build order rationale
The calculator is built and tested *before* any UI exists. This is deliberate: the math is the product, and it is far easier to verify against known inputs in tests than through a browser.

---

## 1. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite, TypeScript | Matches user's existing workflow |
| Styling | Tailwind CSS | Fast, no build complexity |
| Hosting | Vercel | Auto-deploys from GitHub on push — critical, see below |
| Backend | Vercel Serverless Functions | Needed to keep API keys server-side |
| Database + Auth | Supabase | Postgres, anonymous auth, RLS, storage, backups |
| AI Vision (OCR) | Anthropic API via serverless function | Never called from the browser |
| PWA | vite-plugin-pwa | Installable on phone home screen |

### Critical workflow constraint
**The user develops entirely from a phone with no local development environment.** There is no `npm run dev` available to them. Therefore:

- Every change must be verifiable at a **live deployed URL**.
- Vercel must be connected to the GitHub repo so every push auto-deploys.
- Never instruct the user to run something locally. If a command must be run, it runs in CI or in the Supabase web console.

---

## 2. Phase 0 — Setup

**Goal:** an empty React app deployed and reachable at a public URL.

### 0.1 Repository
Create a GitHub repo. Standard Vite + React + TypeScript scaffold. Commit.

### 0.2 Vercel
1. Sign in to vercel.com with GitHub.
2. "Add New Project" → import the repo.
3. Framework preset: Vite. Accept defaults. Deploy.
4. Confirm the live URL loads.

### 0.3 Supabase
1. Create a project at supabase.com. Save the database password.

> Supabase's own GitHub integration ("No repository connected") is **not** required and should be skipped. Schema is created directly against the project, not via Supabase git migrations.
2. From Project Settings → API, copy three values.

> ⚠️ **Supabase has renamed its API keys.** Older docs (and most tutorials) use the old names. Current dashboard labels:
>
> | Old name | Current label | Looks like |
> |---|---|---|
> | anon / public key | **Publishable key** | `sb_publishable_…` |
> | service_role key | **Secret key** | `sb_secret_…` |
>
> The environment variable names in this project intentionally keep the **old** names for stability. Do not rename them:
> - `VITE_SUPABASE_ANON_KEY` holds the **publishable** key
> - `SUPABASE_SERVICE_ROLE_KEY` holds the **secret** key

> ⚠️ **The `service_role` key bypasses all row-level security.** It goes *only* into Vercel environment variables, never into frontend code, never into the repo. The `anon` key is the only one the browser ever sees.

### 0.4 Anthropic API (needed for Phase 3 only, but set up now)
1. Create an account at console.anthropic.com. **This is separate from a Claude Pro subscription** — Pro does not include API usage.
2. Add a small amount of credit (a few dollars is ample for personal use).
3. Create an API key.
4. **Set a monthly spend limit.** This is a required safety net, not optional.

### 0.5 Environment variables
In Vercel → Settings → Environment Variables → **Add Environment Variable**.

Scope each to **Production and Preview**. (A Development scope may not be offered; it only applies to local CLI development, which is not used on this project.)

Variables are applied to **new deployments only** — after adding them, redeploy from Deployments → ⋯ → Redeploy.

```
VITE_SUPABASE_URL=          # safe for browser
VITE_SUPABASE_ANON_KEY=     # safe for browser
SUPABASE_SERVICE_ROLE_KEY=  # server only — no VITE_ prefix
ANTHROPIC_API_KEY=          # server only — no VITE_ prefix
```

> The `VITE_` prefix is what exposes a variable to the browser bundle. Anything secret must **not** have it.

### 0.6 Secrets hygiene
`.env` is in `.gitignore` from the first commit. If a key is ever committed, it stays in git history forever — the fix is to **rotate the key**, not to delete the line.

**Done when:** the live URL loads a page, and all four env vars are set in Vercel.

---

## 3. Phase 1 — Data & Calculator (no UI)

**Goal:** a correct, tested trading calculator. Nothing visual.

### 3.1 Database schema

```sql
-- Server regions are SEPARATE ECONOMIES. This is not cosmetic:
-- a price from the EU server is meaningless on NA.
create table servers (
  id text primary key,          -- 'na', 'eu', 'ru', 'asia'
  name text not null
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  server_id text references servers(id),
  faction_id text,              -- may be null; unaligned is valid
  created_at timestamptz default now()
);

-- Static reference data, seeded from JSON. Global across servers.
create table goods (
  id text primary key,
  name text not null,
  weight integer not null,      -- 1:1 with ship hold units
  base_value integer,           -- reference only, NOT a live price
  min_price integer,            -- sanity-check band only
  max_price integer,
  is_trade_good boolean not null, -- true = one of the 20; false = craft material
  perishable boolean default false,
  category text
);

create table ships (
  id text primary key,
  name text not null,
  class text not null,
  hull_type text,
  rate integer not null,        -- 1..7; 7 is smallest
  durability integer,
  speed numeric,                -- BASE speed; see §5.4
  maneuverability integer,
  armor numeric,
  hold integer not null,        -- the only cargo constraint
  crew integer,
  upgrade_slots integer,
  verified boolean default true
);

create table upgrades (
  id text primary key,
  name text not null,
  category text,                -- 'cargo' | 'speed' | 'sails' | 'other'
  hold_flat integer default 0,
  hold_percent numeric default 0,
  speed_flat numeric default 0,
  speed_percent numeric default 0,
  cruise_speed_flat numeric default 0,
  durability_flat integer default 0,
  durability_percent numeric default 0,
  upgrade_slots_flat integer default 0,
  prevents_spoilage boolean default false
);

-- Ports: static identity + per-server mutable state
create table ports (
  id text primary key,
  name text not null,
  display_name text,
  x integer not null,           -- map pixel coords, relative distance only
  y integer not null,
  category text                 -- 'n' | 'f' | 'k' | 'p'
);

create table port_state (
  port_id text references ports(id),
  server_id text references servers(id),
  tax_percent numeric,          -- null = unknown. DO NOT default to 8.
  docking_fee integer,          -- null = unknown, treated as 0. UNVERIFIED.
  min_ship_rate integer,        -- e.g. 6 means only rates 6-7 may dock
  controlling_faction text,
  port_level integer,
  port_type text,               -- 'city' | 'settlement'
  has_market boolean default true,
  updated_by uuid references profiles(id),
  updated_at timestamptz default now(),
  primary key (port_id, server_id)
);

-- The volatile data. Buy and sell are SEPARATE fields — see §5.1.
--
-- APPEND-ONLY. Every submission is kept as its own row; nothing is overwritten.
-- This is required, not optional:
--   * Phase 4 consensus weighting needs multiple submissions to compare
--   * outlier detection needs to see disagreement between contributors
--   * price history (backlog) needs the time series
-- A single upserted row per port/good would make all three impossible.
create table price_submissions (
  id bigserial primary key,
  server_id text not null references servers(id),
  port_id text not null references ports(id),
  good_id text not null references goods(id),
  buy_price integer,            -- tenths of gold, integer (see §5.2)
  sell_price integer,
  stock integer,                -- null if not shown for this item type
  submitted_by uuid references profiles(id),  -- null for demo rows
  source text not null default 'manual',      -- 'manual' | 'ocr' | 'screenshare' | 'demo'
  is_demo boolean not null default false,
  observed_at timestamptz not null default now(),
  flagged boolean default false,
  flag_reason text
);

create index on price_submissions (server_id, port_id, good_id, observed_at desc);

-- Fast lookup of the price the calculator should actually use.
-- Rules:
--   * ignore flagged rows
--   * ignore demo rows for a (port, good) once ANY real submission exists for it
--   * otherwise take the most recent
-- Implement as a view in Phase 1. In Phase 4, swap the selection logic for
-- consensus weighting without changing the calculator's interface.
create view prices_current as
select distinct on (server_id, port_id, good_id)
  server_id, port_id, good_id, buy_price, sell_price, stock,
  observed_at, is_demo, source
from price_submissions ps
where not flagged
  and (
    not is_demo
    or not exists (
      select 1 from price_submissions r
      where r.server_id = ps.server_id
        and r.port_id   = ps.port_id
        and r.good_id   = ps.good_id
        and not r.is_demo
        and not r.flagged
    )
  )
order by server_id, port_id, good_id, observed_at desc;

create table ship_presets (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  ship_id text not null references ships(id),
  upgrade_ids text[] default '{}',   -- may be empty: barebones is valid
  created_at timestamptz default now()
);

create table saved_routes (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  origin_port_id text references ports(id),
  destination_port_id text references ports(id),
  label text,
  last_used_at timestamptz default now()
);

-- Records what OCR read vs what a human corrected it to.
-- Structured fields ONLY — never store the source image.
create table ocr_corrections (
  id bigserial primary key,
  screen_type text,             -- 'market' | 'shipyard' | 'port_tooltip'
  field_name text,
  ocr_value text,
  corrected_value text,
  created_at timestamptz default now()
);

-- Seasonal world modifiers. Cannot be predicted; recorded when observed.
create table seasons (
  id bigserial primary key,
  server_id text references servers(id),
  name text,                    -- e.g. 'Season IV'
  starts_at timestamptz,
  ends_at timestamptz,
  modifiers jsonb,              -- free-form; e.g. {"note":"Copper output up; Siege ships -10%"}
  active boolean default false
);
```

### 3.2 Row Level Security

Enable RLS on **every** table. Policies:

| Table | Read | Write |
|---|---|---|
| `goods`, `ships`, `upgrades`, `ports`, `servers` | everyone | admin only |
| `price_submissions`, `port_state` | everyone (shared community data) | insert: any authenticated user. **No update or delete** — the table is append-only; corrections are new rows. Admins may set `flagged`. |
| `prices_current` (view) | everyone | n/a |
| `profiles` | own row only | own row only |
| `ship_presets`, `saved_routes` | own rows only | own rows only |
| `seasons` | everyone | any authenticated user (world state, shared) |
| `ocr_corrections` | admin only | any authenticated user (insert only) |

> Verify RLS by attempting to read another profile's presets with the anon key. If it succeeds, the policy is wrong.

### 3.3 Seed import
Import the four JSON files. `goods.json` and `resources.json` both feed the `goods` table — set `is_trade_good = true` for the 20, `false` for craft materials and special items.

**Expected row counts after seeding — assert these:**
- ports: **42**
- ships: **38**
- goods (trade goods): **20**
- goods (craft + special): **41**
- goods total: **61**

### 3.4 Demo data
Insert clearly-labelled fake prices so the calculator is testable before real data exists.

Demo rows are `price_submissions` with `is_demo = true`, `source = 'demo'`, `submitted_by = null`. The `prices_current` view automatically drops them for any (port, good) as soon as a real submission exists — no cleanup job needed, no risk of demo data silently contaminating real results.

The UI must visibly badge any figure derived from demo data.

**Done when:** all tables exist, RLS verified, seed counts assert correctly, and the calculator tests in §5 pass.

---

## 4. Domain Rules (implement exactly)

### 4.1 Ship rate gating (hard constraint)
A port may specify `min_ship_rate`. A ship whose `rate` is **lower-numbered than** `min_ship_rate` cannot use that port — for **both departure and arrival**.

```
canUsePort(ship, port) = port.min_ship_rate == null || ship.rate >= port.min_ship_rate
```

Example: a port with "Shallow waters ranks VI-7" has `min_ship_rate = 6`. A rate 3 ship is excluded. A rate 7 ship is fine.

This filters the UI in both directions: after picking an origin, only ships that can leave it are selectable; after picking a ship, only reachable destinations are shown.

> Lighthouses do **not** bypass this. They are a travel-time mechanic only. Do not implement them as a depth workaround.

### 4.2 Distance
Straight-line pixel distance between port coordinates:

```
distance = sqrt((x2-x1)^2 + (y2-y1)^2)
```

**Display this as an abstract "distance unit", never as time.** Actual travel time depends on wind direction, sail configuration and cargo load, none of which we can predict. Converting to minutes would be inventing precision we do not have.

Origin and destination must not be the same port — guard this explicitly (division by zero in profit-per-distance).

### 4.3 Effective ship stats
Apply **flat modifiers first, then percentage modifiers**, to the base value:

```
effectiveHold  = (base.hold + Σ flat) * (1 + Σ percent/100)
effectiveSpeed = (base.speed + Σ flat) * (1 + Σ percent/100)
```

This ordering reproduces observed in-game values and is verified — see `ships.json` → `_meta.validationEvidence`.

Presets with **zero upgrades are valid**. Never require upgrades.

---

## 5. The Calculator

### 5.1 Price model
The calculator reads from the `prices_current` view, never from `price_submissions` directly. Each `(server, port, good)` has an optional `buy_price` and an optional `sell_price`.

> **Important context:** we have never directly observed a Buy button on the 20 trade goods in-game — only a greyed sell control (greyed because the hold was empty). The trading model is inferred from the game's own encyclopedia text ("Profit from price differences by transporting between ports") plus observed price patterns. It is strong evidence, not proof. Keeping buy and sell as separate nullable fields means that if the real mechanic differs, it is a data change, not a rewrite.
>
> Craft materials **do** show a confirmed spread (e.g. Wood 4.2 buy / 3.9 sell).

If a good has no `buy_price` at origin or no `sell_price` at destination, it is excluded from that route with a stated reason.

### 5.2 Currency as integers
Prices in game can have one decimal (e.g. `4.2`, `18.9`). Store and compute in **tenths of gold as integers**:

```
storedValue = round(displayedPrice * 10)
```

All arithmetic uses these integers. Convert to display only at render time. Never use floats for money.

### 5.3 Profit formula

For one good on one route, for `n` units:

```
grossRevenue = sellPrice * n
taxAmount    = grossRevenue * (taxPercent / 100)      // destination port's tax
purchaseCost = buyPrice * n
netProfit    = grossRevenue - taxAmount - purchaseCost
```

Then once per trip (not per unit):

```
tripProfit = Σ netProfit(all goods) - dockingFee
```

**Order of operations matters.** Tax applies to the sale only. Docking fee is a flat per-trip cost, not per unit.

Rules:
- `taxPercent` null → treat as **0** and display "tax unknown" on the result.
- `dockingFee` null → treat as **0** and display "docking fee unverified".
- Never substitute a default of 8% for unknown tax. Observed real values range 4–12%.

### 5.4 Speed and travel
Use **base speed** from the ship record. The in-game HUD shows a range (e.g. `9.2 – 11.7`); the lower bound is base, the upper is max cruise speed.

Display alongside any speed figure: *"Base speed — actual speed varies with wind direction, sails and cargo load."*

Sail upgrades increase cruise speed, not base. Store them on presets and show them, but do not use them in profit-per-distance in V1.

> Cargo weight is confirmed to affect speed (the in-game hold screen shows a live "Speed from load" modifier). We do not have the formula, so V1 does not model it. Note this in the UI as a known limitation.

### 5.5 Cargo optimisation

**There is no cargo-slot limit.** Hold capacity by weight is the only constraint. (An earlier design assumed slots existed; in-game ship cards prove they do not.)

Solve as an **exact bounded knapsack**:

- Capacity: `effectiveHold`
- Items: every good with a valid buy price at origin and sell price at destination
- Per-item weight: `good.weight`
- Per-item value: `netProfit per unit`
- Per-item bound: `min(effectiveStock, affordabilityLimit, floor(capacity / weight))`

> ⚠️ **Null stock is common and must not zero the bound.** The Market screen does **not** display a quantity for the 20 trade goods — only craft resources show `pcs`. So `stock` is `null` for most trade-good rows. Treat it as *unbounded*, not as zero:
>
> ```
> effectiveStock = (stock == null) ? floor(capacity / weight) : stock
> ```
>
> Getting this wrong makes the optimiser return an empty cargo plan for every trade good — a silent, total failure.
- Quantities are **whole units only**

Feasibility is confirmed: worst case is the largest hold (54,000) × 61 goods ≈ 3.3M DP cells. This runs comfortably in a browser. **Do not substitute a greedy approximation** — greedy is not optimal once stock limits and integer quantities are involved.

Exclude items with `netProfit <= 0`.

### 5.6 The four metrics

Compute all four; let the user sort by any:

| Metric | Formula |
|---|---|
| Total profit | `tripProfit` |
| Profit per weight | `tripProfit / totalWeightCarried` |
| Profit per distance | `tripProfit / distance` |
| ROI | `tripProfit / totalPurchaseCost` |

### 5.7 Affordability
Optional "available gold" input. When set, it constrains total purchase cost inside the knapsack. This matters more than it sounds — early game, capital is the real bottleneck, not hold space.

### 5.8 Return leg
After computing origin → destination, also compute destination → origin using existing data and present it as a secondary suggestion. This is *not* full multi-leg routing (that is backlog) — it just covers the common out-and-back pattern.

### 5.9 Required tests

Write these as automated tests. They must pass before Phase 2.

1. **Known-answer test.** Fixed prices, fixed ship, hand-computed expected output. Assert exact match.
2. **Knapsack optimality.** Use this exact case, which is verified to defeat greedy-by-ratio:

   | Good | Weight | Profit/unit | Stock | Ratio |
   |---|---|---|---|---|
   | A | 16 | 30 | 6 | 1.875 |
   | B | 10 | 9 | 5 | 0.900 |
   | C | 13 | 28 | 5 | 2.154 |

   Capacity **120**. Greedy-by-ratio yields **230**. The optimum is **234**. Assert the solver returns 234.

   *Do not substitute an arbitrary case — most random inputs happen to give the same answer for both methods, so a greedy implementation would pass and the test would give false confidence.*
3. **Integer money.** Assert no floating-point drift across a 1000-unit transaction.
4. **Rate gating.** Assert a rate-3 ship is rejected from a `min_ship_rate = 6` port, in both directions.
5. **Same-port guard.** Assert origin == destination is rejected without dividing by zero.
6. **Null tax/fee.** Assert nulls are treated as 0 and the "unverified" flag is set on the result.
7. **Stock limiting.** Assert the plan never exceeds available stock.
8. **Empty result.** Assert a route with no profitable goods returns a helpful empty state, not an error.
9. **Null stock.** Assert a good with `stock = null` is still included and bounded only by capacity and affordability — not excluded, not zeroed.
10. **Demo-data displacement.** Insert a demo price and a real price for the same (port, good). Assert `prices_current` returns the real one, and that the demo row is ignored. Assert a demo row IS returned when no real submission exists.
11. **Real-data regression.** Using the two real observed port price sets in `goods.json` → `_validationEvidence`, assert the calculator returns **zero profitable goods** — those two ports are priced nearly identically, and this is the correct answer. This test guards against a calculator that hallucinates profit.

---

## 6. Phase 2 — Core UI

**Goal:** the first genuinely usable version.

### 6.1 Flow
Four steps, in order:

1. **Origin port** — click on map
2. **Destination port** — click on map (only ports reachable by the chosen ship, once known)
3. **Ship** — pick a saved preset, or a base ship
4. **Results**

Saved and recent routes skip steps 1–2.

### 6.2 Map
V1 is a **functional map**, not illustrated art (illustration is Phase 5).

- Render the 42 ports at their coordinates on a stylised background
- Pan and zoom; cluster markers that overlap at low zoom
- **Marker primary visual = data freshness** (see 6.3). Faction is a small secondary badge.
- Ports the current ship cannot use are visibly disabled with the reason on hover/tap
- **Provide a searchable text list as an equal alternative to the map.** Required for accessibility and faster for users who know the port name.
- Clearly indicate which step is being chosen (origin vs destination) and allow swap/reset

### 6.3 Freshness indicator

| Age | Colour | Icon | Meaning |
|---|---|---|---|
| < 1 hour | green | ✓ | fresh |
| 1–6 hours | yellow | ◷ | aging |
| 6–24 hours | orange | ⚠ | stale |
| > 24 hours | red | ! | likely wrong |
| no data | grey | ○ | never recorded |

**Colour alone is never the only signal** — always pair with the icon and a text label. Thresholds are user-adjustable in settings.

Rationale for the bands: the in-game Market states offers refresh "every 1-2 days", but prices also react in real time to player buying and selling, so freshness is a confidence signal rather than a guarantee.

### 6.4 Results screen
- **Top:** the recommended cargo plan — which goods, how many units, total profit. Prominent.
- **Sort control:** the four metrics from §5.6.
- **Below:** full supporting table — every good on the route with buy price, sell price, margin, weight, stock, and freshness. This shows *why* the recommendation is what it is.
- **Return leg** as a secondary section.
- Any unverified inputs (tax, docking fee) called out explicitly on the result.

### 6.5 Ship presets
- Create from any ship; upgrades optional
- Editable in place (upgrading a real ship should not require recreating the preset)
- Deleting requires confirmation and offers a brief undo
- Show computed effective hold and speed so the user can sanity-check against their in-game HUD

### 6.6 Empty and error states

| Situation | Behaviour |
|---|---|
| No profitable goods on route | Say so plainly. Suggest the nearest port that *is* profitable. If data is stale, say that instead. |
| No price data for the route | Prompt to add data for these ports; link straight to entry. |
| Port has no market | State it; exclude from selection. |
| Ship cannot reach destination | Explain the rate restriction with the actual numbers. |
| Same port both ends | Prevent selection rather than erroring after. |

**Done when:** a user can go from cold start to a profit recommendation using demo data, on both phone and desktop.

---

## 7. Phase 3 — Data Entry

Build in this order. Each is independently useful.

### 7.1 Manual entry (the guaranteed path)
Pick a port → see all goods with current values and freshness → edit → save. Must be fast on a phone. This path must remain fully functional forever, regardless of OCR.

### 7.2 Screenshot OCR

Flow: upload image → serverless function → Anthropic vision API → parsed values → **user review screen** → save.

**Required safeguards:**

1. **API key stays server-side.** The browser calls our function; our function calls Anthropic. The key is never in frontend code or network traffic visible to the client.
2. **Strip EXIF metadata from every uploaded image before processing or storage.** Phone photos of a monitor can carry GPS coordinates. This is a real privacy leak, not a hypothetical.
3. **Validate every returned field before it touches the database.** A crafted image can attempt prompt injection. Never trust model output structurally:
   - good name must match a known good id
   - prices must be integers within the min/max sanity band
   - stock must be a non-negative integer
   - anything failing validation is rejected, not corrected
4. **Per-user rate limits** on the upload endpoint, separate from the account-wide spend cap. Without this, one bad actor can run up the bill even if every image is correctly rejected.
5. **Never store the raw image** beyond the processing request.
6. **Always show the review screen.** Never save OCR output unattended.
7. File type and size validation before processing.

**Screens to support** (layouts confirmed from real screenshots):
- **Market tab** — 20 trade goods with prices; header states City vs Settlement
- **Trade with port** — craft resources with buy/sell pairs and stock
- **Map port tooltip** — tax %, shallow water rank, faction owner, port level
- **Shipyard card** — ship stats

Log every user correction into `ocr_corrections` (structured fields only, never images). Group by pattern when displaying, so systematic weaknesses surface rather than drowning in one-offs.

> Frame OCR as experimental in the UI. It will need iteration against real output.

### 7.3 Screen share (optional, desktop only)

- **Off by default.** Opt-in per session, never persistent.
- Honest framing: *"Share your World of Sea Battle window and we'll read port prices as you play — this helps keep pricing current for everyone."*
- Instruct **window-only** sharing, not full screen.
- Sample at most once every 5–10 seconds, and only analyse a frame if it changed *and* matches a known screen layout. Discard everything else without sending it anywhere.
- Detected data queues quietly for later review — never interrupt active play with a modal.
- Detect share-stop cleanly. Show a live thumbnail of what is being captured.
- If declined, do not ask again that session.
- Does not work on mobile browsers — this is a platform limitation, state it plainly rather than failing silently.

**Done when:** manual entry is complete and pleasant; OCR works on at least the Market screen with review.

---

## 8. Phase 4 — Multi-user & Polish

- **Optional account upgrade** — anonymous → email/password, carrying all data across. Add a captcha on signup.
- **Account recovery** — show the access token as copyable text *and* a QR code at first run. iOS Safari can evict local storage after ~7 days of non-use, so a recoverable identity is genuinely necessary.
- **Submission moderation:**
  - auto-flag prices outside the min/max sanity band
  - consensus weighting when multiple users submit for the same port/good
  - contributor reputation: established accounts weight higher than brand-new ones
  - admin review queue with accept / reject / ban
- **Privacy:** round submission timestamps rather than storing exact times. This is a PvP game with guild warfare; precise "who was where when" data is a real risk to contributors.
- **Offline resilience:** queue submissions locally and retry on reconnect, with a visible pending indicator.
- **Error monitoring** (e.g. Sentry free tier) — there is no QA team, so failures must self-report.
- **Account deletion** that actually deletes.
- **Privacy Policy and Terms** before any public sharing.
- **Seasons UI** — record the current season and its modifiers; apply to displayed estimates. Cannot be predicted, only recorded.

**Done when:** anonymous users can upgrade to a recoverable account without losing data; flagged submissions surface in an admin queue; account deletion works end to end; errors self-report.

---

## 9. Known Unknowns

State these in the UI where relevant. Do not silently assume values.

| Item | Status | Handling |
|---|---|---|
| Docking fee | Never observed in game | Default 0, labelled unverified |
| Trade good buy prices | Buy control never seen | Separate nullable field; excluded if absent |
| Faction match discount | Community-reported ~25% on materials | Configurable, default 0 |
| Cargo weight → speed | Confirmed real, formula unknown | Not modelled; note as limitation |
| Perishable trade goods | Spoilage exists; all known perishables are craft/food items | All 20 trade goods default `perishable: false` |
| Port category `f` vs `n` | Inferred, two known discrepancies | Display hint only, never a rule |
| Good home regions | Unknown | `homeRegion: null`; would improve predictions if determined |
| Season effects | Cannot be predicted | Recorded manually per season |
| Ship roster | 38 of ~58 captured | App must handle additions gracefully |

---

## 10. Backlog (do not build in V1)

Multi-ship comparison · circuit/multi-leg routing · risk-adjusted profit (cargo loss on sinking is displayed in-game, so this is feasible) · ship upkeep and upgrade wear costs · price history charts · crafting profit calculator · illustrated map · six faction scenes · interactive background easter eggs · production sites / lighthouses / forts on the map · auction-tab aggregate price capture.

---

## 11. Definition of Done for V1

- [ ] Deployed and reachable at a public URL
- [ ] All 61 goods, 42 ports, 38 ships seeded and asserted
- [ ] All eleven calculator tests passing, including the real-data regression
- [ ] Four-step flow works on phone and desktop
- [ ] Manual price entry complete
- [ ] OCR working on the Market screen with mandatory review
- [ ] RLS verified by attempted cross-account read
- [ ] API keys confirmed absent from the client bundle
- [ ] Unverified values visibly labelled everywhere they appear
- [ ] Unofficial-fan-tool disclaimer present
