import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendTranscriptMessage,
  readTranscript,
  transcriptPaths,
} from "../client-transcript";

describe("client transcript locking", () => {
  let dataDir = "";

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("serializes concurrent appends without lost updates", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "sikong-transcript-"));
    const { transcriptPath, lockPath } = transcriptPaths(dataDir);

    await Promise.all([
      appendTranscriptMessage(transcriptPath, lockPath, {
        id: "m1",
        role: "user",
        createdAt: new Date().toISOString(),
        parts: [{ type: "text", text: "one" }],
      }),
      appendTranscriptMessage(transcriptPath, lockPath, {
        id: "m2",
        role: "user",
        createdAt: new Date().toISOString(),
        parts: [{ type: "text", text: "two" }],
      }),
    ]);

    const transcript = await readTranscript(transcriptPath);
    expect(transcript).toHaveLength(2);
    expect(transcript.map((message) => message.id).sort()).toEqual(["m1", "m2"]);
  });
});
