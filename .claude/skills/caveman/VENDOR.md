# Vendored from caveman

Two files, both from the same upstream release. This file is the provenance
record for both.

## Where they came from

| | |
|---|---|
| Upstream | https://github.com/JuliusBrussee/caveman |
| Tag | `v2.3.1` |
| Commit | `b5ec6351396b643a17cbbec4a6eee8b3fb9dd782` |
| License | MIT — `skills/` is MIT in the upstream split-license model (see its `LICENSING.md`) |

| Vendored to | From upstream | sha256 of the upstream half |
|---|---|---|
| `.claude/skills/caveman/SKILL.md` | `skills/caveman/SKILL.md` | `3edd677596cbf12f010f25f05dfb1e8a6c9c178d92499c86e5b5afa44c86c16c` |
| `.claude/agents/caveman-explore.md` | `skills/caveman-explore/SKILL.md` | `71afe67eac052ecedc28cb03937d7191b35c216f844676d9bcf49cc4ebae2cb4` |

Both were copied byte-for-byte and the hashes verified after copying. This
project's own additions were then appended below a marked separator in each, so
the upstream half can be swapped for a newer release without hand-merging.

`caveman-explore` is filed under `.claude/agents/` rather than `.claude/skills/`
because its frontmatter (`tools:`, `model:`) is an agent definition. Upstream
keeps it under `skills/` for its own installer's reasons; the content is
unchanged.

## What each one is for

- **`caveman`** compresses **output** — the replies in chat. Pinned to `lite`.
- **`caveman-explore`** compresses **input** — it delegates repo search to a
  cheap read-only Haiku agent that reports only `path:line` citations, so the
  files it reads never enter the main conversation. This is the one aimed at the
  expensive half of the bill.

## Why vendored instead of installed

Upstream offers `npx skills add`, a Claude Code plugin marketplace entry, and
`install.sh` / `install.ps1`. None of those survive here:

- Claude Code sessions on this project run in an **ephemeral container** that is
  cloned fresh and reclaimed after inactivity. Anything `npm install`ed is gone
  by the next session.
- The person running this project works **from a phone**, with no terminal and no
  machine to install onto. `install.ps1` is Windows PowerShell; there is no
  Windows machine anywhere in this workflow.

A file committed to the repo is the one mechanism that persists, because the repo
is what gets cloned into every future session. So it is vendored.

## To update them

For each file: replace everything ABOVE the `---` separator with the newer
upstream version of the file named in the table, leave everything below it
alone, and update the tag, commit and hashes in the table above.

## What was deliberately NOT taken

Upstream ships twenty skills and a proxy. Two files are here.

- **Caveman Proxy** (`@caveman-ai/cli`) is the half that carries the headline
  33.2% input-token figure, and it **cannot run in this setup at all.** It works
  by wrapping a locally launched agent and intercepting that agent's provider
  traffic. There is no local agent here and no place to insert a proxy. This is
  structural, not a matter of effort. Its runtime is also BSL-1.1, not MIT.
- **`caveman-setup`, `caveman-learn`, `caveman-stats`, `caveman-discover`,
  `caveman-help`** all shell out to the `caveman` CLI, which for the reasons
  above is never installed. Vendoring a skill whose instructions tell the agent
  to run a binary that does not exist is worse than not having it.
- **`caveman-compress`** rewrites memory files such as `CLAUDE.md` into
  caveman-speak in place. `CLAUDE.md` here is written by the user, is read by the
  user, and is the file that governs everything else. It is not a candidate for
  lossy machine rewriting.
## Honest note on what this saves

The upstream **65%** figure is measured on **output** tokens, and that is all
`caveman` touches. On this project output is the small side of the ledger. The
bulk is input: whole-file reads, the output of 274 tests, SQL dumps, and the
conversation history replayed on every turn.

`caveman-explore` is the one that reaches the input side, and only for the
narrow case of searching the repo. It does nothing about test output, SQL dumps
or replayed history, and on a repo this small it will sometimes cost more than
it saves — see the guidance appended to the agent file about when to skip it.

The upstream **33.2%** input-token figure belongs to neither of these files. It
is Caveman Proxy's, and the proxy cannot run here at all. Do not quote that
number as something this project achieved.

Expect a real but modest saving overall. Nothing here has been measured on this
project; the figures above are upstream's, on their benchmark, not ours.
