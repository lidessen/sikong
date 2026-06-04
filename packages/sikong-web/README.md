# sikong-web

Website and local monitor dashboard for sikong (司空, sikong.dev).

Built with [semajsx](https://github.com/user/semajsx) — a JSX-to-HTML renderer
for static site generation and lightweight server-rendered dashboards.

## Structure

- `src/site/build.ts` — static site build script for sikong.dev
- `src/dashboard/server.ts` — local monitor dashboard server
- `dist/` — build output

## Commands

```sh
bun run typecheck     # type-check only
bun run build:site    # build the static site into dist/
bun run dashboard     # start the local dashboard server
```
