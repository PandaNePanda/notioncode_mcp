# Security policy

This project uses an unofficial Notion private API and authenticates with the
`token_v2` browser session cookie. That cookie grants the same access as the
signed-in Notion account and must be treated like a password.

## Never publish or share

- `token_v2`, full browser cookies, account JSON files or screenshots of them;
- `runtime/.env` or its `MCP_PATH_SECRET`;
- `.notionagents/`, `state/`, `.runtime/`, logs or Codex config backups.

Use `notion-agent init --token-v2 -` so the token is read from standard input
instead of appearing in shell history or the process list. The bridge binds to
`127.0.0.1` by default; do not expose ports 8765 or 8787 to a public network.

Before publishing, run:

```bash
node scripts/check-public-release.mjs
git status --short
```

If a credential was committed at any point, deleting it in a later commit is
not enough. Revoke or rotate it first, then purge it from Git history before
publishing.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting / Security Advisory feature.
Do not include live credentials, cookies, private pages or user data in the
report. If private reporting is unavailable, open an issue containing only a
minimal, redacted description and request a private contact channel.
