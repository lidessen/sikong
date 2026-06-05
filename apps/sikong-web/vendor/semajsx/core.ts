/**
 * semajsx/core — VNode, components, context, RenderStrategy seam (vendored)
 *
 * The shared tree-walk engine. Defines the VNode / JSX model, component
 * abstraction, context threading, and the RenderStrategy generic interface.
 *
 * @module
 */

import type { Signal } from "./signal"
export type { Signal }

// ── VNode types ────────────────────────────────────────────────────────

/** A function that renders to VNodes */
export type Component<P extends Record<string, unknown> = Record<string, unknown>> = (
  props: P,
) => JSXNode

/** A VNode tree — element, component, fragment, portal, text, or signal */
export type JSXNode =
  | VElement
  | VComponent
  | VFragment
  | VPortal
  | VText
  | VSignal
  | null
  | undefined
  | boolean

export interface VElement {
  type: "element"
  tag: string
  props: Record<string, unknown>
  children: JSXNode[]
}

export interface VComponent {
  type: "component"
  component: Component
  props: Record<string, unknown>
}

export interface VFragment {
  type: "fragment"
  children: JSXNode[]
}

export interface VPortal {
  type: "portal"
  target: unknown
  children: JSXNode[]
}

export interface VText {
  type: "text"
  value: string | number
}

export interface VSignal {
  type: "signal"
  signal: Signal<JSXNode>
}

// ── JSX Factory ─────────────────────────────────────────────────────────

/**
 * JSX factory — the `h` / `createElement` function.
 */
export function jsx(
  tag: string | Component,
  props: Record<string, unknown> | null,
  ...children: (JSXNode | string | number)[]
): JSXNode {
  const normalizedProps = props ?? {}
  const flatChildren = children.length > 0 ? flatten(children) : []

  if (typeof tag === "function") {
    const childrenProp =
      flatChildren.length > 0
        ? flatChildren
        : "children" in normalizedProps
          ? normalizedProps.children
          : undefined
    return {
      type: "component",
      component: tag as Component,
      props: {
        ...normalizedProps,
        children: childrenProp,
      },
    }
  }

  return {
    type: "element",
    tag,
    props: normalizedProps,
    children: flatChildren,
  }
}

/** Fragment support */
export function Fragment(props: {
  children?: JSXNode | JSXNode[] | string | number
}): VFragment {
  return {
    type: "fragment",
    children: props.children
      ? Array.isArray(props.children)
        ? flatten(props.children)
        : flatten([props.children])
      : [],
  }
}

/** Flatten nested arrays, converting strings/numbers to VText nodes and signals to VSignal */
function flatten(nodes: (JSXNode | string | number)[]): JSXNode[] {
  const result: JSXNode[] = []
  for (const node of nodes) {
    if (Array.isArray(node)) {
      result.push(...flatten(node))
    } else if (typeof node === "string" || typeof node === "number") {
      result.push({ type: "text", value: node })
    } else if (isSignal(node)) {
      result.push({ type: "signal", signal: node as unknown as Signal<JSXNode> })
    } else {
      result.push(node)
    }
  }
  return result
}

// ── Context ─────────────────────────────────────────────────────────────

export interface ContextFrame extends Map<symbol, unknown> {}

let activeContextStack: ContextFrame[] | null = null

export interface Context<T> {
  id: symbol
  Provider: (props: { value: T | Signal<T>; children: JSXNode }) => VComponent
  use: () => T
}

/**
 * Create a context value.
 */
export function createContext<T>(defaultValue: T): Context<T> {
  const id = Symbol("context")
  return {
    id,
    Provider: (props: { value: T | Signal<T>; children: JSXNode }) =>
      ({
        type: "component",
        component: () => {
          const kids = props.children
          const arr = Array.isArray(kids) ? kids : [kids]
          const flat = flatten(arr)
          if (flat.length === 0) return null
          if (flat.length === 1) return flat[0]
          return { type: "fragment", children: flat }
        },
        props: {
          _contextId: id,
          _contextValue: props.value,
        },
      }) as VComponent,
    use: () => {
      if (!activeContextStack) return defaultValue
      for (let i = activeContextStack.length - 1; i >= 0; i--) {
        const val = activeContextStack[i]!.get(id)
        if (val !== undefined) return val as T
      }
      return defaultValue
    },
  }
}

// ── Signal detection ────────────────────────────────────────────────────

/** Runtime check: is a value a Signal? */
export function isSignal(value: unknown): value is Signal<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "subscribe" in value &&
    typeof (value as Record<string, unknown>).subscribe === "function" &&
    "value" in value
  )
}

// ── RenderStrategy seam ─────────────────────────────────────────────────

export interface RenderStrategy<TNode> {
  createTextNode(text: string): TNode
  createElement(tag: string): TNode
  createFragment(): TNode
  insertBefore(parent: TNode, child: TNode, reference: TNode | null): void
  removeChild(parent: TNode, child: TNode): void
  replaceChild(parent: TNode, newChild: TNode, oldChild: TNode): void
  setProperty(node: TNode, key: string, value: unknown): void
  getPortalTarget(target: unknown): TNode
}

export interface StyleRefInfo {
  className: string
  css: string | null
  styleObject: Record<string, string | number>
}

export interface CSSCollector {
  add: (ref: StyleRefInfo) => void
  refs: StyleRefInfo[]
  css: string
}

/**
 * Create a CSSCollector instance for collecting StyleRef CSS during SSR/SSG.
 */
export function createCSSCollector(): CSSCollector {
  const seen = new Set<string>()
  const refs: StyleRefInfo[] = []
  return {
    add(ref: StyleRefInfo) {
      if (ref.css && !seen.has(ref.className)) {
        seen.add(ref.className)
        refs.push(ref)
      }
    },
    get refs() {
      return refs
    },
    get css() {
      return refs
        .map((r) => `<style data-semajsx="${r.className}">${r.css}</style>`)
        .join("\n")
    },
  }
}

export interface RendererOptions {
  onError?: (err: unknown) => void
  cssCollector?: CSSCollector
}

// ── createRenderer — core tree-walk ─────────────────────────────────────

/**
 * Create a renderer from a strategy. The renderer owns tree-walk,
 * lifecycle, context, fragments, and async operations.
 */
export function createRenderer<TNode>(
  strategy: RenderStrategy<TNode>,
  options?: RendererOptions,
) {
  const onError = options?.onError ?? ((_err: unknown) => {})
  const cssCollector = options?.cssCollector

  function collectClassRefs(value: unknown): void {
    if (!cssCollector) return
    if (value == null || typeof value === "boolean") return
    if (Array.isArray(value)) {
      for (const item of value) collectClassRefs(item)
      return
    }
    if (isStyleRefInfo(value)) {
      cssCollector.add(value)
    }
  }

  function isStyleRefInfo(value: unknown): value is StyleRefInfo {
    return (
      value !== null &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).className === "string" &&
      "css" in (value as Record<string, unknown>)
    )
  }

  function mount(vnode: JSXNode, parent: TNode): () => void {
    const saved = activeContextStack
    activeContextStack = []
    try {
      const dispose = mountNode(vnode, parent, null)
      return () => {
        if (dispose) dispose()
      }
    } finally {
      activeContextStack = saved
    }
  }

  function mountNode(
    vnode: JSXNode,
    parent: TNode,
    reference: TNode | null,
  ): (() => void) | null {
    if (vnode == null || typeof vnode === "boolean") return null

    switch (vnode.type) {
      case "text": {
        const node = strategy.createTextNode(String(vnode.value))
        strategy.insertBefore(parent, node, reference)
        return () => strategy.removeChild(parent, node)
      }

      case "element": {
        const el = strategy.createElement(vnode.tag)
        strategy.insertBefore(parent, el, reference)

        const childDisposes: (() => void)[] = []
        for (const child of vnode.children) {
          const d = mountNode(child, el, null)
          if (d) childDisposes.push(d)
        }

        const propDisposes: (() => void)[] = []
        for (const [key, value] of Object.entries(vnode.props)) {
          if (key === "children" || key === "key" || key === "ref") continue

          if ((key === "class" || key === "className") && cssCollector) {
            collectClassRefs(value)
          }

          if (isSignal(value)) {
            strategy.setProperty(el, key, value.value)
            const unsub = value.subscribe((nv) => {
              strategy.setProperty(el, key, nv)
            })
            propDisposes.push(unsub)
          } else {
            strategy.setProperty(el, key, value)
          }
        }

        if (vnode.props.ref) {
          const ref = vnode.props.ref
          if (typeof ref === "function") {
            ref(el)
            propDisposes.push(() => ref(null))
          } else if (ref !== null && typeof ref === "object" && "current" in ref) {
            ;(ref as { current: TNode | null }).current = el
            propDisposes.push(() => {
              ;(ref as { current: TNode | null }).current = null
            })
          }
        }

        return () => {
          for (const d of propDisposes) d()
          for (let i = childDisposes.length - 1; i >= 0; i--) childDisposes[i]!()
          strategy.removeChild(parent, el)
        }
      }

      case "component": {
        const contextId = vnode.props?._contextId as symbol | undefined
        const rawContextValue = vnode.props?._contextValue

        if (contextId !== undefined && activeContextStack) {
          const frame = new Map() as ContextFrame
          frame.set(contextId, isSignal(rawContextValue) ? rawContextValue.value : rawContextValue)
          activeContextStack.push(frame)
        }

        let childDispose: (() => void) | null = null

        try {
          const childVNode = vnode.component(vnode.props)
          childDispose = mountNode(childVNode, parent, reference)
        } catch (err) {
          onError(err)
        }

        if (contextId !== undefined && activeContextStack) {
          activeContextStack.pop()
        }

        let contextUnsub: (() => void) | undefined
        if (contextId !== undefined && isSignal(rawContextValue) && activeContextStack) {
          const capturedStack = activeContextStack
          contextUnsub = (rawContextValue as Signal<unknown>).subscribe(() => {
            const prevStack = activeContextStack
            activeContextStack = capturedStack

            if (childDispose) childDispose()

            const frame = new Map() as ContextFrame
            frame.set(contextId, (rawContextValue as Signal<unknown>).value)
            capturedStack.push(frame)

            try {
              const childVNode = vnode.component(vnode.props)
              childDispose = mountNode(childVNode, parent, reference)
            } catch (err) {
              onError(err)
            }

            capturedStack.pop()
            activeContextStack = prevStack
          })
        }

        return () => {
          if (contextUnsub) contextUnsub()
          if (childDispose) childDispose()
        }
      }

      case "fragment": {
        const childDisposes: (() => void)[] = []
        for (const child of vnode.children) {
          const d = mountNode(child, parent, reference)
          if (d) childDisposes.push(d)
        }
        return () => {
          for (let i = childDisposes.length - 1; i >= 0; i--) childDisposes[i]!()
        }
      }

      case "portal": {
        const target = strategy.getPortalTarget(vnode.target)
        const childDisposes: (() => void)[] = []
        for (const child of vnode.children) {
          const d = mountNode(child, target, null)
          if (d) childDisposes.push(d)
        }
        return () => {
          for (let i = childDisposes.length - 1; i >= 0; i--) childDisposes[i]!()
        }
      }

      case "signal": {
        const marker = strategy.createFragment()
        strategy.insertBefore(parent, marker, reference)

        let currentDispose: (() => void) | null = null
        const capturedStack = activeContextStack ?? []

        const update = (newValue: JSXNode) => {
          const prevStack = activeContextStack
          activeContextStack = capturedStack
          if (currentDispose) currentDispose()
          currentDispose = mountNode(newValue, parent, marker)
          activeContextStack = prevStack
        }

        update(vnode.signal.value)
        const unsub = vnode.signal.subscribe(update)

        return () => {
          unsub()
          if (currentDispose) currentDispose()
          strategy.removeChild(parent, marker)
        }
      }

      default:
        return null
    }
  }

  return { mount }
}

// ── Async helpers ───────────────────────────────────────────────────────

export { when, resource, stream } from "./signal"
