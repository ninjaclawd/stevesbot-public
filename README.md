# StevesBot

StevesBot is a TypeScript Discord support bot with a constrained tool surface, local knowledge storage, and configurable repo-aware drafting workflows.

This public export intentionally excludes:

- live Discord IDs and personal account identifiers
- local databases, transcripts, logs, and attachment dumps
- private infrastructure notes and machine-specific deployment files
- secrets and local repository clones

## What Is Included

- `src/` runtime code
- `tests/` automated tests
- `skills/` scheduled and on-demand skill definitions
- `resources/instructions/` support guidance
- `resources/manifests/` sample manifests for routes, repos, and resource scopes
- `dashboard/` static dashboard assets

## Quick Start

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and fill in your own values.
3. Update the sample manifests under `resources/manifests/`.
4. Clone any product repositories you want the bot to read into `repos/`.
5. Run `npm test`.
6. Start the app with `npm run dev`.

## Runtime Layout

- `data/sqlite/` local databases
- `data/transcripts/` archived raw message history
- `logs/` runtime logs
- `repos/` local clones used for read-only repo search

These directories are created as empty placeholders in this repo and are git-ignored by default.

## Notes

- This repository is prepared for GitHub publication with a fresh history.
- The included manifests are examples and are disabled or placeholder-based until you configure them.
- No license file is included yet; add one before wider public release if you want to grant reuse rights.
