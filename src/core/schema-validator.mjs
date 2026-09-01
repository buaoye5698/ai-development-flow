import { stableStringify } from "./canonical.mjs";

const ANNOTATION_KEYWORDS = new Set([
  "$schema", "$id", "$comment", "title", "description", "default", "examples",
  "deprecated", "readOnly", "writeOnly"
]);
const VALIDATION_KEYWORDS = new Set([
  "$ref", "$defs", "definitions", "type", "const", "enum", "allOf", "anyOf", "oneOf", "not",
  "required", "properties", "additionalProperties", "dependentRequired", "minProperties", "maxProperties",
  "items", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"
]);
const SUPPORTED_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childPath(parent, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(String(key))
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(String(key))}]`;
}

function sameValue(left, right) {
  try {
    return stableStringify(left) === stableStringify(right);
  } catch {
    return Object.is(left, right);
  }
}

function typeMatches(value, type) {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "object": return isObject(value);
    case "array": return Array.isArray(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "string": return typeof value === "string";
    default: return false;
  }
}

function resolveLocalRef(rootSchema, ref) {
  if (ref === "#") return rootSchema;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  let current = rootSchema;
  for (const encoded of ref.slice(2).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current) || !Object.hasOwn(current, key)) return null;
    current = current[key];
  }
  return current;
}

function inspectSupportedSchema(schema, path, errors, visited) {
  if (typeof schema === "boolean") return;
  if (!isObject(schema)) {
    errors.push({ path, keyword: "schema", message: "schema must be an object or boolean" });
    return;
  }
  if (visited.has(schema)) return;
  visited.add(schema);

  for (const key of Object.keys(schema)) {
    if (!ANNOTATION_KEYWORDS.has(key) && !VALIDATION_KEYWORDS.has(key)) {
      errors.push({ path: childPath(path, key), keyword: "unsupported", message: `unsupported schema keyword: ${key}` });
    }
  }

  const declaredTypes = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  for (const type of declaredTypes) {
    if (!SUPPORTED_TYPES.has(type)) {
      errors.push({ path: childPath(path, "type"), keyword: "type", message: `unsupported type: ${type}` });
    }
  }
  if (typeof schema.pattern === "string") {
    try { new RegExp(schema.pattern, "u"); } catch (error) {
      errors.push({ path: childPath(path, "pattern"), keyword: "pattern", message: `invalid regular expression: ${error.message}` });
    }
  }
  if (typeof schema.$ref === "string" && !schema.$ref.startsWith("#")) {
    errors.push({ path: childPath(path, "$ref"), keyword: "$ref", message: "only local JSON Pointer references are supported" });
  }

  for (const containerName of ["properties", "$defs", "definitions"]) {
    const container = schema[containerName];
    if (container === undefined) continue;
    if (!isObject(container)) {
      errors.push({ path: childPath(path, containerName), keyword: containerName, message: "must be an object" });
      continue;
    }
    for (const [key, child] of Object.entries(container)) {
      inspectSupportedSchema(child, childPath(childPath(path, containerName), key), errors, visited);
    }
  }
  for (const key of ["items", "additionalProperties", "not"]) {
    if (schema[key] !== undefined) inspectSupportedSchema(schema[key], childPath(path, key), errors, visited);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key])) {
      errors.push({ path: childPath(path, key), keyword: key, message: "must be an array" });
      continue;
    }
    schema[key].forEach((child, index) => inspectSupportedSchema(child, `${childPath(path, key)}[${index}]`, errors, visited));
  }
}

export function assertSupportedSchema(schema) {
  const errors = [];
  inspectSupportedSchema(schema, "$schema", errors, new Set());
  return errors;
}

function validateNode(value, schema, path, rootSchema, errors, refStack) {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path, keyword: "falseSchema", message: "value is forbidden by schema" });
    return;
  }
  if (!isObject(schema)) return;

  if (typeof schema.$ref === "string") {
    const target = resolveLocalRef(rootSchema, schema.$ref);
    if (!target) {
      errors.push({ path, keyword: "$ref", message: `unresolved local reference: ${schema.$ref}` });
    } else if (refStack.has(schema.$ref)) {
      errors.push({ path, keyword: "$ref", message: `cyclic local reference: ${schema.$ref}` });
    } else {
      const nextStack = new Set(refStack);
      nextStack.add(schema.$ref);
      validateNode(value, target, path, rootSchema, errors, nextStack);
    }
  }

  if (schema.const !== undefined && !sameValue(value, schema.const)) {
    errors.push({ path, keyword: "const", message: `must equal ${stableStringify(schema.const)}` });
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameValue(value, candidate))) {
    errors.push({ path, keyword: "enum", message: "must equal one of the allowed values" });
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push({ path, keyword: "type", message: `must be ${types.join(" or ")}` });
      return;
    }
  }

  for (const child of Array.isArray(schema.allOf) ? schema.allOf : []) {
    validateNode(value, child, path, rootSchema, errors, refStack);
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    let matches = 0;
    for (const child of schema[keyword]) {
      const candidateErrors = [];
      validateNode(value, child, path, rootSchema, candidateErrors, refStack);
      if (candidateErrors.length === 0) matches += 1;
    }
    if ((keyword === "anyOf" && matches === 0) || (keyword === "oneOf" && matches !== 1)) {
      errors.push({ path, keyword, message: keyword === "anyOf" ? "must match at least one schema" : "must match exactly one schema" });
    }
  }
  if (schema.not !== undefined) {
    const candidateErrors = [];
    validateNode(value, schema.not, path, rootSchema, candidateErrors, refStack);
    if (candidateErrors.length === 0) errors.push({ path, keyword: "not", message: "must not match the forbidden schema" });
  }

  if (isObject(value)) {
    const keys = Object.keys(value);
    if (Number.isInteger(schema.minProperties) && keys.length < schema.minProperties) {
      errors.push({ path, keyword: "minProperties", message: `must have at least ${schema.minProperties} properties` });
    }
    if (Number.isInteger(schema.maxProperties) && keys.length > schema.maxProperties) {
      errors.push({ path, keyword: "maxProperties", message: `must have at most ${schema.maxProperties} properties` });
    }
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, required)) errors.push({ path: childPath(path, required), keyword: "required", message: "is required" });
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateNode(value[key], childSchema, childPath(path, key), rootSchema, errors, refStack);
    }
    const unknownKeys = keys.filter((key) => !Object.hasOwn(properties, key));
    if (schema.additionalProperties === false) {
      for (const key of unknownKeys) errors.push({ path: childPath(path, key), keyword: "additionalProperties", message: "is not allowed" });
    } else if (isObject(schema.additionalProperties) || typeof schema.additionalProperties === "boolean") {
      for (const key of unknownKeys) validateNode(value[key], schema.additionalProperties, childPath(path, key), rootSchema, errors, refStack);
    }
    if (isObject(schema.dependentRequired)) {
      for (const [key, dependencies] of Object.entries(schema.dependentRequired)) {
        if (!Object.hasOwn(value, key)) continue;
        for (const dependency of Array.isArray(dependencies) ? dependencies : []) {
          if (!Object.hasOwn(value, dependency)) {
            errors.push({ path: childPath(path, dependency), keyword: "dependentRequired", message: `is required when ${key} is present` });
          }
        }
      }
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push({ path, keyword: "minItems", message: `must have at least ${schema.minItems} items` });
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push({ path, keyword: "maxItems", message: `must have at most ${schema.maxItems} items` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      value.forEach((entry, index) => {
        const identity = stableStringify(entry);
        if (seen.has(identity)) errors.push({ path: `${path}[${index}]`, keyword: "uniqueItems", message: "must be unique" });
        seen.add(identity);
      });
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => validateNode(entry, schema.items, `${path}[${index}]`, rootSchema, errors, refStack));
    }
  }

  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && [...value].length < schema.minLength) {
      errors.push({ path, keyword: "minLength", message: `must have at least ${schema.minLength} characters` });
    }
    if (Number.isInteger(schema.maxLength) && [...value].length > schema.maxLength) {
      errors.push({ path, keyword: "maxLength", message: `must have at most ${schema.maxLength} characters` });
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push({ path, keyword: "pattern", message: `must match ${schema.pattern}` });
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push({ path, keyword: "minimum", message: `must be >= ${schema.minimum}` });
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push({ path, keyword: "maximum", message: `must be <= ${schema.maximum}` });
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push({ path, keyword: "exclusiveMinimum", message: `must be > ${schema.exclusiveMinimum}` });
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) errors.push({ path, keyword: "exclusiveMaximum", message: `must be < ${schema.exclusiveMaximum}` });
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 10) {
        errors.push({ path, keyword: "multipleOf", message: `must be a multiple of ${schema.multipleOf}` });
      }
    }
  }
}

export function validateSchema(value, schema, rootPath = "$") {
  const schemaErrors = assertSupportedSchema(schema);
  if (schemaErrors.length > 0) return schemaErrors;
  const errors = [];
  validateNode(value, schema, rootPath, schema, errors, new Set());
  return errors;
}

export function assertSchema(value, schema, label = "value") {
  const errors = validateSchema(value, schema);
  if (errors.length === 0) return value;
  const error = new Error(`${label} does not satisfy its schema (${errors.length} error${errors.length === 1 ? "" : "s"})`);
  error.code = "SCHEMA_VALIDATION_FAILED";
  error.errors = errors;
  throw error;
}
