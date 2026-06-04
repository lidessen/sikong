/**
 * Candidate C: "Flow" — Clean Modern SaaS-Style Landing Page
 *
 * Minimal, spacious design focusing on readability and clarity. Problem/Solution
 * framing, architecture layers, real code examples, and community metrics.
 * Inspired by modern open-source project pages (Tailwind, tRPC, Clerk).
 *
 * @module
 */

import { jsx as h, Fragment as fragment } from "semajsx/core"
import { css } from "semajsx/style"
import type { JSXNode } from "semajsx/html"
import type { StyleRef } from "semajsx/style"

// ── Tokens ────────────────────────────────────────────────────────────────────

const C = {
  bg: "#0b1120",
  bgCard: "#151d2d",
  bgAlt: "#0f172a",
  border: "#1e293b",
  borderHover: "#334155",
  text: "#f1f5f9",
  textDim: "#94a3b8",
  textMuted: "#64748b",
  blue: "#3b82f6",
  blueGlow: "rgba(59, 130, 246, 0.12)",
  teal: "#14b8a6",
  tealGlow: "rgba(20, 184, 166, 0.1)",
  fontMono: '"SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", monospace',
  fontSans:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", Helvetica, Arial, sans-serif',
} as const

export const GLOBAL_CSS = `
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  font-family: ${C.fontSans}; background: ${C.bg}; color: ${C.text};
  line-height: 1.6; -webkit-font-smoothing: antialiased;
}
a { color: ${C.blue}; text-decoration: none; }
a:hover { color: #60a5fa; }
::selection { background: rgba(59, 130, 246, 0.25); }
code, pre { font-family: ${C.fontMono}; }
`

// ── Utilities ─────────────────────────────────────────────────────────────────

const container = css`max-width: 1120px; margin: 0 auto; padding: 0 24px;`
const sectionPad = css`padding: 96px 0;`
const sectionTitle = css`
  font-size: clamp(1.75rem, 3vw, 2.25rem); font-weight: 800;
  margin-bottom: 12px; letter-spacing: -0.025em;
`
const sectionTitleCenter = css`
  text-align: center;
`
const sectionSub = css`
  font-size: 1rem; color: ${C.textDim}; line-height: 1.7; max-width: 600px;
`
const sectionSubCenter = css`
  text-align: center; margin: 0 auto 56px;
`

// ── Nav ───────────────────────────────────────────────────────────────────────

const nav = css`
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  background: rgba(11, 17, 32, 0.85); backdrop-filter: blur(12px);
  border-bottom: 1px solid ${C.border};
`

const navInner = css`
  display: flex; align-items: center; justify-content: space-between;
  height: 60px;
`

const navBrand = css`
  display: flex; align-items: center; gap: 8px;
  font-size: 1.05rem; font-weight: 700; color: #f1f5f9;
`

const navLogo = css`
  width: 28px; height: 28px; border-radius: 6px;
  background: linear-gradient(135deg, ${C.blue}, ${C.teal});
  display: flex; align-items: center; justify-content: center;
  font-size: 0.75rem; font-weight: 800; color: #fff;
`

const navCenter = css`
  display: flex; gap: 24px;
`

const navLink = css`
  font-size: 0.85rem; color: ${C.textDim}; transition: color 0.15s;
  &:hover { color: ${C.text}; }
`

const navCta = css`
  padding: 8px 20px; background: ${C.blue}; color: #fff;
  border-radius: 6px; font-size: 0.85rem; font-weight: 600;
  transition: background 0.15s;
  &:hover { background: #2563eb; color: #fff; }
`

// ── Hero ──────────────────────────────────────────────────────────────────────

const hero = css`
  min-height: 90vh; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  padding: 120px 24px 60px; position: relative; overflow: hidden;
  text-align: center;
`

const heroBg = css`
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse at 50% 0%, ${C.blueGlow} 0%, transparent 60%),
    radial-gradient(ellipse at 80% 80%, ${C.tealGlow} 0%, transparent 50%);
  pointer-events: none;
`

const heroH1 = css`
  font-size: clamp(2.75rem, 6vw, 4.25rem); font-weight: 900;
  line-height: 1.1; letter-spacing: -0.04em; margin-bottom: 20px;
  position: relative;
`

const heroGradient = css`
  background: linear-gradient(135deg, ${C.blue}, ${C.teal});
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
`

const heroP = css`
  font-size: clamp(1.05rem, 2vw, 1.25rem); color: ${C.textDim};
  max-width: 580px; line-height: 1.7; margin-bottom: 36px; position: relative;
`

const heroActions = css`
  display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; position: relative;
  margin-bottom: 48px;
`

const btn = css`
  display: inline-flex; align-items: center; gap: 8px;
  padding: 14px 28px; border-radius: 8px;
  font-size: 0.95rem; font-weight: 600;
  transition: all 0.15s ease; cursor: pointer;
`

const btnSolid = css`
  background: ${C.blue}; color: #fff; border: none;
  &:hover { background: #2563eb; color: #fff; transform: translateY(-1px); }
`

const btnOutline = css`
  background: transparent; color: #e2e8f0; border: 1px solid ${C.border};
  &:hover { border-color: ${C.borderHover}; background: ${C.bgCard}; }
`

const heroStats = css`
  display: flex; gap: 32px; justify-content: center; flex-wrap: wrap;
  position: relative;
`

const heroStat = css`
  text-align: center;
`

const heroStatVal = css`
  font-size: 1.25rem; font-weight: 800; color: #f1f5f9;
  font-family: ${C.fontMono};
`

const heroStatLabel = css`
  font-size: 0.75rem; color: ${C.textMuted}; margin-top: 2px;
`

// ── Problem/Solution ──────────────────────────────────────────────────────────

const psGrid = css`
  display: grid; grid-template-columns: 1fr 1fr; gap: 24px; max-width: 900px;
  margin: 0 auto;
`

const psCard = css`
  padding: 32px; border-radius: 12px; border: 1px solid ${C.border};
`

const psBad = css`
  background: rgba(239, 68, 68, 0.04); border-color: rgba(239, 68, 68, 0.15);
`

const psGood = css`
  background: rgba(34, 197, 94, 0.04); border-color: rgba(34, 197, 94, 0.15);
`

const psTitle = css`
  font-size: 1.05rem; font-weight: 700; margin-bottom: 16px;
`

const psItem = css`
  display: flex; align-items: flex-start; gap: 10px;
  padding: 6px 0; font-size: 0.88rem; line-height: 1.6;
`

// ── Features ──────────────────────────────────────────────────────────────────

const featGrid = css`
  display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 20px;
`

const featCard = css`
  padding: 28px; border-radius: 12px;
  border: 1px solid ${C.border}; background: ${C.bgCard};
  transition: border-color 0.2s, box-shadow 0.2s;
  &:hover { border-color: ${C.borderHover}; box-shadow: 0 2px 16px rgba(0,0,0,0.2); }
`

const featTop = css`
  display: flex; align-items: flex-start; gap: 16px; margin-bottom: 12px;
`

const featIcon = (bg: string): StyleRef => css`
  width: 42px; height: 42px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  font-size: 1.2rem; flex-shrink: 0; background: ${bg};
`

const featTitle = css`
  font-size: 1rem; font-weight: 600; color: #f1f5f9; padding-top: 6px;
`

const featDesc = css`
  font-size: 0.85rem; color: ${C.textDim}; line-height: 1.7;
`

// ── Architecture ──────────────────────────────────────────────────────────────

const layerStack = css`
  max-width: 700px; margin: 0 auto; display: flex; flex-direction: column;
  gap: 0; position: relative;
`

const layerItem = css`
  display: flex; align-items: center; gap: 24px;
  padding: 24px 28px; border: 1px solid ${C.border};
  background: ${C.bgCard}; position: relative;
`

const layerBadge = (bg: string): StyleRef => css`
  width: 36px; height: 36px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.85rem; font-weight: 800; color: #fff; flex-shrink: 0;
  background: ${bg};
`

const layerInfo = css`flex: 1;`

const layerTitle = css`
  font-size: 0.95rem; font-weight: 600; color: #f1f5f9; margin-bottom: 2px;
`

const layerDesc = css`
  font-size: 0.8rem; color: ${C.textDim};
`

const layerArrow = css`
  text-align: center; color: ${C.blue}; font-size: 0.8rem;
  padding: 4px 0; line-height: 1;
`

const layerNote = css`
  text-align: center; margin-top: 24px; font-size: 0.85rem;
  color: ${C.textMuted};
`

// ── Code examples ─────────────────────────────────────────────────────────────

const codeShowcase = css`
  display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-width: 900px;
  margin: 0 auto;
`

const codeBlock = css`
  background: #080d1a; border: 1px solid ${C.border}; border-radius: 10px;
  overflow: hidden;
`

const codeHeader = css`
  padding: 10px 14px; background: #0f1629; border-bottom: 1px solid ${C.border};
  display: flex; align-items: center; justify-content: space-between;
  font-size: 0.75rem; color: ${C.textMuted};
`

const codeBody = css`
  padding: 16px 18px; font-family: ${C.fontMono}; font-size: 0.78rem;
  line-height: 2; color: #94a3b8; overflow-x: auto; user-select: all;
`

// ── CTA ───────────────────────────────────────────────────────────────────────

const ctaSection = css`
  text-align: center; background: ${C.bgAlt};
  border-top: 1px solid ${C.border}; border-bottom: 1px solid ${C.border};
`

const ctaGrid = css`
  display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; margin-top: 32px;
`

// ── Footer ────────────────────────────────────────────────────────────────────

const footerMain = css`
  border-top: 1px solid ${C.border}; padding: 48px 24px 24px;
`

const footerInner = css`
  max-width: 1120px; margin: 0 auto;
  display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 40px;
`

const footerBrand = css`
  font-weight: 700; font-size: 1rem; color: #f1f5f9; margin-bottom: 8px;
`

const footerDesc = css`
  font-size: 0.85rem; color: ${C.textDim}; line-height: 1.6; max-width: 280px;
`

const footerColTitle = css`
  font-size: 0.8rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; color: ${C.textMuted}; margin-bottom: 14px;
`

const footerLinks = css`
  list-style: none; display: flex; flex-direction: column; gap: 8px;
`

const footerLink = css`
  font-size: 0.85rem; color: ${C.textDim};
  &:hover { color: ${C.blue}; }
`

const footerBottom = css`
  text-align: center; margin-top: 40px; padding-top: 20px;
  border-top: 1px solid ${C.border};
  font-size: 0.8rem; color: ${C.textMuted};
`

// ── Components ────────────────────────────────────────────────────────────────

export function Nav(): JSXNode {
  return h("nav", { class: nav },
    h("div", { class: [container, navInner] },
      h("a", { class: navBrand, href: "#" },
        h("span", { class: navLogo }, "S"),
        "sikong",
      ),
      h("div", { class: navCenter },
        h("a", { class: navLink, href: "#features" }, "Features"),
        h("a", { class: navLink, href: "#why" }, "Why Sikong"),
        h("a", { class: navLink, href: "#examples" }, "Examples"),
        h("a", { class: navLink, href: "#install" }, "Install"),
      ),
      h("a", { class: navCta, href: "https://github.com/lidessen/sikong", target: "_blank", rel: "noopener noreferrer" }, "GitHub"),
    ),
  )
}

export function Hero(): JSXNode {
  return h("section", { class: hero },
    h("div", { class: heroBg }),
    h("h1", { class: heroH1 },
      h("span", {}, "Orchestrate "),
      h("span", { class: heroGradient }, "agent workflows"),
      h("br", {}),
      "across any runtime",
    ),
    h("p", { class: heroP },
      "A unified coordination layer for multi-agent, multi-model development. ",
      "One config, four runtimes, full observability.",
    ),
    h("div", { class: heroActions },
      h("a", { class: [btn, btnSolid], href: "https://github.com/lidessen/sikong", target: "_blank", rel: "noopener noreferrer" }, "Get Started →"),
      h("a", { class: [btn, btnOutline], href: "#examples" }, "See Examples"),
    ),
    h("div", { class: heroStats },
      h("div", { class: heroStat },
        h("div", { class: heroStatVal }, "4"),
        h("div", { class: heroStatLabel }, "Runtime backends"),
      ),
      h("div", { class: heroStat },
        h("div", { class: heroStatVal }, "Claude·Codex·Cursor·SDK"),
        h("div", { class: heroStatLabel }, "Supported platforms"),
      ),
      h("div", { class: heroStat },
        h("div", { class: heroStatVal }, "MIT"),
        h("div", { class: heroStatLabel }, "Open source license"),
      ),
    ),
  )
}

export function ProblemSolution(): JSXNode {
  return h("section", { id: "why", class: [sectionPad] },
    h("div", { class: container },
      h("h2", { class: [sectionTitle, sectionTitleCenter] }, "Building agent infrastructure shouldn't be your job"),
      h("p", { class: [sectionSub, sectionSubCenter] },
        "Sikong abstracts away the plumbing so you can focus on what your agents actually do.",
      ),
      h("div", { class: psGrid },
        h("div", { class: [psCard, psBad] },
          h("div", { class: [psTitle, css({ color: "#f87171" })] }, "The Manual Way"),
          h("div", { class: psItem }, h("span", { style: { color: "#ef4444", flexShrink: 0 } }, "✕"), h("span", {}, "Write bespoke orchestration scripts per project")),
          h("div", { class: psItem }, h("span", { style: { color: "#ef4444", flexShrink: 0 } }, "✕"), h("span", {}, "Tied to one vendor's agent SDK")),
          h("div", { class: psItem }, h("span", { style: { color: "#ef4444", flexShrink: 0 } }, "✕"), h("span", {}, "No visibility into token spend or cost")),
          h("div", { class: psItem }, h("span", { style: { color: "#ef4444", flexShrink: 0 } }, "✕"), h("span", {}, "State lost between agent sessions")),
        ),
        h("div", { class: [psCard, psGood] },
          h("div", { class: [psTitle, css({ color: "#4ade80" })] }, "With Sikong"),
          h("div", { class: psItem }, h("span", { style: { color: "#22c55e", flexShrink: 0 } }, "✓"), h("span", {}, "Declare workflows once, run anywhere")),
          h("div", { class: psItem }, h("span", { style: { color: "#22c55e", flexShrink: 0 } }, "✓"), h("span", {}, "Swap Claude ↔ Codex ↔ Cursor via config")),
          h("div", { class: psItem }, h("span", { style: { color: "#22c55e", flexShrink: 0 } }, "✓"), h("span", {}, "Built-in usage analytics & cost tracking")),
          h("div", { class: psItem }, h("span", { style: { color: "#22c55e", flexShrink: 0 } }, "✓"), h("span", {}, "JSONL-backed durable state & replay")),
        ),
      ),
    ),
  )
}

export function Features(): JSXNode {
  const FEATURES = [
    { icon: "⚙️", title: "Task Orchestration", desc: "Multi-step agent workflows with automatic retries, timeouts, and handoff-based state management.", iconBg: "#1a2340" },
    { icon: "📡", title: "Cost-aware Routing", desc: "Route cheap work to fast models, escalate complex reasoning to capable ones — automatically.", iconBg: "#1a2e22" },
    { icon: "🔄", title: "Multi-runtime", desc: "Claude Code, Codex, Cursor, Vercel AI SDK — one abstraction over all major agent runtimes.", iconBg: "#1a2234" },
    { icon: "💾", title: "Durable State", desc: "Append-only JSONL event log for every workspace. Inspect, replay, and recover any past session.", iconBg: "#2a1a22" },
    { icon: "📊", title: "Live Monitor", desc: "Real-time dashboard for projects, tasks, tokens, and costs. Auto-refreshing, terminal-native.", iconBg: "#1a2a2a" },
    { icon: "⌨️", title: "CLI-native", desc: "Git workspace isolation, JSON scripting output, minimal config — designed for the terminal.", iconBg: "#2a1a2a" },
  ]

  return h("section", { id: "features", class: [sectionPad, css({ background: C.bgAlt })] },
    h("div", { class: container },
      h("h2", { class: [sectionTitle, sectionTitleCenter] }, "Everything you need"),
      h("p", { class: [sectionSub, sectionSubCenter] },
        "A complete coordination layer for agent-driven development.",
      ),
      h("div", { class: featGrid },
        ...FEATURES.map((f) =>
          h("div", { class: featCard },
            h("div", { class: featTop },
              h("div", { class: featIcon(f.iconBg) }, f.icon),
              h("div", { class: featTitle }, f.title),
            ),
            h("p", { class: featDesc }, f.desc),
          )
        ),
      ),
    ),
  )
}

export function Architecture(): JSXNode {
  const layers = [
    { badge: "CLI", title: "Sikong CLI & Dashboard", desc: "User interface, project management, and monitoring", color: C.blue },
    { badge: "WF", title: "Workflow Engine", desc: "Task orchestration, state machine, and handoff management", color: C.teal },
    { badge: "AD", title: "Runtime Adapters", desc: "Claude Code · Codex · Cursor · Vercel AI SDK", color: "#8b5cf6" },
    { badge: "LLM", title: "Model Providers", desc: "DeepSeek · Anthropic · OpenAI · Custom gateways", color: "#f59e0b" },
  ]

  return h("section", { class: [sectionPad] },
    h("div", { class: container },
      h("h2", { class: [sectionTitle, sectionTitleCenter] }, "Architecture"),
      h("p", { class: [sectionSub, sectionSubCenter] },
        "Runtime ⊥ Provider — the loop engine is decoupled from your LLM backend.",
      ),
      h("div", { class: layerStack },
        ...layers.flatMap((l, i) => [
          h("div", { class: layerItem },
            h("div", { class: layerBadge(l.color) }, l.badge),
            h("div", { class: layerInfo },
              h("div", { class: layerTitle }, l.title),
              h("div", { class: layerDesc }, l.desc),
            ),
          ),
          i < layers.length - 1
            ? h("div", { class: layerArrow }, "▼")
            : null,
        ]).filter(Boolean),
      ),
      h("div", { class: layerNote }, "One credential drives any compatible runtime. Swap backends without changing your workflow."),
    ),
  )
}

export function CodeExamples(): JSXNode {
  return h("section", { id: "examples", class: [sectionPad, css({ background: C.bgAlt })] },
    h("div", { class: container },
      h("h2", { class: [sectionTitle, sectionTitleCenter] }, "See it in action"),
      h("p", { class: [sectionSub, sectionSubCenter] },
        "Define your workflow once, run it across any runtime.",
      ),
      h("div", { class: codeShowcase },
        h("div", { class: codeBlock },
          h("div", { class: codeHeader },
            h("span", {}, "workflow.yaml"),
            h("span", { style: { color: C.textMuted } }, "Configuration"),
          ),
          h("div", { class: codeBody },
            "stages:", h("br", {}),
            "  - id: code", h("br", {}),
            "    effort: high", h("br", {}),
            "    tools: [edit, bash]", h("br", {}),
            "  - id: test", h("br", {}),
            "    effort: medium", h("br", {}),
            "  - id: review", h("br", {}),
            "    effort: low", h("br", {}),
            "on_complete: notify", h("br", {}),
          ),
        ),
        h("div", { class: codeBlock },
          h("div", { class: codeHeader },
            h("span", {}, "terminal"),
            h("span", { style: { color: C.textMuted } }, "CLI usage"),
          ),
          h("div", { class: codeBody },
            "# Create a project", h("br", {}),
            "sikong init my-app", h("br", {}),
            "sikong project set-default worker dev", h("br", {}),
            h("br", {}),
            "# Run the workflow", h("br", {}),
            "sikong run", h("br", {}),
            h("br", {}),
            "# Watch live", h("br", {}),
            "sikong overview", h("br", {}),
          ),
        ),
      ),
    ),
  )
}

export function Install(): JSXNode {
  return h("section", { id: "install", class: [sectionPad] },
    h("div", { class: container },
      h("h2", { class: [sectionTitle, sectionTitleCenter] }, "Get started in seconds"),
      h("p", { class: [sectionSub, sectionSubCenter] },
        "Choose the install method that works for you.",
      ),
      h("div", { style: { display: "flex", gap: "16px", justifyContent: "center", flexWrap: "wrap" } },
        h("div", { class: codeBlock, style: { maxWidth: "400px" } },
          h("div", { class: codeHeader },
            h("span", {}, "curl"),
            h("span", { style: { textTransform: "none" } }, "macOS / Linux"),
          ),
          h("div", { class: codeBody },
            "curl -fsSL https://sikong.dev/install.sh | sh",
          ),
        ),
        h("div", { class: codeBlock, style: { maxWidth: "400px" } },
          h("div", { class: codeHeader },
            h("span", {}, "npm"),
            h("span", { style: { textTransform: "none" } }, "Any platform"),
          ),
          h("div", { class: codeBody },
            "npm install -g sikong",
          ),
        ),
      ),
    ),
  )
}

export function CTA(): JSXNode {
  return h("section", { class: [sectionPad, ctaSection] },
    h("div", { class: container },
      h("h2", { class: sectionTitleCenter }, "Built in the open, for the community"),
      h("p", { class: [sectionSub, sectionSubCenter] },
        "Sikong is MIT-licensed and developed in public. Contributions, issues, and ideas are welcome.",
      ),
      h("div", { class: ctaGrid },
        h("a", { class: [btn, btnSolid], href: "https://github.com/lidessen/sikong", target: "_blank", rel: "noopener noreferrer" }, "Star on GitHub"),
        h("a", { class: [btn, btnOutline], href: "https://sikong.dev/docs" }, "Read Docs"),
        h("a", { class: [btn, btnOutline], href: "https://github.com/lidessen/sikong/issues", target: "_blank", rel: "noopener noreferrer" }, "Report Issue"),
      ),
    ),
  )
}

export function Footer(): JSXNode {
  return h("footer", { class: footerMain },
    h("div", { class: footerInner },
      h("div", {},
        h("div", { class: footerBrand }, "Sikong (司空)"),
        h("p", { class: footerDesc },
          "Durable wake-loop workspaces for agent-driven development. MIT licensed. Built with Bun, semajsx, and agent-loop.",
        ),
      ),
      h("div", {},
        h("div", { class: footerColTitle }, "Product"),
        h("ul", { class: footerLinks },
          h("li", {}, h("a", { class: footerLink, href: "#features" }, "Features")),
          h("li", {}, h("a", { class: footerLink, href: "#why" }, "Why Sikong")),
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
          h("li", {}, h("a", { class: footerLink, href: "https://sikong.dev/docs" }, "Docs")),
          h("li", {}, h("a", { class: footerLink, href: "https://github.com/lidessen/sikong/blob/main/README.md", target: "_blank", rel: "noopener noreferrer" }, "README")),
          h("li", {}, h("a", { class: footerLink, href: "https://sikong.dev/install.sh" }, "install.sh")),
        ),
      ),
    ),
    h("div", { class: footerBottom },
      "Copyright ", String(new Date().getFullYear()), " — Sikong."
    ),
  )
}

export function Page(): JSXNode {
  return fragment({ children: [
    Nav(),
    Hero(),
    ProblemSolution(),
    Features(),
    Architecture(),
    CodeExamples(),
    Install(),
    CTA(),
    Footer(),
  ]})
}
