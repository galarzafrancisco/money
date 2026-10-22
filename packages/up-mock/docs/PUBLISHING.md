# Publishing readiness

Status: **not published**. `package.json` has `"private": true` so an accidental
`npm publish` fails. Remove it only after the checklist below.

## Checklist

- [x] No dependencies, no application-private configuration or imports (nothing from `@money/*`).
- [x] Public API is `src/index.ts` only; `dist/` contains compiled JS and `.d.ts`; test files are excluded from `files`.
- [x] Deterministic, offline by default (loopback-only delivery).
- [x] `docs/CONTRACT.md` separates documented Up behaviour from emulation.
- [ ] Validate the "recalled, not re-verified" items against Up's documentation and a real read-only token.
- [ ] Decide the final package name and scope (the unscoped `up-bank-mock` is a working name; check it is free and does not imply endorsement by Up).
- [ ] Choose the licence holder (`MIT` is declared) and add a `LICENSE` file.
- [ ] Add a repository `directory` field and a changelog.
- [ ] `npm pack --dry-run` and install the tarball in a scratch project.

## Versioning

Semver. While `0.x`, any change to endpoint behaviour or the programmatic API may
be breaking; list them in the changelog. Tighten emulation to match Up after
live validation as a minor bump with a note.
