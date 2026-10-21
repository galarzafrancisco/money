# Best practices for Node applications

- Use TypeScript and `npm` (workspaces); no `bun`, `deno`, `yarn` or `pnpm` dependencies.
- Target Node >= 20 (root `engines`).
- Extend the repository's `tsconfig.base.json`.
- Use `nodenext` modules and module resolution (as `apps/backend/tsconfig.json` does), overriding the base config's bundler settings.
- Register the project with Nx so `npm run build`, `test` and `typecheck` include it.
- Add npm scripts:
  - `dev`: runs the app with hot reload (watch mode)
  - `build`: compiles the app
  - `start`: runs the app from the compiled directory
  - `test`: runs tests
  - `typecheck`: type-checks without emitting
  - `lint`: runs a linter and fixes issues (not yet set up in Money)
- Configuration comes from environment variables with safe development defaults; production refuses to start without required values (e.g. `DATABASE_URL`).
