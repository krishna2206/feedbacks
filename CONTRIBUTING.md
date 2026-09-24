# Contributing

Thanks for your interest! Feedbacks is early-stage: open an issue before starting large changes so we can agree on the approach.

## Setup

```bash
pnpm install
pnpm dev
```

Only Node 22+ and pnpm are needed (see the [README](README.md)).

## Before opening a pull request

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test:e2e-sync
```

## Conventions

- **Schema changes**: edit `packages/schema/src/db/*`, run `pnpm db:generate` (migration + Zero schema), and update the `zero_data` publication with a new migration if you add a synced table.
- **Queries and mutators** live in `packages/schema/src/zero`. Every query must apply the permission helpers, and every mutator must validate its arguments (Zod) and check permissions on the server (`tx.location === "server"`).
- **UI text** goes through i18next. Add every key to `apps/web/src/i18n/locales/en.json` and `fr.json`.
- **Styling** uses the tokens in `packages/ui/src/tokens.css` (`var(--bg-base)`, `var(--label-muted)`…), with no hard-coded colors. Hover states change instantly; leaving fades in .15s.
- **Icons**: add Fluent icons to `packages/ui/scripts/gen-icons.mjs`, then run `pnpm --filter @feedbacks/ui icons`.
- Code, comments and docs are in English.

By contributing, you agree that your contributions are licensed under the AGPL-3.0.
