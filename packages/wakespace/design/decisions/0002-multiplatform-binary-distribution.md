# 0002 — Multi-platform binary distribution via optional dependencies

Status: **Accepted**
Date: 2026-06-01

## Context

`wakespace` ships as a Bun single-file executable (`bun build --compile`). The
first cut published one package locked to `os: [darwin]`, `cpu: [arm64]`, with the
~64MB binary inlined and a Node shim execing it. Consequence: `npm install
wakespace` fails with `EBADPLATFORM` on every other platform — effectively
macOS-arm64-only.

Bun can cross-compile all of `darwin-{arm64,x64}`, `linux-{x64,arm64}[-musl]`, and
`windows-x64` from one host (verified). But each binary is 64–115MB, so inlining
every target into one package (~650MB) is abusive and forces every user to
download six binaries they can't run.

## Decision

Adopt the esbuild/turbo/swc distribution shape:

1. **One package per platform** — `wakespace-<key>` (`darwin-arm64`, `darwin-x64`,
   `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`,
   `windows-x64`). Each carries exactly one binary and declares `os`/`cpu` (+
   `libc` for the linux glibc/musl split) so npm installs only the matching one.
2. **`wakespace` is a thin cross-platform launcher** — no `os`/`cpu` lock, no
   binary. `bin/wakespace` is a Node ESM shim that resolves
   `wakespace-<key>/bin/<exe>` (via `import.meta.resolve`, with filesystem-sibling
   fallback for older Node and a `dist/` fallback for local dev) and execs it.
3. **Platform packages are optional dependencies** of `wakespace`, pinned to the
   exact version. Optionality means a host with no matching package still installs
   the launcher; the launcher then emits a clear "unsupported platform" error.
4. **The build matrix is the single source of truth.** `scripts/build-platforms.ts`
   cross-compiles every target into `npm/<key>/`, stamps each generated
   `package.json` with the launcher's version, and fails the build if
   `wakespace`'s `optionalDependencies` drift from the matrix.
5. **Release order is platforms-first.** `scripts/release.ts` builds, publishes
   every `wakespace-<key>`, then publishes the launcher last so its optional
   dependencies already resolve on the registry.

## Consequences

- `npm install wakespace` works on all seven targets, downloading only the host's
  binary (~40MB tarball) instead of a fat single package.
- The launcher tarball is tiny (~3KB) and platform-agnostic.
- Releasing now publishes 8 packages and requires the version to be bumped in two
  places in `package.json` (the package `version` and each `optionalDependencies`
  entry); the build script's sync check guards against forgetting.
- The linux glibc/musl distinction relies on npm honoring the `libc` field; the
  launcher additionally disambiguates at runtime (glibc detection via the process
  report), so a host that installs both still execs the correct one.
- `npm/` is a generated artifact (gitignored); a clean checkout must run
  `build:platforms` before publishing.

## Implementation Notes

- `bin/wakespace` — launcher with `platformKey()` + `detectLibc()`.
- `scripts/build-platforms.ts` — matrix, cross-compile, generate platform packages,
  optionalDependencies sync check.
- `scripts/release.ts` — build → publish platforms → publish launcher (`--dry-run`
  supported).
- `package.json` — dropped `os`/`cpu`; `files` no longer includes a binary; added
  `optionalDependencies` and `build:platforms`/`release`/`release:dry` scripts.

## Open Questions

- No CI cross-build/publish pipeline yet; releases are run locally. A
  tag-triggered GitHub Action could run `release` once secrets are set.
- `linux-arm64*` and `windows-x64` binaries are cross-compiled but not yet
  smoke-tested on their native hosts.
