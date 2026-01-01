import { homedir } from "node:os";
import path from "node:path";

export function expandHome(value: string): string {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}
