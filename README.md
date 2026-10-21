# Money

Personal investment tracking: accounts, cash, shares, valuations. It is MCP-first
and uses Taico's authorization server for federated sign-in. Money only records
and tracks. It has no banking or brokerage integrations and never moves real
money or executes trades.

## Layout

An Nx + npm-workspaces monorepo, structured like ai-monorepo:

```
apps/       deployable applications
  backend/  REST + MCP API over shared business logic (see apps/backend/README.md)
packages/   shared libraries
  auth/     @taico/auth, TEMPORARILY vendored from ai-monorepo (see packages/auth/VENDORED.md)
docs/       repository-wide design guides and review checklists (see docs/README.md)
```

## Contributing

Read [AGENTS.md](AGENTS.md) first. It covers product boundaries, commands and
architecture, and links every design guide and review checklist (index:
[docs/README.md](docs/README.md)). Reviews check changes against
[docs/review-guides/](docs/review-guides/) and, for UI work,
[docs/ui/review.md](docs/ui/review.md).

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install and link workspace packages |
| `npm run build` | Build every project (Nx, dependency-ordered, cached) |
| `npm run build:dev` | Clean install (`npm ci`), build, verify `@taico/auth` imports resolve |
| `npm run dev` | Build packages, then run the backend in watch mode (http://localhost:4180) |
| `npm run dev:auth` | Watch-compile `@taico/auth` only |
| `npm start` | Run the built backend |
| `npm test` | Run every project's tests |
| `npm run typecheck` | Type-check every project |

Requires Node >= 20.
