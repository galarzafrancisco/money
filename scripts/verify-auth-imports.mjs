// Smoke test: resolve @taico/auth the way a Money app will (through the npm
// workspace symlink in node_modules, not a relative path) and check that every
// public subpath loads and exposes the entry points Money relies on.
import assert from 'node:assert/strict';

const core = await import('@taico/auth');
for (const name of ['TokenVerifier', 'ResourceServer']) {
  assert.equal(typeof core[name], 'function', `@taico/auth is missing ${name}`);
}

const subpaths = ['nest', 'nest-ws', 'express', 'hono', 'typeorm', 'memory', 'idp-local', 'client'];
const failures = [];
for (const sub of subpaths) {
  try {
    const mod = await import(`@taico/auth/${sub}`);
    assert.ok(Object.keys(mod).length > 0, `@taico/auth/${sub} has no exports`);
  } catch (err) {
    failures.push(`@taico/auth/${sub}: ${err.message}`);
  }
}

if (failures.length) {
  console.error('verify:auth failed\n' + failures.join('\n'));
  process.exit(1);
}
console.log(`verify:auth ok: @taico/auth + ${subpaths.length} subpaths resolve from the workspace`);
