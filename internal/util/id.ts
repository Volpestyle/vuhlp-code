import { randomBytes } from "node:crypto";

const alphabet = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      const index = (value >> (bits - 5)) & 31;
      output += alphabet[index];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}

function newId(prefix: string): string {
  const bytes = randomBytes(10);
  const enc = base32Encode(bytes);
  let ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}z$/i, "z");
  ts = ts.replace("T", "t").replace("Z", "z");
  return `${prefix}${ts}_${enc}`;
}

export function newRunId(): string {
  return newId("run_");
}

export function newStepId(): string {
  return newId("step_");
}

export function newSessionId(): string {
  return newId("sess_");
}

export function newMessageId(): string {
  return newId("msg_");
}

export function newTurnId(): string {
  return newId("turn_");
}

export function newToolCallId(): string {
  return newId("call_");
}

export function newAttachmentId(): string {
  return newId("att_");
}
