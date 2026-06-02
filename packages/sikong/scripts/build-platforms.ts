#!/usr/bin/env bun
// Cross-compiles the sikong CLI for every supported platform and emits one
// publishable npm package per platform under `npm/<key>/`. Each package carries a
// single prebuilt binary gated by os/cpu/libc, so `npm install sikong` pulls in
// exactly the one that matches the host. The matrix here is the single source of
// truth; `main` package.json's optionalDependencies must mirror it (validated below).
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_ROOT = join(PKG_ROOT, "npm");

type Target = {
  key: string; // npm package suffix + launcher platformKey()
  bunTarget: string; // bun --target
  os: string;
  cpu: string;
  libc: "glibc" | "musl" | null;
  exe: string;
};

const MATRIX: Target[] = [
  { key: "darwin-arm64", bunTarget: "bun-darwin-arm64", os: "darwin", cpu: "arm64", libc: null, exe: "sikong" },
  { key: "darwin-x64", bunTarget: "bun-darwin-x64", os: "darwin", cpu: "x64", libc: null, exe: "sikong" },
  { key: "linux-x64", bunTarget: "bun-linux-x64", os: "linux", cpu: "x64", libc: "glibc", exe: "sikong" },
  { key: "linux-arm64", bunTarget: "bun-linux-arm64", os: "linux", cpu: "arm64", libc: "glibc", exe: "sikong" },
  { key: "linux-x64-musl", bunTarget: "bun-linux-x64-musl", os: "linux", cpu: "x64", libc: "musl", exe: "sikong" },
  { key: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl", os: "linux", cpu: "arm64", libc: "musl", exe: "sikong" },
  { key: "windows-x64", bunTarget: "bun-windows-x64", os: "win32", cpu: "x64", libc: null, exe: "sikong.exe" },
];

const main = (await import(join(PKG_ROOT, "package.json"), { with: { type: "json" } })).default;
const VERSION: string = main.version;

// Keep main's optionalDependencies honest: one entry per target, all at this version.
const expected = Object.fromEntries(MATRIX.map((t) => [`sikong-${t.key}`, VERSION]));
const actual = main.optionalDependencies ?? {};
const mismatch = JSON.stringify(expected) !== JSON.stringify(actual);
if (mismatch) {
  console.error("optionalDependencies in package.json are out of sync with the platform matrix.");
  console.error("expected:", JSON.stringify(expected, null, 2));
  console.error("actual:  ", JSON.stringify(actual, null, 2));
  process.exit(1);
}

await rm(OUT_ROOT, { recursive: true, force: true });

for (const t of MATRIX) {
  const dir = join(OUT_ROOT, t.key);
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });

  const outfile = join(binDir, t.exe);
  const proc = Bun.spawn(
    ["bun", "build", "src/cli.ts", "--compile", `--target=${t.bunTarget}`, "--outfile", outfile],
    { cwd: PKG_ROOT, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`build failed for ${t.key} (exit ${code})`);
    process.exit(1);
  }

  const pkg: Record<string, unknown> = {
    name: `sikong-${t.key}`,
    version: VERSION,
    description: `sikong prebuilt CLI binary for ${t.os}/${t.cpu}${t.libc ? ` (${t.libc})` : ""}.`,
    license: main.license,
    repository: main.repository,
    os: [t.os],
    cpu: [t.cpu],
    ...(t.libc ? { libc: [t.libc] } : {}),
    files: [`bin/${t.exe}`],
    engines: main.engines,
  };
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  console.log(`packed sikong-${t.key}@${VERSION}`);
}

console.log(`\nBuilt ${MATRIX.length} platform packages under ${OUT_ROOT}`);
