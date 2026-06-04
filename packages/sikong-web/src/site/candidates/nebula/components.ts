/**
 * Candidate B: "Nebula" — Bold Colorful Product Landing
 *
 * An editorial, brand-forward design. Large typography, full-width color-block
 * sections, a "How It Works" step-through, and rich visual hierarchy that
 * makes Sikong feel like a major platform.
 *
 * @module
 */

import { jsx as h, Fragment as fragment } from "semajsx/core"
import { css } from "semajsx/style"
import type { JSXNode } from "semajsx/html"
import type { StyleRef } from "semajsx/style"

// ── Design tokens ─────────────────────────────────────────────────────────────

const TOKENS = {
  bg: "#0a0f1e",
  bgAlt: "#111827",
  bgCard: "#1a2332",
  border: "#1e293b",
  text: "#f1f5f9",
  textDim: "#94a3b8",
  textMuted: "#64748b",
  primary: "#7c3aed",
  primaryLight: "#a78bfa",
  accent: "#f59e0b",
  accent2: "#ec4899",
  teal: "#14b8a6",
  fontMono: '"SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", monospace',
  fontSans:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", Helvetica, Arial, sans-serif',
} as const

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
a { color: ${TOKENS.primaryLight}; text-decoration: none; }
a:hover { color: #c4b5fd; }
::selection { background: rgba(124, 58, 237, 0.3); }
code { font-family: ${TOKENS.fontMono}; }
`

// ── Layout utilities ──────────────────────────────────────────────────────────

const container = css`max-width: 1200px; margin: 0 auto; padding: 0 24px;`
const sectionPad = css`padding: 100px 0;`

// ── Navigation ────────────────────────────────────────────────────────────────

const nav = css`
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  background: rgba(10, 15, 30, 0.8); backdrop-filter: blur(16px);
  border-bottom: 1px solid ${TOKENS.border};
`

const navInner = css`
  display: flex; align-items: center; justify-content: space-between;
  height: 64px;
`

const navBrand = css`
  font-size: 1.25rem; font-weight: 800; color: #f1f5f9;
  letter-spacing: -0.03em;
  background: linear-gradient(135deg, #a78bfa, #f59e0b);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
`

const navLinks = css`
  display: flex; align-items: center; gap: 24px;
`

const navLink = css`
  font-size: 0.85rem; color: ${TOKENS.textDim};
  transition: color 0.15s;
  &:hover { color: #e2e8f0; }
`

const navCta = css`
  padding: 8px 20px; background: ${TOKENS.primary}; color: #fff;
  border-radius: 6px; font-size: 0.85rem; font-weight: 600;
  &:hover { background: #6d28d9; color: #fff; }
`

// ── Hero ──────────────────────────────────────────────────────────────────────

const hero = css`
  min-height: 95vh; display: flex; flex-direction: column;
  align-items: center; justify-content: center; text-align: center;
  padding: 120px 24px 80px; position: relative; overflow: hidden;
  background: linear-gradient(160deg, #0a0f1e 0%, #1a0a2e 40%, #0f1a2e 70%, #0a0f1e 100%);
`

const heroBgGlow = css`
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at 30% 20%, rgba(124, 58, 237, 0.1) 0%, transparent 50%),
              radial-gradient(ellipse at 70% 60%, rgba(245, 158, 11, 0.06) 0%, transparent 50%);
  pointer-events: none;
`

const heroEyebrow = css`
  display: inline-block; padding: 6px 16px; border-radius: 20px;
  background: rgba(124, 58, 237, 0.12); border: 1px solid rgba(124, 58, 237, 0.25);
  font-size: 0.8rem; color: ${TOKENS.primaryLight}; font-weight: 500;
  margin-bottom: 24px; position: relative;
`

const heroTitle = css`
  font-size: clamp(3rem, 7vw, 5.5rem); font-weight: 900;
  line-height: 1.05; letter-spacing: -0.04em; margin-bottom: 24px;
  position: relative;
`

const heroAccentLine1 = css`
  display: block; color: #f1f5f9;
`

const heroAccentLine2 = css`
  display: block;
  background: linear-gradient(135deg, #a78bfa, #f59e0b, #ec4899);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
`

const heroTagline = css`
  font-size: clamp(1.1rem, 2vw, 1.35rem); color: ${TOKENS.textDim};
  max-width: 600px; position: relative; line-height: 1.7;
  margin-bottom: 36px;
`

const heroActions = css`
  display: flex; gap: 16px; justify-content: center; flex-wrap: wrap;
  position: relative; margin-bottom: 48px;
`

const btnPrimary = css`
  display: inline-flex; align-items: center; gap: 8px;
  padding: 16px 36px; background: ${TOKENS.primary}; color: #fff;
  border-radius: 10px; font-size: 1rem; font-weight: 600;
  transition: all 0.2s;
  &:hover { background: #6d28d9; color: #fff; transform: translateY(-1px); box-shadow: 0 4px 20px rgba(124, 58, 237, 0.3); }
`

const btnSecondary = css`
  display: inline-flex; align-items: center; gap: 8px;
  padding: 16px 36px; background: transparent; color: #e2e8f0;
  border: 1px solid ${TOKENS.border}; border-radius: 10px;
  font-size: 1rem; font-weight: 600; transition: all 0.2s;
  &:hover { border-color: ${TOKENS.textMuted}; background: ${TOKENS.bgAlt}; }
`

const heroBottom = css`
  display: flex; gap: 40px; align-items: center; justify-content: center;
  flex-wrap: wrap; position: relative;
`

const heroMeta = css`
  display: flex; align-items: center; gap: 6px;
  font-size: 0.85rem; color: ${TOKENS.textMuted};
`

const heroMetaDot = css`
  width: 6px; height: 6px; border-radius: 50%; background: ${TOKENS.teal};
`

// ── Section titles (shared) ──────────────────────────────────────────────────

const sectionTitle = css`
  font-size: clamp(2rem, 4vw, 2.75rem); font-weight: 800;
  text-align: center; margin-bottom: 16px; letter-spacing: -0.025em;
`

const sectionSub = css`
  font-size: 1.05rem; color: ${TOKENS.textDim}; text-align: center;
  max-width: 640px; margin: 0 auto 56px; line-height: 1.7;
`

// ── "How It Works" section ────────────────────────────────────────────────────

const howSteps = css`
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px;
  position: relative;

  @media (max-width: 900px) { grid-template-columns: repeat(2, 1fr); }
`

const howConnector = css`
  display: none;
  @media (min-width: 901px) {
    display: block; position: absolute; top: 44px;
    left: calc(12.5% + 20px); right: calc(12.5% + 20px);
    height: 2px;
    background: linear-gradient(90deg, ${TOKENS.primary}, ${TOKENS.accent}, ${TOKENS.accent2});
  }
`

const howStep = css`
  text-align: center; padding: 32px 20px; position: relative;
  background: ${TOKENS.bgCard}; border: 1px solid ${TOKENS.border};
  border-radius: 14px; transition: transform 0.2s, border-color 0.2s;
  &:hover { transform: translateY(-3px); border-color: ${TOKENS.primaryLight}; }
`

const howNumber = css`
  width: 48px; height: 48px; border-radius: 24px;
  display: flex; align-items: center; justify-content: center;
  margin: 0 auto 16px; font-size: 1.125rem; font-weight: 800;
  font-family: ${TOKENS.fontMono}; color: #fff;
  position: relative; z-index: 1;
`

const howTitle = css`
  font-size: 1.05rem; font-weight: 700; margin-bottom: 8px; color: #f1f5f9;
`

const howDesc = css`
  font-size: 0.85rem; color: ${TOKENS.textDim}; line-height: 1.6;
`

// ── Features grid ─────────────────────────────────────────────────────────────

const featGrid = css`
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px;
  @media (max-width: 900px) { grid-template-columns: repeat(2, 1fr); }
  @media (max-width: 600px) { grid-template-columns: 1fr; }
`

const featCard = css`
  padding: 28px; border-radius: 14px;
  border: 1px solid ${TOKENS.border}; background: ${TOKENS.bgCard};
  transition: all 0.25s ease;
  &:hover { border-color: ${TOKENS.primaryLight}; box-shadow: 0 4px 24px rgba(124, 58, 237, 0.08); }
`

const featIconBox = css`
  width: 44px; height: 44px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  font-size: 1.25rem; margin-bottom: 16px;
`

const featTitle = css`
  font-size: 1rem; font-weight: 700; color: #f1f5f9; margin-bottom: 8px;
`

const featDesc = css`
  font-size: 0.85rem; color: ${TOKENS.textDim}; line-height: 1.7;
`

// ── Alt section background ───────────────────────────────────────────────────

const altSection = css`
  background: linear-gradient(180deg, ${TOKENS.bg} 0%, ${TOKENS.bgAlt} 100%);
`

const altSection2 = css`
  background: linear-gradient(180deg, ${TOKENS.bgAlt} 0%, ${TOKENS.bg} 100%);
`

// ── Runtime badges section ────────────────────────────────────────────────────

const badgeRow = css`
  display: flex; justify-content: center; gap: 16px; flex-wrap: wrap;
`

const runtimeBadge = css`
  display: flex; align-items: center; gap: 10px;
  padding: 14px 24px; border-radius: 10px;
  background: ${TOKENS.bgCard}; border: 1px solid ${TOKENS.border};
  font-size: 0.9rem; font-weight: 600; color: #e2e8f0;
`

const runtimeIcon = css`
  font-size: 1.3rem;
`

// ── Architecture flow ─────────────────────────────────────────────────────────

const archRow = css`
  display: flex; align-items: stretch; justify-content: center;
  gap: 0; flex-wrap: wrap; max-width: 900px; margin: 0 auto;
`

const archBlock = css`
  flex: 1; min-width: 160px; padding: 24px 20px; text-align: center;
  background: ${TOKENS.bgCard}; border: 1px solid ${TOKENS.border};
  position: relative;
`

const archBlockLabel = css`
  font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.1em; color: ${TOKENS.textMuted}; margin-bottom: 8px;
`

const archBlockTitle = css`
  font-size: 0.9rem; font-weight: 700; color: #f1f5f9; margin-bottom: 4px;
`

const archBlockDesc = css`
  font-size: 0.75rem; color: ${TOKENS.textDim}; line-height: 1.5;
`

const archArrowEl = css`
  display: flex; align-items: center; padding: 0 6px;
  color: ${TOKENS.primaryLight}; font-weight: 700; font-size: 1rem;
`

// ── Install section ───────────────────────────────────────────────────────────

const installGrid = css`
  display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-width: 800px; margin: 0 auto;

  @media (max-width: 640px) { grid-template-columns: 1fr; }
`

const installCard = css`
  background: #0a0f1e; border: 1px solid ${TOKENS.border}; border-radius: 10px;
  overflow: hidden;
`

const installCardHeader = css`
  padding: 12px 16px; background: #131d2e; border-bottom: 1px solid ${TOKENS.border};
  font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; color: ${TOKENS.textMuted};
  display: flex; align-items: center; justify-content: space-between;
`

const installCardBody = css`
  padding: 20px; font-family: ${TOKENS.fontMono}; font-size: 0.8rem;
  line-height: 2; color: #94a3b8; overflow-x: auto; user-select: all;
`

// ── Trust / CTA section ───────────────────────────────────────────────────────

const trustLogos = css`
  display: flex; justify-content: center; gap: 40px; flex-wrap: wrap;
  margin-bottom: 48px;
`

const trustItem = css`
  display: flex; flex-direction: column; align-items: center; gap: 6px;
`

const trustIcon = css`
  font-size: 2rem;
`

const trustLabel = css`
  font-size: 0.85rem; color: ${TOKENS.textDim}; font-weight: 500;
`

// ── Footer ────────────────────────────────────────────────────────────────────

const footer = css`
  border-top: 1px solid ${TOKENS.border};
  padding: 56px 24px 32px;
`

const footerGrid = css`
  display: grid; grid-template-columns: 2fr 1fr 1fr;
  gap: 40px; max-width: 1200px; margin: 0 auto;
  @media (max-width: 640px) { grid-template-columns: 1fr; }
`

const footerBrand = css`
  font-size: 1.25rem; font-weight: 800; margin-bottom: 12px;
  background: linear-gradient(135deg, #a78bfa, #f59e0b);
  background-clip: text; -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
`

const footerDesc = css`
  font-size: 0.85rem; color: ${TOKENS.textDim}; line-height: 1.6; max-width: 300px;
`

const footerColTitle = css`
  font-size: 0.8rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: ${TOKENS.textMuted}; margin-bottom: 16px;
`

const footerLinks = css`
  list-style: none; display: flex; flex-direction: column; gap: 10px;
`

const footerLink = css`
  font-size: 0.85rem; color: ${TOKENS.textDim};
  &:hover { color: ${TOKENS.primaryLight}; }
`

const footerBottom = css`
  text-align: center; padding-top: 32px; margin-top: 40px;
  border-top: 1px solid ${TOKENS.border};
  font-size: 0.8rem; color: ${TOKENS.textMuted};
`

// ── Keyframes ─────────────────────────────────────────────────────────────────

const KEYFRAMES = `
@keyframes sk-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
@keyframes sk-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}
`

// ── Components ────────────────────────────────────────────────────────────────

/** Sticky nav. */
export function Nav(): JSXNode {
  return h("nav", { class: nav },
    h("div", { class: [container, navInner] },
      h("a", { class: navBrand, href: "#" }, "Sikong"),
      h("div", { class: navLinks },
        h("a", { class: navLink, href: "#features" }, "Features"),
        h("a", { class: navLink, href: "#how" }, "How It Works"),
        h("a", { class: navLink, href: "#install" }, "Install"),
        h("a", { class: [navCta], href: "https://github.com/lidessen/sikong", target: "_blank", rel: "noopener noreferrer" }, "GitHub →"),
      ),
    ),
  )
}

/** Hero — large typography, gradient text, badge. */
export function Hero(): JSXNode {
  return h("section", { class: hero },
    h("div", { class: heroBgGlow }),
    h("span", { class: heroEyebrow }, "✦ v0.1.7 — Open Source (MIT)"),
    h("h1", { class: heroTitle },
      h("span", { class: heroAccentLine1 }, "Agent-Driven"),
      h("span", { class: heroAccentLine2 }, "Development Platform"),
    ),
    h("p", { class: heroTagline },
      "Unified orchestration across Claude Code, Codex, Cursor, and AI SDK — ",
      "with durable state, cost routing, and live monitoring built in.",
    ),
    h("div", { class: heroActions },
      h("a", { class: btnPrimary, href: "https://github.com/lidessen/sikong", target: "_blank", rel: "noopener noreferrer" }, "Get Started Free"),
      h("a", { class: btnSecondary, href: "#how" }, "Learn More"),
    ),
    h("div", { class: heroBottom },
      h("span", { class: heroMeta },
        h("span", { class: heroMetaDot }),
        "Multi-runtime",
      ),
      h("span", { class: heroMeta },
        h("span", { class: [heroMetaDot, css({ background: TOKENS.primaryLight })] }),
        "Cost-aware",
      ),
      h("span", { class: heroMeta },
        h("span", { class: [heroMetaDot, css({ background: TOKENS.accent })] }),
        "Open Source",
      ),
      h("span", { class: heroMeta },
        h("span", { class: [heroMetaDot, css({ background: TOKENS.accent2 })] }),
        "MIT License",
      ),
    ),
  )
}

/** Step-number generator helper. */
function stepNum(n: number, color: string): StyleRef {
  return css({ background: color })
}

/** "How It Works" 4-step process. */
export function HowItWorks(): JSXNode {
  const steps = [
    { num: "01", title: "Define", desc: "Declare your workflow stages, tools, and model preferences in a simple config.", color: "#7c3aed" },
    { num: "02", title: "Orchestrate", desc: "Run your task — Sikong routes work to the right runtime, handles retries, and manages state.", color: "#a78bfa" },
    { num: "03", title: "Monitor", desc: "Watch real-time progress with the live dashboard. Track tokens, costs, and task status at a glance.", color: "#f59e0b" },
    { num: "04", title: "Iterate", desc: "Review logs and usage data. Tweak your workflow and run again — every session is reproducible.", color: "#ec4899" },
  ]

  return h("section", { id: "how", class: [sectionPad, altSection] },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "How It Works"),
      h("p", { class: sectionSub },
        "From definition to iteration — Sikong streamlines the full agent development cycle.",
      ),
      h("div", { class: howSteps },
        h("div", { class: howConnector }),
        ...steps.map((s) =>
          h("div", { class: howStep },
            h("div", { class: [howNumber, stepNum(s.num, s.color)] }, s.num),
            h("div", { class: howTitle }, s.title),
            h("div", { class: howDesc }, s.desc),
          )
        ),
      ),
    ),
  )
}

/** Features grid — 2 columns, richer cards with colored icon backgrounds. */
export function Features(): JSXNode {
  const FEATURES = [
    { icon: "⚙️", title: "Task Orchestration", desc: "Multi-step agent workflows with automatic retries, timeouts, and cross-run state management via handoffs.", iconBg: "#1a1a3e" },
    { icon: "📡", title: "Cost-aware Routing", desc: "Smart model selection — route fast cheap models for simple tasks, escalate to powerful reasoning when needed.", iconBg: "#1a2e1a" },
    { icon: "🔄", title: "Multi-runtime Support", desc: "Claude Code, Codex, Cursor Agent SDK, Vercel AI SDK — one coordination layer across every major runtime.", iconBg: "#1a2e3e" },
    { icon: "💾", title: "JSONL-backed State", desc: "Durable append-only logs. Every event is inspectable. Audit, replay, and recover any past session.", iconBg: "#2e1a1a" },
    { icon: "📊", title: "Live Dashboard", desc: "Real-time terminal dashboard with project overviews, task progress, token usage, and cost breakdowns.", iconBg: "#1a2e2e" },
    { icon: "⌨️", title: "CLI-first", desc: "Git-native isolation, JSON output for scripting, and minimal ceremony. Designed to stay out of your way.", iconBg: "#2e1a2e" },
  ]

  return h("section", { id: "features" },
    h("div", { class: sectionPad },
      h("div", { class: container },
        h("h2", { class: sectionTitle }, "Everything you need"),
        h("p", { class: sectionSub },
          "From orchestration to insights — Sikong provides the coordination layer for AI-assisted development.",
        ),
        h("div", { class: featGrid },
          ...FEATURES.map((f) =>
            h("div", { class: featCard },
              h("div", { class: [featIconBox, css({ background: f.iconBg })] }, f.icon),
              h("h3", { class: featTitle }, f.title),
              h("p", { class: featDesc }, f.desc),
            )
          ),
        ),
      ),
    ),
  )
}

/** Runtime badges — show supported backends. */
export function RuntimeBadges(): JSXNode {
  const runtimes = [
    { icon: "🤖", name: "Claude Code" },
    { icon: "▲", name: "Codex" },
    { icon: "↗", name: "Cursor" },
    { icon: "⚡", name: "AI SDK" },
  ]

  return h("div", { class: [sectionPad, altSection2] },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Works With Your Stack"),
      h("p", { class: sectionSub },
        "Sikong adapts to your existing toolchain — swap runtimes without changing your workflow definitions.",
      ),
      h("div", { class: badgeRow },
        ...runtimes.map((r) =>
          h("div", { class: runtimeBadge },
            h("span", { class: runtimeIcon }, r.icon),
            r.name,
          )
        ),
      ),
    ),
  )
}

/** Architecture flow visual. */
export function Architecture(): JSXNode {
  const blocks = [
    { label: "User", title: "CLI & Dashboard", desc: "Interface & projects" },
    { label: "Core", title: "Workflow Engine", desc: "Orchestration & state" },
    { label: "Edge", title: "Runtime Adapters", desc: "Claude·Codex·Cursor·SDK" },
  ]

  return h("div", { class: [sectionPad, altSection] },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Architecture"),
      h("p", { class: sectionSub },
        "Clean separation of concerns — the loop engine is runtime-agnostic; adapters bridge the gap.",
      ),
      h("div", { class: archRow },
        ...blocks.flatMap((b, i) => {
          const el = h("div", { class: archBlock },
            h("div", { class: archBlockLabel }, b.label),
            h("div", { class: archBlockTitle }, b.title),
            h("div", { class: archBlockDesc }, b.desc),
          )
          return i < blocks.length - 1
            ? [el, h("div", { class: archArrowEl }, "▸")]
            : [el]
        }),
      ),
    ),
  )
}

/** Comparison table - Why Sikong. */
export function Comparison(): JSXNode {
  const rows = [
    { without: "Manual scripting per runtime", with: "One declarative workflow definition" },
    { without: "Vendor lock-in to one backend", with: "Swap runtimes via config change" },
    { without: "No cross-session visibility", with: "Full JSONL audit trail & replay" },
    { without: "Implicit token costs", with: "Built-in usage & cost analytics" },
    { without: "Reinvent per project", with: "Consistent tooling, project to project" },
  ]

  const compTable = css`
    max-width: 800px; margin: 0 auto; border-collapse: collapse;
    width: 100%;
  `

  const compTh = css`
    padding: 12px 16px; font-size: 0.85rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.05em;
    border-bottom: 2px solid ${TOKENS.border}; text-align: left;
  `

  const compTd = css`
    padding: 14px 16px; font-size: 0.9rem; border-bottom: 1px solid ${TOKENS.border};
    color: #cbd5e1;
  `

  const compTdAlt = css`
    background: rgba(124, 58, 237, 0.04);
  `

  return h("div", { class: [sectionPad, altSection2] },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Sikong vs. The Manual Way"),
      h("p", { class: sectionSub },
        "Stop wiring agent infrastructure by hand. Focus on building, not plumbing.",
      ),
      h("table", { class: compTable },
        h("thead", {},
          h("tr", {},
            h("th", { class: compTh, style: { color: "#ef4444", width: "40%" } }, "Without Sikong"),
            h("th", { class: compTh, style: { color: "#22c55e", width: "40%" } }, "With Sikong"),
          ),
        ),
        h("tbody", {},
          ...rows.map((r, i) =>
            h("tr", {},
              h("td", { class: [compTd, i % 2 ? compTdAlt : null] },
                h("span", { style: { color: "#ef4444", marginRight: "8px" } }, "✕"),
                r.without,
              ),
              h("td", { class: [compTd, i % 2 ? compTdAlt : null] },
                h("span", { style: { color: "#22c55e", marginRight: "8px" } }, "✓"),
                r.with,
              ),
            )
          ),
        ),
      ),
    ),
  )
}

/** Install section — two-column code blocks. */
export function Install(): JSXNode {
  return h("section", { id: "install", class: [sectionPad, altSection] },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Get Started in Seconds"),
      h("p", { class: sectionSub },
        "Choose your install method and start orchestrating agent workflows immediately.",
      ),
      h("div", { class: installGrid },
        h("div", { class: installCard },
          h("div", { class: installCardHeader },
            h("span", {}, "Curl"),
            h("span", { style: { fontWeight: 400, textTransform: "none" } }, "macOS / Linux"),
          ),
          h("div", { class: installCardBody },
            "curl -fsSL https://sikong.dev/install.sh | sh",
          ),
        ),
        h("div", { class: installCard },
          h("div", { class: installCardHeader },
            h("span", {}, "npm"),
            h("span", { style: { fontWeight: 400, textTransform: "none" } }, "Any platform"),
          ),
          h("div", { class: installCardBody },
            "npm install -g sikong",
          ),
        ),
      ),
      h("p", { style: { textAlign: "center", color: TOKENS.textMuted, fontSize: "0.85rem", marginTop: "20px" } },
        "Or clone from ", h("a", { href: "https://github.com/lidessen/sikong", target: "_blank", rel: "noopener noreferrer", style: { color: TOKENS.primaryLight } }, "GitHub"), " and run from source."
      ),
    ),
  )
}

/** CTA section. */
export function CTA(): JSXNode {
  return h("div", { class: [sectionPad], style: { textAlign: "center" } },
    h("div", { class: container },
      h("div", { class: trustLogos },
        h("div", { class: trustItem },
          h("div", { class: trustIcon }, "🔓"),
          h("div", { class: trustLabel }, "Open Source"),
        ),
        h("div", { class: trustItem },
          h("div", { class: trustIcon }, "📄"),
          h("div", { class: trustLabel }, "MIT License"),
        ),
        h("div", { class: trustItem },
          h("div", { class: trustIcon }, "🛡️"),
          h("div", { class: trustLabel }, "No Vendor Lock-in"),
        ),
        h("div", { class: trustItem },
          h("div", { class: trustIcon }, "🌐"),
          h("div", { class: trustLabel }, "Community-driven"),
        ),
      ),
      h("h2", { class: sectionTitle }, "Join the Community"),
      h("p", { class: sectionSub },
        "Sikong is built for the agent-driven development community. Star us on GitHub, contribute, or just follow along.",
      ),
      h("div", { style: { display: "flex", gap: "16px", justifyContent: "center", flexWrap: "wrap" } },
        h("a", { class: btnPrimary, href: "https://github.com/lidessen/sikong", target: "_blank", rel: "noopener noreferrer" }, "Star on GitHub ⭐"),
        h("a", { class: btnSecondary, href: "https://sikong.dev/docs" }, "Read Documentation"),
      ),
    ),
  )
}

/** Footer. */
export function Footer(): JSXNode {
  return h("footer", { class: footer },
    h("div", { class: footerGrid },
      h("div", {},
        h("div", { class: footerBrand }, "Sikong"),
        h("p", { class: footerDesc },
          "Durable wake-loop workspaces for agent-driven development. MIT licensed.",
        ),
      ),
      h("div", {},
        h("div", { class: footerColTitle }, "Product"),
        h("ul", { class: footerLinks },
          h("li", {}, h("a", { class: footerLink, href: "#features" }, "Features")),
          h("li", {}, h("a", { class: footerLink, href: "#how" }, "How It Works")),
          h("li", {}, h("a", { class: footerLink, href: "#install" }, "Install")),
          h("li", {}, h("a", { class: footerLink, href: "/changelog" }, "Changelog")),
        ),
      ),
      h("div", {},
        h("div", { class: footerColTitle }, "Connect"),
        h("ul", { class: footerLinks },
          h("li", {}, h("a", { class: footerLink, href: "https://github.com/lidessen/sikong", target: "_blank", rel: "noopener noreferrer" }, "GitHub")),
          h("li", {}, h("a", { class: footerLink, href: "https://github.com/lidessen/sikong/issues", target: "_blank", rel: "noopener noreferrer" }, "Issues")),
          h("li", {}, h("a", { class: footerLink, href: "https://sikong.dev/community" }, "Community")),
          h("li", {}, h("a", { class: footerLink, href: "https://sikong.dev/docs" }, "Docs")),
        ),
      ),
    ),
    h("div", { class: footerBottom },
      "Copyright ", String(new Date().getFullYear()), " — Sikong. MIT License."
    ),
  )
}

/** Page composer. */
export function Page(): JSXNode {
  return fragment({ children: [
    h("style", {}, KEYFRAMES),
    Nav(),
    Hero(),
    HowItWorks(),
    Features(),
    RuntimeBadges(),
    Architecture(),
    Comparison(),
    Install(),
    CTA(),
    Footer(),
  ]})
}
