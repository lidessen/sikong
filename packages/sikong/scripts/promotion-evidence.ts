#!/usr/bin/env bun
/**
 * Generate lead-review evidence for promoting a Sikong candidate.
 *
 * This script does not replace local stable and does not publish. It builds or
 * uses a candidate binary, runs deterministic gates, runs the candidate
 * self-smoke, and writes JSON/Markdown evidence for lead review.
 *
 * Usage:
 *   bun scripts/promotion-evidence.ts
 *   bun scripts/promotion-evidence.ts --bin ./dist/sikong-candidate
 *   bun scripts/promotion-evidence.ts --out ../../promotion-evidence
 */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CommandEvidence,
  type PromotionEvidence,
  promotionEvidencePassed,
  readPackageIdentity,
  runCommandEvidence,
  writePromotionEvidence,
} from "../src/promotion-evidence";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PKG_ROOT));
const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return argv.includes(name);
}

function usage(): never {
  console.error(
    [
      "usage: bun scripts/promotion-evidence.ts [--bin <path>] [--candidate <path>] [--out <dir>] [--skip-self-smoke]",
      "",
      "  --bin <path>        Use an existing candidate binary instead of building one.",
      "  --candidate <path>  Candidate build output path. Defaults to dist/sikong-candidate.",
      "  --out <dir>         Evidence output directory. Defaults to ../../promotion-evidence.",
      "  --skip-self-smoke   Skip the compiled-binary self-smoke. Use only for debugging.",
    ].join("\n"),
  );
  process.exit(2);
}

if (hasFlag("--help")) usage();

const suppliedBin = flag("--bin");
const candidatePath = resolve(PKG_ROOT, flag("--candidate") ?? join("dist", "sikong-candidate"));
const candidateBin = suppliedBin ? resolve(PKG_ROOT, suppliedBin) : candidatePath;
const outDir = resolve(PKG_ROOT, flag("--out") ?? join("..", "..", "promotion-evidence"));
const skipSelfSmoke = hasFlag("--skip-self-smoke");
const candidateRelToPkg = repoSafeRelative(PKG_ROOT, candidateBin);
const candidateRelToRepo = repoSafeRelative(REPO_ROOT, candidateBin);

async function runGit(args: readonly string[], fallback = "unknown"): Promise<string> {
  const result = await runEvidence(`git ${args.join(" ")}`, ["git", ...args], REPO_ROOT, ".");
  if (result.exitCode !== 0) return fallback;
  return result.stdoutPreview.trim() || fallback;
}

async function runEvidence(
  name: string,
  command: readonly string[],
  cwd: string,
  evidenceCwd: string,
  evidenceCommand: readonly string[] = command,
): Promise<CommandEvidence> {
  return await runCommandEvidence(name, command, cwd, {
    evidenceCommand,
    evidenceCwd,
    scrubOutput,
  });
}

async function main(): Promise<void> {
  const identity = await readPackageIdentity(join(PKG_ROOT, "package.json"));
  const generatedAt = new Date().toISOString();
  const checks: CommandEvidence[] = [];

  const sha = await runGit(["rev-parse", "HEAD"]);
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await runGit(["status", "--short"], "");

  if (suppliedBin) {
    checks.push(
      await runEvidence(
        "candidate executable",
        ["test", "-x", candidateBin],
        PKG_ROOT,
        "packages/sikong",
        ["test", "-x", candidateRelToPkg],
      ),
    );
  } else {
    await mkdir(dirname(candidateBin), { recursive: true });
    checks.push(
      await runEvidence(
        "build candidate",
        ["bun", "build", "src/cli.ts", "--compile", "--outfile", candidateRelToPkg],
        PKG_ROOT,
        "packages/sikong",
      ),
    );
  }

  checks.push(await runEvidence("typecheck", ["bun", "run", "typecheck"], REPO_ROOT, "."));
  checks.push(await runEvidence("test", ["bun", "run", "test"], REPO_ROOT, "."));
  checks.push(await runEvidence("diff check", ["git", "diff", "--check"], REPO_ROOT, "."));

  if (!skipSelfSmoke) {
    checks.push(
      await runEvidence(
        "candidate self-smoke",
        ["bun", "scripts/self-smoke.ts", "--bin", candidateRelToPkg],
        PKG_ROOT,
        "packages/sikong",
      ),
    );
  }

  const evidence: PromotionEvidence = {
    schemaVersion: 1,
    generatedAt,
    packageName: identity.name,
    packageVersion: identity.version,
    git: { sha, branch, status },
    candidate: {
      binPath: candidateRelToRepo,
      builtFromSource: suppliedBin === undefined,
    },
    checks,
    decision: {
      status: "pending_lead_review",
      requiredAction:
        "Lead must review this evidence and explicitly accept or reject before replacing local stable or publishing.",
    },
  };

  const paths = await writePromotionEvidence(outDir, evidence);
  const passed = promotionEvidencePassed(evidence);

  console.log(`promotion evidence: ${passed ? "PASS" : "FAIL"}`);
  console.log(`json: ${displayPath(paths.jsonPath)}`);
  console.log(`markdown: ${displayPath(paths.markdownPath)}`);
  console.log(`candidate: ${candidateRelToRepo}`);

  if (!passed) process.exit(1);
}

await main();

function repoSafeRelative(root: string, target: string): string {
  const rel = toPosix(relative(root, target));
  if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) {
    throw new Error(`promotion evidence path must stay inside the repository: ${target}`);
  }
  return rel || ".";
}

function scrubOutput(value: string): string {
  return value
    .replaceAll(REPO_ROOT, ".")
    .replaceAll(PKG_ROOT, "packages/sikong")
    .replaceAll(tmpdir(), "<tmp>");
}

function displayPath(value: string): string {
  return scrubOutput(value).replace(/^\.\//, "");
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}
