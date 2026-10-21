# Money

Personal investment tracking: accounts, cash, shares, valuations. It is MCP-first
and uses Taico's authorization server for federated sign-in. Money only records
and tracks. It has no banking or brokerage integrations and never moves real
money or executes trades.

## Layout

An Nx + npm-workspaces monorepo, structured like ai-monorepo:

```
apps/       deployable applications (backend, UI, ...)
packages/   shared libraries
  auth/     @taico/auth, TEMPORARILY vendored from ai-monorepo (see packages/auth/VENDORED.md)
```

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install and link workspace packages |
| `npm run build` | Build every project (Nx, dependency-ordered, cached) |
| `npm run build:dev` | Clean install (`npm ci`), build, verify `@taico/auth` imports resolve |
| `npm run dev` | Build packages, then watch-compile `@taico/auth` |
| `npm test` | Run every project's tests |
| `npm run typecheck` | Type-check every project |

Requires Node >= 20.
