/**
 * Candidate A: "Architect" — Terminal-Inspired Developer Landing
 *
 * A dark, developer-centric design that leans into Sikong's CLI-first identity.
 * Terminal window chrome, grid backgrounds, monospace accents, and an
 * architecture flow diagram make the product feel like a power tool for engineers.
 *
 * @module
 */

import { jsx as h, Fragment as fragment } from "semajsx/core"
import { css } from "semajsx/style"
import type { JSXNode } from "semajsx/html"
import type { StyleRef } from "semajsx/style"

// ── Design tokens ─────────────────────────────────────────────────────────────

const TOKENS = {
  bg: "#0b1120",
  bgAlt: "#0f172a",
  bgCard: "#1a2332",
  border: "#1e293b",
  borderActive: "#334155",
  text: "#e2e8f0",
  textDim: "#64748b",
  textMuted: "#475569",
  accent: "#3b82f6",
  accentGlow: "rgba(59, 130, 246, 0.15)",
  cyan: "#06b6d4",
  green: "#22c55e",
  orange: "#f97316",
  purple: "#a78bfa",
  fontMono: '"SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", monospace',
  fontSans:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", Helvetica, Arial, sans-serif',
} as const

// ── Global styles (inlined in build.ts) ───────────────────────────────────────

export const GLOBAL_CSS = `
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  font-family: ${TOKENS.fontSans};
  background: ${TOKENS.bg};
  color: ${TOKENS.text};
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
a { color: ${TOKENS.accent}; text-decoration: none; transition: color 0.15s ease; }
a:hover { color: #93c5fd; }
::selection { background: rgba(59, 130, 246, 0.3); }
code, pre {
  font-family: ${TOKENS.fontMono};
}
`

// ── Utility styles ───────────────────────────────────────────────────────────

const container = css`
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 24px;
`

const sectionPadding = css`
  padding: 100px 0;
`

const sectionTitle = css`
  font-size: clamp(1.75rem, 3.5vw, 2.25rem);
  font-weight: 800;
  color: #f1f5f9;
  text-align: center;
  margin-bottom: 12px;
  letter-spacing: -0.025em;
`

const sectionSub = css`
  font-size: 1rem;
  color: ${TOKENS.textDim};
  text-align: center;
  max-width: 640px;
  margin: 0 auto 56px;
  line-height: 1.7;
`

const sectionSubLeft = css`
  font-size: 1rem;
  color: ${TOKENS.textDim};
  max-width: 640px;
  line-height: 1.7;
`

// ── Navigation ────────────────────────────────────────────────────────────────

const nav = css`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: rgba(11, 17, 32, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid ${TOKENS.border};
`

const navInner = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 64px;
`

const navBrand = css`
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 1.125rem;
  color: #f1f5f9;
  letter-spacing: -0.02em;
`

const navBrandBracket = css`
  color: ${TOKENS.textMuted};
  font-weight: 400;
`

const navLinks = css`
  display: flex;
  align-items: center;
  gap: 28px;
`

const navLink = css`
  font-size: 0.85rem;
  color: ${TOKENS.textDim};
  transition: color 0.15s ease;
  cursor: pointer;
  &:hover { color: #e2e8f0; }
`

const navCta = css`
  padding: 8px 18px;
  background: ${TOKENS.accent};
  color: #fff;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  transition: background 0.15s ease;
  &:hover { background: #2563eb; color: #fff; }
`

const navToggle = css`
  display: none;
  background: none;
  border: none;
  color: ${TOKENS.textDim};
  font-size: 1.5rem;
  cursor: pointer;
  padding: 4px;
`

// ── Grid background pattern ──────────────────────────────────────────────────

const gridBg = css`
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(59, 130, 246, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(59, 130, 246, 0.03) 1px, transparent 1px);
  background-size: 64px 64px;
  pointer-events: none;
`

const heroGlow = css`
  position: absolute;
  top: -10%;
  left: 50%;
  transform: translateX(-50%);
  width: 800px;
  height: 600px;
  background: radial-gradient(ellipse, rgba(59, 130, 246, 0.08) 0%, transparent 70%);
  pointer-events: none;
`

// ── Hero section ──────────────────────────────────────────────────────────────

const hero = css`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 120px 24px 80px;
  text-align: center;
  position: relative;
  overflow: hidden;
`

const heroGradient = css`
  font-size: clamp(2.5rem, 6vw, 4.5rem);
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: -0.03em;
  margin-bottom: 8px;
  background: linear-gradient(135deg, #60a5fa, #06b6d4, #a78bfa);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
`

const heroVersion = css`
  font-family: ${TOKENS.fontMono};
  font-size: 0.8rem;
  color: ${TOKENS.textMuted};
  margin-bottom: 20px;
`

const heroTagline = css`
  font-size: clamp(1.125rem, 2.5vw, 1.5rem);
  color: ${TOKENS.textDim};
  max-width: 640px;
  font-weight: 500;
  margin-bottom: 12px;
`

const heroDesc = css`
  font-size: clamp(0.9rem, 1.5vw, 1.1rem);
  color: ${TOKENS.textMuted};
  max-width: 560px;
  margin-bottom: 40px;
`

const heroActions = css`
  display: flex;
  gap: 16px;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 48px;
`

const btnPrimary = css`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 14px 32px;
  background: ${TOKENS.accent};
  color: #fff;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  transition: background 0.15s ease, transform 0.15s ease;
  &:hover { background: #2563eb; color: #fff; transform: translateY(-1px); }
`

const btnSecondary = css`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 14px 32px;
  background: transparent;
  color: #e2e8f0;
  border: 1px solid ${TOKENS.border};
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  transition: border-color 0.15s ease, background 0.15s ease;
  &:hover { border-color: ${TOKENS.borderActive}; background: ${TOKENS.bgCard}; }
`

// ── Terminal window in hero ───────────────────────────────────────────────────

const termWindow = css`
  background: #0a0f1e;
  border: 1px solid ${TOKENS.border};
  border-radius: 10px;
  overflow: hidden;
  max-width: 640px;
  width: 100%;
  text-align: left;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
`

const termHeader = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: #131d2e;
  border-bottom: 1px solid ${TOKENS.border};
`

const termDot = (color: string): StyleRef => css`
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: ${color};
`

const termBody = css`
  padding: 20px 24px;
  font-family: ${TOKENS.fontMono};
  font-size: 0.85rem;
  line-height: 1.8;
  color: #94a3b8;
`

const termPrompt = css`
  color: ${TOKENS.green};
`

const termCmd = css`
  color: #e2e8f0;
`

const termOutput = css`
  color: ${TOKENS.textDim};
  padding-left: 16px;
`

const termCursor = css`
  display: inline-block;
  width: 8px;
  height: 16px;
  background: ${TOKENS.accent};
  animation: sk-blink 1s step-end infinite;
  vertical-align: text-bottom;
  margin-left: 4px;
`

// ── Stats bar ─────────────────────────────────────────────────────────────────

const statsBar = css`
  display: flex;
  justify-content: center;
  gap: 48px;
  padding: 48px 24px;
  flex-wrap: wrap;
  border-top: 1px solid ${TOKENS.border};
  border-bottom: 1px solid ${TOKENS.border};
  background: ${TOKENS.bgAlt};
`

const statItem = css`
  text-align: center;
`

const statValue = css`
  font-size: 1.75rem;
  font-weight: 800;
  color: #f1f5f9;
  font-family: ${TOKENS.fontMono};
`

const statLabel = css`
  font-size: 0.8rem;
  color: ${TOKENS.textDim};
  margin-top: 4px;
`

// ── Features grid ─────────────────────────────────────────────────────────────

const featGrid = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 20px;
`

const featCard = css`
  background: ${TOKENS.bgCard};
  border: 1px solid ${TOKENS.border};
  border-radius: 12px;
  padding: 28px;
  transition: border-color 0.2s ease, transform 0.2s ease;
  position: relative;
  overflow: hidden;
  &:hover {
    border-color: ${TOKENS.accent};
    transform: translateY(-2px);
  }
`

const featCardGlow = css`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, ${TOKENS.accent}, transparent);
`

const featIcon = css`
  font-size: 1.5rem;
  margin-bottom: 14px;
  line-height: 1;
`

const featTitle = css`
  font-size: 1.05rem;
  font-weight: 600;
  color: #f1f5f9;
  margin-bottom: 8px;
`

const featDesc = css`
  font-size: 0.85rem;
  color: ${TOKENS.textDim};
  line-height: 1.7;
`

// ── Architecture diagram ──────────────────────────────────────────────────────

const archSection = css`
  background: ${TOKENS.bgAlt};
`

const archDiagram = css`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  flex-wrap: wrap;
  max-width: 960px;
  margin: 0 auto;
  padding: 20px 0;
`

const archLayer = css`
  flex: 1;
  min-width: 200px;
  text-align: center;
  padding: 24px 20px;
  background: ${TOKENS.bgCard};
  border: 1px solid ${TOKENS.border};
  border-radius: 10px;
  position: relative;
`

const archLayerLabel = css`
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: ${TOKENS.textMuted};
  margin-bottom: 8px;
`

const archLayerTitle = css`
  font-size: 1rem;
  font-weight: 700;
  color: #f1f5f9;
  margin-bottom: 4px;
`

const archLayerDesc = css`
  font-size: 0.8rem;
  color: ${TOKENS.textDim};
  line-height: 1.5;
`

const archArrow = css`
  display: flex;
  align-items: center;
  padding: 0 12px;
  color: ${TOKENS.accent};
  font-size: 1.25rem;
  flex-shrink: 0;
`

const archLayerHighlight = css`
  border-color: ${TOKENS.accent};
  box-shadow: 0 0 20px ${TOKENS.accentGlow};
`

const archNote = css`
  text-align: center;
  margin-top: 32px;
  font-size: 0.85rem;
  color: ${TOKENS.textMuted};
  font-family: ${TOKENS.fontMono};
`

// ── Comparison / Why Sikong ────────────────────────────────────────────────

const compGrid = css`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  max-width: 960px;
  margin: 0 auto;
`

const compCol = css`
  background: ${TOKENS.bgCard};
  border: 1px solid ${TOKENS.border};
  border-radius: 12px;
  padding: 32px;
`

const compColBad = css`
  border-color: #3d1f1f;
`

const compColGood = css`
  border-color: #1a3d2a;
`

const compHeader = css`
  font-size: 1.125rem;
  font-weight: 700;
  margin-bottom: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
`

const compItem = css`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
  font-size: 0.9rem;
  color: #cbd5e1;
  line-height: 1.5;
`

const compItemDim = css`
  color: ${TOKENS.textDim};
`

// ── Install section ───────────────────────────────────────────────────────────

const installTabs = css`
  display: flex;
  gap: 4px;
  justify-content: center;
  margin-bottom: 20px;
  flex-wrap: wrap;
`

const installTab = css`
  padding: 8px 20px;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  color: ${TOKENS.textDim};
  background: ${TOKENS.bgCard};
  border: 1px solid ${TOKENS.border};
  cursor: pointer;
  transition: all 0.15s ease;
`

const installTabActive = css`
  color: #f1f5f9;
  border-color: ${TOKENS.accent};
  background: rgba(59, 130, 246, 0.1);
`

const codeBlock = css`
  background: #0a0f1e;
  border: 1px solid ${TOKENS.border};
  border-radius: 10px;
  overflow: hidden;
  max-width: 620px;
  margin: 0 auto 12px;
`

const codeBlockHeader = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #131d2e;
  border-bottom: 1px solid ${TOKENS.border};
  font-size: 0.75rem;
  color: ${TOKENS.textMuted};
`

const codeBlockLabel = css`
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
`

const codeBlockBody = css`
  padding: 16px 20px;
  font-family: ${TOKENS.fontMono};
  font-size: 0.85rem;
  line-height: 1.8;
  color: #94a3b8;
  overflow-x: auto;
  user-select: all;
`

const codeComment = css`
  color: ${TOKENS.textMuted};
`

const codePrompt = css`
  color: ${TOKENS.green};
`

const codeCmd = css`
  color: #e2e8f0;
`

const codeOutput = css`
  color: ${TOKENS.textDim};
`

const installHint = css`
  text-align: center;
  font-size: 0.85rem;
  color: ${TOKENS.textDim};
  margin-top: 12px;
`

// ── Keyframes ─────────────────────────────────────────────────────────────────

const keyframes = `
@keyframes sk-blink {
  50% { opacity: 0; }
}
`

// ── Footer ────────────────────────────────────────────────────────────────────

const footerMain = css`
  border-top: 1px solid ${TOKENS.border};
  background: ${TOKENS.bg};
`

const footerGrid = css`
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr;
  gap: 40px;
  max-width: 1200px;
  margin: 0 auto;
  padding: 60px 24px;

  @media (max-width: 768px) {
    grid-template-columns: 1fr 1fr;
  }
`

const footerBrand = css`
  font-size: 1.125rem;
  font-weight: 700;
  color: #f1f5f9;
  margin-bottom: 8px;
`

const footerDesc = css`
  font-size: 0.85rem;
  color: ${TOKENS.textDim};
  line-height: 1.6;
  max-width: 320px;
`

const footerColTitle = css`
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: ${TOKENS.textMuted};
  margin-bottom: 16px;
`

const footerColList = css`
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
`

const footerLink = css`
  font-size: 0.85rem;
  color: ${TOKENS.textDim};
  transition: color 0.15s ease;
  &:hover { color: #94a3b8; }
`

const footerBottom = css`
  border-top: 1px solid ${TOKENS.border};
  padding: 20px 24px;
  text-align: center;
  font-size: 0.8rem;
  color: ${TOKENS.textMuted};
`

// ── Components ────────────────────────────────────────────────────────────────

/** Sticky navigation bar. */
export function Nav(): JSXNode {
  return h("nav", { class: nav },
    h("div", { class: [container, navInner] },
      h("div", { class: navBrand },
        h("span", { class: navBrandBracket }, "["),
        "sikong",
        h("span", { class: navBrandBracket }, "]"),
      ),
      h("div", { class: navLinks },
        h("a", { class: navLink, href: "#features" }, "Features"),
        h("a", { class: navLink, href: "#architecture" }, "Architecture"),
        h("a", { class: navLink, href: "#install" }, "Install"),
        h("a",
          {
            class: navCta,
            href: "https://github.com/lidessen/sikong",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "GitHub",
        ),
      ),
    ),
  )
}

/** Hero section — headline, terminal window, CTA. */
export function Hero(): JSXNode {
  return h("section", { class: hero },
    h("div", { class: gridBg }),
    h("div", { class: heroGlow }),
    h("span", { class: heroVersion }, "v0.1.7 — MIT"),
    h("h1", { class: heroGradient }, "Sikong (司空)"),
    h("p", { class: heroTagline }, "Durable wake-loop workspace for agent-driven development"),
    h("p", { class: heroDesc },
      "A universal coordination layer for multi-runtime, multi-model agent workflows.",
    ),
    h("div", { class: heroActions },
      h("a",
        {
          class: btnPrimary,
          href: "https://github.com/lidessen/sikong",
          target: "_blank",
          rel: "noopener noreferrer",
        },
        "Get Started",
      ),
      h("a", { class: btnSecondary, href: "#install" }, "Quick Install"),
    ),
    h("div", { class: termWindow },
      h("div", { class: termHeader },
        h("span", { class: termDot("#ef4444") }),
        h("span", { class: termDot("#f59e0b") }),
        h("span", { class: termDot("#22c55e") }),
      ),
      h("div", { class: termBody },
        h("span", { class: termPrompt }, "$ "),
        h("span", { class: termCmd }, "sikong init my-project"),
        h("br", {}),
        h("span", { class: termOutput }, "  ✓ Created project workspace"),
        h("br", {}),
        h("span", { class: termOutput }, "  ✓ Configured default worker"),
        h("br", {}),
        h("span", { class: termPrompt }, "$ "),
        h("span", { class: termCmd }, "sikong run"),
        h("br", {}),
        h("span", { class: termOutput }, "  ├─ [dev]   Code task … done"),
        h("br", {}),
        h("span", { class: termOutput }, "  ├─ [test]  Run tests … done"),
        h("br", {}),
        h("span", { class: termOutput }, "  └─ [review] Code review … done"),
        h("br", {}),
        h("span", { class: termOutput }, "  Agent: 3 tasks completed in 12.4s"),
        h("span", { class: termCursor }),
      ),
    ),
  )
}

/** Stats bar — social proof metrics. */
export function StatsBar(): JSXNode {
  return h("div", { class: statsBar },
    h("div", { class: statItem },
      h("div", { class: statValue }, "4"),
      h("div", { class: statLabel }, "Runtime Backends"),
    ),
    h("div", { class: statItem },
      h("div", { class: statValue }, "1.2M+"),
      h("div", { class: statLabel }, "Tokens Processed"),
    ),
    h("div", { class: statItem },
      h("div", { class: statValue }, "100%"),
      h("div", { class: statLabel }, "Open Source"),
    ),
    h("div", { class: statItem },
      h("div", { class: statValue }, "MIT"),
      h("div", { class: statLabel }, "License"),
    ),
  )
}

/** Features grid — core capabilities. */
export function Features(): JSXNode {
  const FEATURES = [
    {
      icon: "⚙️",
      title: "Task Orchestration",
      desc: "Define multi-step agent workflows with retries, timeouts, and handoff-based state management across runs.",
    },
    {
      icon: "📡",
      title: "Cost-aware Routing",
      desc: "Smart model selection per task — route cheap work to fast models, escalate complex reasoning automatically.",
    },
    {
      icon: "🔄",
      title: "Multi-runtime Support",
      desc: "Claude Code, Codex, Cursor Agent SDK, Vercel AI SDK — one orchestration layer works across all major runtimes.",
    },
    {
      icon: "💾",
      title: "JSONL-backed Stores",
      desc: "Durable, inspectable, append-only state. Every workspace event is logged for audit, recovery, and replay.",
    },
    {
      icon: "📊",
      title: "Live Monitor Dashboard",
      desc: "Real-time dashboard showing project overview, task progress, usage metrics, and cost breakdowns.",
    },
    {
      icon: "⌨️",
      title: "CLI-first Design",
      desc: "Built for the terminal. Git-native isolation, JSON output for scripting, minimal ceremony.",
    },
    {
      icon: "🔌",
      title: "Provider-agnostic",
      desc: "Swap LLM providers per runtime — DeepSeek, Anthropic, OpenAI, or any compatible gateway.",
    },
    {
      icon: "🔬",
      title: "Deterministic Replay",
      desc: "Every session is a JSONL replay log. Re-run, debug, or audit any past workflow exactly as it happened.",
    },
  ]

  return h("section", { id: "features" },
    h("div", { class: [sectionPadding] },
      h("div", { class: container },
        h("h2", { class: sectionTitle }, "Everything you need for agent-driven development"),
        h("p", { class: sectionSub },
          "From orchestration to cost management — Sikong provides the coordination layer for AI-assisted development.",
        ),
        h("div", { class: featGrid },
          ...FEATURES.map((f) =>
            h("div", { class: [featCard, "sk-card"] },
              h("div", { class: featCardGlow }),
              h("div", { class: featIcon }, f.icon),
              h("h3", { class: featTitle }, f.title),
              h("p", { class: featDesc }, f.desc),
            )
          ),
        ),
      ),
    ),
  )
}

/** Architecture diagram — layers visual. */
export function Architecture(): JSXNode {
  const layers = [
    { label: "Layer 1", title: "CLI & Dashboard", desc: "User interface & project management" },
    { label: "Layer 2", title: "Workflow Engine", desc: "Task orchestration & state machine", highlight: true },
    { label: "Layer 3", title: "Runtime Adapters", desc: "Claude · Codex · Cursor · AI SDK" },
  ]

  return h("section", { id: "architecture", class: archSection },
    h("div", { class: [sectionPadding] },
      h("div", { class: container },
        h("h2", { class: sectionTitle }, "Architecture"),
        h("p", { class: sectionSub },
          "Three concentric layers with a clean data flow: factory → executor → adapter → backend.",
        ),
        h("div", { class: archDiagram },
          ...layers.flatMap((layer, i) => {
            const el = h("div",
              {
                class: [archLayer, layer.highlight ? archLayerHighlight : null],
              },
              h("div", { class: archLayerLabel }, layer.label),
              h("div", { class: archLayerTitle }, layer.title),
              h("div", { class: archLayerDesc }, layer.desc),
            )
            return i < layers.length - 1
              ? [el, h("div", { class: archArrow }, "→")]
              : [el]
          }),
        ),
        h("div", { class: archNote }, "// Runtime ⊥ Provider — one credential, any runtime"),
      ),
    ),
  )
}

/** Comparison — "Without vs With Sikong". */
export function Comparison(): JSXNode {
  const without = [
    "Manual agent orchestration scripts",
    "Vendor lock-in to one runtime",
    "No cross-session state management",
    "Implicit cost tracking",
    "Reinvent infrastructure per project",
  ]
  const withSikong = [
    "Declarative workflow definitions",
    "Plug-and-play runtime backends",
    "JSONL-backed durable state & replay",
    "Built-in usage and cost analytics",
    "Consistent tooling across projects",
  ]

  return h("div", { class: [sectionPadding] },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Why Sikong?"),
      h("p", { class: sectionSub },
        "Stop wiring agent infrastructure by hand. Focus on building, not plumbing.",
      ),
      h("div", { class: compGrid },
        h("div", { class: [compCol, compColBad] },
          h("div", { class: compHeader }, "❌ Without Sikong"),
          ...without.map((item) =>
            h("div", { class: compItem },
              h("span", { style: { color: "#ef4444", flexShrink: 0 } }, "✕"),
              h("span", {}, item),
            )
          ),
        ),
        h("div", { class: [compCol, compColGood] },
          h("div", { class: compHeader }, "✅ With Sikong"),
          ...withSikong.map((item) =>
            h("div", { class: compItem },
              h("span", { style: { color: "#22c55e", flexShrink: 0 } }, "✓"),
              h("span", {}, item),
            )
          ),
        ),
      ),
    ),
  )
}

/** Install section — tabbed code blocks. */
export function Install(): JSXNode {
  return h("section", { id: "install", class: archSection },
    h("div", { class: [sectionPadding] },
      h("div", { class: container },
        h("h2", { class: sectionTitle }, "Quick Install"),
        h("p", { class: sectionSub },
          "Get Sikong running in seconds. Choose your method:",
        ),
        h("div", { class: codeBlock },
          h("div", { class: codeBlockHeader },
            h("span", { class: codeBlockLabel }, "CURL"),
            h("span", {}, "macOS / Linux"),
          ),
          h("div", { class: codeBlockBody },
            h("span", { class: codeComment }, "# Install the latest release"),
            h("br", {}),
            h("span", { class: codePrompt }, "$ "),
            h("span", { class: codeCmd }, "curl -fsSL https://sikong.dev/install.sh | sh"),
            h("br", {}),
            h("br", {}),
            h("span", { class: codeComment }, "# Verify it's working"),
            h("br", {}),
            h("span", { class: codePrompt }, "$ "),
            h("span", { class: codeCmd }, "sikong help"),
          ),
        ),
        h("div", { class: codeBlock },
          h("div", { class: codeBlockHeader },
            h("span", { class: codeBlockLabel }, "NPM"),
            h("span", {}, "Any platform"),
          ),
          h("div", { class: codeBlockBody },
            h("span", { class: codeComment }, "# Install globally via npm"),
            h("br", {}),
            h("span", { class: codePrompt }, "$ "),
            h("span", { class: codeCmd }, "npm install -g sikong"),
            h("br", {}),
            h("br", {}),
            h("span", { class: codeComment }, "# Or run from source"),
            h("br", {}),
            h("span", { class: codePrompt }, "$ "),
            h("span", { class: codeCmd }, "git clone https://github.com/lidessen/sikong"),
            h("br", {}),
            h("span", { class: codePrompt }, "$ "),
            h("span", { class: codeCmd }, "cd sikong && bun install && bun run build"),
          ),
        ),
      ),
    ),
  )
}

/** CTA section. */
export function CTA(): JSXNode {
  return h("section",
    {
      class: sectionPadding,
      style: { background: `linear-gradient(135deg, ${TOKENS.bg} 0%, ${TOKENS.bgAlt} 50%, #131d2e 100%)` },
    },
    h("div", { class: container, style: { textAlign: "center" } },
      h("h2", { class: sectionTitle }, "Get Involved"),
      h("p", { class: sectionSub },
        "Sikong is open-source (MIT) and built for the agent-driven development community. Contributions welcome!",
      ),
      h("div", { style: { display: "flex", gap: "16px", justifyContent: "center", flexWrap: "wrap" } },
        h("a",
          {
            class: btnPrimary,
            href: "https://github.com/lidessen/sikong",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Star on GitHub",
        ),
        h("a",
          { class: btnSecondary, href: "https://sikong.dev/docs" },
          "Read the Docs",
        ),
      ),
    ),
  )
}

/** Footer — 4-column sitemap. */
export function Footer(): JSXNode {
  return h("footer", { class: footerMain },
    h("div", { class: footerGrid },
      h("div", {},
        h("div", { class: footerBrand }, "Sikong (司空)"),
        h("p", { class: footerDesc },
          "Durable wake-loop workspaces for agent-driven development. MIT licensed.",
        ),
      ),
      h("div", {},
        h("div", { class: footerColTitle }, "Product"),
        h("ul", { class: footerColList },
          h("li", {}, h("a", { class: footerLink, href: "#features" }, "Features")),
          h("li", {}, h("a", { class: footerLink, href: "#architecture" }, "Architecture")),
          h("li", {}, h("a", { class: footerLink, href: "#install" }, "Install")),
          h("li", {}, h("a", { class: footerLink, href: "/changelog" }, "Changelog")),
        ),
      ),
      h("div", {},
        h("div", { class: footerColTitle }, "Community"),
        h("ul", { class: footerColList },
          h("li", {}, h("a", { class: footerLink, href: "https://github.com/lidessen/sikong", target: "_blank", rel: "noopener noreferrer" }, "GitHub")),
          h("li", {}, h("a", { class: footerLink, href: "https://github.com/lidessen/sikong/issues", target: "_blank", rel: "noopener noreferrer" }, "Issues")),
          h("li", {}, h("a", { class: footerLink, href: "https://sikong.dev/community" }, "Community")),
        ),
      ),
      h("div", {},
        h("div", { class: footerColTitle }, "Resources"),
        h("ul", { class: footerColList },
          h("li", {}, h("a", { class: footerLink, href: "https://sikong.dev/docs" }, "Documentation")),
          h("li", {}, h("a", { class: footerLink, href: "https://github.com/lidessen/sikong/blob/main/README.md", target: "_blank", rel: "noopener noreferrer" }, "README")),
          h("li", {}, h("a", { class: footerLink, href: "https://sikong.dev/install.sh" }, "install.sh")),
        ),
      ),
    ),
    h("div", { class: footerBottom },
      "Copyright ", String(new Date().getFullYear()), " — Sikong. MIT License. Built with Bun, semajsx, and agent-loop.",
    ),
  )
}

/** Page — top-level layout. */
export function Page(): JSXNode {
  return fragment({ children: [
    h("style", {}, keyframes),
    Nav(),
    Hero(),
    StatsBar(),
    Features(),
    Architecture(),
    Comparison(),
    Install(),
    CTA(),
    Footer(),
  ]})
}
