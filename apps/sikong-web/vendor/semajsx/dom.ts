/**
 * semajsx/dom — Browser DOM render strategy + hydrate entry point (vendored)
 *
 * Implements `RenderStrategy<HTMLElement | Text>` via real DOM APIs so VNode
 * trees render into live browser DOM.  Signal subscriptions cause in-place
 * DOM patches — no virtual DOM diffing, no full re-render.
 *
 * Exports `hydrate(vnode, rootEl)` — mounts a VNode tree into an existing
 * DOM element, returning a dispose function.  Used by the sikong-web
 * dashboard client to hydrate the SSR first paint into a live reactive app.
 *
 * @module
 */

import { createRenderer } from "./core"
import type { JSXNode, RenderStrategy } from "./core"
import type { Signal } from "./signal"

// ── DOM RenderStrategy ────────────────────────────────────────────────────────

/** Node union produced by the DOM strategy: real Elements + Text nodes. */
type DOMNode = HTMLElement | Text | DocumentFragment

function createDOMStrategy(): RenderStrategy<DOMNode> {
  return {
    createTextNode(text: string): Text {
      return document.createTextNode(text)
    },

    createElement(tag: string): HTMLElement {
      return document.createElement(tag)
    },

    createFragment(): DocumentFragment {
      return document.createDocumentFragment()
    },

    insertBefore(
      parent: DOMNode,
      child: DOMNode,
      reference: DOMNode | null,
    ): void {
      parent.insertBefore(child, reference)
    },

    removeChild(parent: DOMNode, child: DOMNode): void {
      parent.removeChild(child)
    },

    replaceChild(
      parent: DOMNode,
      newChild: DOMNode,
      oldChild: DOMNode,
    ): void {
      parent.replaceChild(newChild, oldChild)
    },

    setProperty(node: DOMNode, key: string, value: unknown): void {
      const el = node as HTMLElement

      // event handlers — on* props → addEventListener
      if (key.startsWith("on")) {
        const event = key.slice(2).toLowerCase()
        // track current handler on the element for cleanup
        const store = (el as unknown as Record<string, unknown>).__sjs_handlers as
          | Record<string, EventListener>
          | undefined
        const handlers: Record<string, EventListener> =
          store ?? {}
        const prev = handlers[event]
        if (prev) el.removeEventListener(event, prev)
        if (typeof value === "function") {
          const listener = value as EventListener
          handlers[event] = listener
          el.addEventListener(event, listener)
        } else {
          delete handlers[event]
        }
        ;(el as unknown as Record<string, unknown>).__sjs_handlers = handlers
        return
      }

      // className / class — resolve StyleRef[], StyleRef, string, number
      if (key === "class" || key === "className") {
        el.className = resolveClassNames(value)
        return
      }

      // style — object → set individual properties; string → cssText
      if (key === "style") {
        if (typeof value === "string") {
          el.style.cssText = value
        } else if (value && typeof value === "object" && !Array.isArray(value)) {
          // reset inline styles then apply
          el.removeAttribute("style")
          for (const [prop, val] of Object.entries(
            value as Record<string, string | number>,
          )) {
            ;(el.style as unknown as Record<string, string>)[prop] = String(val)
          }
        }
        return
      }

      // boolean attributes (e.g. disabled, checked, hidden)
      if (typeof value === "boolean") {
        if (value) {
          el.setAttribute(key, "")
        } else {
          el.removeAttribute(key)
        }
        // also set the DOM property for form elements
        if (key in el) {
          ;(el as unknown as Record<string, unknown>)[key] = value
        }
        return
      }

      // null/undefined → remove
      if (value === null || value === undefined) {
        el.removeAttribute(key)
        return
      }

      // default: set as attribute
      el.setAttribute(key, String(value))
    },

    getPortalTarget(target: unknown): DOMNode {
      if (typeof target === "string") {
        const el = document.querySelector(target)
        if (!el) throw new Error(`Portal target not found: ${target}`)
        return el as HTMLElement
      }
      return target as HTMLElement
    },
  }
}

// ── className resolution ─────────────────────────────────────────────────────

function isStyleRef(
  value: unknown,
): value is {
  className: string
  css: string | null
  styleObject: Record<string, string | number>
} {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).className === "string" &&
    "css" in (value as Record<string, unknown>)
  )
}

function resolveClassNames(value: unknown): string {
  if (value == null || typeof value === "boolean") return ""
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  if (isStyleRef(value)) return value.className
  if (Array.isArray(value))
    return value.map(resolveClassNames).filter(Boolean).join(" ")
  return String(value)
}

// ── hydrate ──────────────────────────────────────────────────────────────────

/**
 * Mount a VNode tree into a live DOM element.
 *
 * Clears existing content, then mounts the reactive tree — signal
 * subscriptions cause in-place DOM patches as values change.
 *
 * Returns a dispose function that unmounts the tree and cleans up all
 * subscriptions.
 */
export function hydrate(vnode: JSXNode, rootEl: HTMLElement): () => void {
  const strategy = createDOMStrategy()
  const renderer = createRenderer(strategy)
  rootEl.innerHTML = ""
  return renderer.mount(vnode, rootEl)
}
