# Best practices for Web applications

- Use React and Vite.
- Use `esnext` modules with `bundler` module resolution.
- Extend the repository's `tsconfig.base.json`.
- `noEmit: true`: `tsc` type-checks only; Vite builds.
- No `bun` or `deno` dependencies.
- Call the backend only through the generated client (`docs/architecture/api-clients.md`).
- Follow `docs/ui/guidelines.md`; reviewers use `docs/ui/review.md`.
- Add npm scripts:
  - `dev`: runs the app with hot reload
  - `build`: type-checks and builds
  - `start`/`preview`: serves the built output
  - `test`: runs tests (Vitest)
  - `lint`: runs a linter and fixes issues
