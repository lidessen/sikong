import { withFileLock } from "@sikong/workspace";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ClientMessage } from "../src/types";

const transcriptMaxMessages = 200;

export function transcriptPaths(dataDir: string): {
  transcriptPath: string;
  lockPath: string;
} {
  const transcriptPath = join(dataDir, "state", "client-transcript.json");
  return {
    transcriptPath,
    lockPath: `${transcriptPath}.lock`,
  };
}

export async function readTranscript(transcriptPath: string): Promise<ClientMessage[]> {
  try {
    const value = JSON.parse(await readFile(transcriptPath, "utf8")) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(isClientMessage);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function withTranscriptLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  return await withFileLock(lockPath, fn);
}

export async function appendTranscriptMessage(
  transcriptPath: string,
  lockPath: string,
  message: ClientMessage,
): Promise<void> {
  await withTranscriptLock(lockPath, async () => {
    const transcript = await readTranscript(transcriptPath);
    transcript.push(message);
    await writeTranscriptFile(transcriptPath, transcript);
  });
}

export async function deleteTranscriptMessageById(
  transcriptPath: string,
  lockPath: string,
  messageId: string,
): Promise<ClientMessage[]> {
  return await withTranscriptLock(lockPath, async () => {
    const transcript = await readTranscript(transcriptPath);
    const next = transcript.filter((message) => message.id !== messageId);
    await writeTranscriptFile(transcriptPath, next);
    return next;
  });
}

async function writeTranscriptFile(
  transcriptPath: string,
  transcript: ClientMessage[],
): Promise<void> {
  await mkdir(dirname(transcriptPath), { recursive: true });
  const tmp = `${transcriptPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(transcript.slice(-transcriptMaxMessages), null, 2));
  await rename(tmp, transcriptPath);
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    (record.role === "user" || record.role === "assistant" || record.role === "system") &&
    typeof record.createdAt === "string" &&
    Array.isArray(record.parts)
  );
}
