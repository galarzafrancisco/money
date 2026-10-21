/**
 * Turns zod's JSON Schema output (OpenAPI 3.0 flavour, input side) into the
 * subset @taico/openapi-sdkgen understands. The generator has no
 * allOf/oneOf/anyOf, so (docs/architecture/api-clients.md):
 *
 * - A union of objects (a discriminated union such as the transaction body)
 *   becomes one flattened object: every property of every variant, the
 *   discriminator as an enum, and only the properties all variants require
 *   as required. The service still validates the exact variant.
 * - A union of primitives becomes the wire type: decimals accept a string or
 *   a number but are strings on the wire, query booleans accept "true" or
 *   true, FX rate maps travel as "USD:1.5,EUR:1.6".
 * - `X | null` becomes `nullable: true`.
 *
 * Anything else that cannot be expressed throws, so an unsupported schema
 * fails the build instead of producing a wrong client.
 */
export type JsonSchema = {
  $ref?: string;
  $id?: string;
  type?: string;
  nullable?: boolean;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  description?: string;
  [key: string]: unknown;
};

const COMPOSITIONS = ['anyOf', 'oneOf', 'allOf'] as const;

export function normalizeSchema(schema: JsonSchema, where = 'schema'): JsonSchema {
  if (schema.$ref) return { $ref: schema.$ref };
  const { $id: _id, anyOf, oneOf, allOf, ...rest } = schema;
  void _id;
  if (allOf) {
    if (allOf.length !== 1) throw new Error(`${where}: allOf (an intersection) is not supported by the client generator`);
    const merged = normalizeSchema(allOf[0], where);
    if (merged.$ref) {
      if (rest.nullable) throw new Error(`${where}: a nullable $ref is not supported by the client generator; inline the schema`);
      return merged;
    }
    return { ...merged, ...stripCompositions(rest), ...(rest.nullable ? { nullable: true } : {}) };
  }
  const variants = anyOf ?? oneOf;
  if (variants) return { ...collapseUnion(variants, where), ...pick(rest, ['description']), ...(rest.nullable ? { nullable: true } : {}) };

  const out: JsonSchema = { ...rest };
  if (out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([key, value]) => [key, normalizeSchema(value, `${where}.${key}`)]));
  }
  if (out.items) out.items = normalizeSchema(out.items, `${where}[]`);
  if (out.additionalProperties && typeof out.additionalProperties === 'object') {
    out.additionalProperties = normalizeSchema(out.additionalProperties, `${where}{}`);
  }
  return out;
}

function collapseUnion(rawVariants: JsonSchema[], where: string): JsonSchema {
  const nullVariant = (v: JsonSchema) => v.type === 'null' || (v.nullable === true && Object.keys(v).length === 1) || (Array.isArray(v.enum) && v.enum.length === 1 && v.enum[0] === null);
  const nullable = rawVariants.some(nullVariant);
  const variants = rawVariants.filter((v) => !nullVariant(v)).map((v, i) => normalizeSchema(v, `${where}|${i}`));
  const withNull = (s: JsonSchema): JsonSchema => (nullable ? { ...s, nullable: true } : s);

  if (variants.length === 1) {
    if (variants[0].$ref && nullable) throw new Error(`${where}: a nullable $ref is not supported by the client generator; inline the schema`);
    return withNull(variants[0]);
  }
  if (variants.every((v) => v.type === 'object' && v.properties)) return withNull(flattenObjects(variants, where));
  if (variants.some((v) => v.type === 'string')) {
    // Decimal (string | number), or a value with a string wire form (e.g. fxRates "USD:1.5")
    const enums = variants.filter((v) => v.type === 'string' && v.enum);
    const plain = variants.find((v) => v.type === 'string' && !v.enum);
    return withNull(plain ? { type: 'string' } : { type: 'string', enum: [...new Set(enums.flatMap((v) => v.enum ?? []))] });
  }
  if (variants.every((v) => v.type === 'boolean' || (v.type === 'string' && v.enum))) return withNull({ type: 'boolean' });
  throw new Error(`${where}: union of ${variants.map((v) => v.type ?? v.$ref ?? '?').join(', ')} is not supported by the client generator`);
}

function flattenObjects(variants: JsonSchema[], where: string): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const variant of variants) {
    for (const [key, value] of Object.entries(variant.properties ?? {})) {
      const existing = properties[key];
      if (!existing) {
        properties[key] = value;
      } else if (existing.enum && value.enum) {
        properties[key] = { ...existing, enum: [...new Set([...existing.enum, ...value.enum])] };
      } else if (existing.type !== value.type) {
        throw new Error(`${where}.${key}: variants disagree on the type (${existing.type} vs ${value.type})`);
      }
    }
  }
  const required = Object.keys(properties).filter((key) => variants.every((v) => v.required?.includes(key)));
  return {
    type: 'object',
    description: 'Fields that apply depend on the discriminator; the server validates the exact combination.',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function stripCompositions(schema: JsonSchema): JsonSchema {
  const copy = { ...schema };
  for (const key of COMPOSITIONS) delete copy[key];
  return copy;
}

function pick(schema: JsonSchema, keys: string[]): JsonSchema {
  return Object.fromEntries(keys.filter((k) => schema[k] !== undefined).map((k) => [k, schema[k]])) as JsonSchema;
}

/** Throws if a composition keyword survived normalisation anywhere in the document */
export function assertGeneratorCompatible(value: unknown, path = '#'): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertGeneratorCompatible(item, `${path}/${i}`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'allOf' || key === 'anyOf' || key === 'oneOf') throw new Error(`${path}: ${key} is not supported by the client generator`);
    assertGeneratorCompatible(child, `${path}/${key}`);
  }
}
