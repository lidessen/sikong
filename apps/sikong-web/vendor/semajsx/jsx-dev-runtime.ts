/**
 * semajsx/jsx-dev-runtime — JSX dev runtime (alias to jsx-runtime) (vendored)
 *
 * Provides the `jsxDEV` export expected by TypeScript's `"react-jsxdev"` transform.
 * Delegates to the production jsx-runtime — this project has no dev-mode distinction.
 *
 * @module
 */

export { jsx, jsxs, Fragment } from "./jsx-runtime"
export { jsx as jsxDEV } from "./jsx-runtime"
