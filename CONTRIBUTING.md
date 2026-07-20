# Contributing

Keep the bridge cross-platform: shared behavior belongs in `bridge/`,
`runtime/`, `config/` or `scripts/`; only process-launch adapters may differ
between Linux and Windows. Do not add separate platform copies of shared code.

Before opening a pull request, run the checks listed in `README.md`, including:

```bash
node scripts/check-public-release.mjs
node scripts/check-layout.mjs
```

Never commit Notion credentials, `.env` files, runtime state, logs or generated
Codex configuration. Tests must use obviously fake values. Changes to account
selection, conversation affinity, compaction or image handling require a
regression test because these paths prevent duplicate Notion threads and 502s.
