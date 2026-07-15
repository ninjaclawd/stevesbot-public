# Privacy and public exports

This repository is an allow-listed export, not a copy of a production working directory.

## Never publish

- `.env` files, API keys, tokens, cookies, or authorization headers
- real Discord user, server, channel, thread, message, webhook, or application IDs
- message text, transcripts, attachment contents, usernames, or message links
- SQLite databases, WAL/SHM files, database dumps, or search indexes built from users
- logs, crash dumps, traces, screenshots, backups, or generated reports containing user text
- private hostnames, LAN/VPN addresses, SSH details, systemd environment files, or mount paths
- private repository clones, deployment keys, or private issue/commit metadata
- personal communication-style profiles or unique operational anecdotes

## Safe public substitutes

- clearly fake IDs such as `111111111111111111`
- `example-owner`, `example.test`, and localhost endpoints
- invented support questions that do not paraphrase a real person's message
- empty `.gitkeep` placeholders for runtime directories
- generic route and product instruction templates
- schema-only databases created in temporary test directories

Public product documentation and public repository URLs may be included when useful, but derived support history should still be generalized.

## Export checklist

1. Start from a clean public branch.
2. Copy only known-safe source, tests, templates, and documentation.
3. Do not copy `data/`, `logs/`, `repos/`, `dist/`, or `node_modules/`.
4. Replace real IDs, people, endpoints, absolute paths, and deployment details.
5. Review every tracked file, including tests and generated YAML/Markdown.
6. Run the build and tests from the public checkout.
7. Scan tracked files for secrets and likely Discord IDs.
8. Inspect the final staged diff before committing.
9. Confirm GitHub repository visibility before pushing.

Example local checks:

```bash
git status --short
git diff --cached --stat
git diff --cached
git grep -nE '(DISCORD_BOT_TOKEN|API_KEY|AUTHORIZATION).*=.+$'
git grep -nE 'discord\.com/channels/[0-9]{10,}'
git ls-files | grep -E '(^|/)(data|logs|repos)/|\.env$|\.sqlite($|-)|\.db$'
```

Pattern scans are only a backstop. A private message can contain no obvious ID or token and still be inappropriate to publish; human review of the staged diff remains essential.

## If something leaks

1. Rotate or revoke the credential first.
2. Remove the exposed file from the current branch.
3. Treat Git history, forks, caches, and build artifacts as potentially copied.
4. Rewrite history only with care and coordinate with anyone who cloned it.
5. Document the incident privately and improve the export checklist.
