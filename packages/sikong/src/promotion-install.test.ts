import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildPromotionInstallPlan,
  installPromotionCandidate,
  type PromotionInstallReceipt,
  validatePromotionEvidenceForInstall,
} from "./promotion-install";
import type { PromotionEvidence } from "./promotion-evidence";

function evidence(): PromotionEvidence {
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
    ],
    decision: {
      status: "pending_lead_review",
      requiredAction: "Lead accepts or rejects.",
    },
  };
}

describe("promotion install validation", () => {
  test("accepts clean passing evidence with explicit lead acceptance", () => {
    const e = evidence();
    expect(validatePromotionEvidenceForInstall(e, JSON.stringify(e), {
      repoRoot: "/repo",
      currentSha: e.git.sha,
      acceptedBy: "lead",
    })).toEqual([]);
  });

  test("rejects machine pass without explicit lead acceptance", () => {
    const e = evidence();
    expect(validatePromotionEvidenceForInstall(e, JSON.stringify(e), {
      repoRoot: "/repo",
      currentSha: e.git.sha,
      acceptedBy: "",
    })).toContain("--accepted-by is required to record lead acceptance");
  });

  test("rejects failed checks, dirty git, sha mismatch, and absolute paths", () => {
    const e: PromotionEvidence = {
      ...evidence(),
      git: { ...evidence().git, status: " M file.ts" },
      candidate: { ...evidence().candidate, binPath: "/repo/packages/sikong/dist/sikong-candidate" },
      checks: [{ ...evidence().checks[0]!, exitCode: 1, cwd: "/repo" }],
    };
    const issues = validatePromotionEvidenceForInstall(e, JSON.stringify(e), {
      repoRoot: "/repo",
      currentSha: "different",
      acceptedBy: "lead",
    });
    expect(issues).toContain("promotion evidence checks are not all PASS");
    expect(issues).toContain("promotion evidence was generated from a dirty git status");
    expect(issues.some((issue) => issue.includes("does not match current HEAD"))).toBe(true);
    expect(issues).toContain("candidate.binPath must be repo-relative, got absolute path");
    expect(issues).toContain("typecheck.cwd must be repo-relative, got absolute path");
    expect(issues).toContain("promotion evidence contains local absolute path: /repo");
  });

  test("rejects evidence missing a candidate hash", () => {
    const e: PromotionEvidence = {
      ...evidence(),
      candidate: { ...evidence().candidate, sha256: "" },
    };
    expect(validatePromotionEvidenceForInstall(e, JSON.stringify(e), {
      repoRoot: "/repo",
      currentSha: e.git.sha,
      acceptedBy: "lead",
    })).toContain("candidate sha256 is missing or invalid");
  });

  test("builds a receipt that records lead acceptance", () => {
    const e = evidence();
    const plan = buildPromotionInstallPlan({
      repoRoot: "/repo",
      evidencePath: "/repo/promotion-evidence/evidence.json",
      acceptedBy: "lead",
      reason: "accepted in thread",
      installRoot: "/home/user/.sikong/local-stable",
      currentSha: e.git.sha,
      generatedAt: "2026-06-06T08:00:00.000Z",
    }, e);
    expect(plan.installedBin).toContain("0.1.7-abcdef123456");
    expect(plan.receipt).toMatchObject({
      packageName: "sikong",
      packageVersion: "0.1.7",
      gitSha: e.git.sha,
      sourceEvidence: "promotion-evidence/evidence.json",
      sourceCandidate: "packages/sikong/dist/sikong-candidate",
      sourceCandidateSha256: e.candidate.sha256,
      acceptedBy: "lead",
      reason: "accepted in thread",
    } satisfies Partial<PromotionInstallReceipt>);
  });

  test("installs candidate with a relative current symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sikong-promotion-install-"));
    try {
      const repo = join(dir, "repo");
      const installRoot = join(dir, "stable");
      const sourceBin = join(repo, "packages/sikong/dist/sikong-candidate");
      await mkdir(join(repo, "packages/sikong/dist"), { recursive: true });
      await writeFile(sourceBin, "#!/bin/sh\n", { mode: 0o755 });
      const e = evidence();
      const plan = buildPromotionInstallPlan({
        repoRoot: repo,
        evidencePath: join(repo, "promotion-evidence/evidence.json"),
        acceptedBy: "lead",
        installRoot,
        currentSha: e.git.sha,
        generatedAt: "2026-06-06T08:00:00.000Z",
      }, e);
      await installPromotionCandidate(plan);
      expect(await readlink(plan.currentLink)).toBe("versions/0.1.7-abcdef123456/sikong");
      expect(JSON.parse(await readFile(plan.currentReceiptPath, "utf8"))).toMatchObject({
        currentLink: "current",
        installedBin: "versions/0.1.7-abcdef123456/sikong",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
