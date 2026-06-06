import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type PromotionEvidence,
  promotionEvidencePassed,
  renderPromotionEvidenceMarkdown,
  writePromotionEvidence,
} from "./promotion-evidence";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-promotion-evidence-"));

function sampleEvidence(): PromotionEvidence {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-06T08:00:00.000Z",
    packageName: "sikong",
    packageVersion: "0.1.7",
    git: {
      sha: "abcdef1234567890",
      branch: "main",
      status: "",
    },
    candidate: {
      binPath: "packages/sikong/dist/sikong-candidate",
      builtFromSource: true,
      sha256: "a".repeat(64),
    },
    checks: [
      {
        name: "typecheck",
        command: ["bun", "run", "typecheck"],
        cwd: ".",
        exitCode: 0,
        durationMs: 12,
        stdoutPreview: "ok",
        stderrPreview: "",
      },
      {
        name: "candidate self-smoke",
        command: ["bun", "scripts/self-smoke.ts", "--bin", "dist/sikong-candidate"],
        cwd: "packages/sikong",
        exitCode: 0,
        durationMs: 34,
        stdoutPreview: "22/22 checks passed",
        stderrPreview: "",
      },
    ],
    decision: {
      status: "pending_lead_review",
      requiredAction: "Lead accepts or rejects.",
    },
  };
}

describe("promotion evidence", () => {
  test("renders lead-review markdown", () => {
    const markdown = renderPromotionEvidenceMarkdown(sampleEvidence());
    expect(markdown).toContain("Status: PASS");
    expect(markdown).toContain("Package: sikong@0.1.7");
    expect(markdown).toContain("- PASS typecheck");
    expect(markdown).toContain("Status: pending_lead_review");
    expect(markdown).not.toContain("/repo");
  });

  test("fails if any command failed", () => {
    const evidence = sampleEvidence();
    const failed: PromotionEvidence = {
      ...evidence,
      checks: [{ ...evidence.checks[0]!, exitCode: 1 }],
    };
    expect(promotionEvidencePassed(evidence)).toBe(true);
    expect(promotionEvidencePassed(failed)).toBe(false);
    expect(renderPromotionEvidenceMarkdown(failed)).toContain("Status: FAIL");
  });

  test("writes JSON and Markdown evidence files", async () => {
    const dir = await tmp();
    try {
      const paths = await writePromotionEvidence(dir, sampleEvidence());
      expect(paths.jsonPath).toContain("sikong-0.1.7-abcdef123456");
      expect(paths.markdownPath).toContain("sikong-0.1.7-abcdef123456");
      expect(JSON.parse(await readFile(paths.jsonPath, "utf8"))).toMatchObject({
        packageName: "sikong",
        decision: { status: "pending_lead_review" },
      });
      expect(await readFile(paths.markdownPath, "utf8")).toContain("Sikong Promotion Evidence");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
