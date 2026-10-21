# Vendored copy of `@taico/auth` (temporary)

This directory is a **temporary, unmodified copy** of `packages/auth` from the
Taico monorepo. Money depends on `@taico/auth` for Taico federated auth (JWT
validation for REST and MCP), but the package is not on npm yet. Francisco
cannot publish it right now, so we vendor it rather than block backend work.

## Source

| | |
|---|---|
| Repository | https://github.com/galarzafrancisco/ai-monorepo |
| Pull request | https://github.com/galarzafrancisco/ai-monorepo/pull/1048 (open, not merged at copy time) |
| Branch | `feature/taico-auth-package` |
| Commit | `bab250b5e094c6406062e969ce8354d6909f22d6` (2026-10-21 13:51 +1100) |
| Path | `packages/auth` |
| Version | `0.8.6` |
| Copied | 2026-10-21 |

## Adaptations

**None inside this directory.** Everything except this file is byte-for-byte
identical to the source commit. That includes `package.json` (same name, version,
exports, peers), `src/`, `test/`, `README.md` and `tsconfig.build.json`.

The only supporting change is outside this directory. The package's
`tsconfig.build.json` extends `../../tsconfig.base.json`, so Money's root has a
`tsconfig.base.json` with the same compiler options as ai-monorepo's, minus the
`paths` aliases for Taico packages Money doesn't have.

To check that the copy still matches upstream:

```sh
git -C <ai-monorepo checkout> fetch origin bab250b5e094c6406062e969ce8354d6909f22d6
git -C <ai-monorepo checkout> checkout bab250b5e094c6406062e969ce8354d6909f22d6
diff -r <ai-monorepo checkout>/packages/auth packages/auth -x dist -x node_modules -x VENDORED.md
```

**Do not edit the files here.** Make fixes upstream in ai-monorepo and re-copy,
so the published package and this copy stay the same.

## How Money consumes it

The root `package.json` lists `packages/*` as npm workspaces. `npm install` links
`node_modules/@taico/auth` to this directory, so apps import it exactly as they
would the published package:

```ts
import { TokenVerifier, ResourceServer } from '@taico/auth';
import { AuthModule, RequireScopes } from '@taico/auth/nest';
```

An app declares it like any other dependency, e.g. `"@taico/auth": "^0.8.6"`.
npm resolves it to the workspace because the versions match.

The package builds to `dist/`, and imports resolve to `dist`, so it has to be
built before an app uses it. `npm run build` (Nx, `dependsOn: ^build`) and
`npm run dev` take care of that.

Checks:

- `npm run build:dev`: clean install, build, and `scripts/verify-auth-imports.mjs`
  (imports every public subpath through the workspace link).
- `npm test`: runs the package's own upstream test suite.

## Replacing it with the published package

Once `@taico/auth` is on npm (task `2c99c632-aa5f-45e3-bfbd-21c4d3e948a6`):

1. Delete `packages/auth/`.
2. In each consuming app, set `"@taico/auth": "^<published version>"` (no source
   change: same import paths).
3. Remove `@taico/auth` from `build:packages` in the root `package.json`, and
   take it out of `dev` and `verify:auth` too, or point those at the installed
   package.
4. `npm install`, then `npm run build:dev` and the app test suites.
5. If anything was patched upstream after commit `bab250b`, pick it up via the
   published version. Nothing in Money should depend on local differences,
   because there are none.
