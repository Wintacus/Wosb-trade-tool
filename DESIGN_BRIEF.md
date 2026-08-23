# Design Brief — WOSB Trade Tool

> **For:** Claude Design
> **Purpose:** original artwork and visual direction for a World of Sea Battle trading companion app
> **Read §1 before anything else.** The functional constraints there rule out entire categories of otherwise-good artwork.

---

## 1. Function Comes First

This is a **calculator**. People open it to read profit numbers and decide what to buy, often in under thirty seconds, often on a phone, often while a game is running in another window.

Three hard consequences:

1. **The background must never compete with a dense numbers table.** If a user has to squint past your artwork to read a price, the artwork has failed regardless of quality.
2. **Backgrounds dim, blur, or step back when results are on screen.** Ambience is for browsing and selecting. When someone is reading a calculation, function wins.
3. **Mobile performance is a hard ceiling.** This runs in a phone browser. Layered 2D illustration is affordable; anything heavier is not.

If a choice looks beautiful in isolation but makes the numbers harder to read, it is the wrong choice.

---

## 2. Art Direction

### 2.1 The style, positively stated

**Painterly, hand-illustrated 2D.** Soft natural lighting, visible brush texture, atmospheric depth achieved through layering rather than detail.

Influences: Studio Ghibli backgrounds, Makoto Shinkai's environmental lighting, and the illustrator behind the YouTube channel *Blue Turtle* (Dorian Cottereau, whose "Ithyä's Journey" work sits in the same lineage). These are named for the **technique and mood** — never to be copied, referenced literally, or reproduced.

The world is a weathered maritime archipelago. Working ports, salt air, overcast light, water that looks cold.

### 2.2 The style, negatively stated

These are not hypotheticals. Each one is a direction that was explicitly explored and rejected during design:

| Not this | Why |
|---|---|
| **Bright, saturated anime colour** | Reads cheerful and kitsch. Wrong for a pirate economy. |
| **3D rendering of any kind** | The style is genuinely 2D. Not stylised 3D, not painterly shaders on 3D geometry. |
| **Generic low-poly** | Explicitly rejected. |
| **Photorealism** | Loses to an actual game engine and edges toward the copyright line. |
| **Dark, grim, oppressive** | Muted ≠ gloomy. This must still be inviting to open daily. |
| **Anything resembling World of Sea Battle's own art** | Original work only. See §6. |
| **Flat vector / corporate illustration** | No gradients-and-geometry startup style. |

### 2.3 Palette

Muted and desaturated, but **balanced** — pulled back from vivid, not pushed toward dark.

**Target: no colour exceeds ~55% saturation.** Mid-tones carry the image; avoid both blown highlights and crushed shadows.

Starting palette (adjust in service of the mood, don't treat as law):

| Role | Hex | Notes |
|---|---|---|
| Deep water | `#2C3E4A` | Base sea tone, cool and desaturated |
| Mid water | `#3E5666` | Mid-distance water |
| Shallow / foam | `#6E8794` | Waterline, wake |
| Overcast sky | `#8FA3AC` | Default sky |
| Warm light | `#C89B6A` | Low sun, lantern glow — used sparingly |
| Sail canvas | `#D6CDBD` | Weathered off-white |
| Hull timber | `#6B563F` | Aged wood |
| Deep shadow | `#1E2A32` | Darkest value; not black |
| Parchment | `#E3D9C6` | UI surfaces, map ground |

**Accent discipline:** warm light (`#C89B6A`) is the only warm colour in an otherwise cool palette. Use it to draw the eye — a lit window, a lantern, sun on a sail. If everything is accented, nothing is.

### 2.4 The tone in one line
*Weathered and lived-in, not cheerful and not grim. A working port at the end of an overcast afternoon.*

---

## 3. Deliverables — Phase 1 (blocking)

Only two things block the app's first release.

### 3.1 Ship sprites — 38 required

The single largest asset need, and the most important.

**Specification:**
- **Side profile**, bow facing right, consistent across all ships
- **One static frame per ship.** Motion is added in code (see below) — do not draw animation frames
- Transparent background (PNG), plus SVG where practical
- Waterline at a consistent vertical position across all sprites so they align in a row
- **Scale is meaningful:** a rate VII schooner must read as visibly smaller than a rate I ship of the line. Scale relative to hull length; do not normalise every ship to the same size
- Target render size ~240px wide for the largest ships; deliver at 3× for retina

**Motion is code-driven, not drawn:**
- Vertical bob, ~3s cycle, eased in and out
- Rotation of ±2°, offset in phase from the bob
- Each ship gets a slightly randomised speed and phase so a row doesn't move in lockstep
- A separate shared foam/wake element sits at the waterline and loops independently

*Rationale: 38 ships × 4 frames would be 150+ drawings. One frame each is 38. This is the difference between the art getting finished and not. Code-driven motion is also smoother than a low frame count, tunable after delivery, and cheap on mobile.*

**Class silhouettes must be distinguishable at a glance.** Someone should be able to tell a Transport from a Siege galley from a Fast schooner without reading the label. Rig and hull proportion do this work:

| Class | Silhouette character |
|---|---|
| Fast | Small, low, fore-and-aft rig (schooner, cutter, corvette) — lean and quick |
| Battle | Balanced three-masted square rig, gunports prominent |
| Transport | Deep, broad, high-sided hull — visibly built to carry |
| Heavy | Tall, slab-sided, layered gundecks — the heaviest silhouette |
| Siege | Low and long, oars or lateen rig (galley, xebec, polacca) — distinctly Mediterranean |
| Imperial | Ornate and unusual — the outliers, including one hot-air balloon |

> **Reference material available:** the project has photographs of all 38 in-game ship cards, showing each vessel's real rig and hull proportions. Use these to get *class silhouette and relative proportion* right. **Do not trace, copy, or closely imitate the actual artwork** — match the shipwright's logic, not the game's illustration.

Full ship list with class, rate and hull type: `data/ships.json`.

### 3.2 One ambient background scene

A single painted port scene, layered for parallax.

- **3–4 layers:** sky → distant headland/town → mid-water with a small passing vessel → foreground water and dock edge
- Each layer exported separately, transparent where it should be
- Designed to be **partially obscured** — the UI sits on top of it
- Must hold up with a legible dark or light text panel over its centre
- Include a variant, or guidance, for dimming behind results

---

## 4. Deliverables — Phase 2 (after launch)

Not blocking. Do not start these until Phase 1 ships.

- **Six faction scene sets** — one visual identity each for Antilia, Espaniol, Kai & Severia, Trade Union, Pirates, and Empire/neutral. Distinct architecture and mood per faction, not just a palette swap.
- **Illustrated world map** — replacing the functional V1 map. Must place 42 ports at their real relative coordinates (`data/ports.json`); geographic accuracy matters because distances drive the calculator.
- **Scene transitions** — crossfade/pan between steps (port → dock → trade house). Under 400ms, interruptible.
- **Interactive easter eggs** — a small number of signature interactions, not everything clickable. The best candidate: click a passing ship repeatedly and it sinks. Subtle enough not to distract; discoverable enough to reward curiosity.
- **UI chrome** — parchment panels, buttons, iconography in the same hand-illustrated language.

---

## 5. UI Constraints

| Constraint | Requirement |
|---|---|
| Contrast | Text over artwork must meet **WCAG AA (4.5:1)**. See §5.1 for verified pairings — do not guess. |
| Colour independence | Never encode meaning in colour alone — the app's freshness indicator pairs colour with an icon and a label, and artwork must not undercut that. |
| Mobile first | Every asset must work at phone width. Test the map and results at 375px. |
| Reduced motion | Respect the OS-level `prefers-reduced-motion` setting: when set, **all** motion freezes automatically, without the user needing to find a toggle. This is an accessibility requirement — motion can trigger nausea and vestibular symptoms. |
| Toggle | Users can also disable animated backgrounds manually. The app must look intentional, not broken, with them off. |
| Auto-degrade | Backgrounds disable automatically on low-end devices or slow connections. Design a static fallback. |
| Load order | Artwork loads **after** the calculator is interactive. Never let a background block usability. |

---

### 5.1 Verified text pairings

These ratios are computed from the §2.3 palette, not estimated. Use them rather than judging by eye.

| Surface | White text `#FFFFFF` | Dark text `#1E2A32` | Use |
|---|---|---|---|
| Deep shadow `#1E2A32` | **14.7:1** ✅ | — | white |
| Deep water `#2C3E4A` | **11.1:1** ✅ | 1.3:1 ❌ | white |
| Mid water `#3E5666` | **7.7:1** ✅ | 1.9:1 ❌ | white |
| Overcast sky `#8FA3AC` | **2.6:1 ❌** | **5.6:1** ✅ | **dark only** |
| Parchment `#E3D9C6` | 1.4:1 ❌ | **10.5:1** ✅ | dark |

> ⚠️ **The overcast sky tone is the trap in this palette.** It *reads* as a mid-dark colour, but it is light enough that white text over it fails AA at 2.6:1. Wherever sky occupies the upper region of a scene and text may sit over it, use dark text or apply a scrim. This is the single most likely accessibility mistake here.

**Scrim recipe:** where the artwork underneath text varies, a `#1E2A32` overlay at 55–70% opacity restores white text to passing contrast over every palette colour above.

---

## 6. Originality Requirement

This is a fan-made companion tool for a commercial game. That imposes a hard line:

- **All artwork must be original.** Nothing extracted from, traced over, or closely imitating World of Sea Battle's assets — no ship models, textures, UI art, map imagery, or icons.
- **Style influences are named for technique and mood only.** Ghibli, Shinkai and Blue Turtle inform *how* to light and paint. Nothing may reproduce a specific frame, character, or composition from any of them.
- **Historical ship types are not ownable.** A schooner is a schooner. Drawing an accurate 18th-century xebec is fine; drawing *their* xebec is not.
- The app carries an "unofficial fan tool, not affiliated with the developers" disclaimer.

---

## 7. Practical Notes

**A picture beats this whole document.** Words like "muted" and "atmospheric" have enormous range. If reference images exist that hit the target, they are worth more than every adjective above — attach them and mark them *"this feeling, our own execution."*

**Ask before assuming on ambiguity.** If a requirement here conflicts with what looks good, raise it rather than quietly resolving it.

**Deliver in order:** ship sprites → background layers → everything else. Sprites are the only asset the app genuinely cannot ship without.

---

## 8. Acceptance Test

Three questions. If all three are yes, the art is right.

1. **Can a player identify a ship's class from its silhouette alone, at thumbnail size, without reading the label?**
2. **Can they read a dense profit table over the background without strain?** (Test with real content on top, not in isolation.)
3. **Does it read as weathered and lived-in — rather than either cheerful or grim?**

Question 3 is the one most likely to fail. "Muted" has a wide range, and earlier attempts erred toward bright. If a piece feels cheerful *or* oppressive, it has missed in opposite directions; the target is the middle.

---

## Appendix — Quick Reference

- 38 ships, 6 classes, 7 rates → `data/ships.json`
- 42 ports with map coordinates → `data/ports.json`
- 6 faction identities to design: Antilia, Espaniol, Kai & Severia, Trade Union, Pirates, Empire/neutral. (`data/ports.json` → `factions` lists 7 entries — the 7th, "Unaligned", is a player state, not a faction needing artwork.)
- Build phases and functional detail → `SPEC.md`
