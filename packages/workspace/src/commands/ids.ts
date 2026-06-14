import { randomUUID } from "node:crypto";

export function nextId(prefix: string, generator?: () => string): string {
  const raw = generator?.() ?? randomUUID();
  return `${prefix}_${raw.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}
