/**
 * src/site/components.ts — VNode components for the sikong.dev homepage
 *
 * Uses plain VNode factory functions (h / fragment) from semajsx/core,
 * scoped styles via css() from semajsx/style.
 *
 * @module
 */

import { jsx as h, Fragment as fragment } from "semajsx/core"
import { css } from "semajsx/style"
import type { JSXNode } from "semajsx/html"

// ── Hero section ───────────────────────────────────────────────────────────

const hero = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 85vh;
  padding: 120px 24px 80px;
  text-align: center;
  position: relative;
  overflow: hidden;
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #1e3a5f 100%);
`

const heroBg = css`
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 50% 0%, rgba(59, 130, 246, 0.08) 0%, transparent 65%);
  pointer-events: none;
`

const heroTitle = css`
  font-size: clamp(2.5rem, 6vw, 4.5rem);
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: -0.03em;
  margin-bottom: 20px;
  position: relative;
  background: linear-gradient(135deg, #60a5fa, #a78bfa);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
`

const heroTagline = css`
  font-size: clamp(1.125rem, 2.5vw, 1.5rem);
  color: #94a3b8;
  max-width: 640px;
  font-weight: 500;
  margin-bottom: 16px;
  position: relative;
`

const heroSub = css`
  font-size: clamp(0.9rem, 1.5vw, 1.1rem);
  color: #64748b;
  max-width: 560px;
  position: relative;
`

// ── Shared section container ───────────────────────────────────────────────

const section = css`
  max-width: 1200px;
  margin: 0 auto;
  padding: 100px 24px;
`

const sectionAlt = css`
  background: #0a0f1e;
`

const sectionTitle = css`
  font-size: clamp(1.5rem, 3vw, 2rem);
  font-weight: 700;
  color: #f1f5f9;
  text-align: center;
  margin-bottom: 16px;
`

const sectionSub = css`
  font-size: 1rem;
  color: #64748b;
  text-align: center;
  max-width: 600px;
  margin: 0 auto 56px;
  line-height: 1.6;
`

// ── Features grid ─────────────────────────────────────────────────────────

const featGrid = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 24px;
`

const featCard = css`
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 12px;
  padding: 32px;
  transition: border-color 0.2s ease;
`

const featCardIcon = css`
  font-size: 1.75rem;
  margin-bottom: 16px;
  line-height: 1;
`

const featCardTitle = css`
  font-size: 1.125rem;
  font-weight: 600;
  color: #f1f5f9;
  margin-bottom: 8px;
`

const featCardDesc = css`
  font-size: 0.875rem;
  color: #94a3b8;
  line-height: 1.7;
`

// ── Install section ────────────────────────────────────────────────────────

const cmd = css`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 14px 24px;
  font-family: "SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", monospace;
  font-size: 0.9rem;
  color: #60a5fa;
  max-width: 420px;
  margin: 0 auto 12px;
  user-select: all;
`

const cmdLabel = css`
  font-size: 0.75rem;
  color: #475569;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
`

const cmdPrompt = css`
  color: #64748b;
`

const cmdText = css`
  color: #60a5fa;
`

const installHint = css`
  font-size: 0.85rem;
  color: #64748b;
  text-align: center;
`

// ── CTA section ────────────────────────────────────────────────────────────

const ctaRow = css`
  display: flex;
  gap: 16px;
  justify-content: center;
  flex-wrap: wrap;
`

const btnBase = css`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 28px;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  text-decoration: none;
  transition: background 0.2s ease, border-color 0.2s ease;
  cursor: pointer;
  line-height: 1;
`

const btnPrimary = css`
  background: #3b82f6;
  color: #fff;
  border: none;
`

const btnSecondary = css`
  background: transparent;
  color: #e2e8f0;
  border: 1px solid #334155;
`

// ── Footer ─────────────────────────────────────────────────────────────────

const footer = css`
  border-top: 1px solid #1e293b;
  padding: 40px 24px;
  text-align: center;
  color: #475569;
  font-size: 0.85rem;
`

const footLinks = css`
  display: flex;
  gap: 24px;
  justify-content: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
`

const footLink = css`
  color: #64748b;
  text-decoration: none;
  font-size: 0.85rem;
  transition: color 0.15s ease;
`

// ── Feature data ───────────────────────────────────────────────────────────

interface Feature {
  icon: string
  title: string
  desc: string
}

const FEATURES: Feature[] = [
  {
    icon: "⚙️",
    title: "Task Orchestration",
    desc: "Define and run multi-step agent workflows with automatic retries, timeouts, and handoff-based state management across runs.",
  },
  {
    icon: "📡",
    title: "Cost-aware Routing",
    desc: "Smart model selection per task — route cheap work to fast models, escalate complex reasoning to capable ones automatically.",
  },
  {
    icon: "🔄",
    title: "Multi-runtime Support",
    desc: "Claude Code, Codex, Cursor Agent SDK, Vercel AI SDK — one orchestration layer works across all major agent runtimes.",
  },
  {
    icon: "💾",
    title: "JSONL-backed Stores",
    desc: "Durable, inspectable, append-only state. Every workspace event is logged to JSONL for audit, recovery, and replay.",
  },
  {
    icon: "📊",
    title: "Live Monitor Dashboard",
    desc: "Real-time terminal dashboard showing project overview, task progress, usage metrics, and cost breakdowns.",
  },
  {
    icon: "⌨️",
    title: "CLI-first",
    desc: "Designed for the terminal. Git-native isolation, JSON output for scripting, minimal ceremony — stays out of your way.",
  },
]

// ── Components ─────────────────────────────────────────────────────────────

/** Hero section — headline, tagline, subtitle. */
export function Hero(): JSXNode {
  return h("section", { class: hero },
    h("div", { class: heroBg }),
    h("h1", { class: heroTitle }, "Sikong (司空)"),
    h("p", { class: heroTagline }, "Durable wake-loop workspace for agent-driven development"),
    h("p", { class: heroSub }, "Universal coordination layer for multi-agent, multi-runtime workflows"),
  )
}

/** Features grid — cards describing Sikong capabilities. */
export function Features(): JSXNode {
  return h("section", { class: [section, sectionAlt] },
    h("div", { class: [section] },
      h("h2", { class: sectionTitle }, "Everything you need for agent-driven development"),
      h("p", { class: sectionSub },
        "From task orchestration to cost management — Sikong provides the coordination layer for AI-assisted development.",
      ),
      h("div", { class: featGrid },
        ...FEATURES.map((f) =>
          h("div", { class: [featCard, "sk-card"] },
            h("div", { class: featCardIcon }, f.icon),
            h("h3", { class: featCardTitle }, f.title),
            h("p", { class: featCardDesc }, f.desc),
          )
        ),
      ),
    ),
  )
}

/** Install section — copyable install command. */
export function Install(): JSXNode {
  return h("section", { class: [section] },
    h("h2", { class: sectionTitle }, "Quick Install"),
    h("p", { class: sectionSub }, "Get started with Sikong in seconds"),
    h("div", { class: cmd },
      h("span", { class: cmdLabel }, "INSTALL"),
      h("span", { class: cmdPrompt }, "$"),
      h("span", { class: cmdText }, "curl -fsSL https://sikong.dev/install.sh | sh"),
    ),
    h("p", { class: installHint }, "Or with npm: npm install -g sikong"),
  )
}

/** CTA section — links to GitHub and documentation. */
export function CTA(): JSXNode {
  return h("section", { class: [section, sectionAlt] },
    h("div", { class: [section] },
      h("h2", { class: sectionTitle }, "Get Involved"),
      h("p", { class: sectionSub },
        "Sikong is open-source and built for the agent-driven development community.",
      ),
      h("div", { class: ctaRow },
        h("a",
          {
            class: [btnBase, btnPrimary, "sk-btn-primary"],
            href: "https://github.com/lidessen/sikong",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "GitHub",
        ),
        h("a",
          {
            class: [btnBase, btnSecondary, "sk-btn-secondary"],
            href: "https://sikong.dev/docs",
          },
          "Documentation",
        ),
      ),
    ),
  )
}

/** Footer — copyright and links. */
export function Footer(): JSXNode {
  return h("footer", { class: footer },
    h("div", { class: footLinks },
      h("a", { class: [footLink, "sk-foot-link"], href: "https://github.com/lidessen/sikong", target: "_blank", rel: "noopener noreferrer" }, "GitHub"),
      h("a", { class: [footLink, "sk-foot-link"], href: "https://sikong.dev/docs" }, "Docs"),
      h("a", { class: [footLink, "sk-foot-link"], href: "https://sikong.dev/changelog" }, "Changelog"),
      h("a", { class: [footLink, "sk-foot-link"], href: "https://sikong.dev/community" }, "Community"),
    ),
    h("p", {}, "Copyright ", new Date().getFullYear(), " — Sikong. MIT License."),
  )
}

/** Page — top-level layout composing all sections. */
export function Page(): JSXNode {
  return fragment({ children: [
    Hero(),
    Features(),
    Install(),
    CTA(),
    Footer(),
  ]})
}
