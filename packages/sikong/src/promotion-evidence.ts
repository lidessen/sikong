import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface CommandEvidence {
  name: string;
  command: readonly string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stdoutPreview: string;
  stderrPreview: string;
}

export interface PromotionEvidence {
  schemaVersion: 1;
  generatedAt: string;
  packageName: string;
  packageVersion: string;
  git: {
    sha: string;
    branch: string;
    status: string;
  };
  candidate: {
    binPath: string;
    builtFromSource: boolean;
    sha256: string;
  };
  checks: readonly CommandEvidence[];
  decision: {
    status: "pending_lead_review";
    requiredAction: string;
  };
}

export interface PromotionEvidencePaths {
  jsonPath: string;
  markdownPath: string;
}

export interface RunCommandEvidenceOptions {
  evidenceCommand?: readonly string[];
  evidenceCwd?: string;
  scrubOutput?: (value: string) => string;
}

const PREVIEW_LIMIT = 8_000;

export function commandPassed(check: CommandEvidence): boolean {
  return check.exitCode === 0;
}

export function promotionEvidencePassed(evidence: PromotionEvidence): boolean {
  return evidence.checks.every(commandPassed);
}

export function previewOutput(value: string, limit = PREVIEW_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

export function renderPromotionEvidenceMarkdown(evidence: PromotionEvidence): string {
  const passed = promotionEvidencePassed(evidence);
  const status = passed ? "PASS" : "FAIL";
  const checks = evidence.checks
    .map((check) => {
      const mark = commandPassed(check) ? "PASS" : "FAIL";
      const command = check.command.join(" ");
      const stderr = check.stderrPreview.trim();
      const stderrLine = stderr ? `\n  - stderr: ${singleLine(stderr)}` : "";
      return `- ${mark} ${check.name}: \`${command}\` (exit ${String(check.exitCode)}, ${check.durationMs}ms)${stderrLine}`;
    })
    .join("\n");

  return [
    `# Sikong Promotion Evidence`,
    ``,
    `Status: ${status}`,
    `Generated: ${evidence.generatedAt}`,
    `Package: ${evidence.packageName}@${evidence.packageVersion}`,
    `Git: ${evidence.git.branch} ${evidence.git.sha}`,
    `Candidate: ${evidence.candidate.binPath}`,
    `Candidate sha256: ${evidence.candidate.sha256}`,
    ``,
    `## Checks`,
    ``,
    checks,
    ``,
    `## Lead Decision`,
    ``,
    `Status: ${evidence.decision.status}`,
    `Required action: ${evidence.decision.requiredAction}`,
    ``,
    `## Git Status`,
    ``,
    evidence.git.status.trim() ? fence(evidence.git.status.trim()) : `Clean`,
    ``,
  ].join("\n");
}

export async function writePromotionEvidence(
  outDir: string,
  evidence: PromotionEvidence,
): Promise<PromotionEvidencePaths> {
  await mkdir(outDir, { recursive: true });
  const safeVersion = evidence.packageVersion.replace(/[^a-zA-Z0-9._-]/g, "_");
  const sha = evidence.git.sha.slice(0, 12) || "unknown";
  const stamp = evidence.generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const base = `${stamp}-sikong-${safeVersion}-${sha}`;
  const jsonPath = join(outDir, `${base}.json`);
  const markdownPath = join(outDir, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(markdownPath, renderPromotionEvidenceMarkdown(evidence));
  return { jsonPath, markdownPath };
}

export async function readPackageIdentity(packageJsonPath: string): Promise<{
  name: string;
  version: string;
}> {
  const raw = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
  return {
    name: typeof parsed.name === "string" ? parsed.name : "unknown",
    version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
  };
}

export async function hashFileSha256(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function runCommandEvidence(
  name: string,
  command: readonly string[],
  cwd: string,
  options: RunCommandEvidenceOptions = {},
): Promise<CommandEvidence> {
  const started = Date.now();
  const scrub = options.scrubOutput ?? ((value: string) => value);
  try {
    const proc = Bun.spawn([...command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      name,
      command: options.evidenceCommand ?? command,
      cwd: options.evidenceCwd ?? cwd,
      exitCode,
      durationMs: Date.now() - started,
      stdoutPreview: previewOutput(scrub(stdout)),
      stderrPreview: previewOutput(scrub(stderr)),
    };
  } catch (error) {
    return {
      name,
      command: options.evidenceCommand ?? command,
      cwd: options.evidenceCwd ?? cwd,
      exitCode: null,
      durationMs: Date.now() - started,
      stdoutPreview: "",
      stderrPreview: previewOutput(scrub(error instanceof Error ? error.message : String(error))),
    };
  }
}

function fence(value: string): string {
  return ["```text", value, "```"].join("\n");
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 240);
}
