import { z } from "zod";

type JsonSchema = Record<string, unknown>;

/**
 * Minimal zod (v3) → JSON Schema converter covering exactly the schema
 * features the agent tool parameter contracts use: plain/strict objects,
 * strings with min/max, numbers with int/min/max, booleans, enums, literals,
 * arrays, unions, discriminated unions, records, optional/default/nullable
 * wrappers, and unknown.
 *
 * The Pi runtime validates tool-call arguments with TypeBox's compiler, which
 * accepts plain JSON Schema (pi-ai's validator explicitly handles schemas
 * without the TypeBox kind symbol), so the converted schema serves both as
 * the model-facing parameter description and the runtime validator. The
 * lifecycle still re-parses arguments with the original zod schema, which
 * remains the single source of truth.
 */
export function zodToJsonSchema(schema: z.ZodType<unknown>): JsonSchema {
  return convert(schema);
}

function convert(schema: z.ZodType<unknown>): JsonSchema {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return convert(schema._def.innerType as z.ZodType<unknown>);
  }
  if (schema instanceof z.ZodNullable) {
    return { anyOf: [convert(schema._def.innerType as z.ZodType<unknown>), { type: "null" }] };
  }
  if (schema instanceof z.ZodEffects) {
    return convert(schema._def.schema as z.ZodType<unknown>);
  }
  if (schema instanceof z.ZodString) {
    const out: JsonSchema = { type: "string" };
    for (const check of schema._def.checks) {
      if (check.kind === "min") out.minLength = check.value;
      if (check.kind === "max") out.maxLength = check.value;
    }
    return out;
  }
  if (schema instanceof z.ZodNumber) {
    const out: JsonSchema = { type: "number" };
    for (const check of schema._def.checks) {
      if (check.kind === "int") out.type = "integer";
      if (check.kind === "min") out[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
      if (check.kind === "max") out[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
      if (check.kind === "finite") continue;
    }
    return out;
  }
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) return { enum: [...schema._def.values] };
  if (schema instanceof z.ZodLiteral) return { enum: [schema._def.value] };
  if (schema instanceof z.ZodArray) {
    const out: JsonSchema = { type: "array", items: convert(schema._def.type as z.ZodType<unknown>) };
    const minLength = schema._def.minLength;
    const maxLength = schema._def.maxLength;
    if (minLength) out.minItems = minLength.value;
    if (maxLength) out.maxItems = maxLength.value;
    return out;
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema._def.shape() as Record<string, z.ZodType<unknown>>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value);
      if (!value.isOptional()) required.push(key);
    }
    const out: JsonSchema = { type: "object", properties };
    if (required.length > 0) out.required = required;
    if (schema._def.unknownKeys === "strict") out.additionalProperties = false;
    return out;
  }
  if (schema instanceof z.ZodUnion) {
    return { anyOf: (schema._def.options as z.ZodType<unknown>[]).map(convert) };
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return { anyOf: [...(schema._def.optionsMap as Map<string, z.ZodType<unknown>>).values()].map(convert) };
  }
  if (schema instanceof z.ZodRecord) {
    return { type: "object", additionalProperties: convert(schema._def.valueType as z.ZodType<unknown>) };
  }
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) return {};
  if (schema instanceof z.ZodTuple) {
    return {
      type: "array",
      items: (schema._def.items as z.ZodType<unknown>[]).map(convert)
    };
  }
  const typeName = ((schema as z.ZodType<unknown>)._def as { typeName?: string }).typeName ?? "unknown";
  throw new Error(`zodToJsonSchema: unsupported schema type ${typeName}`);
}
