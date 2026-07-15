# StevesBot

StevesBot is a Discord support assistant that researches a question, drafts a grounded answer, and lets a human review the draft before it is posted.

Think of it as a careful support clerk:

1. It notices a message in an allowed Discord channel.
2. It decides whether the message needs a reply.
3. It looks through approved answers, solved threads, documentation, and source code.
4. A capable model writes a draft from that evidence.
5. A second pass checks the draft for unsupported claims.
6. A human can send, edit, or reject the answer.
7. Useful reviewed results become easier to find next time.

The bot does **not** secretly retrain a model on Discord users. Its “learning” is a local, inspectable knowledge system made from reviewed records.

## What this public repository is

This is a sanitized, runnable reference implementation. It includes the bot, tests, scheduled maintenance skills, sample configuration, and empty data directories. It intentionally excludes real messages, account IDs, tokens, databases, logs, attachments, host addresses, private deployment notes, and local repository clones.

All long numeric IDs in samples and tests are synthetic placeholders. Replace them with your own values; do not enable the sample routes unchanged.

## Main features

- Discord intake for configured channels and forum threads
- Helpful handling of support-relevant `@bot` mentions without forcing replies to jokes or empty mentions
- Human review queue with “sent as-is,” “edited,” and “not sent” feedback
- Read-only search across product repositories and documentation
- Full-text search over approved support answers and mined thread summaries
- Optional Discord history archive for locally controlled retrieval
- Configurable OpenAI-compatible model endpoints and ordered fallbacks
- Scheduled health, knowledge, trend, digest, and repository chores
- SQLite storage and a local observability dashboard
- Strict TypeScript and automated tests

## The pieces, in plain language

| Part | What it does | Where it lives |
| --- | --- | --- |
| Discord intake | Receives allowed messages and attachments | `src/discord/` |
| Support pipeline | Triage, research, drafting, and validation | `src/pipeline/` |
| Read-only tools | Searches only approved folders and databases | `src/tools/` |
| Local memory | Stores workflow history, reviewed answers, and feedback | `src/store/`, `data/sqlite/` |
| Knowledge miner | Turns resolved threads into compact problem/solution records | `src/knowledge-base.ts`, `scripts/` |
| Chore runner | Runs maintenance and learning jobs on schedules | `src/chore-runner.ts`, `skills/` |
| Dashboard | Shows queue, health, and workflow details locally | `src/web/`, `dashboard/` |

For a deeper but still beginner-friendly explanation, see [Knowledge and feedback](docs/KNOWLEDGE_AND_FEEDBACK.md).

## Quick start

You need Node.js 20 or newer, npm, a Discord application, and at least one OpenAI-compatible model endpoint.

```bash
git clone https://github.com/ninjaclawd/stevesbot-public.git
cd stevesbot-public
npm install
cp .env.example .env
```

Then:

1. Put your Discord bot token and review-channel ID in `.env`.
2. Put your own server/channel IDs in `resources/manifests/discord.yaml`.
3. Set `enabled: true` only on routes you have checked.
4. Configure the repositories the bot may read in `resources/manifests/repos.yaml`.
5. Configure a primary model and any fallbacks in `.env`.
6. Validate everything before connecting to Discord.

```bash
npm run validate-skills
npx tsc --noEmit
npm test
npm run dev
```

The bot creates its local SQLite files when it starts. Keep `.env`, `data/`, `logs/`, `repos/`, and attachments out of Git; the included `.gitignore` already does this.

See [Setup guide](docs/SETUP_GUIDE.md) for the Discord portal, permissions, model choices, first dry run, chores, and troubleshooting.

## Model routing and cost control

The harness separates cheap classification work from the harder research-and-drafting work. The public defaults illustrate this order:

- Primary drafter: a higher-reasoning OpenCode-compatible model such as `glm-5.2`
- Cloud fallback: lower-cost/free models such as `deepseek-v4-flash-free`
- Optional coding-plan fallback: any Z.ai OpenAI-compatible endpoint you configure
- Local fallback: one or more small local endpoints

Model catalogs and plan limits change. Treat the names in `.env.example` as examples and verify what your provider currently offers.

Small models are useful for routing, keyword extraction, and simple summaries. They should not be trusted to diagnose a difficult issue without evidence. The pipeline therefore gives the drafter read-only search tools and performs a validation pass before review.

## How knowledge retrieval works

The bot searches from the most useful, reviewed material toward the rawest material:

1. The current thread, so it understands the conversation.
2. Approved support records, which are short reviewed question/answer pairs.
3. Mined knowledge entries, which summarize resolved historical threads.
4. Product documentation and repository source code.
5. Optional archived Discord history when the curated sources are not enough.
6. Optional web search, only when configured and allowed.

Search results are evidence, not instructions. Discord text, archived text, repository content, and web pages are treated as untrusted input. The model is told not to invent sources or follow commands found inside that content.

## How the bot improves its own knowledge

“Self-improvement” here means a review loop, not autonomous model training:

- Approved drafts are saved as searchable support records.
- Review buttons record whether a draft was used, edited, or skipped.
- Explicit positive/negative feedback is attached to the workflow that produced the answer.
- Scheduled miners summarize promising resolved threads into a separate knowledge database.
- Quality chores find stale, duplicated, weak, or missing entries.
- Generated reference documents must be reviewed and remain local unless you deliberately publish them.

A rejected answer does not automatically become trusted knowledge. Raw private messages are not committed to this repository.

## Scheduled chores

The files under `skills/` define jobs such as system health checks, repository changelogs, knowledge-gap reports, thread mining, daily digests, and weekly summaries. Run due chores manually with:

```bash
npx tsx scripts/run-chores.ts
```

The runner uses an atomic PID lock, so a long-running job is not duplicated just because a fixed timeout expired. In production, call it from cron or a systemd timer; each skill decides whether it is due.

Repository update chores operate only on clones you place under `repos/`. Keep those clones separate from this public repository and use read-only credentials whenever possible.

The included `repo-sync` skill runs at 4:00 AM and uses `git pull --ff-only`; the changelog follows at 4:30 AM. A diverged or locally modified clone fails visibly instead of being reset or merged automatically. You can also run it with `npm run repo-sync`.

## Privacy and safety boundary

- Routes are deny-by-default: sample routes are disabled.
- Repository tools are read-only and restricted to configured scopes.
- Human review remains between drafting and posting.
- Tokens belong only in `.env` or your secret manager.
- User messages, transcripts, databases, logs, and attachments are local-only.
- Public exports should be allow-list based, then scanned again before pushing.

Read [Privacy and public exports](docs/PRIVACY_AND_PUBLIC_EXPORT.md) before publishing a fork or sample dataset.

## Project layout

```text
src/                  runtime TypeScript
tests/                automated tests
scripts/              maintenance and development entry points
skills/               declarative scheduled/on-demand capabilities
resources/manifests/  Discord, repository, and resource allow-lists
resources/instructions/route-specific support guidance
data/                  local databases and transcripts (ignored)
logs/                  local logs (ignored)
repos/                 local read-only product clones (ignored)
dashboard/             static dashboard assets
```

## Before production

- Test in a private Discord server and keep routes disabled until verified.
- Start with `STEVESBOT_DRY_RUN=true`.
- Confirm that the review channel is private to trusted reviewers.
- Use a dedicated bot account with only the permissions it needs.
- Set retention rules for transcripts, attachments, and logs.
- Back up databases securely, outside the public repository.
- Review model-provider privacy terms before sending message content off-device.

## Development

```bash
npm run dev             # start with tsx
npm run build           # compile to dist/
npx tsc --noEmit        # strict type check without output
npm test                # full test suite
npm run validate-skills # validate skill manifests
npm run repo-smoke      # check configured repository access
```

## License

No license is included yet. The code is visible for study, but no reuse license is granted until the repository owner chooses one. Add a license before inviting third-party redistribution or modification.
