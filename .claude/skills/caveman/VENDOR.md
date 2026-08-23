# Vendored: caveman skill

## Where it came from

| | |
|---|---|
| Upstream | https://github.com/JuliusBrussee/caveman |
| Tag | `v2.3.1` |
| Commit | `b5ec6351396b643a17cbbec4a6eee8b3fb9dd782` |
| Path upstream | `skills/caveman/SKILL.md` |
| License | MIT — `skills/` is MIT in the upstream split-license model (see its `LICENSING.md`) |
| sha256 of the upstream half | `3edd677596cbf12f010f25f05dfb1e8a6c9c178d92499c86e5b5afa44c86c16c` |

The file was copied byte-for-byte and the hash verified after copying. This
project's own additions were then appended below a marked separator, so the
upstream half can be swapped for a newer release without hand-merging.

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

## To update it

Replace everything ABOVE the `---` separator in `SKILL.md` with the newer
upstream `skills/caveman/SKILL.md`, leave everything below it alone, and update
the tag, commit and hash in the table above.

## What was deliberately NOT taken

Upstream ships twenty skills and a proxy. Only the core one is here.

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
- **`caveman-explore`** is the one genuinely worth revisiting. It delegates repo
  exploration to a cheap read-only Haiku agent that returns only `path:line`
  citations, so file contents never enter the main conversation. That targets
  **input** tokens, which is where this project's spend actually is. It is shaped
  as a subagent rather than a skill, so it belongs in `.claude/agents/`, and it
  was left out only because nobody has asked for subagents on this project yet.

## Honest note on what this saves

The upstream 65% figure is measured on **output** tokens. On this project output
is the small side of the ledger — the bulk is input: whole-file reads, the output
of 274 tests, SQL dumps, and the conversation history replayed on every turn.
This skill does not touch any of that. Expect a real but modest saving, not a
third off the bill.
