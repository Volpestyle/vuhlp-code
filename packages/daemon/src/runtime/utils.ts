import { createHash, randomUUID } from "crypto";

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
