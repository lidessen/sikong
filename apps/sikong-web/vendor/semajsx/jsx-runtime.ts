/**
 * semajsx/jsx-runtime — JSX runtime for the automatic transform (vendored)
 *
 * This module satisfies TypeScript/Bun's `"jsx": "react-jsx"` transform,
 * which imports `jsx`, `jsxs`, and `Fragment` from `[jsxImportSource]/jsx-runtime`.
 *
 * With `"jsxImportSource": "semajsx"` in tsconfig.json, the transpiler
 * auto-imports from this module — no manual `import { jsx }` needed in .tsx files.
 *
 * @module
 */

import { jsx as _jsx, Fragment } from "./core"
import type { Component, JSXNode } from "./core"

/**
 * JSX factory for the automatic transform (single child or zero children).
 */
export function jsx(
  tag: unknown,
  props: Record<string, unknown> | null,
  _key?: string | null,
): JSXNode {
  const normalized = props ?? {}

  if ("children" in normalized) {
    const children = normalized.children
    const { children: _, ...rest } = normalized
    const kids = Array.isArray(children) ? children : [children]
    return _jsx(tag as string | Component, rest, ...kids)
  }

  return _jsx(tag as string | Component, normalized)
}

/**
 * JSX factory for the automatic transform (multiple children).
 */
export function jsxs(
  tag: unknown,
  props: Record<string, unknown> | null,
  _key?: string | null,
): JSXNode {
  return jsx(tag, props, _key)
}

/** Dev-mode JSX factory. Same implementation as production. */
export const jsxDEV = jsx

export { Fragment }
