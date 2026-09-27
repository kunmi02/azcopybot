export function stringifyErrorValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function errorMessage(error: unknown, maxLength = 1000): string {
  const raw = error instanceof Error ? error.message : stringifyErrorValue(error);
  const message = raw === "[object Object]" ? stringifyErrorValue(error) : raw;
  return message.replace(/^Error:\s*/, "").slice(0, maxLength);
}

export function apiErrorMessage(prefix: string, status: number, body: unknown): string {
  const b = body as any;
  const value = b?.error ?? b?.message ?? b;
  const detail = stringifyErrorValue(value);
  if (!detail || detail === "{}") return `${prefix}_${status}`;
  return `${prefix}_${status}: ${detail}`;
}
