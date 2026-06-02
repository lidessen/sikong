#!/usr/bin/env bun
// Full release: build every platform package, publish each to npm, then publish the
// `sikong` launcher last (so its optionalDependencies already resolve). Publishing
// is outward-facing — run this deliberately, with npm auth in place.
//   NPM_TOKEN=... bun scripts/release.ts  # publish for real
//   bun scripts/release.ts --dry-run      # build + npm publish --dry-run everywhere
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_ROOT = join(PKG_ROOT, "npm");
const dryRun = process.argv.includes("--dry-run");

type RunEnv = Record<string, string>;

async function withNpmTokenUserconfig(): Promise<{ env: RunEnv; cleanup: () => Promise<void> }> {
  const token = process.env.NPM_TOKEN;
  const existing = process.env.NPM_CONFIG_USERCONFIG ?? process.env.npm_config_userconfig;
  if (!token || existing) return { env: {}, cleanup: async () => {} };

  const dir = await mkdtemp(join(tmpdir(), "sikong-npm-"));
  const userconfig = join(dir, "npmrc");
  await writeFile(userconfig, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
  return {
    env: { NPM_CONFIG_USERCONFIG: userconfig },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function run(cmd: string[], cwd: string, env: RunEnv = {}) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}) in ${cwd}`);
}

const npmAuth = await withNpmTokenUserconfig();

try {
  if (!dryRun) await run(["npm", "whoami"], PKG_ROOT, npmAuth.env);

  // 1. Build all platform packages (also validates optionalDependencies sync).
  await run(["bun", join("scripts", "build-platforms.ts")], PKG_ROOT);

  // 2. Publish each platform package first.
  const publish = ["npm", "publish", ...(dryRun ? ["--dry-run"] : [])];
  for (const key of (await readdir(OUT_ROOT, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    await run(publish, join(OUT_ROOT, key.name), npmAuth.env);
  }

  // 3. Publish the launcher last.
  await run(publish, PKG_ROOT, npmAuth.env);

  console.log(dryRun ? "\nDry-run complete." : "\nReleased sikong + all platform packages.");
} finally {
  await npmAuth.cleanup();
}
