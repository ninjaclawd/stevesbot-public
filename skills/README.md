# Skills

All bot capabilities live here. Each skill is a directory containing a `skill.yaml` manifest.

## Skill types

### Declarative (`type: declarative`)
Gathers data via shell commands and SQL queries, then sends it to the local Qwen LLM
for summarization. Good for reports, digests, health checks.

### Script (`type: script`)
Runs a standalone script (Python, bash, node, etc.) and captures stdout as the result.
Good for vision analysis, automation, anything that does its own work.

## Adding a new skill

1. Create a directory: `skills/my-skill/`
2. Add `skill.yaml` with the manifest (see schema below)
3. For script skills, put your scripts in the same directory
4. Register a chore in `src/chore-definitions.ts` if it should run on a schedule

## skill.yaml schema

```yaml
# --- Required for all skills ---
type: declarative | script
id: unique-id
name: Human Name
description: What this skill does
schedule: "cron expression"    # e.g. "*/30 * * * *", or "" for on-demand
report_to: review_channel

# --- Declarative skills only ---
uses_llm: true | false
model_preference: local-qwen
data_queries:
  - id: query_name
    type: shell | sql
    command: "shell command"    # for type: shell
    db: stevesbot | knowledge | archive  # for type: sql
    query: "SELECT ..."        # for type: sql
prompt_template: |
  Your prompt with {{data}} and {{date}} placeholders
output_format: text

# --- Script skills only ---
interpreter: python3 | bash | node
entrypoint: script.py          # relative to skill directory
args: []                       # optional default CLI args
env:                           # optional extra env vars
  DISPLAY: ":0"
timeout: 120000                # ms, default 120000
```

## Current skills

| Skill | Type | Schedule | Purpose |
|---|---|---|---|
| system-health-check | script | */30 * * * * | Infrastructure health |
| daily-digest | declarative | 0 20 * * * | Daily activity summary |
| weekly-summary | declarative | 0 18 * * 0 | Weekly review |
| issue-trend-monitor | declarative | 0 9 * * * | Support category spikes |
| knowledge-gap-detector | declarative | 0 10 * * * | Ungrounded question detection |
| repo-changelog | declarative | 30 4 * * * | New commits across repos |
| auto-mine-threads | declarative | 0 3 * * * | Mine archive threads to KB |
| weekly-kb-mining | script | 0 14 * * 0 | Weekly KB mining refresh |
| monthly-kb-refresh | script | 0 15 1-7 * 0 | First-Sunday KB rebuild |
| draft-failure-analyzer | declarative | 0 10 * * 3 | Weekly rejection audit |
| auto-learn-from-approvals | declarative | 0 21 * * * | Extract Q&A from approvals |
| vision-analyzer | script | on-demand | Image analysis via RTX 5090 |
| captcha-bypass | script | on-demand | Vision-based CAPTCHA solving |

## Validation

Run `npm run validate-skills` from the repo root to validate the current skill set.

The validator uses different strategies depending on the skill:
- `data`: run declarative skill queries, verify the prompt can be rendered cleanly, and apply loose semantic/data-shape checks where that adds confidence
- `dry-run`: execute script skills in no-side-effect mode
- `mock-e2e`: execute image/vision skills against a local mock API and assert structured output
- `live-e2e`: run deterministic live scripts such as `system-health-check`

Use `npm run validate-skills -- --json` if you want machine-readable pass/fail output.
