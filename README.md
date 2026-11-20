# StevesBot

StevesBot answers Discord support questions using product source code, documentation, and past support cases. Users opt in by selecting their platform in a support thread’s help prompt or by mentioning the bot with a question. Use Discord’s **Reply** on its answer to continue the conversation with a test result, correction, or follow-up.

A validated answer to an explicit request goes back to the source conversation. Other messages in enabled channels can produce private draft suggestions for a maintainer. Scheduled jobs can also alert maintainers to breaking changes or recurring support issues.

## What does the bot search?

**GitHub repositories are a primary source.** The host clones specific branches, and the drafter searches the files on disk. For example, on the sample Social Stream support route, a question about a chat provider can lead the drafter to search `sources/` in `steveseguin/social_stream`, open the matching file, and use its implementation to explain the behavior. A Git refresh makes changed lines available on the next file read. Issues and pull-request discussions do not come down with the checkout.

| Evidence | Where it comes from | How the drafter gets it |
| --- | --- | --- |
| Product code and docs | Local clones of `steveseguin/vdo.ninja` (`develop`), `steveseguin/social_stream` (`main`), and `steveseguin/ssn_app` (`main`) in the public sample | Literal, regex, symbol, and filename searches, followed by reads of matching files or line ranges. |
| Current conversation | Incoming message, thread starter when available, recent transcript, and the bot answer referenced by a Discord reply when retrievable | Included in drafting context. Extracted screenshot text can also supply search terms. |
| Mined support cases | Local problem statements, solutions, and keywords in `data/sqlite/knowledge.sqlite` | Searched automatically before drafting. The drafter can also call `searchKnowledgeBase`. This collection is shared across routes. |
| Previous Q&A and raw history | `support_records` in `data/sqlite/stevesbot.sqlite` and archived messages in `data/sqlite/archive.sqlite` | `searchSupport` retrieves Q&A for the route. `searchDiscordHistory` retrieves matching conversations for the route. Incoming workflow events are archived on a best-effort basis. |
| Operator material and web results | Local resource directories and optional Brave or Tavily search | Resource tools read configured directories. Web search requires `BRAVE_SEARCH_API_KEY` or `TAVILY_API_KEY`. |

To add a product, clone its repository under `repos/`. Set its owner, repository, branch, checkout path, and readable files or directories in `repos.yaml`. Add that entry’s ID to the Discord route’s `repoScopes`. The general file tools have a separate configuration in `resource-map.yaml`. Review its `readableScopes` too. The sample includes both `repos/` and local support data. [Repository manifest](resources/manifests/repos.yaml) · [Discord routes](resources/manifests/discord.yaml) · [Resource map](resources/manifests/resource-map.yaml)

## Does it use RAG?

**Yes.** StevesBot uses retrieval-augmented generation (RAG) in two places.

1. **Before drafting**, the pipeline extracts search terms from the question and conversation. SQLite FTS5 retrieves up to three matching support cases, ranking by text relevance and recency. An in-memory TF-IDF index compares weighted word vectors using cosine similarity and can add up to two distinct cases. The pipeline puts their problem statements, solutions, and keywords into the model’s prompt.
2. **During drafting**, the model can ask for more evidence. The worker executes read-only tools and returns their results to the model. For an exact setting or code path, the model can search a checkout and open the relevant lines. A separate model call reviews the draft before delivery. The dashboard records tool calls and review decisions so a maintainer can inspect what informed an answer. [Drafting pipeline](src/pipeline/support-pipeline.ts) · [Repository tools](src/tools/read-only-tools.ts)

This design runs with SQLite, an in-process term index, and ordinary Git checkouts. It needs no embedding model or vector database. Literal search suits option names and error strings, and an operator can inspect the exact source revision. The weakness is vocabulary mismatch. TF-IDF depends on shared terms, so a paraphrase can miss a relevant case. FTS reads the current knowledge database. The TF-IDF index is built at startup, so restart the worker after a bulk import to refresh it. [Knowledge search](src/knowledge-base.ts) · [TF-IDF implementation](src/tfidf-search.ts)

A fresh install ships with empty support databases. Repository research works once the clones are present. As the bot handles questions, model-approved Q&A becomes searchable even before a user confirms that a fix worked. Treat historical answers as leads and check version-sensitive claims against the product branch. [Knowledge and feedback](docs/KNOWLEDGE_AND_FEEDBACK.md)

## Self-hosting

Install Node.js 20+, npm, Git, and ripgrep (`rg`). The repository sync script also uses Bash and GNU `timeout`.

```bash
git clone https://github.com/ninjaclawd/stevesbot-public.git
cd stevesbot-public
npm ci
cp .env.example .env
```

1. Configure the Discord token, a private review channel, and the Message Content intent. Replace the sample guild and channel IDs and enable your test route.
2. In `.env`, configure `LOCAL_QWEN_*` for routing and validation and `OPENCODE_*` for research and drafting. They use OpenAI-compatible chat endpoints. For Discord support and the dashboard alone, set `STEVESBOT_ROLE=intake,worker,web` to omit the optional peer-to-peer role.
3. Clone the branches listed above at the manifest paths. Run `npm run repo-sync` to verify and refresh them. Start with `STEVESBOT_DRY_RUN=true` in a test server. This suppresses worker delivery while Discord intake can still display interactive prompts. [Clone commands and full setup](docs/SETUP_GUIDE.md) · [Environment template](.env.example)

```bash
npm run build
npm test
npm run dev
```

**Verify retrieval.** With the model endpoints and clones configured, run `npm run repo-smoke -- --trace` to inspect a repository lookup. To test the mined full-text index independently of Discord or a model, run `npx tsx src/knowledge-base.ts search "audio routing"`. For daily checkout refreshes, schedule `npx tsx scripts/run-chores.ts` from the project root every few minutes. The repo-sync skill is due at 04:00. Check `logs/repo-update.log` for missing clones, wrong branches, or failed updates.

**Data handling.** Transcripts, databases, attachments, and logs stay out of Git. A hosted model can receive conversation text and retrieved excerpts during inference. Keep the dashboard private and set retention and backup policies for your installation. [Privacy and public exports](docs/PRIVACY_AND_PUBLIC_EXPORT.md)

## Deployment observations

From March 16 through November 20, 2026, one deployment recorded **196 interactive searches from 120 accounts**. In the 30 days ending November 20, it recorded 18 explicit requests from 11 identifiable accounts and 17 answers delivered to the source conversation. Delivery is measurable. Resolution requires confirmation from the user. One rejected draft repeated a diagnostic question the user had already answered, which is why the reply handler retrieves the specific bot answer the user selected.

## License

StevesBot uses the [MIT License](LICENSE). The `@vdoninja/sdk` dependency has its own [license and linking exception](https://github.com/steveseguin/ninjasdk/blob/main/LICENSE-SDK-EXCEPTION).
