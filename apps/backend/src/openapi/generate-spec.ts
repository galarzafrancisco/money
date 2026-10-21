import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpenApiSpec } from './build-spec';

/**
 * Writes apps/backend/openapi.json, the input of the generated API client
 * (packages/client, docs/architecture/api-clients.md). Runs after `nest build`
 * and needs no database or configuration: it only reads route metadata.
 */
const root = join(__dirname, '..', '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const target = join(root, 'openapi.json');
const spec = buildOpenApiSpec(version);
writeFileSync(target, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`OpenAPI spec written to ${target} (${Object.keys(spec.paths as object).length} paths)`);
