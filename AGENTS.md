# Instructions for AI agents

Read `README.md`, especially **Strict protocol for AI agents**, before making
changes or attempting installation.

## Repository invariants

1. Keep one shared implementation for Linux and Windows. Platform-specific
   files may launch processes, but must not duplicate bridge/runtime logic.
2. Do not change the operating principle: Codex remains the local runtime and
   Notion remains the inference provider.
3. Never read, print, copy, commit or ask the user to paste `token_v2` into
   chat. Credential entry must use `notion-agent init --token-v2 -` and stdin.
4. Never track `.runtime/`, `state/`, `.env`, account JSON, logs or config
   backups.
5. Preserve unrelated user settings and dirty-worktree changes. The Codex
   installer must only replace its managed blocks.
6. Bind local services to `127.0.0.1`. Do not expose them publicly.
7. Account affinity, failover, compaction and image changes require regression
   tests.
8. Do not claim success until the documented checks pass.

## Required checks after code changes

```bash
PYTHONPATH=bridge ./.runtime/notion-agent-cli-venv/bin/python -m unittest discover -s bridge/tests -v
npm --prefix runtime test
npm --prefix runtime run check
npm --prefix notion-private-api-mcp run check
node --test scripts/install-codex-config.test.mjs
node --test scripts/render-config.test.mjs
node scripts/check-layout.mjs
node scripts/check-public-release.mjs
```

Do not push to GitHub unless the user explicitly provides or confirms the
destination repository.
