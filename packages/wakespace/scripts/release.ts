#!/usr/bin/env bun
// Full release: build every platform package, publish each to npm, then publish the
// `wakespace` launcher last (so its optionalDependencies already resolve). Publishing
// is outward-facing — run this deliberately, with npm auth in place.
//   bun scripts/release.ts            # publish for real
//   bun scripts/release.ts --dry-run  # build + npm publish --dry-run everywhere
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_ROOT = join(PKG_ROOT, "npm");
const dryRun = process.argv.includes("--dry-run");

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}) in ${cwd}`);
}

// 1. Build all platform packages (also validates optionalDependencies sync).
await run(["bun", join("scripts", "build-platforms.ts")], PKG_ROOT);

// 2. Publish each platform package first.
const publish = ["npm", "publish", ...(dryRun ? ["--dry-run"] : [])];
for (const key of (await readdir(OUT_ROOT, { withFileTypes: true })).filter((e) => e.isDirectory())) {
  await run(publish, join(OUT_ROOT, key.name));
}

// 3. Publish the launcher last.
await run(publish, PKG_ROOT);

console.log(dryRun ? "\nDry-run complete." : "\nReleased wakespace + all platform packages.");
