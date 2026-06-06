# AGENTS.md

This repository keeps the canonical agent instructions in [`CLAUDE.md`](CLAUDE.md).
Codex agents should follow that file as the source of truth for repository
architecture, commands, design-doc rules, dogfood strategy, verification, and
commit policy.

The only substitution is the caller identity: where `CLAUDE.md` says "Claude Code",
read it as the current Codex agent. Runtime names inside the document, such as
`claude-code`, `codex`, `cursor`, and `ai-sdk`, are literal project concepts and
must not be renamed.
