import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const marker = "/* sikong-standalone-chunks */";
const command = Bun.argv[2] ?? "apply";
const indexPath = resolveCursorSdkIndex();
const esmDir = dirname(indexPath);
const backupPath = `${indexPath}.sikong-backup`;

if (command === "restore") {
  if (existsSync(backupPath)) copyFileSync(backupPath, indexPath);
  process.exit(0);
}

if (command !== "apply") {
  console.error("usage: bun scripts/patch-cursor-sdk-standalone.ts [apply|restore]");
  process.exit(2);
}

const source = readFileSync(indexPath, "utf8");
if (source.includes(marker)) process.exit(0);

copyFileSync(indexPath, backupPath);

const chunkIds = ["429", "642", "745"].filter((id) => existsSync(join(esmDir, `${id}.index.js`)));
const imports = chunkIds
  .map((id) => `import * as __sikong_chunk_${id} from "./${id}.index.js";`)
  .join("");
const mapEntries = chunkIds.map((id) => `${id}:__sikong_chunk_${id}`).join(",");
const prelude = `${marker}${imports}const __sikongWebpackChunks={${mapEntries}};`;

const dynamicLoader = `var r=import("./"+__webpack_require__.u(e)).then(installChunk,`;
const staticLoader = `var r=Promise.resolve(__sikongWebpackChunks[e]).then(installChunk,`;

if (!source.includes(dynamicLoader)) {
  throw new Error("Could not find Cursor SDK dynamic chunk loader");
}

const patched = source.replace("\n", `\n${prelude}`).replace(dynamicLoader, staticLoader);
writeFileSync(indexPath, patched);

function resolveCursorSdkIndex(): string {
  const workspaceIndex = join(
    process.cwd(),
    "packages",
    "agent-loop",
    "node_modules",
    "@cursor",
    "sdk",
    "dist",
    "esm",
    "index.js",
  );
  if (existsSync(workspaceIndex)) return workspaceIndex;

  const rootIndex = join(
    process.cwd(),
    "node_modules",
    "@cursor",
    "sdk",
    "dist",
    "esm",
    "index.js",
  );
  if (existsSync(rootIndex)) return rootIndex;

  throw new Error("Could not locate @cursor/sdk dist/esm/index.js");
}
