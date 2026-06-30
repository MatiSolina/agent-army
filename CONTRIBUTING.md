# Contributing

Thanks for your interest in agent-army.

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in the values
pnpm dev
```

Requires Node 22+ and pnpm. See [`.env.example`](./.env.example) for required env vars and [`CLAUDE.md`](./CLAUDE.md) for the architecture.

## Workflow

1. Fork and create a branch off `main`.
2. **TDD, strict**: write the failing test in its own commit (red) before the implementation commit (green). Keep them as separate commits.
3. Before opening a PR, make sure these all pass:
   ```bash
   pnpm test
   pnpm exec tsc --noEmit
   pnpm lint
   pnpm build
   ```
4. Open a PR against `main`. CI runs test, typecheck, and lint.

## Conventions

- **English only** in code, UI, comments.
- Dark-only UI, Midday aesthetic.
- Generators that emit code must escape interpolated values (no injection).
- DB migrations are additive, idempotent scripts. No destructive drops without a deliberate migration.
- Never commit secrets. `.env*.local` is gitignored; use `.env.example` for new keys.

## License

By contributing, you agree that your contributions are licensed under the [Apache 2.0 License](./LICENSE).
