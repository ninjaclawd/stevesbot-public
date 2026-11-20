# Setup guide

This guide assumes you can use a terminal but does not assume you have built a Discord bot before.

## 1. Prepare a safe test space

Create a private Discord server for setup. Do not begin in a busy production server: an incorrect channel ID or permission is easier to fix when nobody else is affected.

In the Discord Developer Portal:

1. Create an application and add a bot user.
2. Copy the bot token into `.env` as `DISCORD_BOT_TOKEN`.
3. Enable the message-content intent so the bot can read support text.
4. Invite the bot to the test server with permission to view channels, read history, send messages, create/use threads, add reactions, and use application commands where needed.
5. Avoid administrator permission. Grant access only to the support and review channels.

Discord IDs can be copied after enabling Developer Mode in Discord's advanced settings. Right-click a server, channel, or user and choose **Copy ID**.

## 2. Install the application

```bash
git clone https://github.com/ninjaclawd/stevesbot-public.git
cd stevesbot-public
npm install
cp .env.example .env
```

Keep `.env` private. A token is effectively the bot's password; rotate it immediately if it appears in a terminal recording, chat, issue, or commit.

## 3. Configure Discord routes

Edit `resources/manifests/discord.yaml`. A route says, “messages from this location may enter the support pipeline.”

```yaml
reviewChannel:
  guildId: "YOUR_SERVER_ID"
  channelId: "YOUR_PRIVATE_REVIEW_CHANNEL_ID"
  enabled: true

routes:
  - id: product-support
    guildId: "YOUR_SERVER_ID"
    channelId: "YOUR_FORUM_OR_CHANNEL_ID"
    mode: thread
    instructionRef: resources/instructions/product-support.md
    repoScopes:
      - product
    enabled: true
```

Use `mode: thread` for forum/thread support and `mode: channel` for an ordinary channel. The `repoScopes` names must match repository IDs in `repos.yaml`.

Copy an existing instruction file to `resources/instructions/product-support.md` and replace the product details. Good instructions explain product boundaries, evidence requirements, tone, common mistakes, and when the bot should stay quiet.

## 4. Add documentation and source repositories

For the supplied VDO.Ninja and Social Stream routes, clone the public product sources from `steveseguin` into the paths in the manifest. Run these commands from the bot checkout.

```bash
git clone --depth 1 --branch develop https://github.com/steveseguin/vdo.ninja.git repos/vdo-ninja
git clone --depth 1 --branch main https://github.com/steveseguin/social_stream.git repos/social_stream
git clone --depth 1 --branch main https://github.com/steveseguin/ssn_app.git repos/ssn_app
npm run repo-sync
```

For your own product, clone the source under `repos/`. Then add an entry to `resources/manifests/repos.yaml`:

```yaml
repos:
  - id: product
    owner: YOUR-ORG
    repo: YOUR-PRODUCT
    branch: main
    localPath: repos/product
    summary: Documentation and source for the supported product.
    allowedPaths:
      - docs
      - src
      - README.md
```

The tool layer enforces this allow-list. Do not point it at your whole home directory.

Schedule the chore runner from the repository root so the daily repo-sync skill runs. Check `logs/repo-update.log` after the first scheduled refresh. Use deployment keys or credentials with read-only repository access.

## 5. Configure models

Every model endpoint must support the OpenAI-compatible chat-completions shape used by `src/models/openai-compat.ts`.

Choose:

- A capable primary model for repo research, diagnosis, and final drafting.
- One or two cheaper cloud fallbacks for availability and simple work.
- Optional local endpoints for inexpensive routing or emergency fallback.
- Optional Z.ai coding-plan endpoint as a final cloud fallback.

The order is explicit in `.env`; no secret provider selection happens behind the scenes. Keep expensive models for tasks that need judgment. Small local models are best used for classification and keywords, not unsupported root-cause guesses.

Provider model names and limits change, so verify them in your provider account before launch.

## 6. Validate before connecting

```bash
npm run validate-skills
npm run repo-smoke
npx tsc --noEmit
npm test
```

Keep `STEVESBOT_DRY_RUN=true` for the first run:

```bash
npm run dev
```

Post a test question and inspect its workflow in the dashboard. Dry-run suppresses worker delivery. Discord intake can still display interactive prompts. Exercise the following cases in your private test server.

- a normal support question;
- a support question that `@mentions` the bot;
- a reply to a bot answer with new diagnostic details;
- an empty or joking mention, which should not force a reply;
- a question with no supporting documentation;
- provider failure, so fallback behavior is visible;
- restart during a queued job.

Only set `STEVESBOT_DRY_RUN=false` after review behavior is correct.

## 7. Run chores

Run due jobs once by hand:

```bash
npx tsx scripts/run-chores.ts
```

In production, invoke that command from cron or a systemd timer. Calling it every few minutes is fine because each skill has its own schedule and the runner prevents overlapping executions.

Review which skills are enabled. Expensive knowledge mining should run less often than health checks.

## 8. Backups and retention

Back up `data/sqlite/` to encrypted private storage. Decide how long to retain raw transcripts, logs, and attachments. Knowledge summaries are easier to keep safely than raw conversations, but they still require review for personal or confidential details.

## Common problems

| Symptom | First check |
| --- | --- |
| Bot is online but ignores a channel | Route ID, `enabled`, guild ID, channel ID, and mode |
| Bot cannot read text | Message-content intent and channel permissions |
| Every draft lacks evidence | Repository path/allow-list and empty knowledge databases |
| Model requests fail | Base URL includes `/v1`, model name, token, and timeout |
| The same chore starts twice | Ensure all launches share the same `STEVESBOT_ROOT` |
| Dashboard is exposed publicly | Bind `STEVESBOT_WEB_HOST=127.0.0.1` and use a protected tunnel/proxy |
