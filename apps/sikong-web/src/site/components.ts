/**
 * src/site/components.ts — sikong.dev production homepage
 *
 * Design language: Precision Product Craft (Linear · Vercel · Stripe lineage).
 * Philosophy: earn trust through craft and restraint — "we are infrastructure
 * built by engineers who care about detail."
 *
 * Omits: stock illustration, rounded softness, multi-color palettes,
 * marketing fluff, terminal chrome, decorative glow, slow motion.
 * Elevates: monochrome + one hard-working accent, generous whitespace,
 * real product UI, motion that demonstrates speed, dark mode.
 *
 * Built with semajsx: h (jsx), css (scoped styles), fragment.
 *
 * @module
 */

import { jsx as h, Fragment as fragment } from "semajsx/core"
import { css } from "semajsx/style"
import type { JSXNode } from "semajsx/html"

// ── Design tokens ────────────────────────────────────────────────────────────
// Precision Product Craft: near-monochrome dark canvas + single blue accent.
// 4px base grid; Inter/Geist sans + JetBrains Mono; 6px precise radii.

const T = {
  // Canvas — deep, nearly black. Not #000 (too harsh), not navy (too terminal).
  bg: "#0a0a0b",
  bgAlt: "#111113",
  surface: "#161618",
  surfaceHover: "#1c1c1f",

  // Borders — hairline, low contrast. Precision over decoration.
  border: "#2a2a2e",
  borderHover: "#3a3a3f",

  // Type
  text: "#fafafa",
  textDim: "#a0a0a6",
  textMuted: "#6e6e73",

  // Accent — the ONE hard-working color. Used only for primary actions and key signals.
  accent: "#3b82f6",
  accentHover: "#2563eb",
  accentBg: "rgba(59, 130, 246, 0.06)",
  accentBorder: "rgba(59, 130, 246, 0.15)",

  // Semantic — minimal, functional
  success: "#22c55e",
  warning: "#f59e0b",
  error: "#ef4444",

  // Typography — Inter/Geist lineage (geometric, slightly cold, high contrast)
  fontSans:
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif",
  fontMono: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",

  // Shape — small, precise radii; not rounded/friendly
  radius: "6px",
  radiusLg: "8px",
} as const

// ── Keyframes ────────────────────────────────────────────────────────────────
// Motion: fast, functional. No decorative animations.

const KEYFRAMES = `
@keyframes sk-fadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
`

// ── Global CSS ───────────────────────────────────────────────────────────────

export const GLOBAL_CSS = `
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  font-family: ${T.fontSans};
  background: ${T.bg};
  color: ${T.text};
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
a { color: ${T.accent}; text-decoration: none; transition: color 0.12s ease; }
a:hover { color: #60a5fa; }
::selection { background: rgba(59, 130, 246, 0.25); }
code, pre { font-family: ${T.fontMono}; }

/* Scrollbar — subtle, functional */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: ${T.borderHover}; }
`

// ── Utility styles ───────────────────────────────────────────────────────────

const container = css`
  max-width: 1120px;
  margin: 0 auto;
  padding: 0 24px;
`

const section = css`
  padding: 120px 0;

  @media (max-width: 640px) {
    padding: 80px 0;
  }
`

const sectionTitle = css`
  font-size: clamp(1.625rem, 3vw, 2rem);
  font-weight: 700;
  color: ${T.text};
  text-align: center;
  letter-spacing: -0.03em;
  line-height: 1.2;
`

const sectionSub = css`
  font-size: 0.9375rem;
  color: ${T.textDim};
  text-align: center;
  max-width: 560px;
  margin: 12px auto 64px;
  line-height: 1.65;

  @media (max-width: 640px) {
    margin-bottom: 48px;
  }
`

// ── Navigation ───────────────────────────────────────────────────────────────

const nav = css`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: rgba(10, 10, 11, 0.82);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid ${T.border};
`

const navInner = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
`

const navLeft = css`
  display: flex;
  align-items: center;
  gap: 12px;
`

const navBrand = css`
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 650;
  font-size: 0.9375rem;
  color: ${T.text};
  letter-spacing: -0.02em;
`

const navLogo = css`
  width: 26px;
  height: 26px;
  border-radius: ${T.radius};
  background: ${T.accent};
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 750;
  color: #fff;
`

const navVersion = css`
  font-family: ${T.fontMono};
  font-size: 0.6875rem;
  color: ${T.textMuted};
  padding: 2px 7px;
  border: 1px solid ${T.border};
  border-radius: 4px;
  line-height: 1.4;
`

const navRight = css`
  display: flex;
  align-items: center;
  gap: 24px;

  @media (max-width: 640px) {
    gap: 16px;
  }
`

const navLink = css`
  font-size: 0.8125rem;
  color: ${T.textDim};
  transition: color 0.12s ease;

  &:hover {
    color: ${T.text};
  }

  @media (max-width: 640px) {
    display: none;
  }
`

const navCta = css`
  padding: 7px 18px;
  background: ${T.accent};
  color: #fff;
  border-radius: ${T.radius};
  font-size: 0.8125rem;
  font-weight: 600;
  transition: background 0.12s ease;
  line-height: 1.4;

  &:hover {
    background: ${T.accentHover};
    color: #fff;
  }
`

// ── Hero ─────────────────────────────────────────────────────────────────────
// No glow, no grid background, no terminal chrome. Just confident typography
// and a real product code block. Whitespace is the hero's texture.

const hero = css`
  min-height: 90vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 120px 24px 80px;
  text-align: center;
`

const heroEyebrow = css`
  font-family: ${T.fontMono};
  font-size: 0.75rem;
  color: ${T.textMuted};
  letter-spacing: 0.04em;
  margin-bottom: 20px;
  animation: sk-fadeUp 0.35s ease both;
`

const heroH1 = css`
  font-size: clamp(2.5rem, 5.5vw, 3.75rem);
  font-weight: 750;
  line-height: 1.08;
  letter-spacing: -0.04em;
  margin-bottom: 16px;
  max-width: 720px;
  animation: sk-fadeUp 0.35s 0.06s ease both;
`

const heroAccent = css`
  color: ${T.accent};
`

const heroP = css`
  font-size: clamp(0.9375rem, 1.5vw, 1.0625rem);
  color: ${T.textDim};
  max-width: 520px;
  line-height: 1.6;
  margin-bottom: 36px;
  animation: sk-fadeUp 0.35s 0.12s ease both;
`

const heroActions = css`
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 48px;
  animation: sk-fadeUp 0.35s 0.18s ease both;
`

// ── Buttons — two variants, precise, fast hover ──────────────────────────────

const btnBase = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 12px 26px;
  border-radius: ${T.radius};
  font-size: 0.875rem;
  font-weight: 600;
  transition: all 0.12s ease;
  line-height: 1;
  cursor: pointer;
`

const btnSolid = css`
  background: ${T.accent};
  color: #fff;
  border: none;

  &:hover {
    background: ${T.accentHover};
    color: #fff;
  }
`

const btnOutline = css`
  background: transparent;
  color: ${T.text};
  border: 1px solid ${T.border};

  &:hover {
    border-color: ${T.borderHover};
    background: ${T.surface};
  }
`

// ── Hero code block — real product output, not a simulated terminal ──────────

const heroCode = css`
  background: ${T.surface};
  border: 1px solid ${T.border};
  border-radius: ${T.radiusLg};
  overflow: hidden;
  max-width: 600px;
  width: 100%;
  text-align: left;
  animation: sk-fadeUp 0.35s 0.26s ease both;
`

const heroCodeLabel = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px;
  background: ${T.bgAlt};
  border-bottom: 1px solid ${T.border};
  font-size: 0.6875rem;
  font-weight: 600;
  color: ${T.textMuted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-family: ${T.fontMono};
`

const heroCodeBody = css`
  padding: 18px 20px;
  font-family: ${T.fontMono};
  font-size: 0.8rem;
  line-height: 1.9;
  color: ${T.textDim};
  overflow-x: auto;

  @media (max-width: 640px) {
    padding: 14px 16px;
    font-size: 0.72rem;
  }
`

// Syntax-token styles for code output — restrained, functional
const codeDim = css`color: ${T.textMuted};`
const codeKw = css`color: ${T.accent};`
const codeOk = css`color: ${T.success};`
const codeOut = css`color: ${T.textDim};`

// ── Install row below hero ───────────────────────────────────────────────────

const heroInstall = css`
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-top: 40px;
  padding: 10px 22px;
  background: ${T.surface};
  border: 1px solid ${T.border};
  border-radius: ${T.radius};
  font-family: ${T.fontMono};
  font-size: 0.8rem;

  @media (max-width: 640px) {
    flex-direction: column;
    text-align: center;
    font-size: 0.72rem;
  }
`

const heroInstallLabel = css`
  font-size: 0.6rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: ${T.textMuted};
  background: ${T.bgAlt};
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid ${T.border};
  flex-shrink: 0;
`

const heroInstallCmd = css`
  color: ${T.accent};
  user-select: all;
`

// ── Features grid ────────────────────────────────────────────────────────────

const featGrid = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;

  @media (max-width: 640px) {
    grid-template-columns: 1fr;
  }
`

const featCard = css`
  background: ${T.surface};
  border: 1px solid ${T.border};
  border-radius: ${T.radiusLg};
  padding: 26px 28px;
  transition: border-color 0.15s ease, background 0.15s ease;
  position: relative;
  overflow: hidden;

  &:hover {
    border-color: ${T.borderHover};
    background: ${T.surfaceHover};
  }
`

const featCardLine = css`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, ${T.accent}, transparent);
  opacity: 0;
  transition: opacity 0.15s ease;
`

const featTop = css`
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
`

const featIcon = css`
  font-size: 1.1rem;
  line-height: 1;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: ${T.radius};
  background: ${T.accentBg};
  flex-shrink: 0;
`

const featTitle = css`
  font-size: 0.9375rem;
  font-weight: 650;
  color: ${T.text};
  padding-top: 6px;
  letter-spacing: -0.01em;
`

const featDesc = css`
  font-size: 0.8125rem;
  color: ${T.textDim};
  line-height: 1.65;
`

// ── Architecture pipeline ────────────────────────────────────────────────────

const archBg = css`
  background: ${T.bgAlt};
`

const archPipeline = css`
  display: flex;
  align-items: center;
  justify-content: center;
  max-width: 960px;
  margin: 0 auto;

  @media (max-width: 768px) {
    flex-direction: column;
    gap: 0;
  }
`

const archNode = css`
  flex: 1;
  min-width: 150px;
  text-align: center;
  padding: 24px 18px;
  background: ${T.surface};
  border: 1px solid ${T.border};
  border-radius: ${T.radiusLg};
  transition: border-color 0.15s ease;

  &:hover {
    border-color: ${T.borderHover};
  }

  @media (max-width: 768px) {
    width: 100%;
    min-width: unset;
  }
`

const archNodeActive = css`
  border-color: ${T.accent};
`

const archNodeLabel = css`
  font-size: 0.6rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: ${T.textMuted};
  margin-bottom: 6px;
`

const archNodeTitle = css`
  font-size: 0.9rem;
  font-weight: 650;
  color: ${T.text};
  margin-bottom: 4px;
`

const archNodeDesc = css`
  font-size: 0.75rem;
  color: ${T.textDim};
  line-height: 1.5;
`

const archArrow = css`
  color: ${T.textMuted};
  font-size: 1rem;
  padding: 0 10px;
  flex-shrink: 0;

  @media (max-width: 768px) {
    transform: rotate(90deg);
    padding: 6px 0;
  }
`

const archNote = css`
  text-align: center;
  margin-top: 28px;
  font-size: 0.8125rem;
  color: ${T.textMuted};
  font-family: ${T.fontMono};
`

// ── Runtime comparison table ─────────────────────────────────────────────────

const compWrap = css`
  max-width: 880px;
  margin: 0 auto;
  overflow-x: auto;
  border: 1px solid ${T.border};
  border-radius: ${T.radiusLg};
`

const compTable = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
`

const compTh = css`
  padding: 13px 16px;
  text-align: left;
  font-weight: 600;
  color: ${T.text};
  background: ${T.surface};
  border-bottom: 1px solid ${T.border};
  white-space: nowrap;
  font-size: 0.75rem;
`

const compThRt = css`
  font-family: ${T.fontMono};
`

const compTd = css`
  padding: 12px 16px;
  border-bottom: 1px solid rgba(42, 42, 46, 0.5);
  color: ${T.textDim};
  font-size: 0.8125rem;
`

const compTdLabel = css`
  font-weight: 600;
  color: ${T.text};
  white-space: nowrap;
`

const compYes = css`color: ${T.success};`
const compNo = css`color: ${T.textMuted};`
const compPartial = css`color: ${T.warning};`

// ── Install section ──────────────────────────────────────────────────────────

const installGrid = css`
  display: flex;
  gap: 16px;
  justify-content: center;
  flex-wrap: wrap;
  max-width: 800px;
  margin: 0 auto;
`

const codeBlock = css`
  background: ${T.surface};
  border: 1px solid ${T.border};
  border-radius: ${T.radiusLg};
  overflow: hidden;
  flex: 1;
  min-width: 280px;
  max-width: 400px;
  transition: border-color 0.15s ease;

  &:hover {
    border-color: ${T.borderHover};
  }
`

const codeHeader = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px;
  background: ${T.bgAlt};
  border-bottom: 1px solid ${T.border};
  font-size: 0.6875rem;
  color: ${T.textMuted};
`

const codeLabel = css`
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-family: ${T.fontMono};
`

const codeBody = css`
  padding: 16px 18px;
  font-family: ${T.fontMono};
  font-size: 0.78rem;
  line-height: 1.9;
  color: ${T.textDim};
  overflow-x: auto;
  user-select: all;

  @media (max-width: 640px) {
    font-size: 0.72rem;
    padding: 12px 14px;
  }
`

const installHint = css`
  text-align: center;
  font-size: 0.8125rem;
  color: ${T.textDim};
  margin-top: 24px;
`

// ── CTA ──────────────────────────────────────────────────────────────────────

const ctaSection = css`
  background: ${T.bgAlt};
  border-top: 1px solid ${T.border};
  border-bottom: 1px solid ${T.border};
`

const ctaActions = css`
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 28px;
`

// ── Footer ───────────────────────────────────────────────────────────────────

const footerMain = css`
  border-top: 1px solid ${T.border};
  padding: 56px 24px 24px;
`

const footerGrid = css`
  max-width: 1120px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr;
  gap: 40px;

  @media (max-width: 768px) {
    grid-template-columns: 1fr 1fr;
    gap: 32px;
  }

  @media (max-width: 480px) {
    grid-template-columns: 1fr;
  }
`

const footerBrand = css`
  font-weight: 650;
  font-size: 0.9375rem;
  color: ${T.text};
  margin-bottom: 8px;
  letter-spacing: -0.01em;
`

const footerDesc = css`
  font-size: 0.8125rem;
  color: ${T.textDim};
  line-height: 1.6;
  max-width: 280px;
`

const footerColTitle = css`
  font-size: 0.6875rem;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: ${T.textMuted};
  margin-bottom: 14px;
`

const footerLinks = css`
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const footerLink = css`
  font-size: 0.8125rem;
  color: ${T.textDim};
  transition: color 0.12s ease;

  &:hover {
    color: ${T.text};
  }
`

const footerBottom = css`
  text-align: center;
  margin-top: 44px;
  padding-top: 18px;
  border-top: 1px solid ${T.border};
  font-size: 0.75rem;
  color: ${T.textMuted};
`

// ═══════════════════════════════════════════════════════════════════════════════
// Components
// ═══════════════════════════════════════════════════════════════════════════════

/** Sticky navigation — brand, version badge, anchor links, GitHub CTA. */
export function Nav(): JSXNode {
  return h("nav", { class: nav },
    h("div", { class: [container, navInner] },
      h("div", { class: navLeft },
        h("a", { class: navBrand, href: "#" },
          h("span", { class: navLogo }, "司"),
          "sikong",
        ),
        h("span", { class: navVersion }, "v0.1.7"),
      ),
      h("div", { class: navRight },
        h("a", { class: navLink, href: "#features" }, "Features"),
        h("a", { class: navLink, href: "#architecture" }, "Architecture"),
        h("a", { class: navLink, href: "#comparison" }, "Comparison"),
        h("a", { class: navLink, href: "#install" }, "Install"),
        h("a", {
          class: navCta,
          href: "https://github.com/lidessen/sikong",
          target: "_blank",
          rel: "noopener noreferrer",
        }, "GitHub"),
      ),
    ),
  )
}

/** Hero — confident typography, real product code block, no terminal chrome. */
export function Hero(): JSXNode {
  return h("section", { class: hero },
    h("div", { class: heroEyebrow }, "Open source · MIT · TypeScript"),
    h("h1", { class: heroH1 },
      "Build with ",
      h("span", { class: heroAccent }, "agent workflows"),
      " across any runtime",
    ),
    h("p", { class: heroP },
      "A coordination layer for multi-agent, multi-runtime development. ",
      "One config, four backends, full observability.",
    ),
    h("div", { class: heroActions },
      h("a", {
        class: [btnBase, btnSolid],
        href: "https://github.com/lidessen/sikong",
        target: "_blank",
        rel: "noopener noreferrer",
      }, "Get Started"),
      h("a", { class: [btnBase, btnOutline], href: "#install" }, "Install"),
    ),

    // Real product output — code block, not terminal window
    h("div", { class: heroCode },
      h("div", { class: heroCodeLabel },
        h("span", {}, "sikong run"),
        h("span", { style: { textTransform: "none", fontWeight: "400" } }, "3 tasks · 12.4s"),
      ),
      h("div", { class: heroCodeBody },
        h("span", { class: codeDim }, "$ "),
        h("span", { class: codeKw }, "sikong"),
        " run my-project",
        h("br", {}),
        h("span", { class: codeOk }, "  ✓"),
        h("span", { class: codeOut }, " [dev]    Implement feature … done"),
        h("br", {}),
        h("span", { class: codeOk }, "  ✓"),
        h("span", { class: codeOut }, " [test]   Assertions passed (14/14)"),
        h("br", {}),
        h("span", { class: codeOk }, "  ✓"),
        h("span", { class: codeOut }, " [review] Code review … approved"),
        h("br", {}),
        h("span", { class: codeDim }, "  ─────────────────────────────"),
        h("br", {}),
        h("span", { class: codeOut }, "  3 stages · 14.2k tokens · $0.04"),
      ),
    ),

    // Quick install — one-liner
    h("div", { class: heroInstall },
      h("span", { class: heroInstallLabel }, "Install"),
      h("span", { class: heroInstallCmd }, "curl -fsSL https://sikong.dev/install.sh | sh"),
    ),
  )
}

/** Features — 6-card grid. Clean geometric cards with restrained hover. */
export function Features(): JSXNode {
  const items = [
    {
      icon: "⚙️",
      title: "Task Orchestration",
      desc: "Declarative multi-step agent workflows with automatic retries, timeouts, and handoff-based state management across runs.",
    },
    {
      icon: "📡",
      title: "Cost-aware Routing",
      desc: "Route simple tasks to fast, cheap models and escalate complex reasoning to capable ones — configured per stage.",
    },
    {
      icon: "🔄",
      title: "Multi-runtime",
      desc: "Claude Code, Codex, Cursor Agent SDK, Vercel AI SDK — one orchestration layer across all major agent runtimes.",
    },
    {
      icon: "💾",
      title: "Durable State",
      desc: "Append-only JSONL event log for every workspace. Inspect, replay, and recover any past workflow exactly as it ran.",
    },
    {
      icon: "📊",
      title: "Live Monitor",
      desc: "Real-time dashboard showing project overview, task progress, token usage, and cost breakdowns.",
    },
    {
      icon: "🔌",
      title: "Provider-agnostic",
      desc: "Swap LLM providers per runtime — DeepSeek, Anthropic, OpenAI, or any compatible gateway. No vendor lock-in.",
    },
  ]

  return h("section", { id: "features", class: [section, archBg] },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Everything you need for agent-driven development"),
      h("p", { class: sectionSub },
        "From orchestration to cost management — the complete coordination layer.",
      ),
      h("div", { class: featGrid },
        ...items.map((f) =>
          h("div", { class: featCard },
            h("div", { class: featCardLine }),
            h("div", { class: featTop },
              h("div", { class: featIcon }, f.icon),
              h("div", { class: featTitle }, f.title),
            ),
            h("p", { class: featDesc }, f.desc),
          )
        ),
      ),
    ),
  )
}

/** Architecture — pipeline flow showing the four system layers. */
export function Architecture(): JSXNode {
  const nodes = [
    { label: "Interface", title: "CLI & Dashboard", desc: "User interface, project management, live monitor" },
    { label: "Orchestration", title: "Workflow Engine", desc: "Task orchestration, state machine, handoff management", active: true },
    { label: "Runtime", title: "Runtime Adapters", desc: "Claude · Codex · Cursor · Vercel AI SDK" },
    { label: "Models", title: "Model Providers", desc: "DeepSeek · Anthropic · OpenAI · Custom gateways" },
  ]

  return h("section", { id: "architecture", class: section },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Architecture"),
      h("p", { class: sectionSub },
        "Runtime ⊥ Provider — the loop engine is decoupled from your LLM backend. One credential drives any compatible runtime.",
      ),
      h("div", { class: archPipeline },
        ...nodes.flatMap((n, i) => {
          const node = h("div",
            { class: [archNode, n.active ? archNodeActive : null] },
            h("div", { class: archNodeLabel }, n.label),
            h("div", { class: archNodeTitle }, n.title),
            h("div", { class: archNodeDesc }, n.desc),
          )
          return i < nodes.length - 1
            ? [node, h("div", { class: archArrow }, "→")]
            : [node]
        }),
      ),
      h("div", { class: archNote }, "// One model provider, four runtimes — or vice versa"),
    ),
  )
}

/** Runtime comparison — precise table with check/cross/partial markers. */
export function RuntimeComparison(): JSXNode {
  interface Row {
    feature: string
    claude: string | boolean
    codex: string | boolean
    cursor: string | boolean
    aiSdk: string | boolean
  }

  const rows: Row[] = [
    { feature: "Native agent loop", claude: true, codex: true, cursor: true, aiSdk: true },
    { feature: "Tools / MCP", claude: true, codex: true, cursor: true, aiSdk: true },
    { feature: "Provider flexibility", claude: true, codex: "Responses wire", cursor: "Native only", aiSdk: true },
    { feature: "Effort levels", claude: true, codex: true, cursor: false, aiSdk: false },
    { feature: "Usage tracking", claude: true, codex: true, cursor: "Estimate only", aiSdk: true },
    { feature: "Open source", claude: true, codex: true, cursor: false, aiSdk: true },
  ]

  const cell = (v: string | boolean): JSXNode => {
    if (v === true) return h("span", { class: compYes }, "✓")
    if (v === false) return h("span", { class: compNo }, "—")
    return h("span", { class: compPartial }, v)
  }

  return h("section", { id: "comparison", class: [section, archBg] },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Runtime comparison"),
      h("p", { class: sectionSub },
        "Choose the runtime that fits your workflow. Sikong abstracts the common core across all four.",
      ),
      h("div", { class: compWrap },
        h("table", { class: compTable },
          h("thead", {},
            h("tr", {},
              h("th", { class: compTh }, ""),
              h("th", { class: [compTh, compThRt] }, "Claude Code"),
              h("th", { class: [compTh, compThRt] }, "Codex"),
              h("th", { class: [compTh, compThRt] }, "Cursor"),
              h("th", { class: [compTh, compThRt] }, "AI SDK"),
            ),
          ),
          h("tbody", {},
            ...rows.map((r) =>
              h("tr", {},
                h("td", { class: [compTd, compTdLabel] }, r.feature),
                h("td", { class: compTd }, cell(r.claude)),
                h("td", { class: compTd }, cell(r.codex)),
                h("td", { class: compTd }, cell(r.cursor)),
                h("td", { class: compTd }, cell(r.aiSdk)),
              )
            ),
          ),
        ),
      ),
    ),
  )
}

/** Install — two side-by-side code blocks for curl and npm. */
export function Install(): JSXNode {
  return h("section", { id: "install", class: section },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Get started in seconds"),
      h("p", { class: sectionSub },
        "Install Sikong and have your first workflow running in under a minute.",
      ),
      h("div", { class: installGrid },
        h("div", { class: codeBlock },
          h("div", { class: codeHeader },
            h("span", { class: codeLabel }, "curl"),
            h("span", {}, "macOS / Linux"),
          ),
          h("div", { class: codeBody },
            h("span", { class: codeDim }, "# Install the latest release"),
            h("br", {}),
            "curl -fsSL https://sikong.dev/install.sh | sh",
            h("br", {}),
            h("br", {}),
            h("span", { class: codeDim }, "# Start your first project"),
            h("br", {}),
            "sikong init my-project && cd my-project",
            h("br", {}),
            "sikong run",
          ),
        ),
        h("div", { class: codeBlock },
          h("div", { class: codeHeader },
            h("span", { class: codeLabel }, "npm"),
            h("span", {}, "Any platform"),
          ),
          h("div", { class: codeBody },
            h("span", { class: codeDim }, "# Install globally via npm"),
            h("br", {}),
            "npm install -g sikong",
            h("br", {}),
            h("br", {}),
            h("span", { class: codeDim }, "# Or run from source"),
            h("br", {}),
            "git clone https://github.com/lidessen/sikong",
            h("br", {}),
            "cd sikong && bun install && bun run build",
          ),
        ),
      ),
      h("p", { class: installHint },
        "Requires Bun ≥1.2 · macOS / Linux / WSL · ",
        h("a", {
          href: "https://github.com/lidessen/sikong/blob/main/README.md",
          target: "_blank",
          rel: "noopener noreferrer",
        }, "View README"),
      ),
    ),
  )
}

/** CTA — restrained community call-to-action. */
export function CTA(): JSXNode {
  return h("section", { class: [section, ctaSection] },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Built in the open, for the community"),
      h("p", { class: sectionSub },
        "Sikong is MIT-licensed and developed in public. Contributions, issues, and ideas are welcome.",
      ),
      h("div", { class: ctaActions },
        h("a", {
          class: [btnBase, btnSolid],
          href: "https://github.com/lidessen/sikong",
          target: "_blank",
          rel: "noopener noreferrer",
        }, "Star on GitHub"),
        h("a", {
          class: [btnBase, btnOutline],
          href: "https://sikong.dev/docs",
        }, "Read the Docs"),
        h("a", {
          class: [btnBase, btnOutline],
          href: "https://github.com/lidessen/sikong/issues",
          target: "_blank",
          rel: "noopener noreferrer",
        }, "Report Issue"),
      ),
    ),
  )
}

/** Footer — 4-column sitemap with copyright. */
export function Footer(): JSXNode {
  return h("footer", { class: footerMain },
    h("div", { class: footerGrid },
      h("div", {},
        h("div", { class: footerBrand }, "Sikong (司空)"),
        h("p", { class: footerDesc },
          "Durable agent workspaces for multi-runtime development. ",
          "MIT licensed. Built with Bun, semajsx, and agent-loop.",
        ),
      ),
      h("div", {},
        h("div", { class: footerColTitle }, "Product"),
        h("ul", { class: footerLinks },
          h("li", {}, h("a", { class: footerLink, href: "#features" }, "Features")),
          h("li", {}, h("a", { class: footerLink, href: "#architecture" }, "Architecture")),
          h("li", {}, h("a", { class: footerLink, href: "#install" }, "Install")),
          h("li", {}, h("a", { class: footerLink, href: "/changelog" }, "Changelog")),
        ),
      ),
      h("div", {},
        h("div", { class: footerColTitle }, "Community"),
        h("ul", { class: footerLinks },
          h("li", {}, h("a", { class: footerLink, href: "https://github.com/lidessen/sikong", target: "_blank", rel: "noopener noreferrer" }, "GitHub")),
          h("li", {}, h("a", { class: footerLink, href: "https://github.com/lidessen/sikong/issues", target: "_blank", rel: "noopener noreferrer" }, "Issues")),
          h("li", {}, h("a", { class: footerLink, href: "https://sikong.dev/community" }, "Community")),
        ),
      ),
      h("div", {},
        h("div", { class: footerColTitle }, "Resources"),
        h("ul", { class: footerLinks },
          h("li", {}, h("a", { class: footerLink, href: "https://sikong.dev/docs" }, "Documentation")),
          h("li", {}, h("a", { class: footerLink, href: "https://github.com/lidessen/sikong/blob/main/README.md", target: "_blank", rel: "noopener noreferrer" }, "README")),
          h("li", {}, h("a", { class: footerLink, href: "https://sikong.dev/install.sh" }, "install.sh")),
        ),
      ),
    ),
    h("div", { class: footerBottom },
      `Copyright ${new Date().getFullYear()} — Sikong. MIT License. Built with Bun, semajsx, and agent-loop.`,
    ),
  )
}

/** Page — top-level layout composing all sections. */
export function Page(): JSXNode {
  return fragment({ children: [
    h("style", {}, KEYFRAMES),
    Nav(),
    Hero(),
    Features(),
    Architecture(),
    RuntimeComparison(),
    Install(),
    CTA(),
    Footer(),
  ]})
}
