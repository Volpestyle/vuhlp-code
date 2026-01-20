
export function normalizeBaseUrl(value: string | undefined, fallback: string): string {
    const base = value?.trim() || fallback;
    return base.replace(/\/+$/, "");
}

export function parseJsonArgs(raw: string): Record<string, unknown> {
    if (!raw.trim()) {
        return {};
    }
    try {
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return { _raw: raw };
    }
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function safeJsonParse<T extends JsonValue = JsonValue>(value: string): T | null {
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}
