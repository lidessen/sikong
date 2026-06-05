/**
 * semajsx/html — HTML-string target → SSR (edge) + SSG (build.ts) (vendored)
 *
 * Renders a VNode tree to an HTML string. Used for server-side rendering
 * in edge functions and for static site generation in build scripts.
 *
 * @module
 */

import { createRenderer, createCSSCollector } from "./core"
import type { Component, JSXNode, CSSCollector, RenderStrategy } from "./core"
import type { StyleRef } from "./style"

export type { JSXNode, Component, CSSCollector } from "./core"
export { createCSSCollector } from "./core"

// ── HtmlNode — the "TNode" for the HTML RenderStrategy ─────────────────────

interface HtmlNode {
  type: "root" | "element" | "text" | "fragment"
  tag?: string
  text?: string
  props: Record<string, unknown>
  children: HtmlNode[]
}

// ── HTML RenderStrategy ─────────────────────────────────────────────────────

function createHtmlStrategy(): RenderStrategy<HtmlNode> & { portalRoots: HtmlNode[] } {
  const portalRoots: HtmlNode[] = []

  const strategy: RenderStrategy<HtmlNode> = {
    createTextNode(text: string): HtmlNode {
      return { type: "text", text, props: {}, children: [] }
    },

    createElement(tag: string): HtmlNode {
      return { type: "element", tag, props: {}, children: [] }
    },

    createFragment(): HtmlNode {
      return { type: "fragment", props: {}, children: [] }
    },

    insertBefore(parent: HtmlNode, child: HtmlNode, reference: HtmlNode | null): void {
      if (reference) {
        const idx = parent.children.indexOf(reference)
        if (idx >= 0) {
          parent.children.splice(idx, 0, child)
        } else {
          parent.children.push(child)
        }
      } else {
        parent.children.push(child)
      }
    },

    removeChild(parent: HtmlNode, child: HtmlNode): void {
      const idx = parent.children.indexOf(child)
      if (idx >= 0) {
        parent.children.splice(idx, 1)
      }
    },

    replaceChild(parent: HtmlNode, newChild: HtmlNode, oldChild: HtmlNode): void {
      const idx = parent.children.indexOf(oldChild)
      if (idx >= 0) {
        parent.children[idx] = newChild
      }
    },

    setProperty(node: HtmlNode, key: string, value: unknown): void {
      if (node.type === "element") {
        node.props[key] = value
      }
    },

    getPortalTarget(_target: unknown): HtmlNode {
      const node: HtmlNode = { type: "fragment", props: {}, children: [] }
      portalRoots.push(node)
      return node
    },
  }

  return Object.assign(strategy, { portalRoots })
}

// ── HTML Serialization ──────────────────────────────────────────────────────

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
])

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function camelToDash(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

function serializeStyle(style: Record<string, string | number>): string {
  return Object.entries(style)
    .map(([key, value]) => `${camelToDash(key)}:${value}`)
    .join(";")
}

function resolveClassName(value: unknown): string {
  if (value == null || value === false || value === true) return ""
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  if (isStyleRef(value)) return value.className
  if (Array.isArray(value)) return value.map(resolveClassName).filter(Boolean).join(" ")
  return String(value)
}

function isStyleRef(value: unknown): value is StyleRef {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).className === "string" &&
    "css" in (value as Record<string, unknown>)
  )
}

function serializeAttributes(props: Record<string, unknown>): string {
  const parts: string[] = []

  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key" || key === "ref") continue
    if (key.startsWith("_")) continue
    if (typeof value === "function") continue
    if (value === null || value === undefined) continue

    if (typeof value === "boolean") {
      if (value) parts.push(` ${key}`)
      continue
    }

    if (key === "class" || key === "className") {
      const resolved = resolveClassName(value)
      if (resolved) {
        parts.push(` class="${escapeAttr(resolved)}"`)
      }
      continue
    }

    if (key === "style" && typeof value === "object" && !Array.isArray(value)) {
      parts.push(` style="${escapeAttr(serializeStyle(value as Record<string, string | number>))}"`)
      continue
    }

    parts.push(` ${key}="${escapeAttr(String(value))}"`)
  }

  return parts.join("")
}

function serializeNode(node: HtmlNode): string {
  switch (node.type) {
    case "root":
    case "fragment":
      return node.children.map(serializeNode).join("")
    case "text":
      return escapeHtml(node.text ?? "")
    case "element": {
      const tag = node.tag ?? ""
      const attrs = serializeAttributes(node.props)
      if (VOID_ELEMENTS.has(tag)) {
        return `<${tag}${attrs}>`
      }
      const inner = node.children.map(serializeNode).join("")
      return `<${tag}${attrs}>${inner}</${tag}>`
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Render a VNode tree to an HTML string.
 */
export function renderToString(vnode: JSXNode): string {
  const strategy = createHtmlStrategy()
  const renderer = createRenderer(strategy)
  const root: HtmlNode = { type: "root", props: {}, children: [] }

  const dispose = renderer.mount(vnode, root)

  const mainHtml = serializeNode(root)
  const portalHtml = strategy.portalRoots.map(serializeNode).join("")

  dispose()

  return mainHtml + portalHtml
}

/**
 * Render a VNode tree to HTML with separate CSS extraction.
 */
export function renderToStringWithCSS(
  vnode: JSXNode,
): { html: string; css: string } {
  const cssCollector = createCSSCollector()
  const strategy = createHtmlStrategy()
  const renderer = createRenderer(strategy, { cssCollector })
  const root: HtmlNode = { type: "root", props: {}, children: [] }

  const dispose = renderer.mount(vnode, root)

  const mainHtml = serializeNode(root)
  const portalHtml = strategy.portalRoots.map(serializeNode).join("")

  dispose()

  return {
    html: mainHtml + portalHtml,
    css: cssCollector.css,
  }
}
