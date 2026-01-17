export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

export function parseJsonValue(raw: string): JsonValue | null {
  try {
    const parsed: JsonValue = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonObject(value: JsonValue): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

export function isJsonArray(value: JsonValue): value is JsonArray {
  return Array.isArray(value);
}

export function asJsonArray(value: JsonValue): JsonArray | null {
  return isJsonArray(value) ? value : null;
}

export function getString(value: JsonValue): string | null {
  return typeof value === "string" ? value : null;
}

export function getBoolean(value: JsonValue): boolean | null {
  return typeof value === "boolean" ? value : null;
}
