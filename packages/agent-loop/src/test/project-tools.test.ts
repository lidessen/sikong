import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createProjectTools, type ProjectToolOptions } from "../tools";
import type { ToolDefinition, ToolExecutionContext } from "../core/types";

async function tempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-loop-tools-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.txt"), "needle\nother\n", "utf8");
  return root;
}

async function execute(
  tool: ToolDefinition | undefined,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext = {},
): Promise<unknown> {
  expect(tool?.execute).toBeTypeOf("function");
  return await tool!.execute!(args, ctx);
}

describe("project tools", () => {
  test("provides bash-tool backed project read/write/bash tools", async () => {
    const root = await tempProject();
    const tools = await createProjectTools({ cwd: root });

    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        "bash",
        "readFile",
        "viewFile",
        "writeFile",
        "replaceInFile",
        "rg",
        "grep",
        "web_fetch",
        "web_search",
      ]),
    );
    await expect(execute(tools.readFile, { path: "src/a.txt" })).resolves.toEqual({
      content: "needle\nother\n",
    });

    await execute(tools.writeFile, { path: "out/result.txt", content: "done\n" });
    await expect(readFile(join(root, "out", "result.txt"), "utf8")).resolves.toBe("done\n");

    const bash = (await execute(tools.bash, { command: "rg needle ." })) as { stdout?: string; exitCode?: number };
    expect(bash.exitCode).toBe(0);
    expect(bash.stdout).toContain("src/a.txt:1:needle");
  });

  test("views a line-numbered file window", async () => {
    const root = await tempProject();
    const tools = await createProjectTools({ cwd: root });

    const viewed = (await execute(tools.viewFile, {
      path: "src/a.txt",
      start_line: 2,
      max_lines: 1,
    })) as {
      path?: string;
      startLine?: number;
      endLine?: number;
      totalLines?: number;
      truncatedBefore?: boolean;
      truncatedAfter?: boolean;
      content?: string;
    };

    expect(viewed).toMatchObject({
      path: "src/a.txt",
      startLine: 2,
      endLine: 2,
      totalLines: 2,
      truncatedBefore: true,
      truncatedAfter: false,
      content: "2 | other",
    });
  });

  test("replaces exact text inside an existing project file", async () => {
    const root = await tempProject();
    const tools = await createProjectTools({ cwd: root });

    await expect(
      execute(tools.replaceInFile, {
        path: "src/a.txt",
        search: "needle\n",
        replace: "needle\npatched\n",
        expected_replacements: 1,
      }),
    ).resolves.toMatchObject({ path: "src/a.txt", replacements: 1 });
    await expect(readFile(join(root, "src", "a.txt"), "utf8")).resolves.toBe("needle\npatched\nother\n");

    await expect(
      execute(tools.replaceInFile, {
        path: "src/a.txt",
        search: "missing",
        replace: "x",
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("Search text not found") });
  });

  test("searches with ripgrep and rejects paths outside the project root", async () => {
    const root = await tempProject();
    const tools = await createProjectTools({ cwd: root });

    const found = (await execute(tools.rg, {
      pattern: "needle",
      path: "src",
      max_results: 5,
    })) as { matches?: string[]; count?: number };
    expect(found.count).toBe(1);
    expect(found.matches).toEqual(["src/a.txt:1:needle"]);

    const withSignal = (await execute(
      tools.rg,
      { pattern: "needle", path: "src" },
      { signal: new AbortController().signal },
    )) as { matches?: string[]; count?: number };
    expect(withSignal.count).toBe(1);
    expect(withSignal.matches).toEqual(["src/a.txt:1:needle"]);

    const rejected = (await execute(tools.grep, {
      pattern: "needle",
      path: "..",
    })) as { error?: string };
    expect(rejected.error).toContain("outside the project root");
  });

  test("fetches readable web text and blocks private resolved targets", async () => {
    const root = await tempProject();
    let privateFetchCalled = false;
    const htmlFetch: ProjectToolOptions["fetch"] = async () =>
      new Response(
        "<html><head><title>Example</title></head><body><h1>Hello</h1><script>ignore()</script><p>World &amp; team</p></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      );
    const tools = await createProjectTools({
      cwd: root,
      fetch: htmlFetch,
      resolveAddresses: async () => ["93.184.216.34"],
    });

    const fetched = (await execute(tools.web_fetch, {
      url: "https://example.com/page",
    })) as { title?: string; text?: string; status?: number };
    expect(fetched.status).toBe(200);
    expect(fetched.title).toBe("Example");
    expect(fetched.text).toContain("Hello");
    expect(fetched.text).toContain("World & team");
    expect(fetched.text).not.toContain("ignore()");

    const privateTools = await createProjectTools({
      cwd: root,
      fetch: async () => {
        privateFetchCalled = true;
        return new Response("unreachable");
      },
      resolveAddresses: async () => ["127.0.0.1"],
    });
    const rejected = (await execute(privateTools.web_fetch, {
      url: "https://internal.example",
    })) as { error?: string };
    expect(rejected.error).toContain("Private/local URL targets are blocked");
    expect(privateFetchCalled).toBe(false);
  });

  test("searches the web through Brave when configured", async () => {
    const root = await tempProject();
    const fetchImpl: ProjectToolOptions["fetch"] = async (input, init) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("api.search.brave.com");
      expect(url.searchParams.get("q")).toBe("agent loop");
      expect((init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("test-key");
      return new Response(
        JSON.stringify({
          web: {
            results: [{ title: "Result", url: "https://example.com", description: "desc" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const tools = await createProjectTools({ cwd: root, fetch: fetchImpl, webSearchApiKey: "test-key" });

    const result = (await execute(tools.web_search, {
      query: "agent loop",
      count: 1,
    })) as { results?: Array<{ title: string; url: string; description: string }> };
    expect(result.results).toEqual([{ title: "Result", url: "https://example.com", description: "desc" }]);
  });
});
