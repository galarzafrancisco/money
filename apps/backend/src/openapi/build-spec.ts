import 'reflect-metadata';
import { RequestMethod, type Type } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { z } from 'zod';
import { API_ROUTE, type ApiRouteOptions } from './api-route.decorator';
import { apiSchemas, errorResponseSchema } from './api-schemas';
import { assertGeneratorCompatible, normalizeSchema, type JsonSchema } from './normalize';
// Imported for their side effect of registering response schemas, and for the controller list
import { REST_CONTROLLERS } from './rest-controllers';

const JSON_SCHEMA_OPTIONS = { target: 'openapi-3.0', io: 'input', unrepresentable: 'any' } as const;
const COMPONENT_PREFIX = '#/components/schemas/';

const METHODS: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

export type RestRoute = {
  controller: string;
  handler: string;
  method: string;
  /** OpenAPI form, e.g. /api/accounts/{accountId} */
  path: string;
  status: number;
  options: ApiRouteOptions | undefined;
};

/** Every route declared on the given controllers, from Nest's own decorator metadata */
export function listRoutes(controllers: readonly Type[]): RestRoute[] {
  const routes: RestRoute[] = [];
  for (const controller of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    for (const handler of Object.getOwnPropertyNames(controller.prototype)) {
      if (handler === 'constructor') continue;
      const fn = controller.prototype[handler] as object;
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
      if (requestMethod === undefined) continue;
      const method = METHODS[requestMethod];
      if (!method) throw new Error(`${controller.name}.${handler}: unsupported HTTP method ${requestMethod}`);
      const sub = String(Reflect.getMetadata(PATH_METADATA, fn) ?? '');
      const path = `/${[base, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const explicitStatus = Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number | undefined;
      routes.push({
        controller: controller.name,
        handler,
        method,
        path,
        status: explicitStatus ?? (method === 'post' ? 201 : 200),
        options: Reflect.getMetadata(API_ROUTE, fn) as ApiRouteOptions | undefined,
      });
    }
  }
  return routes;
}

function ref(schema: z.ZodType, where: string): JsonSchema {
  const meta = apiSchemas.get(schema);
  if (!meta) throw new Error(`${where}: schema is not registered with apiSchema(), so it has no component name`);
  return { $ref: `${COMPONENT_PREFIX}${meta.id}` };
}

function queryParameters(schema: z.ZodObject, where: string) {
  const json = normalizeSchema(z.toJSONSchema(schema, JSON_SCHEMA_OPTIONS) as JsonSchema, where);
  return Object.entries(json.properties ?? {}).map(([name, property]) => {
    const { description, ...rest } = property;
    return {
      name,
      in: 'query',
      required: json.required?.includes(name) ?? false,
      ...(description ? { description } : {}),
      schema: rest,
    };
  });
}

const errorResponses = (status: number[]) =>
  Object.fromEntries(
    status.map((code) => [
      String(code),
      { description: ERROR_DESCRIPTIONS[code], content: { 'application/json': { schema: { $ref: `${COMPONENT_PREFIX}ErrorResponse` } } } },
    ]),
  );
const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'validation_failed: the input is invalid; error.message says why',
  401: 'Not signed in, or the session expired (session_expired)',
  403: 'csrf_failed: missing or stale X-CSRF-Token on a cookie-session request',
  404: 'not_found: missing, or belongs to another user',
  409: 'conflict: the change conflicts with other records (see error.details)',
  422: 'ledger_violation: the account history does not allow it (negative cash, overselling, lots)',
};

/** The OpenAPI 3.0 document for Money's REST API, in the subset the client generator supports */
export function buildOpenApiSpec(version = '0.0.1'): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const operationIds = new Set<string>();
  for (const route of listRoutes(REST_CONTROLLERS)) {
    if (!route.path.startsWith('/api')) continue;
    const where = `${route.controller}.${route.handler}`;
    const options = route.options;
    if (!options) throw new Error(`${where} (${route.method.toUpperCase()} ${route.path}) has no @ApiRoute metadata`);
    if (operationIds.has(options.operationId)) throw new Error(`${where}: duplicate operationId ${options.operationId}`);
    operationIds.add(options.operationId);

    const pathParameters = [...route.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const operation: Record<string, unknown> = {
      operationId: options.operationId,
      summary: options.summary,
      tags: [options.tag],
      parameters: [...pathParameters, ...(options.query ? queryParameters(options.query, `${where} query`) : [])],
      responses: {
        [String(route.status)]: {
          description: options.summary,
          content: { 'application/json': { schema: ref(options.response, `${where} response`) } },
        },
        ...errorResponses(route.method === 'get' ? [400, 401, 404] : [400, 401, 403, 404, 409, 422]),
      },
    };
    if (options.body) {
      operation.requestBody = {
        required: options.bodyRequired ?? true,
        content: { 'application/json': { schema: ref(options.body, `${where} body`) } },
      };
    }
    paths[route.path] = { ...(paths[route.path] ?? {}), [route.method]: operation };
  }

  void errorResponseSchema; // registered on import
  const components = z.toJSONSchema(apiSchemas, { ...JSON_SCHEMA_OPTIONS, uri: (id) => `${COMPONENT_PREFIX}${id}` }) as { schemas: Record<string, JsonSchema> };
  const schemas = Object.fromEntries(
    Object.entries(components.schemas)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, schema]) => [name, normalizeSchema(schema, name)]),
  );

  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'Money API',
      version,
      description:
        'Personal investment tracking. Records only: Money never moves money or places trades. Figures are tracking aids, not tax advice. ' +
        'Authenticate with a Taico access token (Authorization: Bearer) or, in the web app, the backend session cookie plus X-CSRF-Token on unsafe requests (docs/web-auth.md).',
    },
    servers: [{ url: '/' }],
    components: {
      schemas,
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
    security: [{ bearer: [] }],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  };
  assertGeneratorCompatible(spec);
  return spec;
}
