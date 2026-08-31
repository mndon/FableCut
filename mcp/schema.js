"use strict";

function matchesType(value, type) {
  switch (type) {
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

function validateSchema(value, schema, label = "arguments") {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type && !types.some((type) => matchesType(value, type)))
    throw new Error(`${label} must be ${types.join(" or ")}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${label} must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) throw new Error(`${label} is too short`);
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
      throw new Error(`${label} must be a UUID v4`);
    if (schema.format === "uri") { try { new URL(value); } catch { throw new Error(`${label} must be a URI`); } }
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) throw new Error(`${label} must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) throw new Error(`${label} must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) throw new Error(`${label} must be > ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) throw new Error(`${label} needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${label}[${index}]`));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) throw new Error(`${label}.${key} is required`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties || {}, key)) throw new Error(`${label}.${key} is not allowed`);
    }
    for (const [key, child] of Object.entries(schema.properties || {}))
      if (key in value) validateSchema(value[key], child, `${label}.${key}`);
  }
}

module.exports = { validateSchema };
