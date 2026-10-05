export type JsonObject = Record<string, unknown>;

export function requireObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as JsonObject;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
}

export function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

export function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ApplicationSummary {
  ok: true;
  accounts: number;
  entries: number;
  documents: number;
}

export function requireApplicationSummary(value: unknown): ApplicationSummary {
  const summary = requireObject(value, "Lab summary");
  const accounts = requireNumber(summary.accounts, "accounts");
  const entries = requireNumber(summary.entries, "entries");
  const documents = requireNumber(summary.documents, "documents");
  if (
    summary.ok !== true ||
    [accounts, entries, documents].some(
      (count) => !Number.isSafeInteger(count) || count < 1,
    )
  ) {
    throw new Error(`Unexpected lab summary: ${JSON.stringify(summary)}`);
  }
  return { ok: true, accounts, entries, documents };
}
