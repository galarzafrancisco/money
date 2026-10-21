import { z } from 'zod';

/**
 * Named schemas that appear in the OpenAPI spec as `components.schemas`.
 * Request bodies are the services' own zod input schemas; responses are the
 * `*.responses.ts` schemas next to each service. A schema used in a route must
 * be registered here so the spec can refer to it by name, and so a schema used
 * in several places (e.g. Account inside a portfolio) is emitted once.
 */
export const apiSchemas = z.registry<{ id: string }>();

/** Registers a schema under a component name and returns it unchanged */
export function apiSchema<T extends z.ZodType>(id: string, schema: T): T {
  const existing = apiSchemas.get(schema);
  if (existing && existing.id !== id) throw new Error(`Schema already registered as ${existing.id}, cannot also be ${id}`);
  if (!existing) apiSchemas.add(schema, { id });
  return schema;
}

/** A decimal amount on the wire: always a string, never a JSON number */
export const decimalOut = (description?: string) => (description ? z.string().describe(description) : z.string());

/** The error envelope every REST error uses (see common/domain-error.filter.ts and docs/api.md) */
export const errorResponseSchema = apiSchema(
  'ErrorResponse',
  z.object({
    error: z.object({
      code: z.string().describe('validation_failed, not_found, conflict, ledger_violation, upstream_unavailable, session_expired, csrf_failed, …'),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
);
