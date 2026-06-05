/**
 * semajsx/style — JS-native styling + utility styling API (vendored)
 *
 * Returns stable class names and injects CSS rules (web). The same
 * definitions produce style objects for non-CSS targets.
 *
 * @module
 */

// ── Types ───────────────────────────────────────────────────────────────

export interface StyleRef {
  className: string
  css: string | null
  styleObject: Record<string, string | number>
}

export interface StyleOptions {
  className?: string
}

// ── Counter for generated class names ───────────────────────────────────

let counter = 0

function camelToDash(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

// ══════════════════════════════════════════════════════════════════════════
// css() / style()
// ══════════════════════════════════════════════════════════════════════════

export function css(rules: Record<string, string | number>, options?: StyleOptions): StyleRef
export function css(strings: TemplateStringsArray, ...values: unknown[]): StyleRef
export function css(
  first: Record<string, string | number> | TemplateStringsArray,
  ...rest: unknown[]
): StyleRef {
  if (Array.isArray(first) && "raw" in first) {
    const className = `sjs-${counter++}`
    const raw = String.raw(first as TemplateStringsArray, ...rest).trim()
    return { className, css: raw ? `.${className}{${raw}}` : null, styleObject: {} }
  }
  const rules = first as Record<string, string | number>
  const options = rest[0] as StyleOptions | undefined
  const className = options?.className ?? `sjs-${counter++}`
  const entries = Object.entries(rules)
    .map(([key, val]) => `${camelToDash(key)}:${val}`)
    .join(";")
  return {
    className,
    css: entries ? `.${className}{${entries}}` : null,
    styleObject: rules,
  }
}

export function style(obj: Record<string, string | number | boolean>): StyleRef {
  const className = `sjs-${counter++}`
  return { className, css: null, styleObject: obj as Record<string, string | number> }
}

// ══════════════════════════════════════════════════════════════════════════
// Internal helpers for utility functions
// ══════════════════════════════════════════════════════════════════════════

let utCounter = 0
function nextUtId(): string {
  return `sjs-ut-${utCounter++}`
}

function makeRef(className: string, rules: Record<string, string | number>): StyleRef {
  const entries = Object.entries(rules)
    .map(([key, val]) => `${camelToDash(key)}:${val}`)
    .join(";")
  return { className, css: entries ? `.${className}{${entries}}` : null, styleObject: rules }
}

const registry = new Map<string, StyleRef>()
function reg(name: string, ref: StyleRef): StyleRef {
  registry.set(name, ref)
  return ref
}

// ── Type exports ─────────────────────────────────────────────────────────

export type SpacingToken =
  | 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 3.5 | 4
  | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 14
  | 16 | 20 | 24 | 28 | 32 | 36 | 40 | 44 | 48
  | 52 | 56 | 60 | 64 | 72 | 80 | 96

export type RadiusToken = "none" | "sm" | "md" | "lg" | "xl" | "2xl" | "full"

export type TextStyleToken = "xs" | "sm" | "base" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl" | "6xl"

export type FontWeightToken = "thin" | "light" | "normal" | "medium" | "semibold" | "bold" | "extrabold"

export type ShadowToken = "sm" | "md" | "lg" | "xl" | "2xl" | "inner" | "none"

export type SizingToken =
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16 | 20 | 24 | 28
  | 32 | 36 | 40 | 44 | 48 | 56 | 64 | 72 | 80 | 96
  | "full" | "screen" | "auto" | "min" | "max" | "fit"

// ── Resolution helpers ────────────────────────────────────────────────────

const SPACING_SCALE = new Set([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96])

function spacingToPx(value: number): string {
  if (SPACING_SCALE.has(value)) return `${value * 4}px`
  return `${value}px`
}

function radiusTokenToPx(value: RadiusToken | number): string {
  const radii: Record<string, string> = {
    none: "0", sm: "2px", md: "6px", lg: "8px", xl: "12px", "2xl": "16px", full: "9999px",
  }
  if (typeof value === "string") return radii[value] ?? value
  return `${value}px`
}

function sizingToCSS(value: SizingToken | number | string): string {
  if (typeof value === "string") {
    switch (value) {
      case "full": return "100%"
      case "screen": return "100vw"
      case "auto": return "auto"
      case "min": return "min-content"
      case "max": return "max-content"
      case "fit": return "fit-content"
      default: return value
    }
  }
  return `${value * 4}px`
}

function heightSizingToCSS(value: SizingToken | number | string): string {
  if (value === "screen") return "100vh"
  return sizingToCSS(value)
}

const fontWeightMap: Record<FontWeightToken, number> = {
  thin: 100, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800,
}

const textStyleMap: Record<TextStyleToken, { fontSize: string; lineHeight: string }> = {
  xs: { fontSize: "12px", lineHeight: "16px" },
  sm: { fontSize: "14px", lineHeight: "20px" },
  base: { fontSize: "16px", lineHeight: "24px" },
  lg: { fontSize: "18px", lineHeight: "28px" },
  xl: { fontSize: "20px", lineHeight: "28px" },
  "2xl": { fontSize: "24px", lineHeight: "32px" },
  "3xl": { fontSize: "30px", lineHeight: "36px" },
  "4xl": { fontSize: "36px", lineHeight: "40px" },
  "5xl": { fontSize: "48px", lineHeight: "48px" },
  "6xl": { fontSize: "60px", lineHeight: "60px" },
}

const shadowMap: Record<ShadowToken, string> = {
  none: "none",
  sm: "0 1px 2px 0 rgba(0,0,0,0.05)",
  md: "0 4px 6px -1px rgba(0,0,0,0.1)",
  lg: "0 10px 15px -3px rgba(0,0,0,0.1)",
  xl: "0 20px 25px -5px rgba(0,0,0,0.1)",
  "2xl": "0 25px 50px -12px rgba(0,0,0,0.25)",
  inner: "inset 0 2px 4px 0 rgba(0,0,0,0.06)",
}

const DEFAULT_BORDER = "1px solid currentColor"

// ══════════════════════════════════════════════════════════════════════════
// combine() & tw()
// ══════════════════════════════════════════════════════════════════════════

export function combine(...refs: StyleRef[]): StyleRef {
  if (refs.length === 0) return { className: "", css: null, styleObject: {} }
  if (refs.length === 1) {
    const r = refs[0]!
    return { className: r.className, css: r.css, styleObject: r.styleObject }
  }
  const className = refs.map((r) => r.className).join(" ")
  const css = refs.map((r) => r.css).filter((c): c is string => c !== null).join("") || null
  const styleObject = Object.assign({}, ...refs.map((r) => r.styleObject))
  return { className, css, styleObject }
}

export function tw(classString: string): StyleRef {
  const tokens = classString.split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return { className: "", css: null, styleObject: {} }
  const seen = new Set<string>()
  const uniqueTokens = tokens.filter((t) => { if (seen.has(t)) return false; seen.add(t); return true })
  const refs: StyleRef[] = []
  for (const token of uniqueTokens) {
    const ref = registry.get(token)
    if (ref) refs.push(ref)
  }
  return combine(...refs)
}

// ══════════════════════════════════════════════════════════════════════════
// Layout & Display
// ══════════════════════════════════════════════════════════════════════════

export const flex = reg("flex", makeRef("sjs-flex", { display: "flex" }))
export const inline_flex = reg("inline_flex", makeRef("sjs-inline_flex", { display: "inline-flex" }))
export const grid = reg("grid", makeRef("sjs-grid", { display: "grid" }))
export const hidden = reg("hidden", makeRef("sjs-hidden", { display: "none" }))
export const block = reg("block", makeRef("sjs-block", { display: "block" }))
export const inline_block = reg("inline_block", makeRef("sjs-inline_block", { display: "inline-block" }))
export const inline = reg("inline", makeRef("sjs-inline", { display: "inline" }))

export const flex_row = reg("flex_row", makeRef("sjs-flex_row", { flexDirection: "row" }))
export const flex_col = reg("flex_col", makeRef("sjs-flex_col", { flexDirection: "column" }))
export const flex_wrap = reg("flex_wrap", makeRef("sjs-flex_wrap", { flexWrap: "wrap" }))
export const flex_nowrap = reg("flex_nowrap", makeRef("sjs-flex_nowrap", { flexWrap: "nowrap" }))
export const flex_1 = reg("flex_1", makeRef("sjs-flex_1", { flex: 1 }))
export const flex_auto = reg("flex_auto", makeRef("sjs-flex_auto", { flex: "1 1 auto" }))
export const flex_none = reg("flex_none", makeRef("sjs-flex_none", { flex: "none" }))
export const grow = reg("grow", makeRef("sjs-grow", { flexGrow: 1 }))
export const shrink = reg("shrink", makeRef("sjs-shrink", { flexShrink: 1 }))
export const basis_full = reg("basis_full", makeRef("sjs-basis_full", { flexBasis: "100%" }))
export const basis_auto = reg("basis_auto", makeRef("sjs-basis_auto", { flexBasis: "auto" }))

export const items_start = reg("items_start", makeRef("sjs-items_start", { alignItems: "flex-start" }))
export const items_center = reg("items_center", makeRef("sjs-items_center", { alignItems: "center" }))
export const items_end = reg("items_end", makeRef("sjs-items_end", { alignItems: "flex-end" }))
export const items_stretch = reg("items_stretch", makeRef("sjs-items_stretch", { alignItems: "stretch" }))

export const justify_start = reg("justify_start", makeRef("sjs-justify_start", { justifyContent: "flex-start" }))
export const justify_center = reg("justify_center", makeRef("sjs-justify_center", { justifyContent: "center" }))
export const justify_end = reg("justify_end", makeRef("sjs-justify_end", { justifyContent: "flex-end" }))
export const justify_between = reg("justify_between", makeRef("sjs-justify_between", { justifyContent: "space-between" }))
export const justify_around = reg("justify_around", makeRef("sjs-justify_around", { justifyContent: "space-around" }))
export const justify_evenly = reg("justify_evenly", makeRef("sjs-justify_evenly", { justifyContent: "space-evenly" }))

export const self_start = reg("self_start", makeRef("sjs-self_start", { alignSelf: "flex-start" }))
export const self_center = reg("self_center", makeRef("sjs-self_center", { alignSelf: "center" }))
export const self_end = reg("self_end", makeRef("sjs-self_end", { alignSelf: "flex-end" }))
export const self_stretch = reg("self_stretch", makeRef("sjs-self_stretch", { alignSelf: "stretch" }))

export const text_left = reg("text_left", makeRef("sjs-text_left", { textAlign: "left" }))
export const text_center = reg("text_center", makeRef("sjs-text_center", { textAlign: "center" }))
export const text_right = reg("text_right", makeRef("sjs-text_right", { textAlign: "right" }))

export const relative = reg("relative", makeRef("sjs-relative", { position: "relative" }))
export const absolute = reg("absolute", makeRef("sjs-absolute", { position: "absolute" }))
export const fixed = reg("fixed", makeRef("sjs-fixed", { position: "fixed" }))
export const sticky = reg("sticky", makeRef("sjs-sticky", { position: "sticky" }))
export const statik = reg("static", makeRef("sjs-static", { position: "static" }))

export const overflow_hidden = reg("overflow_hidden", makeRef("sjs-overflow_hidden", { overflow: "hidden" }))
export const overflow_auto = reg("overflow_auto", makeRef("sjs-overflow_auto", { overflow: "auto" }))
export const overflow_scroll = reg("overflow_scroll", makeRef("sjs-overflow_scroll", { overflow: "scroll" }))
export const overflow_visible = reg("overflow_visible", makeRef("sjs-overflow_visible", { overflow: "visible" }))
export const overflow_x_hidden = reg("overflow_x_hidden", makeRef("sjs-overflow_x_hidden", { overflowX: "hidden" }))
export const overflow_y_auto = reg("overflow_y_auto", makeRef("sjs-overflow_y_auto", { overflowY: "auto" }))

export const visible = reg("visible", makeRef("sjs-visible", { visibility: "visible" }))
export const invisible = reg("invisible", makeRef("sjs-invisible", { visibility: "hidden" }))

export const z_0 = reg("z_0", makeRef("sjs-z_0", { zIndex: 0 }))
export const z_10 = reg("z_10", makeRef("sjs-z_10", { zIndex: 10 }))
export const z_20 = reg("z_20", makeRef("sjs-z_20", { zIndex: 20 }))
export const z_30 = reg("z_30", makeRef("sjs-z_30", { zIndex: 30 }))
export const z_40 = reg("z_40", makeRef("sjs-z_40", { zIndex: 40 }))
export const z_50 = reg("z_50", makeRef("sjs-z_50", { zIndex: 50 }))
export const z_auto = reg("z_auto", makeRef("sjs-z_auto", { zIndex: "auto" }))

export const cursor_pointer = reg("cursor_pointer", makeRef("sjs-cursor_pointer", { cursor: "pointer" }))
export const cursor_default = reg("cursor_default", makeRef("sjs-cursor_default", { cursor: "default" }))
export const cursor_not_allowed = reg("cursor_not_allowed", makeRef("sjs-cursor_not_allowed", { cursor: "not-allowed" }))
export const cursor_text = reg("cursor_text", makeRef("sjs-cursor_text", { cursor: "text" }))
export const cursor_move = reg("cursor_move", makeRef("sjs-cursor_move", { cursor: "move" }))
export const cursor_grab = reg("cursor_grab", makeRef("sjs-cursor_grab", { cursor: "grab" }))

export const object_cover = reg("object_cover", makeRef("sjs-object_cover", { objectFit: "cover" }))
export const object_contain = reg("object_contain", makeRef("sjs-object_contain", { objectFit: "contain" }))
export const object_fill = reg("object_fill", makeRef("sjs-object_fill", { objectFit: "fill" }))

export const opacity_0 = reg("opacity_0", makeRef("sjs-opacity_0", { opacity: 0 }))
export const opacity_25 = reg("opacity_25", makeRef("sjs-opacity_25", { opacity: 0.25 }))
export const opacity_50 = reg("opacity_50", makeRef("sjs-opacity_50", { opacity: 0.5 }))
export const opacity_75 = reg("opacity_75", makeRef("sjs-opacity_75", { opacity: 0.75 }))
export const opacity_100 = reg("opacity_100", makeRef("sjs-opacity_100", { opacity: 1 }))

export const select_none = reg("select_none", makeRef("sjs-select_none", { userSelect: "none" }))
export const select_all = reg("select_all", makeRef("sjs-select_all", { userSelect: "all" }))
export const select_text = reg("select_text", makeRef("sjs-select_text", { userSelect: "text" }))

export const pointer_events_none = reg("pointer_events_none", makeRef("sjs-pointer_events_none", { pointerEvents: "none" }))
export const pointer_events_auto = reg("pointer_events_auto", makeRef("sjs-pointer_events_auto", { pointerEvents: "auto" }))

// ══════════════════════════════════════════════════════════════════════════
// Spacing (padding, margin, gap)
// ══════════════════════════════════════════════════════════════════════════

export function p(value: number): StyleRef { return makeRef(nextUtId(), { padding: spacingToPx(value) }) }
export function pt(value: number): StyleRef { return makeRef(nextUtId(), { paddingTop: spacingToPx(value) }) }
export function pr(value: number): StyleRef { return makeRef(nextUtId(), { paddingRight: spacingToPx(value) }) }
export function pb(value: number): StyleRef { return makeRef(nextUtId(), { paddingBottom: spacingToPx(value) }) }
export function pl(value: number): StyleRef { return makeRef(nextUtId(), { paddingLeft: spacingToPx(value) }) }
export function px(value: number): StyleRef { return makeRef(nextUtId(), { paddingLeft: spacingToPx(value), paddingRight: spacingToPx(value) }) }
export function py(value: number): StyleRef { return makeRef(nextUtId(), { paddingTop: spacingToPx(value), paddingBottom: spacingToPx(value) }) }

export function m(value: number): StyleRef { return makeRef(nextUtId(), { margin: spacingToPx(value) }) }
export function mt(value: number): StyleRef { return makeRef(nextUtId(), { marginTop: spacingToPx(value) }) }
export function mr(value: number): StyleRef { return makeRef(nextUtId(), { marginRight: spacingToPx(value) }) }
export function mb(value: number): StyleRef { return makeRef(nextUtId(), { marginBottom: spacingToPx(value) }) }
export function ml(value: number): StyleRef { return makeRef(nextUtId(), { marginLeft: spacingToPx(value) }) }
export function mx(value: number): StyleRef { return makeRef(nextUtId(), { marginLeft: spacingToPx(value), marginRight: spacingToPx(value) }) }
export function my(value: number): StyleRef { return makeRef(nextUtId(), { marginTop: spacingToPx(value), marginBottom: spacingToPx(value) }) }

export function gap(value: number): StyleRef { return makeRef(nextUtId(), { gap: spacingToPx(value) }) }
export function gap_x(value: number): StyleRef { return makeRef(nextUtId(), { columnGap: spacingToPx(value) }) }
export function gap_y(value: number): StyleRef { return makeRef(nextUtId(), { rowGap: spacingToPx(value) }) }

export const p_0 = reg("p_0", p(0))
export const p_1 = reg("p_1", p(1))
export const p_2 = reg("p_2", p(2))
export const p_3 = reg("p_3", p(3))
export const p_4 = reg("p_4", p(4))
export const p_5 = reg("p_5", p(5))

export const m_0 = reg("m_0", m(0))
export const m_1 = reg("m_1", m(1))
export const m_2 = reg("m_2", m(2))
export const m_3 = reg("m_3", m(3))
export const m_4 = reg("m_4", m(4))
export const m_5 = reg("m_5", m(5))

// ══════════════════════════════════════════════════════════════════════════
// Sizing
// ══════════════════════════════════════════════════════════════════════════

export function w(value: SizingToken | number | string): StyleRef { return makeRef(nextUtId(), { width: sizingToCSS(value) }) }
export function h(value: SizingToken | number | string): StyleRef { return makeRef(nextUtId(), { height: heightSizingToCSS(value) }) }
export function min_w(value: SizingToken | number | string): StyleRef { return makeRef(nextUtId(), { minWidth: sizingToCSS(value) }) }
export function min_h(value: SizingToken | number | string): StyleRef { return makeRef(nextUtId(), { minHeight: heightSizingToCSS(value) }) }
export function max_w(value: SizingToken | number | string): StyleRef { return makeRef(nextUtId(), { maxWidth: sizingToCSS(value) }) }
export function max_h(value: SizingToken | number | string): StyleRef { return makeRef(nextUtId(), { maxHeight: heightSizingToCSS(value) }) }

export const w_full = reg("w_full", w("full"))
export const w_screen = reg("w_screen", w("screen"))
export const w_auto = reg("w_auto", w("auto"))
export const h_full = reg("h_full", h("full"))
export const h_screen = reg("h_screen", h("screen"))
export const h_auto = reg("h_auto", h("auto"))

// ══════════════════════════════════════════════════════════════════════════
// Color & Background
// ══════════════════════════════════════════════════════════════════════════

export function color(value: string): StyleRef { return makeRef(nextUtId(), { color: value }) }
export function bg(value: string): StyleRef { return makeRef(nextUtId(), { backgroundColor: value }) }
export function border_color(value: string): StyleRef { return makeRef(nextUtId(), { borderColor: value }) }
export function outline_color(value: string): StyleRef { return makeRef(nextUtId(), { outlineColor: value }) }
export function accent_color(value: string): StyleRef { return makeRef(nextUtId(), { accentColor: value }) }

export const bg_white = reg("bg_white", makeRef("sjs-bg_white", { backgroundColor: "#fff" }))
export const bg_black = reg("bg_black", makeRef("sjs-bg_black", { backgroundColor: "#000" }))
export const bg_transparent = reg("bg_transparent", makeRef("sjs-bg_transparent", { backgroundColor: "transparent" }))
export const text_white = reg("text_white", makeRef("sjs-text_white", { color: "#fff" }))
export const text_black = reg("text_black", makeRef("sjs-text_black", { color: "#000" }))
export const text_muted = reg("text_muted", makeRef("sjs-text_muted", { color: "#6b7280" }))

// ══════════════════════════════════════════════════════════════════════════
// Typography
// ══════════════════════════════════════════════════════════════════════════

export function text(value: TextStyleToken): StyleRef {
  const cls = nextUtId()
  const s = textStyleMap[value]
  return makeRef(cls, { fontSize: s.fontSize, lineHeight: s.lineHeight })
}
export function font_size(value: number | string): StyleRef {
  const val = typeof value === "number" ? `${value}px` : value
  return makeRef(nextUtId(), { fontSize: val })
}
export function font_weight(value: FontWeightToken): StyleRef {
  return makeRef(nextUtId(), { fontWeight: fontWeightMap[value] })
}
export function leading(value: number): StyleRef { return makeRef(nextUtId(), { lineHeight: value }) }
export function tracking(value: number): StyleRef { return makeRef(nextUtId(), { letterSpacing: `${value}px` }) }

export const font_bold = reg("font_bold", makeRef("sjs-font_bold", { fontWeight: 700 }))
export const font_semibold = reg("font_semibold", makeRef("sjs-font_semibold", { fontWeight: 600 }))
export const font_medium = reg("font_medium", makeRef("sjs-font_medium", { fontWeight: 500 }))
export const font_normal = reg("font_normal", makeRef("sjs-font_normal", { fontWeight: 400 }))
export const font_light = reg("font_light", makeRef("sjs-font_light", { fontWeight: 300 }))

export const italic = reg("italic", makeRef("sjs-italic", { fontStyle: "italic" }))
export const underline = reg("underline", makeRef("sjs-underline", { textDecoration: "underline" }))
export const line_through = reg("line_through", makeRef("sjs-line_through", { textDecoration: "line-through" }))
export const no_underline = reg("no_underline", makeRef("sjs-no_underline", { textDecoration: "none" }))

export const truncate = reg("truncate", makeRef("sjs-truncate", { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }))
export const text_wrap = reg("text_wrap", makeRef("sjs-text_wrap", { whiteSpace: "normal" }))
export const text_nowrap = reg("text_nowrap", makeRef("sjs-text_nowrap", { whiteSpace: "nowrap" }))
export const whitespace_pre = reg("whitespace_pre", makeRef("sjs-whitespace_pre", { whiteSpace: "pre" }))

// ══════════════════════════════════════════════════════════════════════════
// Border & Shadow
// ══════════════════════════════════════════════════════════════════════════

export function border(value?: string): StyleRef { return makeRef(nextUtId(), { border: value ?? DEFAULT_BORDER }) }
export function border_t(value?: string): StyleRef { return makeRef(nextUtId(), { borderTop: value ?? DEFAULT_BORDER }) }
export function border_b(value?: string): StyleRef { return makeRef(nextUtId(), { borderBottom: value ?? DEFAULT_BORDER }) }
export function border_l(value?: string): StyleRef { return makeRef(nextUtId(), { borderLeft: value ?? DEFAULT_BORDER }) }
export function border_r(value?: string): StyleRef { return makeRef(nextUtId(), { borderRight: value ?? DEFAULT_BORDER }) }

export const border_0 = reg("border_0", makeRef("sjs-border_0", { borderWidth: 0 }))
export const border_2 = reg("border_2", makeRef("sjs-border_2", { borderWidth: "2px" }))
export const border_4 = reg("border_4", makeRef("sjs-border_4", { borderWidth: "4px" }))

export function rounded(value?: RadiusToken | number): StyleRef { return makeRef(nextUtId(), { borderRadius: radiusTokenToPx(value ?? "md") }) }
export function rounded_t(value?: RadiusToken | number): StyleRef {
  const px = radiusTokenToPx(value ?? "md")
  return makeRef(nextUtId(), { borderTopLeftRadius: px, borderTopRightRadius: px })
}
export function rounded_b(value?: RadiusToken | number): StyleRef {
  const px = radiusTokenToPx(value ?? "md")
  return makeRef(nextUtId(), { borderBottomLeftRadius: px, borderBottomRightRadius: px })
}
export function rounded_l(value?: RadiusToken | number): StyleRef {
  const px = radiusTokenToPx(value ?? "md")
  return makeRef(nextUtId(), { borderTopLeftRadius: px, borderBottomLeftRadius: px })
}
export function rounded_r(value?: RadiusToken | number): StyleRef {
  const px = radiusTokenToPx(value ?? "md")
  return makeRef(nextUtId(), { borderTopRightRadius: px, borderBottomRightRadius: px })
}
export function rounded_tl(value?: RadiusToken | number): StyleRef { return makeRef(nextUtId(), { borderTopLeftRadius: radiusTokenToPx(value ?? "md") }) }
export function rounded_tr(value?: RadiusToken | number): StyleRef { return makeRef(nextUtId(), { borderTopRightRadius: radiusTokenToPx(value ?? "md") }) }
export function rounded_bl(value?: RadiusToken | number): StyleRef { return makeRef(nextUtId(), { borderBottomLeftRadius: radiusTokenToPx(value ?? "md") }) }
export function rounded_br(value?: RadiusToken | number): StyleRef { return makeRef(nextUtId(), { borderBottomRightRadius: radiusTokenToPx(value ?? "md") }) }

export const rounded_none = reg("rounded_none", makeRef("sjs-rounded_none", { borderRadius: "0" }))
export const rounded_sm = reg("rounded_sm", makeRef("sjs-rounded_sm", { borderRadius: "2px" }))
export const rounded_md = reg("rounded_md", makeRef("sjs-rounded_md", { borderRadius: "6px" }))
export const rounded_lg = reg("rounded_lg", makeRef("sjs-rounded_lg", { borderRadius: "8px" }))
export const rounded_full = reg("rounded_full", makeRef("sjs-rounded_full", { borderRadius: "9999px" }))

export function shadow(value?: ShadowToken | string): StyleRef {
  const shadowValue = shadowMap[(value ?? "md") as ShadowToken]
  return makeRef(nextUtId(), { boxShadow: shadowValue ?? value ?? shadowMap.md })
}

export const shadow_sm = reg("shadow_sm", makeRef("sjs-shadow_sm", { boxShadow: shadowMap.sm }))
export const shadow_md = reg("shadow_md", makeRef("sjs-shadow_md", { boxShadow: shadowMap.md }))
export const shadow_lg = reg("shadow_lg", makeRef("sjs-shadow_lg", { boxShadow: shadowMap.lg }))
export const shadow_xl = reg("shadow_xl", makeRef("sjs-shadow_xl", { boxShadow: shadowMap.xl }))
export const shadow_2xl = reg("shadow_2xl", makeRef("sjs-shadow_2xl", { boxShadow: shadowMap["2xl"] }))
export const shadow_inner = reg("shadow_inner", makeRef("sjs-shadow_inner", { boxShadow: shadowMap.inner }))
export const shadow_none = reg("shadow_none", makeRef("sjs-shadow_none", { boxShadow: shadowMap.none }))
