/**
 * Design worker tools: `design_preview` and `design_deliver`.
 *
 * These are task-agnostic worker-boundary tools (ADR 0017, the "preview bridge")
 * injected via WorkerToolsFactory when a design workflow wakes an agent. The agent
 * calls them to emit live previews of candidate designs or to deliver the finished
 * design into the target project.
 *
 * Task-agnostic by design — they know nothing about the workflow, only about the
 * project root and a preview output directory. The engine remains agnostic (ADR 0007).
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defineTool, type ToolSet } from "agent-loop";

// ---- Exported constants -------------------------------------------------------

export const DESIGN_TOOL_NAMES = ["design_preview", "design_deliver"] as const;
export type DesignToolName = (typeof DESIGN_TOOL_NAMES)[number];

// ---- Types --------------------------------------------------------------------

/** Target type for a design preview. */
export type PreviewType = "web" | "tui" | "both";

/** A file in a design candidate's artifact set. */
export interface DesignFile {
  path: string;
  content: string;
}

/** Options for building the design worker tools. */
export interface DesignToolsOptions {
  /** Absolute project root — where deliver writes files. */
  projectRoot: string;
  /** Preview output directory. Defaults to `<projectRoot>/design/preview/`. */
  previewDir?: string;
}

/** A single entry in the preview index. */
interface PreviewIndexEntry {
  candidateId: string;
  title: string;
  type: string;
  designDoc?: boolean;
}

// ---- Builder ------------------------------------------------------------------

/**
 * Build the design worker tools for the given project.
 *
 * Usage (injected via WorkerToolsFactory):
 *
 *   workerTools: (ctx, loop) => {
 *     const projectRoot = ctx.project?.root ?? process.cwd();
 *     return ctx.workflow.id === "design"
 *       ? buildDesignTools({ projectRoot }).tools
 *       : {};
 *   }
 */
export function buildDesignTools(opts: DesignToolsOptions): { tools: ToolSet } {
  const projectRoot = resolve(opts.projectRoot);
  const previewDir = opts.previewDir
    ? resolve(opts.previewDir)
    : join(projectRoot, "design", "preview");

  // Security invariant: preview directory must be under the project root so the
  // engine's file-scoping (cwd/allowedPaths) still applies. A misconfiguration
  // here would let an agent write preview files outside the project boundary.
  const relPreview = relative(projectRoot, previewDir);
  if (relPreview.startsWith("..") || isAbsolute(relPreview)) {
    throw new Error(
      `previewDir must be under projectRoot (got ${previewDir} for project root ${projectRoot})`,
    );
  }

  /**
   * Directory-traversal guard: ensure a file path resolves within its intended
   * base directory. Throws on any attempt to escape with `..` or an absolute path.
   */
  function assertPathSafe(target: string, base: string): void {
    const resolved = resolve(base, target);
    const rel = relative(base, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `path traversal blocked: "${target}" resolves outside "${base}"`,
      );
    }
  }

  return {
    tools: {
      // ---- design_preview ----------------------------------------------------
      design_preview: defineTool({
        description:
          "Emit a candidate design as a live preview — write runnable files the owner can open and interact with (semajsx web SSR/dev-server components, TUI terminal renders, or both). Use this during the preview/diverge stage to make each design candidate tangible. The files ARE the preview: this is not a screenshot or mockup tool. Do NOT use this to deliver the final design — use `design_deliver` after critique+converge select a winner.",
        inputSchema: {
          type: "object",
          properties: {
            candidateId: {
              type: "string",
              description:
                'Short handle for this candidate (e.g. "a", "b", "c") — used as the subdirectory name in the preview directory so the owner can compare candidates side by side. Must match [a-zA-Z0-9_-]+.',
            },
            type: {
              type: "string",
              enum: ["web", "tui", "both"],
              description:
                "Target type — web (SSR/dev-server semajsx components), TUI (terminal render), or both.",
            },
            title: {
              type: "string",
              description:
                "Human-readable title for this candidate, shown in the preview index so the owner can identify it at a glance. Defaults to candidateId.",
            },
            files: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: {
                    type: "string",
                    description:
                      'Relative file path within the candidate output (e.g. "pages/home.tsx"). Use forward slashes.',
                  },
                  content: {
                    type: "string",
                    description:
                      "File content — real, runnable semajsx code. The files ARE the preview.",
                  },
                },
                required: ["path", "content"],
                additionalProperties: false,
              },
              description:
                "The runnable files for this candidate. Write complete, self-contained semajsx components and pages the owner can open and interact with.",
            },
            designDoc: {
              type: "string",
              description:
                "Optional design rationale document explaining the thinking, layout decisions, token usage, and tradeoffs behind this candidate. Written as design.md alongside the preview files.",
            },
          },
          required: ["candidateId", "type", "files"],
          additionalProperties: false,
        },

        execute: async (args) => {
          const candidateId = String(args.candidateId);
          if (!/^[a-zA-Z0-9_-]+$/.test(candidateId)) {
            return {
              ok: false,
              error: `invalid candidateId "${candidateId}": must match [a-zA-Z0-9_-]+`,
            };
          }

          const type = String(args.type) as PreviewType;
          if (!["web", "tui", "both"].includes(type)) {
            return {
              ok: false,
              error: `invalid type "${type}": must be "web", "tui", or "both"`,
            };
          }

          const files = Array.isArray(args.files) ? args.files : [];
          if (files.length === 0) {
            return { ok: false, error: "at least one file is required" };
          }

          const designDoc =
            typeof args.designDoc === "string" ? args.designDoc : undefined;
          const title =
            typeof args.title === "string" ? args.title : candidateId;
          const outDir = join(previewDir, candidateId);
          const written: string[] = [];

          try {
            await mkdir(outDir, { recursive: true });

            for (const f of files) {
              assertPathSafe(f.path, outDir);
              const fullPath = join(outDir, f.path);
              const dir = dirname(fullPath);
              await mkdir(dir, { recursive: true });
              await writeFile(fullPath, f.content, "utf-8");
              written.push(f.path);
            }

            if (designDoc) {
              const docPath = join(outDir, "design.md");
              await writeFile(docPath, designDoc, "utf-8");
              written.push("design.md");
            }

            // Write a lightweight metadata file so the owner can inspect it
            const meta = { candidateId, title, type, fileCount: files.length };
            await writeFile(
              join(outDir, ".meta.json"),
              JSON.stringify(meta, null, 2),
              "utf-8",
            );
            written.push(".meta.json");

            // Maintain a catalog of all candidates at the preview root
            await updatePreviewIndex(
              previewDir,
              candidateId,
              title,
              type,
              !!designDoc,
            );

            const relDir = relative(projectRoot, outDir);

            return {
              ok: true,
              previewDir: relDir,
              files: written.length,
              message:
                `Candidate "${candidateId}" (${title}) preview written to ` +
                `${relDir} (${written.length} files).`,
              instructions:
                type === "web" || type === "both"
                  ? `Open preview/${candidateId}/ in an editor. To serve it live, run the semajsx SSR dev-server from the project root targeting these files.`
                  : `Open preview/${candidateId}/ in a terminal and run the TUI render entry point to see the live design.`,
            };
          } catch (err) {
            return {
              ok: false,
              error: `preview write failed: ${(err as Error).message}`,
            };
          }
        },
      }),

      // ---- design_deliver ----------------------------------------------------
      design_deliver: defineTool({
        description:
          'Write the chosen design into the target project as real source files. Call this only after the critique and converge stages have selected a winner. The files submitted here ARE the deliverable — they become project source code. Use `basePath` to target a subdirectory (e.g. "src/components/") when delivering components rather than full pages.',
        inputSchema: {
          type: "object",
          properties: {
            candidateId: {
              type: "string",
              description:
                "Short handle identifying which candidate this deliverable originates from. Recorded for audit; the files themselves are what lands in the project.",
            },
            files: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: {
                    type: "string",
                    description:
                      'Relative file path within the project (or within basePath). E.g. "src/components/NavBar.tsx". Use forward slashes.',
                  },
                  content: {
                    type: "string",
                    description:
                      "File content — real, production-ready project source code.",
                  },
                },
                required: ["path", "content"],
                additionalProperties: false,
              },
              description:
                "The final files to write into the project. Each file should be a complete, production-quality source file.",
            },
            basePath: {
              type: "string",
              description:
                'Optional subdirectory within the project to write into (e.g. "src/components/design/"). All file paths are relative to this. Defaults to the project root.',
            },
            designDoc: {
              type: "string",
              description:
                "Optional design rationale document written alongside the delivered files — explains key decisions, token usage, and what to look for during review.",
            },
            designDocPath: {
              type: "string",
              description:
                'Where to write the design doc relative to basePath or project root. Defaults to "DESIGN.md".',
            },
          },
          required: ["candidateId", "files"],
          additionalProperties: false,
        },

        execute: async (args) => {
          const candidateId = String(args.candidateId);
          const files = Array.isArray(args.files) ? args.files : [];
          const base =
            typeof args.basePath === "string" ? args.basePath : "";
          const designDoc =
            typeof args.designDoc === "string" ? args.designDoc : undefined;
          const designDocPath =
            typeof args.designDocPath === "string" && args.designDocPath
              ? args.designDocPath
              : "DESIGN.md";

          if (files.length === 0) {
            return { ok: false, error: "no files provided to deliver" };
          }

          const deliverRoot = base
            ? join(projectRoot, base)
            : projectRoot;
          const written: string[] = [];

          try {
            await mkdir(deliverRoot, { recursive: true });

            for (const f of files) {
              assertPathSafe(f.path, deliverRoot);
              const fullPath = join(deliverRoot, f.path);
              const dir = dirname(fullPath);
              await mkdir(dir, { recursive: true });
              await writeFile(fullPath, f.content, "utf-8");
              written.push(base ? join(base, f.path) : f.path);
            }

            if (designDoc) {
              const docFullPath = join(
                base ? deliverRoot : projectRoot,
                designDocPath,
              );
              const dir = dirname(docFullPath);
              await mkdir(dir, { recursive: true });
              await writeFile(docFullPath, designDoc, "utf-8");
              written.push(designDocPath);
            }

            return {
              ok: true,
              deliveredTo: relative(projectRoot, deliverRoot) || ".",
              files: written.length,
              message:
                `Design "${candidateId}" delivered (${written.length} files written).`,
              writtenFiles: written,
            };
          } catch (err) {
            return {
              ok: false,
              error: `design deliver failed: ${(err as Error).message}`,
            };
          }
        },
      }),
    },
  };
}

// ---- Preview index (shared helper) -------------------------------------------

/**
 * Update or create the preview index at `<previewDir>/index.json` so the
 * owner can browse all candidates across divergence rounds at a glance.
 */
async function updatePreviewIndex(
  previewDir: string,
  candidateId: string,
  title: string,
  type: string,
  hasDesignDoc: boolean,
): Promise<void> {
  const indexPath = join(previewDir, "index.json");
  let index: PreviewIndexEntry[] = [];

  try {
    const raw = await readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) index = parsed as PreviewIndexEntry[];
  } catch {
    // No existing index or invalid JSON — start a fresh one
  }

  const entry: PreviewIndexEntry = { candidateId, title, type };
  if (hasDesignDoc) entry.designDoc = true;

  const existing = index.findIndex((e) => e.candidateId === candidateId);
  if (existing >= 0) {
    index[existing] = entry;
  } else {
    index.push(entry);
  }

  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");
}
