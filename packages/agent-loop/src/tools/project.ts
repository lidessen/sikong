import { readFile, realpath, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { lookup } from "node:dns/promises";
import type { Bash } from "just-bash";
import * as zod from "zod";
import { defineTool, type ToolDefinition, type ToolSet } from "../core/types";

const z = ((zod as unknown as { z?: typeof zod }).z ?? zod) as typeof zod;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type ResolveAddresses = (hostname: string) => Promise<readonly string[]>;

export interface ProjectToolOptions {
  /** Real project root. All local project tools are scoped to this directory. */
  cwd: string;
  /** Environment exposed to the virtual bash runtime and used for web credentials. */
  env?: Record<string, string>;
  /** Brave Search API key. Falls back to env.BRAVE_SEARCH_API_KEY / process env. */
  webSearchApiKey?: string;
  /** Maximum characters returned by bash-tool stdout/stderr. */
  maxOutputLength?: number;
  /** Maximum bytes fetched by web_fetch before truncating. */
  maxFetchBytes?: number;
  /** Test hook / custom network layer. */
  fetch?: FetchLike;
  /** Test hook / custom DNS resolver used by web_fetch safety checks. */
  resolveAddresses?: ResolveAddresses;
  /** Allow private/local URL targets for web_fetch. Defaults to false. */
  allowPrivateUrls?: boolean;
}

type AiSdkToolLike = {
  description?: string;
  inputSchema?: unknown;
  execute?: (args: unknown, ctx?: unknown) => unknown | Promise<unknown>;
};

const rgSchema = z.object({
  pattern: z.string().min(1).describe("The ripgrep pattern to search for."),
  path: z.string().optional().describe("File or directory to search, relative to the project root."),
  glob: z.union([z.string(), z.array(z.string())]).optional().describe("One or more rg --glob filters."),
  max_results: z.number().int().min(1).max(500).optional().describe("Maximum matching lines to return."),
  context: z.number().int().min(0).max(10).optional().describe("Context lines before and after each match."),
  case_insensitive: z.boolean().optional().describe("Use case-insensitive matching."),
  fixed_strings: z.boolean().optional().describe("Treat pattern as a literal string instead of a regex."),
});

const webFetchSchema = z.object({
  url: z.string().url().describe("HTTP(S) URL to fetch."),
  max_bytes: z.number().int().min(1_000).max(500_000).optional().describe("Maximum response bytes to read."),
  raw: z.boolean().optional().describe("Return raw response text instead of extracting readable text from HTML."),
});

const webSearchSchema = z.object({
  query: z.string().min(1).describe("Search query."),
  count: z.number().int().min(1).max(10).optional().describe("Number of results to return."),
  country: z.string().min(2).max(2).optional().describe("Two-letter country code, such as US."),
  search_lang: z.string().min(2).max(5).optional().describe("Search language code, such as en."),
});

const replaceInFileSchema = z.object({
  path: z.string().min(1).describe("File to edit, relative to the project root."),
  search: z.string().min(1).describe("Exact text to replace."),
  replace: z.string().describe("Replacement text."),
  expected_replacements: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Require exactly this many replacements; if it differs, no file is written."),
});

const insertInFileSchema = z.object({
  path: z.string().min(1).describe("Existing file to edit, relative to the project root."),
  text: z.string().min(1).describe("Line block to insert."),
  position: z
    .enum(["before", "after", "end"])
    .optional()
    .describe("Where to insert the text relative to `line`. Defaults to after when `line` is set, otherwise end."),
  line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based anchor line for before/after insertion. Not required for position=end."),
  expected_line: z
    .string()
    .optional()
    .describe("Optional exact content of the anchor line, without line number or newline. If it differs, no file is written."),
});

const viewFileSchema = z.object({
  path: z.string().min(1).describe("File to inspect, relative to the project root."),
  start_line: z.number().int().min(1).optional().describe("1-based first line to show. Defaults to 1."),
  max_lines: z.number().int().min(1).max(500).optional().describe("Maximum lines to return. Defaults to 120."),
});

export async function createProjectTools(options: ProjectToolOptions): Promise<ToolSet> {
  const cwd = resolve(options.cwd);
  const [{ createBashTool }, { Bash, ReadWriteFs }] = await Promise.all([
    import("bash-tool"),
    import("just-bash"),
  ]);

  const fs = new ReadWriteFs({ root: cwd });
  const bash = new Bash({
    fs,
    cwd: "/",
    ...(options.env ? { env: options.env } : {}),
  });
  const { tools: bashTools } = await createBashTool({
    sandbox: bash,
    destination: "/",
    maxFiles: 0,
    maxOutputLength: options.maxOutputLength,
    extraInstructions:
      "This sandbox maps / to the project root. File reads and writes are constrained to that root; symlink traversal is rejected by the filesystem.",
  });

  const out: ToolSet = {
    bash: withPipefail(fromAiSdkTool(bashTools.bash)),
    readFile: fromAiSdkTool(bashTools.readFile),
    writeFile: fromAiSdkTool(bashTools.writeFile),
  };
  out.viewFile = createViewFileTool({ cwd });
  out.replaceInFile = createReplaceInFileTool({ cwd });
  out.insertInFile = createInsertInFileTool({ cwd });

  const rg = createRipgrepTool({ bash, cwd });
  out.rg = rg;
  out.grep = {
    ...rg,
    description:
      "Search project files with ripgrep. Use this when you want grep-like content search with optional globs, context, literal matching, or case-insensitive matching.",
  };
  out.web_fetch = createWebFetchTool(options);
  out.web_search = createWebSearchTool(options);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fromAiSdkTool(tool: unknown): ToolDefinition {
  const t = tool as AiSdkToolLike;
  return defineTool({
    description: t.description,
    inputSchema: t.inputSchema,
    execute: async (args, ctx) => {
      if (!t.execute) return { error: "Tool has no executor." };
      return await t.execute(args, { toolCallId: ctx.callId, abortSignal: ctx.signal });
    },
  });
}

function withPipefail(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    execute: async (rawArgs, ctx) => {
      if (!tool.execute || !isRecord(rawArgs) || typeof rawArgs.command !== "string") {
        return tool.execute?.(rawArgs, ctx);
      }
      return tool.execute({ ...rawArgs, command: `set -o pipefail\n${rawArgs.command}` }, ctx);
    },
  };
}

function createViewFileTool(opts: { cwd: string }): ToolDefinition {
  return defineTool({
    description:
      "Inspect a window of an existing project file with 1-based line numbers. Prefer this over readFile when you only need part of a file or need exact lines for an edit.",
    inputSchema: viewFileSchema,
    execute: async (rawArgs) => {
      const args = viewFileSchema.parse(rawArgs);
      const pathResult = await resolveProjectPath(opts.cwd, args.path);
      if (!pathResult.ok) return { error: pathResult.error };

      const filePath = resolve(opts.cwd, pathResult.rgPath);
      let text: string;
      try {
        text = await readFile(filePath, "utf8");
      } catch (err) {
        return { error: `Could not read "${pathResult.rgPath}": ${(err as Error).message}` };
      }

      const lines = splitLines(text);
      const totalLines = lines.length;
      const startLine = Math.min(args.start_line ?? 1, Math.max(totalLines, 1));
      const maxLines = args.max_lines ?? 120;
      const startIndex = startLine - 1;
      const selected = lines.slice(startIndex, startIndex + maxLines);
      const endLine = selected.length ? startLine + selected.length - 1 : startLine;
      const width = String(endLine).length;
      return {
        path: pathResult.rgPath,
        startLine,
        endLine,
        totalLines,
        truncatedBefore: startLine > 1,
        truncatedAfter: endLine < totalLines,
        content: selected.map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${line}`).join("\n"),
      };
    },
  });
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (text.endsWith("\n") || text.endsWith("\r")) lines.pop();
  return lines;
}

function detectNewline(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeInsertedLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (text.endsWith("\n") || text.endsWith("\r")) lines.pop();
  return lines;
}

function hasFinalNewline(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}

function createRipgrepTool(opts: { bash: Bash; cwd: string }): ToolDefinition {
  return defineTool({
    description:
      "Search project files with ripgrep (`rg`). Returns matching lines with file paths and line numbers.",
    inputSchema: rgSchema,
    execute: async (rawArgs, ctx) => {
      const args = rgSchema.parse(rawArgs);
      const maxResults = args.max_results ?? 100;
      const pathResult = await resolveProjectPath(opts.cwd, args.path ?? ".");
      if (!pathResult.ok) return { error: pathResult.error };

      const rgArgs = ["--line-number"];
      if (args.case_insensitive) rgArgs.push("--ignore-case");
      if (args.fixed_strings) rgArgs.push("--fixed-strings");
      if (args.context !== undefined && args.context > 0) rgArgs.push("-C", String(args.context));
      const globs = typeof args.glob === "string" ? [args.glob] : (args.glob ?? []);
      for (const glob of globs) rgArgs.push("--glob", glob);
      rgArgs.push(args.pattern, pathResult.rgPath);

      let result: { exitCode?: number; stdout: string; stderr: string };
      try {
        const completed = await opts.bash.exec("rg", {
          args: rgArgs,
          signal: ctx.signal,
        });
        result = {
          exitCode: completed.exitCode,
          stdout: String(completed.stdout ?? ""),
          stderr: String(completed.stderr ?? ""),
        };
      } catch (err) {
        return { error: `rg search failed: ${(err as Error).message}` };
      }
      const exitCode = result.exitCode ?? 0;
      if (exitCode > 1) {
        return {
          error: result.stderr || `rg exited with code ${exitCode}`,
          exitCode,
        };
      }
      const stdout = result.stdout ? result.stdout.replace(/\n$/, "") : "";
      const lines = stdout ? stdout.split("\n") : [];
      const matches = lines.slice(0, maxResults);
      return {
        matches,
        count: lines.length,
        truncated: lines.length > matches.length,
        exitCode,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    },
  });
}

function createReplaceInFileTool(opts: { cwd: string }): ToolDefinition {
  return defineTool({
    description:
      "Edit an existing project file by replacing exact text. Safer than writeFile for small source changes because it preserves the rest of the file.",
    inputSchema: replaceInFileSchema,
    execute: async (rawArgs) => {
      const args = replaceInFileSchema.parse(rawArgs);
      const pathResult = await resolveProjectPath(opts.cwd, args.path);
      if (!pathResult.ok) return { error: pathResult.error };
      const filePath = resolve(opts.cwd, pathResult.rgPath);
      let before: string;
      try {
        before = await readFile(filePath, "utf8");
      } catch (err) {
        return { error: `Could not read "${pathResult.rgPath}": ${(err as Error).message}` };
      }
      const parts = before.split(args.search);
      const replacements = parts.length - 1;
      if (replacements === 0) return { error: `Search text not found in "${pathResult.rgPath}".` };
      if (args.expected_replacements !== undefined && replacements !== args.expected_replacements) {
        return {
          error: `Expected ${args.expected_replacements} replacement(s) in "${pathResult.rgPath}", found ${replacements}. No file was written.`,
          replacements,
        };
      }
      const after = parts.join(args.replace);
      try {
        await writeFile(filePath, after, "utf8");
      } catch (err) {
        return { error: `Could not write "${pathResult.rgPath}": ${(err as Error).message}` };
      }
      return { path: pathResult.rgPath, replacements, bytes: new TextEncoder().encode(after).byteLength };
    },
  });
}

function createInsertInFileTool(opts: { cwd: string }): ToolDefinition {
  return defineTool({
    description:
      "Insert a line block into an existing project file using 1-based line numbers from viewFile. Use expected_line after viewing the anchor line so the edit fails safely if the file changed.",
    inputSchema: insertInFileSchema,
    execute: async (rawArgs) => {
      const args = insertInFileSchema.parse(rawArgs);
      const position = args.position ?? (args.line === undefined ? "end" : "after");
      if (position !== "end" && args.line === undefined) {
        return { error: "`line` is required when position is before or after." };
      }
      const pathResult = await resolveProjectPath(opts.cwd, args.path);
      if (!pathResult.ok) return { error: pathResult.error };
      const filePath = resolve(opts.cwd, pathResult.rgPath);
      let before: string;
      try {
        before = await readFile(filePath, "utf8");
      } catch (err) {
        return { error: `Could not read "${pathResult.rgPath}": ${(err as Error).message}` };
      }

      const lines = splitLines(before);
      const insertLines = normalizeInsertedLines(args.text);
      if (insertLines.length === 0) return { error: "Insert text must contain at least one line." };
      let index = lines.length;
      if (position !== "end") {
        const line = args.line!;
        if (line > lines.length) {
          return { error: `Line ${line} is outside "${pathResult.rgPath}" (${lines.length} lines).` };
        }
        const actualLine = lines[line - 1] ?? "";
        if (args.expected_line !== undefined && actualLine !== args.expected_line) {
          return {
            error: `Expected line ${line} in "${pathResult.rgPath}" to be ${JSON.stringify(args.expected_line)}, found ${JSON.stringify(actualLine)}. No file was written.`,
            line,
            actualLine,
          };
        }
        index = position === "before" ? line - 1 : line;
      }

      const afterLines = [...lines];
      afterLines.splice(index, 0, ...insertLines);
      const newline = detectNewline(before);
      const after = afterLines.join(newline) + (hasFinalNewline(before) || position === "end" ? newline : "");
      try {
        await writeFile(filePath, after, "utf8");
      } catch (err) {
        return { error: `Could not write "${pathResult.rgPath}": ${(err as Error).message}` };
      }
      return {
        path: pathResult.rgPath,
        position,
        ...(position !== "end" ? { line: args.line } : {}),
        insertedLines: insertLines.length,
        bytes: new TextEncoder().encode(after).byteLength,
      };
    },
  });
}

function createWebFetchTool(options: ProjectToolOptions): ToolDefinition {
  return defineTool({
    description:
      "Fetch an HTTP(S) URL and return status, content type, final URL, and readable text. Private/local network targets are blocked by default.",
    inputSchema: webFetchSchema,
    execute: async (rawArgs, ctx) => {
      const args = webFetchSchema.parse(rawArgs);
      const fetchImpl = options.fetch ?? fetch;
      const resolveAddresses = options.resolveAddresses ?? defaultResolveAddresses;
      const maxBytes = args.max_bytes ?? options.maxFetchBytes ?? 120_000;
      const checked = await validatePublicHttpUrl(args.url, {
        allowPrivateUrls: options.allowPrivateUrls ?? false,
        resolveAddresses,
      });
      if (!checked.ok) return { error: checked.error };

      const fetched = await fetchWithValidatedRedirects(checked.url, {
        fetchImpl,
        resolveAddresses,
        allowPrivateUrls: options.allowPrivateUrls ?? false,
        signal: ctx.signal,
        maxRedirects: 5,
      });
      if (!fetched.ok) return { error: fetched.error };

      const response = fetched.response;
      const contentType = response.headers.get("content-type") ?? "";
      const clipped = await readResponseText(response, maxBytes);
      const isHtml = contentType.toLowerCase().includes("text/html");
      const text = args.raw || !isHtml ? clipped.text : htmlToReadableText(clipped.text);
      const title = isHtml ? extractHtmlTitle(clipped.text) : undefined;
      return {
        url: fetched.url.href,
        status: response.status,
        ok: response.ok,
        contentType,
        text,
        truncated: clipped.truncated,
        ...(title ? { title } : {}),
      };
    },
  });
}

function createWebSearchTool(options: ProjectToolOptions): ToolDefinition {
  return defineTool({
    description:
      "Search the web with Brave Search. Requires BRAVE_SEARCH_API_KEY in the project environment, process environment, or tool options.",
    inputSchema: webSearchSchema,
    execute: async (rawArgs, ctx) => {
      const args = webSearchSchema.parse(rawArgs);
      const apiKey =
        options.webSearchApiKey ?? options.env?.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_SEARCH_API_KEY;
      if (!apiKey) return { error: "BRAVE_SEARCH_API_KEY is not configured." };

      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", args.query);
      url.searchParams.set("count", String(args.count ?? 5));
      if (args.country) url.searchParams.set("country", args.country);
      if (args.search_lang) url.searchParams.set("search_lang", args.search_lang);

      const fetchImpl = options.fetch ?? fetch;
      const response = await fetchImpl(url, {
        signal: ctx.signal,
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
      });
      if (!response.ok) {
        return { error: `Brave Search returned HTTP ${response.status}.`, status: response.status };
      }
      const json = (await response.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      return {
        query: args.query,
        results: (json.web?.results ?? []).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          description: r.description ?? "",
        })),
      };
    },
  });
}

async function resolveProjectPath(
  cwd: string,
  inputPath: string,
): Promise<{ ok: true; rgPath: string } | { ok: false; error: string }> {
  const root = resolve(cwd);
  const target = resolve(root, inputPath);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${separatorFor(rel)}`) || isAbsolute(rel)) {
    return { ok: false, error: `Path "${inputPath}" is outside the project root.` };
  }
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    const realRel = relative(realRoot, realTarget);
    if (realRel === ".." || realRel.startsWith(`..${separatorFor(realRel)}`) || isAbsolute(realRel)) {
      return { ok: false, error: `Path "${inputPath}" resolves outside the project root.` };
    }
  } catch {
    return { ok: false, error: `Path "${inputPath}" does not exist or cannot be inspected.` };
  }
  const rgPath = rel === "" ? "." : rel;
  return { ok: true, rgPath };
}

function separatorFor(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

async function defaultResolveAddresses(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname)) return [hostname];
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function validatePublicHttpUrl(
  rawUrl: string,
  opts: { allowPrivateUrls: boolean; resolveAddresses: ResolveAddresses },
): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http and https URLs are supported." };
  }
  if (opts.allowPrivateUrls) return { ok: true, url };
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, error: "Private/local URL targets are blocked." };
  }
  let addresses: readonly string[];
  try {
    addresses = await opts.resolveAddresses(host);
  } catch (err) {
    return { ok: false, error: `Could not resolve URL host: ${(err as Error).message}` };
  }
  if (addresses.length === 0) return { ok: false, error: "URL host did not resolve to an address." };
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return { ok: false, error: "Private/local URL targets are blocked." };
    }
  }
  return { ok: true, url };
}

async function fetchWithValidatedRedirects(
  url: URL,
  opts: {
    fetchImpl: FetchLike;
    resolveAddresses: ResolveAddresses;
    allowPrivateUrls: boolean;
    signal?: AbortSignal;
    maxRedirects: number;
  },
): Promise<{ ok: true; response: Response; url: URL } | { ok: false; error: string }> {
  let current = url;
  for (let i = 0; i <= opts.maxRedirects; i++) {
    const response = await opts.fetchImpl(current, { redirect: "manual", signal: opts.signal });
    if (response.status < 300 || response.status >= 400) {
      return { ok: true, response, url: current };
    }
    const location = response.headers.get("location");
    if (!location) return { ok: true, response, url: current };
    const next = new URL(location, current);
    const checked = await validatePublicHttpUrl(next.href, {
      allowPrivateUrls: opts.allowPrivateUrls,
      resolveAddresses: opts.resolveAddresses,
    });
    if (!checked.ok) return checked;
    current = checked.url;
  }
  return { ok: false, error: `Too many redirects (${opts.maxRedirects}).` };
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80")) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice("::ffff:".length));
  return false;
}

async function readResponseText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return clipText(await response.text(), maxBytes);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - received;
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      await reader.cancel();
      return { text: decodeChunks(chunks), truncated: true };
    }
    chunks.push(value);
    received += value.byteLength;
    if (received >= maxBytes) {
      await reader.cancel();
      return { text: decodeChunks(chunks), truncated: true };
    }
  }
  return { text: decodeChunks(chunks), truncated: false };
}

function clipText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return { text: new TextDecoder().decode(bytes.slice(0, maxBytes)), truncated: true };
}

function decodeChunks(chunks: readonly Uint8Array[]): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function extractHtmlTitle(html: string): string | undefined {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  if (open < 0) return undefined;
  const start = lower.indexOf(">", open);
  if (start < 0) return undefined;
  const end = lower.indexOf("</title>", start + 1);
  if (end < 0) return undefined;
  return decodeHtmlEntities(collapseWhitespace(stripTags(html.slice(start + 1, end)))).trim() || undefined;
}

function htmlToReadableText(html: string): string {
  return decodeHtmlEntities(collapseWhitespace(stripTags(html))).trim();
}

function stripTags(html: string): string {
  let out = "";
  let i = 0;
  let skipTag: string | null = null;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      if (!skipTag) out += html.slice(i);
      break;
    }
    if (!skipTag) out += html.slice(i, lt);
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    const tag = parseTagName(html.slice(lt + 1, gt));
    if (tag) {
      if (!skipTag && (tag.name === "script" || tag.name === "style" || tag.name === "noscript" || tag.name === "svg")) {
        skipTag = tag.name;
      } else if (skipTag && tag.closing && tag.name === skipTag) {
        skipTag = null;
      }
    }
    if (!skipTag && tag && isBlockTag(tag.name)) out += "\n";
    i = gt + 1;
  }
  return out;
}

function parseTagName(rawTag: string): { name: string; closing: boolean } | null {
  let i = 0;
  while (i < rawTag.length && isWhitespace(rawTag.charCodeAt(i))) i++;
  const closing = rawTag[i] === "/";
  if (closing) i++;
  while (i < rawTag.length && isWhitespace(rawTag.charCodeAt(i))) i++;
  const start = i;
  while (i < rawTag.length) {
    const code = rawTag.charCodeAt(i);
    const alpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = code >= 48 && code <= 57;
    if (!alpha && !digit) break;
    i++;
  }
  if (i === start) return null;
  return { name: rawTag.slice(start, i).toLowerCase(), closing };
}

function isBlockTag(name: string): boolean {
  return (
    name === "address" ||
    name === "article" ||
    name === "aside" ||
    name === "blockquote" ||
    name === "br" ||
    name === "div" ||
    name === "footer" ||
    name === "h1" ||
    name === "h2" ||
    name === "h3" ||
    name === "h4" ||
    name === "h5" ||
    name === "h6" ||
    name === "header" ||
    name === "li" ||
    name === "main" ||
    name === "nav" ||
    name === "ol" ||
    name === "p" ||
    name === "pre" ||
    name === "section" ||
    name === "table" ||
    name === "td" ||
    name === "th" ||
    name === "tr" ||
    name === "ul"
  );
}

function collapseWhitespace(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of text) {
    if (isWhitespace(char.charCodeAt(0))) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out) out += " ";
    out += char;
    pendingSpace = false;
  }
  return out;
}

function isWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
}

function decodeHtmlEntities(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const amp = text.indexOf("&", i);
    if (amp < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, amp);
    const semi = text.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 12) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const entity = text.slice(amp + 1, semi);
    out += decodeEntity(entity) ?? `&${entity};`;
    i = semi + 1;
  }
  return out;
}

function decodeEntity(entity: string): string | undefined {
  if (entity === "amp") return "&";
  if (entity === "lt") return "<";
  if (entity === "gt") return ">";
  if (entity === "quot") return '"';
  if (entity === "apos") return "'";
  if (entity === "nbsp") return " ";
  if (entity.startsWith("#x")) {
    const code = Number.parseInt(entity.slice(2), 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : undefined;
  }
  if (entity.startsWith("#")) {
    const code = Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : undefined;
  }
  return undefined;
}
