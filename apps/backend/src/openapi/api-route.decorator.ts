import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';

export const API_ROUTE = 'money:api-route';

/**
 * OpenAPI metadata for one REST route. Path and method come from Nest's own
 * decorators; this adds what the generated client needs. Every /api route
 * carries it (openapi.spec.ts checks).
 */
export type ApiRouteOptions = {
  /** Groups operations into client resources: `money.<tag>.<operationId>()` */
  tag: string;
  operationId: string;
  summary: string;
  /** Query parameters: an object schema, usually the service's own input schema */
  query?: z.ZodObject;
  /** Request body: a registered (apiSchema) zod schema, usually the service's own input schema */
  body?: z.ZodType;
  bodyRequired?: boolean;
  /** Success response: a registered (apiSchema) zod schema */
  response: z.ZodType;
};

export const ApiRoute = (options: ApiRouteOptions) => SetMetadata(API_ROUTE, options);
