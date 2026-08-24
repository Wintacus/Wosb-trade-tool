# Vendored: caveman-explore

| | |
|---|---|
| Upstream | https://github.com/JuliusBrussee/caveman |
| Tag | `v2.3.1` |
| Commit | `b5ec6351396b643a17cbbec4a6eee8b3fb9dd782` |
| Path upstream | `skills/caveman-explore/SKILL.md` |
| Vendored to | `.claude/agents/caveman-explore.md` |
| License | MIT — `skills/` is MIT in the upstream split-license model |
| sha256 of the upstream half | `71afe67eac052ecedc28cb03937d7191b35c216f844676d9bcf49cc4ebae2cb4` |

Copied byte-for-byte and the hash verified after copying; this project's notes were
appended below a marked separator. To update, replace everything ABOVE that separator
with the newer upstream file and update the commit and hash here.

Filed under `.claude/agents/` rather than `.claude/skills/` because its frontmatter
(`tools:`, `model:`) is an agent definition. Upstream keeps it under `skills/` for its
own installer's reasons; the content is unchanged.

## Why only this one

The `caveman` output-compression skill was vendored alongside it on 2026-08-23 and
**removed on 2026-08-24** after the first session's token usage was measured properly:

- Visible replies totalled roughly **7,000 tokens** across a 146.8M-token session.
- The skill's own instructions are about **2,100 tokens**, loaded into context on trigger
  and then replayed on every request for the rest of that session, plus ~150 tokens of
  standing instruction in `CLAUDE.md` replayed unconditionally.

It cost more to carry than it could save. That is not a knock on the upstream project —
its headline figures are real on the workload it was measured against — it simply does not
match this one, where 95.6% of spend is replayed context rather than generated prose.

`caveman-explore` targets that replayed 95.6%: it reads files in a side channel and
returns only `path:line` citations, so file contents never enter the main conversation.
Also deliberately not taken: **Caveman Proxy**, which carries the upstream 33.2%
input-token figure but cannot run in a phone-only, ephemeral-container setup (it wraps a
locally launched agent's provider traffic; there is no local agent here), and the
CLI-dependent skills (`caveman-setup`, `caveman-learn`, `caveman-stats`, `caveman-discover`,
`caveman-help`), which shell out to a binary that is never installed.

**One hard limit, given this project's first rule:** this agent returns locations, not
facts. Never quote a game value, price, tax rate or confidence level from its citations
without opening the file and reading the real line.
