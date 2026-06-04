/**
 * Tests for design worker tools: `design_preview` and `design_deliver`.
 *
 * These tests exercise the actual tool exports — no mocking — writing real
 * files to a temp directory, then verifying structure, content, security
 * guards, and error paths.
 */
import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesignTools } from "./design-tools";
import type { ToolDefinition } from "agent-loop";

// ---- Helpers -----------------------------------------------------------------

/**
 * Execute a design tool with the given args. Properly typed call wrapper
 * that handles ToolDefinition's nullable execute and (args, ctx) signature.
 */
async function execTool(
  tool: ToolDefinition | undefined,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!tool?.execute) throw new Error("tool missing execute");
  return (await tool.execute(args, {})) as Record<string, unknown>;
}

interface ToolMap {
  preview: ToolDefinition | undefined;
  deliver: ToolDefinition | undefined;
}

function getTools(root: string, previewDir?: string): ToolMap {
  const { tools } = buildDesignTools({
    projectRoot: root,
    previewDir,
  });
  return {
    preview: tools["design_preview"],
    deliver: tools["design_deliver"],
  };
}

const tmp = () => mkdtemp(join(tmpdir(), "design-tools-"));

async function allFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(d: string, prefix: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries.sort()) {
      if (e.isDirectory()) {
        await walk(join(d, e.name), `${prefix}${e.name}/`);
      } else {
        result.push(`${prefix}${e.name}`);
      }
    }
  }
  await walk(dir, "");
  return result.sort();
}

// ---- design_preview ----------------------------------------------------------

describe("design_preview", () => {
  test("writes a web preview with files, index, and meta", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.preview, {
        candidateId: "a",
        type: "web",
        title: "Homepage v1",
        files: [
          { path: "pages/home.tsx", content: "export default () => <h1>Hello</h1>;" },
          { path: "styles/theme.css", content: "body { color: red; }" },
        ],
      });

      expect(result).toMatchObject({
        ok: true,
        files: 3, // 2 files + .meta.json (index.json is a side-effect, not counted)
      });

      // Verify preview directory structure
      const previewDir = join(dir, "design", "preview", "a");
      expect(await stat(previewDir)).toBeDefined();

      const files = await allFiles(previewDir);
      expect(files).toContain("pages/home.tsx");
      expect(files).toContain("styles/theme.css");
      expect(files).toContain(".meta.json");

      // Verify content
      const homeContent = await readFile(join(previewDir, "pages/home.tsx"), "utf-8");
      expect(homeContent).toBe("export default () => <h1>Hello</h1>;");

      // Verify meta.json
      const metaRaw = await readFile(join(previewDir, ".meta.json"), "utf-8");
      expect(JSON.parse(metaRaw)).toEqual({
        candidateId: "a",
        title: "Homepage v1",
        type: "web",
        fileCount: 2,
      });

      // Verify preview index
      const indexRaw = await readFile(join(dir, "design", "preview", "index.json"), "utf-8");
      expect(JSON.parse(indexRaw)).toEqual([
        { candidateId: "a", title: "Homepage v1", type: "web" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes a TUI preview with design doc", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.preview, {
        candidateId: "b",
        type: "tui",
        files: [{ path: "app.tsx", content: "console.log('hello')" }],
        designDoc: "Using react-blessed for the terminal UI.",
      });

      expect(result).toMatchObject({ ok: true, files: 3 }); // 1 file + design.md + .meta.json

      const previewDir = join(dir, "design", "preview", "b");
      const mdContent = await readFile(join(previewDir, "design.md"), "utf-8");
      expect(mdContent).toBe("Using react-blessed for the terminal UI.");

      // index entry has designDoc flag
      const indexRaw = await readFile(join(dir, "design", "preview", "index.json"), "utf-8");
      expect(JSON.parse(indexRaw)).toEqual([
        { candidateId: "b", title: "b", type: "tui", designDoc: true },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes a 'both' preview", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.preview, {
        candidateId: "c",
        type: "both",
        files: [{ path: "index.tsx", content: "export default () => <div />;" }],
      });

      expect(result).toMatchObject({ ok: true, files: 2 }); // 1 file + .meta.json (no designDoc)

      const metaRaw = await readFile(
        join(dir, "design", "preview", "c", ".meta.json"),
        "utf-8",
      );
      expect(JSON.parse(metaRaw).type).toBe("both");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("defaults title to candidateId", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      await execTool(t.preview, {
        candidateId: "alpha",
        type: "web",
        files: [{ path: "a.tsx", content: "// test" }],
      });

      const metaRaw = await readFile(
        join(dir, "design", "preview", "alpha", ".meta.json"),
        "utf-8",
      );
      expect(JSON.parse(metaRaw).title).toBe("alpha");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("updates existing preview index on subsequent writes", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      // Write two candidates
      await execTool(t.preview, {
        candidateId: "a",
        type: "web",
        files: [{ path: "a.tsx", content: "// a" }],
      });
      await execTool(t.preview, {
        candidateId: "b",
        type: "tui",
        files: [{ path: "b.tsx", content: "// b" }],
      });

      const indexRaw = await readFile(
        join(dir, "design", "preview", "index.json"),
        "utf-8",
      );
      const index = JSON.parse(indexRaw);
      expect(index).toHaveLength(2);
      expect(index.map((e: any) => e.candidateId)).toEqual(["a", "b"]);

      // Rewrite candidate 'a' — index entry should be updated (not duplicated)
      await execTool(t.preview, {
        candidateId: "a",
        type: "web",
        title: "Homepage v2",
        files: [{ path: "a.tsx", content: "// a v2" }],
      });
      const index2Raw = await readFile(
        join(dir, "design", "preview", "index.json"),
        "utf-8",
      );
      const index2 = JSON.parse(index2Raw);
      expect(index2).toHaveLength(2); // still 2
      expect(index2.find((e: any) => e.candidateId === "a").title).toBe("Homepage v2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ---- Edge cases ------------------------------------------------------------

  test("rejects empty files array", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.preview, {
        candidateId: "x",
        type: "web",
        files: [],
      });
      expect(result).toMatchObject({ ok: false, error: "at least one file is required" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid candidateId", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.preview, {
        candidateId: "../bad",
        type: "web",
        files: [{ path: "a.tsx", content: "x" }],
      });
      expect(result).toMatchObject({ ok: false });
      expect(result.error).toContain("invalid candidateId");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects candidateId with spaces", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.preview, {
        candidateId: "my candidate",
        type: "web",
        files: [{ path: "a.tsx", content: "x" }],
      });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("invalid candidateId") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects unknown type", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.preview, {
        candidateId: "x",
        type: "desktop",
        files: [{ path: "a.tsx", content: "x" }],
      });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("invalid type") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("blocks file path traversal in preview files", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.preview, {
        candidateId: "a",
        type: "web",
        files: [{ path: "../../../etc/escape.txt", content: "pwn" }],
      });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("path traversal blocked") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("blocks absolute paths in preview files", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.preview, {
        candidateId: "a",
        type: "web",
        files: [{ path: "/etc/passwd", content: "no" }],
      });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("path traversal blocked") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes nested file paths correctly", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      await execTool(t.preview, {
        candidateId: "a",
        type: "web",
        files: [
          { path: "a/b/c/deep.txt", content: "deep" },
          { path: "a/b/shallow.txt", content: "shallow" },
        ],
      });
      const files = await allFiles(join(dir, "design", "preview", "a"));
      expect(files).toContain("a/b/c/deep.txt");
      expect(files).toContain("a/b/shallow.txt");
      expect(files).toContain(".meta.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- design_deliver ----------------------------------------------------------

describe("design_deliver", () => {
  test("delivers files to the project root", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.deliver, {
        candidateId: "a",
        files: [
          { path: "src/components/Button.tsx", content: "export const Button = () => <button />;" },
          { path: "src/components/index.ts", content: "export * from './Button';" },
        ],
      });

      expect(result).toMatchObject({
        ok: true,
        deliveredTo: ".",
        files: 2,
        writtenFiles: [
          "src/components/Button.tsx",
          "src/components/index.ts",
        ],
      });

      const buttonContent = await readFile(
        join(dir, "src/components/Button.tsx"),
        "utf-8",
      );
      expect(buttonContent).toBe("export const Button = () => <button />;");

      const indexPathContent = await readFile(
        join(dir, "src/components/index.ts"),
        "utf-8",
      );
      expect(indexPathContent).toBe("export * from './Button';");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("delivers files to a basePath", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.deliver, {
        candidateId: "b",
        basePath: "src/components/design",
        files: [
          { path: "NavBar.tsx", content: "export const NavBar = () => <nav />;" },
        ],
      });

      expect(result).toMatchObject({
        ok: true,
        deliveredTo: "src/components/design",
        files: 1,
        writtenFiles: ["src/components/design/NavBar.tsx"],
      });

      const content = await readFile(
        join(dir, "src/components/design/NavBar.tsx"),
        "utf-8",
      );
      expect(content).toBe("export const NavBar = () => <nav />;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("delivers files with design doc at default path", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.deliver, {
        candidateId: "c",
        files: [{ path: "index.ts", content: "// deliver" }],
        designDoc: "# Design notes\n\nUsed a flexbox layout.",
      });

      expect(result).toMatchObject({ ok: true, files: 2 });

      const docContent = await readFile(join(dir, "DESIGN.md"), "utf-8");
      expect(docContent).toBe("# Design notes\n\nUsed a flexbox layout.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("delivers design doc at a custom path", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      await execTool(t.deliver, {
        candidateId: "d",
        files: [{ path: "lib.ts", content: "// lib" }],
        designDoc: "# Custom path doc",
        designDocPath: "docs/design-decisions/CHOSEN.md",
      });

      const docContent = await readFile(
        join(dir, "docs/design-decisions/CHOSEN.md"),
        "utf-8",
      );
      expect(docContent).toBe("# Custom path doc");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("delivers design doc at a custom path relative to basePath", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      await execTool(t.deliver, {
        candidateId: "e",
        basePath: "src/components",
        files: [{ path: "Header.tsx", content: "// header" }],
        designDoc: "# Component design notes",
        designDocPath: "Header.DESIGN.md",
      });

      // designDocPath should resolve relative to deliverRoot (which is projectRoot + basePath)
      const docContent = await readFile(
        join(dir, "src/components/Header.DESIGN.md"),
        "utf-8",
      );
      expect(docContent).toBe("# Component design notes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ---- Edge cases ------------------------------------------------------------

  test("rejects empty files", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.deliver, {
        candidateId: "x",
        files: [],
      });
      expect(result).toMatchObject({ ok: false, error: "no files provided to deliver" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("blocks file path traversal in deliver files", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.deliver, {
        candidateId: "x",
        files: [{ path: "../../../etc/malware.txt", content: "evil" }],
      });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("path traversal blocked") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("blocks absolute paths in deliver files", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.deliver, {
        candidateId: "x",
        files: [{ path: "/root/.ssh/authorized_keys", content: "ssh-rsa pwn" }],
      });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("path traversal blocked") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("blocks path traversal relative to basePath", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      const result = await execTool(t.deliver, {
        candidateId: "x",
        basePath: "src/components",
        files: [{ path: "../../../outside.txt", content: "escape" }],
      });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("path traversal blocked") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes nested deliver file paths correctly", async () => {
    const dir = await tmp();
    try {
      const t = getTools(dir);
      await execTool(t.deliver, {
        candidateId: "a",
        files: [
          { path: "deep/nested/path/component.tsx", content: "// deep" },
          { path: "top-level.ts", content: "// top" },
        ],
      });

      const files = await allFiles(dir);
      expect(files).toContain("deep/nested/path/component.tsx");
      expect(files).toContain("top-level.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- Factory invariants ------------------------------------------------------

describe("buildDesignTools factory", () => {
  test("rejects previewDir outside projectRoot", () => {
    expect(() =>
      buildDesignTools({
        projectRoot: "/tmp/project",
        previewDir: "/etc/preview",
      }),
    ).toThrow(/previewDir must be under projectRoot/);
  });

  test("rejects previewDir with absolute traversal", () => {
    expect(() =>
      buildDesignTools({
        projectRoot: "/tmp/a",
        previewDir: "/tmp/b/preview",
      }),
    ).toThrow(/previewDir must be under projectRoot/);
  });

  test("accepts previewDir inside projectRoot", () => {
    const { tools } = buildDesignTools({
      projectRoot: "/tmp/project",
      previewDir: "/tmp/project/my-previews",
    });
    expect(tools.design_preview).toBeDefined();
    expect(tools.design_deliver).toBeDefined();
  });

  test("defaults previewDir to projectRoot/design/preview", () => {
    const root = "/tmp/project";
    const opts = { projectRoot: root };
    // Can't directly inspect previewDir (it's private), but we can verify
    // that the factory doesn't throw and tools work.
    const { tools } = buildDesignTools(opts);
    expect(tools.design_preview).toBeDefined();
    expect(tools.design_deliver).toBeDefined();
  });

  test("resolves relative previewDir relative to cwd (via resolve)", async () => {
    // buildDesignTools always resolves previewDir, so a relative path
    // is anchored to process.cwd(), not projectRoot. This is subtle but
    // acceptable — the security assert against projectRoot catches it.
    //
    // What matters: a relative path that resolves OUTSIDE projectRoot is
    // rejected by the assertPathSafe check later.
    const dir = await tmp();
    try {
      // projectRoot = /some/dir/project
      // Passing previewDir as relative "../../outside" — resolve makes it
      // an absolute path outside projectRoot, caught by the security assert.
      expect(() =>
        buildDesignTools({
          projectRoot: join(dir, "project"),
          previewDir: "../../outside",
        }),
      ).toThrow(/previewDir must be under projectRoot/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- Export shape ------------------------------------------------------------

describe("public API", () => {
  test("DESIGN_TOOL_NAMES includes both tools", async () => {
    const { DESIGN_TOOL_NAMES } = await import("./design-tools");
    expect(DESIGN_TOOL_NAMES).toEqual(["design_preview", "design_deliver"]);
  });

  test("buildDesignTools returns design_preview and design_deliver", () => {
    const { tools } = buildDesignTools({ projectRoot: "/tmp" });
    expect(tools).toHaveProperty("design_preview");
    expect(tools).toHaveProperty("design_deliver");
    expect(Object.keys(tools)).toHaveLength(2);
  });

  test("tools barrel re-exports design tools", async () => {
    const barrel = await import("./index");
    expect(barrel.buildDesignTools).toBeDefined();
    expect(barrel.DESIGN_TOOL_NAMES).toBeDefined();
  });

  test("package index re-exports tools barrel", async () => {
    const pkg = await import("../index");
    expect(pkg.buildDesignTools).toBeDefined();
    expect(pkg.DESIGN_TOOL_NAMES).toBeDefined();
  });
});
