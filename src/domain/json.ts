/**
 * Shared JSON-compatible types for the domain. Zero SDK imports: this is the
 * domain's own vocabulary, independent of any external package's JSON type.
 */
export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonArray = JsonValue[];

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
