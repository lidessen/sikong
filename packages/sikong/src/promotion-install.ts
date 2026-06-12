import { copyFile, chmod, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { safeWorkspaceSegment } from "./workspace-layout";
import { hashFileSha256, type PromotionEvidence, promotionEvidencePassed } from "./promotion-evidence";

export interface PromotionInstallOptions {
  repoRoot: string;
  evidencePath: string;
  acceptedBy: string;
  reason?: string;
  installRoot: string;
  currentSha: string;
  generatedAt?: string;
}

export interface PromotionInstallPlan {
  sourceBin: string;
  versionDir: string;
  installedBin: string;
  currentLink: string;
  currentCommand: string;
  currentReceiptPath: string;
  receiptPath: string;
  receipt: PromotionInstallReceipt;
}

export interface PromotionInstallReceipt {
  schemaVersion: 1;
  installedAt: string;
  packageName: string;
  packageVersion: string;
  gitSha: string;
  sourceEvidence: string;
  sourceCandidate: string;
  sourceCandidateSha256: string;
  installedBin: string;
  currentLink: string;
  currentCommand: string;
  acceptedBy: string;
  reason?: string;
}

export async function readPromotionEvidence(path: string): Promise<{
  raw: string;
  evidence: PromotionEvidence;
}> {
  const raw = await readFile(path, "utf8");
  return { raw, evidence: JSON.parse(raw) as PromotionEvidence };
}

export function validatePromotionEvidenceForInstall(
  evidence: PromotionEvidence,
  raw: string,
  opts: { repoRoot: string; currentSha: string; acceptedBy: string },
): string[] {
  const issues: string[] = [];
  if (evidence.schemaVersion !== 1) issues.push("unsupported promotion evidence schema");
  if (evidence.packageName !== "sikong") issues.push(`expected packageName sikong, got ${String(evidence.packageName)}`);
  if (!promotionEvidencePassed(evidence)) issues.push("promotion evidence checks are not all PASS");
  if (evidence.git.status.trim()) issues.push("promotion evidence was generated from a dirty git status");
  if (evidence.git.sha !== opts.currentSha) {
    issues.push(`promotion evidence sha ${evidence.git.sha} does not match current HEAD ${opts.currentSha}`);
  }
  if (!opts.acceptedBy.trim()) issues.push("--accepted-by is required to record lead acceptance");
  if (!/^[a-f0-9]{64}$/i.test(evidence.candidate.sha256)) {
    issues.push("candidate sha256 is missing or invalid");
  }

  checkRelative("candidate.binPath", evidence.candidate.binPath, issues);
  for (const check of evidence.checks) {
    checkRelative(`${check.name}.cwd`, check.cwd, issues);
    for (const [index, arg] of check.command.entries()) {
      checkRelative(`${check.name}.command[${index}]`, arg, issues);
    }
  }

  const forbidden = [opts.repoRoot, homedir(), tmpdir()].filter((v) => v && v !== "/" && v !== ".");
  for (const value of forbidden) {
    if (raw.includes(value)) issues.push(`promotion evidence contains local absolute path: ${value}`);
  }

  return issues;
}

export function buildPromotionInstallPlan(opts: PromotionInstallOptions, evidence: PromotionEvidence): PromotionInstallPlan {
  const sha = evidence.git.sha.slice(0, 12);
  const versionKey = `${safeWorkspaceSegment(evidence.packageVersion)}-${sha}`;
  const installedAt = opts.generatedAt ?? new Date().toISOString();
  const versionDir = join(opts.installRoot, "versions", versionKey);
  const installedBin = join(versionDir, "sikong");
  const currentLink = join(opts.installRoot, "current");
  const currentCommand = join(currentLink, "sikong");
  const sourceBin = join(opts.repoRoot, evidence.candidate.binPath);
  const sourceEvidence = relativePath(opts.repoRoot, opts.evidencePath);
  const currentReceiptPath = join(opts.installRoot, "current.json");
  const receiptPath = join(opts.installRoot, "receipts", `${installedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${versionKey}.json`);
  const receipt: PromotionInstallReceipt = {
    schemaVersion: 1,
    installedAt,
    packageName: evidence.packageName,
    packageVersion: evidence.packageVersion,
    gitSha: evidence.git.sha,
    sourceEvidence,
    sourceCandidate: evidence.candidate.binPath,
    sourceCandidateSha256: evidence.candidate.sha256,
    installedBin: relativePath(opts.installRoot, installedBin),
    currentLink: relativePath(opts.installRoot, currentLink),
    currentCommand: relativePath(opts.installRoot, currentCommand),
    acceptedBy: opts.acceptedBy.trim(),
    ...(opts.reason?.trim() ? { reason: opts.reason.trim() } : {}),
  };
  return { sourceBin, versionDir, installedBin, currentLink, currentCommand, currentReceiptPath, receiptPath, receipt };
}

export async function verifyCandidateBinaryHash(sourceBin: string, expectedSha256: string): Promise<string[]> {
  const actual = await hashFileSha256(sourceBin);
  if (actual === expectedSha256) return [];
  return [`candidate binary sha256 mismatch: expected ${expectedSha256}, got ${actual}`];
}

export async function installPromotionCandidate(plan: PromotionInstallPlan): Promise<void> {
  await mkdir(plan.versionDir, { recursive: true });
  await copyFile(plan.sourceBin, plan.installedBin);
  await chmod(plan.installedBin, 0o755);
  await mkdir(dirname(plan.receiptPath), { recursive: true });
  await writeFile(plan.receiptPath, `${JSON.stringify(plan.receipt, null, 2)}\n`);
  await writeFile(plan.currentReceiptPath, `${JSON.stringify(plan.receipt, null, 2)}\n`);

  const tmpLink = `${plan.currentLink}.tmp-${process.pid}`;
  try {
    await symlink(relativePath(dirname(plan.currentLink), plan.versionDir), tmpLink);
    await rename(tmpLink, plan.currentLink);
  } catch (error) {
    throw new Error(`failed to update local stable symlink: ${(error as Error).message}`);
  }
}

function checkRelative(label: string, value: string, issues: string[]): void {
  if (isAbsolute(value)) issues.push(`${label} must be repo-relative, got absolute path`);
}

function relativePath(root: string, target: string): string {
  return relative(root, target).replaceAll("\\", "/") || ".";
}
