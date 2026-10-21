# AGENTS.md

Rules for anyone changing this repository, people and coding agents alike. They follow the team guidelines in [akses-bogor-docs/guidelines](https://github.com/al-dioooo/akses-bogor-docs/tree/main/guidelines).

## Repository rules

**Commits.** Small and focused: one logical change, roughly 5 to 100 lines, easy to revert. Never mix a refactor with a feature, or a fix with formatting. No WIP commits on shared branches and no vague messages like "update code".

**Before committing.** `pnpm lint`, `pnpm typecheck` and `pnpm test` pass, and the change works locally. New features come with tests.

**Messages.** Conventional Commits for commit messages and PR titles: `type(scope): description`, e.g. `feat(laporan): accept unavailable reasons`. Types: feat, fix, refactor, docs, chore, test. Mark breaking changes with `!`, e.g. `feat(api)!: rename report fields`.

**Branches.** Trunk-based. `main` is always release-ready; `release` tracks production; there is no `develop` or `staging`. Work on short-lived `feature/<desc>`, `fix/<desc>` or `chore/<desc>` branches and merge through a PR whose title carries the issue number, e.g. `feat(auth): add email code login (#12)`. No direct commits to `main` except emergency hotfixes.

**Secrets.** Never commit `.env*` files, API keys, tokens, credentials or logs. Only `.env.example` with empty or sample values is committed.

**Docs.** Keep the README sections current: overview, tech stack, setup and run, environment variables, deployment. `docs/` holds the architecture diagram and the API spec. Product and technical decisions are ADRs in [akses-bogor-docs](https://github.com/al-dioooo/akses-bogor-docs/tree/main/decisions), not here.

## API conventions

- Every route declares Zod schemas for its params, body and responses. `docs/openapi.json` is generated from them with `pnpm openapi` and committed together with the route change; CI fails when it is out of date.
- Errors are `{ galat, pesan }`: a stable snake_case code and a short message in Bahasa Indonesia.
- The browser never talks to the database or R2 directly. Every request that touches data checks the session and role here.

## Attribution

Never add AI attribution anywhere: no AI author or `Co-authored-by` trailers, no "Generated with" or "Written by" lines in commit messages, PR titles or descriptions, code comments, docs, or API messages. Commits are authored by the human team only.

## Writing

All text people read (API messages, docs, commit messages, PR descriptions) must read as written by a person. Before committing text, check it with the unslop skill: run `python3 ~/.claude/skills/unslop/scripts/banned_phrase_scan.py` and `structure_scan.py` on it, and cut formulaic framing, inflated words, empty slogans and filler. Messages for users are short, concrete and in plain Bahasa Indonesia ([ADR-0020](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0020-antarmuka-bahasa-indonesia-siap-i18n.md)).
