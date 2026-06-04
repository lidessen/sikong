/**
 * src/site/components.ts — sikong.dev production homepage
 *
 * Converged design: "Sikong (司空)" — Terminal-Meets-SaaS Landing Page.
 * Flow's clean SaaS structure with Architect's terminal hero, stats,
 * comparison table, and terminal-themed installation.
 *
 * Built with semajsx: h (jsx), css (scoped styles), fragment.
 *
 * @module
 */

import { jsx as h, Fragment as fragment } from "semajsx/core"
import { css } from "semajsx/style"
import type { JSXNode } from "semajsx/html"
import type { StyleRef } from "semajsx/style"

// ── Design tokens ────────────────────────────────────────────────────────────

const T = {
  bg: "#0b0f19",
  bgAlt: "#0f172a",
  surface: "#131a2b",
  surfaceAlt: "#1a2332",
  border: "#1e293b",
  borderHover: "#334155",
  text: "#f1f5f9",
  textDim: "#94a3b8",
  textMuted: "#64748b",
  blue: "#60a5fa",
  blueBg: "rgba(96, 165, 250, 0.08)",
  blueGlow: "rgba(96, 165, 250, 0.15)",
  purple: "#a78bfa",
  purpleBg: "rgba(167, 139, 250, 0.08)",
  green: "#34d399",
  red: "#f87171",
  amber: "#fbbf24",
  fontMono: '"SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", monospace',
  fontSans:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", Helvetica, Arial, sans-serif',
} as const

// ── Keyframe animations ──────────────────────────────────────────────────────

const KEYFRAMES = `
@keyframes sk-blink { 50% { opacity: 0; } }
@keyframes sk-fadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
@keyframes sk-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
@keyframes sk-slideUp { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
`

// ── Global CSS (injected into build.ts <head>) ──────────────────────────────

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
a { color: ${T.blue}; text-decoration: none; transition: color 0.15s ease; }
a:hover { color: #93c5fd; }
::selection { background: rgba(96, 165, 250, 0.3); }
code, pre { font-family: ${T.fontMono}; }

/* Scrollbar */
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: ${T.bg}; }
::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: ${T.borderHover}; }

/* Interaction classes */
.sk-card:hover { border-color: ${T.blue} !important; transform: translateY(-2px); }
.sk-btn-primary:hover { background: #2563eb !important; transform: translateY(-1px); }
.sk-btn-secondary:hover { border-color: ${T.borderHover} !important; background: ${T.surface} !important; }
.sk-foot-link:hover { color: ${T.textDim} !important; }

/* Responsive utilities */
@media (max-width: 640px) {
  .sk-card { padding: 20px !important; }
  .sk-hide-mobile { display: none !important; }
}
`

// ── Utility styles ───────────────────────────────────────────────────────────

const container = css`
  max-width: 1120px;
  margin: 0 auto;
  padding: 0 24px;
`

const sectionPad = css`
  padding: 100px 0;

  @media (max-width: 640px) {
    padding: 64px 0;
  }
`

const sectionTitle = css`
  font-size: clamp(1.75rem, 3vw, 2.25rem);
  font-weight: 800;
  color: #f1f5f9;
  text-align: center;
  margin-bottom: 12px;
  letter-spacing: -0.025em;
`

const sectionSub = css`
  font-size: 1rem;
  color: ${T.textDim};
  text-align: center;
  max-width: 600px;
  margin: 0 auto 56px;
  line-height: 1.7;

  @media (max-width: 640px) {
    margin-bottom: 40px;
  }
`

// ── Navigation ───────────────────────────────────────────────────────────────

const nav = css`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: rgba(11, 15, 25, 0.88);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-bottom: 1px solid ${T.border};
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
  font-size: 1.1rem;
  color: #f1f5f9;
  letter-spacing: -0.02em;
`

const navLogo = css`
  width: 30px;
  height: 30px;
  border-radius: 7px;
  background: linear-gradient(135deg, ${T.blue}, ${T.purple});
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 800;
  color: #fff;
`

const navLinks = css`
  display: flex;
  align-items: center;
  gap: 28px;

  @media (max-width: 640px) {
    display: none;
  }
`

const navLink = css`
  font-size: 0.85rem;
  color: ${T.textDim};
  transition: color 0.15s ease;
  cursor: pointer;

  &:hover {
    color: #e2e8f0;
  }
`

const navCta = css`
  padding: 8px 20px;
  background: ${T.blue};
  color: #fff;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  transition: background 0.15s ease, transform 0.15s ease;

  &:hover {
    background: #2563eb;
    color: #fff;
    transform: translateY(-1px);
  }
`

const navVersion = css`
  font-family: ${T.fontMono};
  font-size: 0.7rem;
  color: ${T.textMuted};
  padding: 2px 8px;
  border: 1px solid ${T.border};
  border-radius: 4px;
`

// ── Hero section ─────────────────────────────────────────────────────────────

const hero = css`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 120px 24px 60px;
  position: relative;
  overflow: hidden;
  text-align: center;
`

const heroBg = css`
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(96, 165, 250, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(96, 165, 250, 0.03) 1px, transparent 1px);
  background-size: 56px 56px;
  pointer-events: none;
`

const heroGlow = css`
  position: absolute;
  top: -15%;
  left: 50%;
  transform: translateX(-50%);
  width: 900px;
  height: 700px;
  background: radial-gradient(ellipse, rgba(96, 165, 250, 0.06) 0%, rgba(167, 139, 250, 0.03) 40%, transparent 70%);
  pointer-events: none;
`

const heroTopGlow = css`
  position: absolute;
  top: -20%;
  right: -10%;
  width: 500px;
  height: 500px;
  background: radial-gradient(circle, rgba(167, 139, 250, 0.04) 0%, transparent 60%);
  pointer-events: none;
`

const heroH1 = css`
  font-size: clamp(2.75rem, 6vw, 4.25rem);
  font-weight: 900;
  line-height: 1.1;
  letter-spacing: -0.04em;
  margin-bottom: 8px;
  position: relative;
`

const heroGradient = css`
  background: linear-gradient(135deg, ${T.blue}, ${T.purple});
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
`

const heroVersion = css`
  font-family: ${T.fontMono};
  font-size: 0.8rem;
  color: ${T.textMuted};
  margin-bottom: 20px;
`

const heroTagline = css`
  font-size: clamp(1.05rem, 2vw, 1.25rem);
  color: ${T.textDim};
  max-width: 560px;
  line-height: 1.7;
  margin-bottom: 40px;
  position: relative;
`

// ── Terminal window ──────────────────────────────────────────────────────────

const termWindow = css`
  background: #0a0f1e;
  border: 1px solid ${T.border};
  border-radius: 10px;
  overflow: hidden;
  max-width: 660px;
  width: 100%;
  text-align: left;
  box-shadow:
    0 4px 24px rgba(0, 0, 0, 0.3),
    0 0 60px rgba(96, 165, 250, 0.04);
  position: relative;
`

const termHeader = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: #111a2b;
  border-bottom: 1px solid ${T.border};
`

const termTitle = css`
  font-size: 0.75rem;
  color: ${T.textMuted};
  margin-left: auto;
  font-family: ${T.fontMono};
`

const termDot = (color: string): StyleRef => css`
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: ${color};
`

const termBody = css`
  padding: 20px 24px;
  font-family: ${T.fontMono};
  font-size: 0.82rem;
  line-height: 1.85;
  color: ${T.textDim};

  @media (max-width: 640px) {
    padding: 14px 16px;
    font-size: 0.75rem;
  }
`

const termPrompt = css`
  color: ${T.green};
`

const termCmd = css`
  color: #e2e8f0;
`

const termOutput = css`
  color: ${T.textDim};
  padding-left: 16px;
`

const termSuccess = css`
  color: ${T.green};
  padding-left: 16px;
`

const termCursor = css`
  display: inline-block;
  width: 8px;
  height: 16px;
  background: ${T.blue};
  animation: sk-blink 1s step-end infinite;
  vertical-align: text-bottom;
  margin-left: 2px;
`

// ── Hero actions ─────────────────────────────────────────────────────────────

const heroActions = css`
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 32px;
  position: relative;
`

const btn = css`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 14px 28px;
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 600;
  transition: all 0.15s ease;
  cursor: pointer;
  line-height: 1;
`

const btnSolid = css`
  background: ${T.blue};
  color: #fff;
  border: none;

  &:hover {
    background: #2563eb;
    color: #fff;
    transform: translateY(-1px);
  }
`

const btnOutline = css`
  background: transparent;
  color: #e2e8f0;
  border: 1px solid ${T.border};

  &:hover {
    border-color: ${T.borderHover};
    background: ${T.surface};
  }
`

// ── Install command below hero ───────────────────────────────────────────────

const heroInstallRow = css`
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 48px;
  padding: 12px 24px;
  background: ${T.surface};
  border: 1px solid ${T.border};
  border-radius: 8px;
  font-family: ${T.fontMono};
  font-size: 0.85rem;
  position: relative;

  @media (max-width: 640px) {
    flex-direction: column;
    padding: 12px 16px;
    font-size: 0.78rem;
  }
`

const heroInstallLabel = css`
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: ${T.textMuted};
  background: ${T.surfaceAlt};
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid ${T.border};
  flex-shrink: 0;
`

const heroInstallCmd = css`
  color: ${T.blue};
  user-select: all;
`

const heroInstallArrow = css`
  color: ${T.green};
  margin-left: auto;
  flex-shrink: 0;

  @media (max-width: 640px) {
    margin-left: 0;
  }
`

// ── Stats bar ────────────────────────────────────────────────────────────────

const statsBar = css`
  display: flex;
  justify-content: center;
  gap: 56px;
  padding: 48px 24px;
  flex-wrap: wrap;
  border-top: 1px solid ${T.border};
  border-bottom: 1px solid ${T.border};
  background: ${T.bgAlt};

  @media (max-width: 640px) {
    gap: 32px;
    padding: 36px 24px;
  }
`

const statItem = css`
  text-align: center;
`

const statValue = css`
  font-size: 1.75rem;
  font-weight: 800;
  color: #f1f5f9;
  font-family: ${T.fontMono};
`

const statLabel = css`
  font-size: 0.8rem;
  color: ${T.textDim};
  margin-top: 4px;
`

// ── Features grid ────────────────────────────────────────────────────────────

const featGrid = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 20px;

  @media (max-width: 640px) {
    grid-template-columns: 1fr;
  }
`

const featCard = css`
  background: ${T.surface};
  border: 1px solid ${T.border};
  border-radius: 12px;
  padding: 28px;
  transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
  position: relative;
  overflow: hidden;

  &:hover {
    border-color: ${T.blue};
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  }
`

const featCardGlow = css`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, ${T.blue}, transparent);
`

const featTop = css`
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin-bottom: 12px;
`

const featIconHolder = (bg: string): StyleRef => css`
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.15rem;
  flex-shrink: 0;
  background: ${bg};
`

const featTitle = css`
  font-size: 1rem;
  font-weight: 600;
  color: #f1f5f9;
  padding-top: 8px;
`

const featDesc = css`
  font-size: 0.85rem;
  color: ${T.textDim};
  line-height: 1.7;
`

// ── Architecture flow ────────────────────────────────────────────────────────

const archSection = css`
  background: ${T.bgAlt};
`

const archPipeline = css`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  max-width: 960px;
  margin: 0 auto;
  padding: 12px 0;

  @media (max-width: 768px) {
    flex-direction: column;
    gap: 4px;
  }
`

const archNode = css`
  flex: 1;
  min-width: 160px;
  text-align: center;
  padding: 28px 20px;
  background: ${T.surface};
  border: 1px solid ${T.border};
  border-radius: 10px;
  position: relative;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;

  &:hover {
    border-color: ${T.blue};
    box-shadow: 0 0 24px ${T.blueBg};
  }

  @media (max-width: 768px) {
    width: 100%;
    min-width: unset;
  }
`

const archNodeHighlight = css`
  border-color: ${T.blue};
  box-shadow: 0 0 20px ${T.blueBg};
`

const archNodeIcon = css`
  font-size: 1.3rem;
  margin-bottom: 8px;
  line-height: 1;
`

const archNodeLabel = css`
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: ${T.textMuted};
  margin-bottom: 4px;
`

const archNodeTitle = css`
  font-size: 0.95rem;
  font-weight: 700;
  color: #f1f5f9;
  margin-bottom: 2px;
`

const archNodeDesc = css`
  font-size: 0.75rem;
  color: ${T.textDim};
  line-height: 1.5;
`

const archArrow = css`
  display: flex;
  align-items: center;
  padding: 0 8px;
  color: ${T.blue};
  font-size: 1.1rem;
  flex-shrink: 0;

  @media (max-width: 768px) {
    transform: rotate(90deg);
    padding: 4px 0;
  }
`

const archNote = css`
  text-align: center;
  margin-top: 28px;
  font-size: 0.82rem;
  color: ${T.textMuted};
  font-family: ${T.fontMono};
`

// ── Runtime comparison table ─────────────────────────────────────────────────

const compWrap = css`
  max-width: 960px;
  margin: 0 auto;
  overflow-x: auto;
  border-radius: 12px;
  border: 1px solid ${T.border};
`

const compTable = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
`

const compTh = css`
  padding: 16px 18px;
  text-align: left;
  font-weight: 600;
  color: #f1f5f9;
  background: ${T.surfaceAlt};
  border-bottom: 1px solid ${T.border};
  white-space: nowrap;
`

const compThRuntime = css`
  font-family: ${T.fontMono};
  font-size: 0.82rem;
`

const compTd = css`
  padding: 14px 18px;
  border-bottom: 1px solid rgba(30, 41, 59, 0.5);
  color: ${T.textDim};
  font-size: 0.85rem;
`

const compTdLabel = css`
  font-weight: 600;
  color: ${T.text};
  white-space: nowrap;
`

const compCheck = css`
  color: ${T.green};
`

const compCross = css`
  color: ${T.textMuted};
`

const compPartial = css`
  color: ${T.amber};
`

// ── Install section ──────────────────────────────────────────────────────────

const installGrid = css`
  display: flex;
  gap: 20px;
  justify-content: center;
  flex-wrap: wrap;
  max-width: 860px;
  margin: 0 auto;
`

const codeBlock = css`
  background: #080d1a;
  border: 1px solid ${T.border};
  border-radius: 10px;
  overflow: hidden;
  flex: 1;
  min-width: 280px;
  max-width: 420px;
  transition: border-color 0.2s ease;

  &:hover {
    border-color: ${T.borderHover};
  }
`

const codeHeader = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #0f1629;
  border-bottom: 1px solid ${T.border};
  font-size: 0.75rem;
  color: ${T.textMuted};
`

const codeLabel = css`
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
`

const codeBody = css`
  padding: 16px 20px;
  font-family: ${T.fontMono};
  font-size: 0.82rem;
  line-height: 1.9;
  color: ${T.textDim};
  overflow-x: auto;
  user-select: all;

  @media (max-width: 640px) {
    font-size: 0.75rem;
    padding: 12px 14px;
  }
`

const codeComment = css`
  color: ${T.textMuted};
`

const codePrompt = css`
  color: ${T.green};
`

const codeCmd = css`
  color: #e2e8f0;
`

const codeOutput = css`
  color: ${T.textDim};
`

const installHint = css`
  text-align: center;
  font-size: 0.85rem;
  color: ${T.textDim};
  margin-top: 28px;
`

// ── CTA section ──────────────────────────────────────────────────────────────

const ctaSection = css`
  text-align: center;
  background: linear-gradient(180deg, ${T.bg} 0%, ${T.bgAlt} 50%, ${T.bg} 100%);
  border-top: 1px solid ${T.border};
  border-bottom: 1px solid ${T.border};
`

const ctaActions = css`
  display: flex;
  gap: 16px;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 32px;
`

// ── Footer ───────────────────────────────────────────────────────────────────

const footerMain = css`
  border-top: 1px solid ${T.border};
  padding: 60px 24px 24px;
`

const footerInner = css`
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
  font-weight: 700;
  font-size: 1.05rem;
  color: #f1f5f9;
  margin-bottom: 8px;
`

const footerDesc = css`
  font-size: 0.85rem;
  color: ${T.textDim};
  line-height: 1.6;
  max-width: 280px;
`

const footerColTitle = css`
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: ${T.textMuted};
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
  color: ${T.textDim};
  transition: color 0.15s ease;

  &:hover {
    color: #94a3b8;
  }
`

const footerBottom = css`
  text-align: center;
  margin-top: 48px;
  padding-top: 20px;
  border-top: 1px solid ${T.border};
  font-size: 0.8rem;
  color: ${T.textMuted};
`

// ── Components ───────────────────────────────────────────────────────────────

/** Sticky navigation bar with brand, links, version badge, and GitHub CTA. */
export function Nav(): JSXNode {
  return h("nav", { class: nav },
    h("div", { class: [container, navInner] },
      h("a", { class: navBrand, href: "#" },
        h("span", { class: navLogo }, "S"),
        "sikong",
        h("span", { class: navVersion }, "v0.1.7"),
      ),
      h("div", { class: navLinks },
        h("a", { class: navLink, href: "#features" }, "Features"),
        h("a", { class: navLink, href: "#architecture" }, "Architecture"),
        h("a", { class: navLink, href: "#comparison" }, "Comparison"),
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

/** Terminal emulator window — renders inside the hero section. */
function TerminalWindow(): JSXNode {
  return h("div", { class: termWindow },
    h("div", { class: termHeader },
      h("span", { class: termDot(T.red) }),
      h("span", { class: termDot(T.amber) }),
      h("span", { class: termDot(T.green) }),
      h("span", { class: termTitle }, "sikong run — my-project"),
    ),
    h("div", { class: termBody },
      h("span", { class: termPrompt }, "$ "),
      h("span", { class: termCmd }, "sikong init my-project"),
      h("br", {}),
      h("span", { class: termSuccess }, "  ✔ Created project workspace"),
      h("br", {}),
      h("span", { class: termOutput }, "  ✔ Configured default worker (dev)"),
      h("br", {}),
      h("span", { class: termOutput }, "  ✔ Initialized JSONL event store"),
      h("br", {}),
      h("span", { class: termPrompt }, "$ "),
      h("span", { class: termCmd }, "sikong run"),
      h("br", {}),
      h("span", { class: termSuccess }, "  ├─ [dev]     Generated README … done"),
      h("br", {}),
      h("span", { class: termSuccess }, "  ├─ [test]    Assertions … passed"),
      h("br", {}),
      h("span", { class: termOutput }, "  ├─ [review]  Code review … "),
      h("span", { class: termCursor }),
      h("br", {}),
      h("span", { class: termOutput }, "", "            Agent: 3 tasks, effort: high → medium → low"),
    ),
  )
}

/** Hero section — headline, terminal window, actions, quick install command. */
export function Hero(): JSXNode {
  return h("section", { class: hero },
    h("div", { class: heroBg }),
    h("div", { class: heroGlow }),
    h("div", { class: heroTopGlow }),
    h("span", { class: heroVersion }, "v0.1.7 — MIT — 100% TypeScript"),
    h("h1", { class: heroH1 },
      h("span", {}, "Build with "),
      h("span", { class: heroGradient }, "agent workflows"),
      h("br", {}),
      "across any runtime",
    ),
    h("p", { class: heroTagline },
      "A unified coordination layer for multi-agent, multi-runtime development. ",
      "One config, four backends, full observability.",
    ),
    h("div", { class: heroActions },
      h("a",
        {
          class: [btn, btnSolid, "sk-btn-primary"],
          href: "https://github.com/lidessen/sikong",
          target: "_blank",
          rel: "noopener noreferrer",
        },
        "Get Started",
      ),
      h("a", { class: [btn, btnOutline, "sk-btn-secondary"], href: "#install" }, "Quick Install"),
    ),
    TerminalWindow(),
    h("div", { class: heroInstallRow },
      h("span", { class: heroInstallLabel }, "install"),
      h("span", { class: heroInstallCmd }, "curl -fsSL https://sikong.dev/install.sh | sh"),
      h("span", { class: heroInstallArrow }, "→ ready in seconds"),
    ),
  )
}

/** Stats bar — social proof metrics across the project. */
export function StatsBar(): JSXNode {
  return h("div", { class: statsBar },
    h("div", { class: statItem },
      h("div", { class: statValue }, "30k+"),
      h("div", { class: statLabel }, "Runs Executed"),
    ),
    h("div", { class: statItem },
      h("div", { class: statValue }, "4"),
      h("div", { class: statLabel }, "Runtime Backends"),
    ),
    h("div", { class: statItem },
      h("div", { class: statValue }, "MIT"),
      h("div", { class: statLabel }, "Open Source License"),
    ),
    h("div", { class: statItem },
      h("div", { class: statValue }, "100%"),
      h("div", { class: statLabel }, "TypeScript"),
    ),
  )
}

/** Features grid — 8 expanded cards covering Sikong capabilities. */
export function Features(): JSXNode {
  const FEATURES = [
    {
      icon: "⚙️",
      title: "Task Orchestration",
      desc: "Declarative multi-step agent workflows with automatic retries, timeouts, and handoff-based state management across runs.",
      iconBg: "#1a2340",
    },
    {
      icon: "📡",
      title: "Cost-aware Routing",
      desc: "Route simple tasks to fast, cheap models and escalate complex reasoning to capable ones — configured per stage, not hard-coded.",
      iconBg: "#1a2e22",
    },
    {
      icon: "🔄",
      title: "Multi-runtime",
      desc: "Claude Code, Codex, Cursor Agent SDK, Vercel AI SDK — one orchestration layer abstracts across all major agent runtimes.",
      iconBg: "#1a2234",
    },
    {
      icon: "💾",
      title: "Durable State",
      desc: "Append-only JSONL event log for every workspace session. Inspect, replay, and recover any past workflow exactly as it ran.",
      iconBg: "#2a1a22",
    },
    {
      icon: "📊",
      title: "Live Monitor",
      desc: "Real-time terminal dashboard showing project overview, task progress, token usage, and cost breakdowns with auto-refresh.",
      iconBg: "#1a2a2a",
    },
    {
      icon: "⌨️",
      title: "CLI-native",
      desc: "Git workspace isolation, JSON output for scripting, minimal ceremony. Designed from the ground up for the terminal.",
      iconBg: "#2a1a2a",
    },
    {
      icon: "🔌",
      title: "Provider-agnostic",
      desc: "Swap LLM providers per runtime — DeepSeek, Anthropic, OpenAI, or any compatible gateway. No vendor lock-in.",
      iconBg: "#1a1a3a",
    },
    {
      icon: "🔬",
      title: "Deterministic Replay",
      desc: "Every session writes a JSONL replay log. Re-run, debug, or audit any past workflow with exact step-by-step reconstruction.",
      iconBg: "#2a2a1a",
    },
  ]

  return h("section", { id: "features", class: [sectionPad, css({ background: T.bgAlt })] },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Everything you need for agent-driven development"),
      h("p", { class: sectionSub },
        "From task orchestration to cost management — Sikong provides the complete coordination layer.",
      ),
      h("div", { class: featGrid },
        ...FEATURES.map((f) =>
          h("div", { class: [featCard, "sk-card"] },
            h("div", { class: featCardGlow }),
            h("div", { class: featTop },
              h("div", { class: featIconHolder(f.iconBg) }, f.icon),
              h("div", { class: featTitle }, f.title),
            ),
            h("p", { class: featDesc }, f.desc),
          )
        ),
      ),
    ),
  )
}

/** Architecture — pipeline flow diagram showing the system layers. */
export function Architecture(): JSXNode {
  const nodes = [
    { icon: "📋", title: "CLI & Dashboard", desc: "User interface, project management, live monitor", layer: "Interface" },
    { icon: "⚡", title: "Workflow Engine", desc: "Task orchestration, state machine, handoff management", layer: "Orchestration", highlight: true },
    { icon: "🔗", title: "Runtime Adapters", desc: "Claude · Codex · Cursor · Vercel AI SDK", layer: "Runtime" },
    { icon: "🤖", title: "Model Providers", desc: "DeepSeek · Anthropic · OpenAI · Custom gateways", layer: "Models" },
  ]

  return h("section", { id: "architecture", class: [sectionPad, archSection] },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Architecture"),
      h("p", { class: sectionSub },
        "Runtime ⊥ Provider — the loop engine is decoupled from your LLM backend. One credential drives any compatible runtime.",
      ),
      h("div", { class: archPipeline },
        ...nodes.flatMap((n, i) => {
          const node = h("div",
            { class: [archNode, n.highlight ? archNodeHighlight : null] },
            h("div", { class: archNodeIcon }, n.icon),
            h("div", { class: archNodeLabel }, n.layer),
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

/** Runtime comparison table — feature comparison across all four backends. */
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
    if (v === true) return h("span", { class: compCheck }, "✓")
    if (v === false) return h("span", { class: compCross }, "—")
    return h("span", { class: compPartial }, v)
  }

  return h("section", { id: "comparison", class: [sectionPad] },
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
              h("th", { class: [compTh, compThRuntime] }, "Claude Code"),
              h("th", { class: [compTh, compThRuntime] }, "Codex"),
              h("th", { class: [compTh, compThRuntime] }, "Cursor"),
              h("th", { class: [compTh, compThRuntime] }, "AI SDK"),
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

/** Install section — terminal-style code blocks for curl and npm install methods. */
export function Install(): JSXNode {
  return h("section", { id: "install", class: [sectionPad, archSection] },
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
            h("span", { class: codeComment }, "# Install the latest release"),
            h("br", {}),
            h("span", { class: codePrompt }, "$ "),
            h("span", { class: codeCmd }, "curl -fsSL https://sikong.dev/install.sh | sh"),
            h("br", {}),
            h("br", {}),
            h("span", { class: codeComment }, "# Start your first project"),
            h("br", {}),
            h("span", { class: codePrompt }, "$ "),
            h("span", { class: codeCmd }, "sikong init my-project && cd my-project"),
            h("br", {}),
            h("span", { class: codePrompt }, "$ "),
            h("span", { class: codeCmd }, "sikong run"),
          ),
        ),
        h("div", { class: codeBlock },
          h("div", { class: codeHeader },
            h("span", { class: codeLabel }, "npm"),
            h("span", {}, "Any platform"),
          ),
          h("div", { class: codeBody },
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
            h("br", {}),
            h("span", { class: codePrompt }, "$ "),
            h("span", { class: codeCmd }, "sikong --version"),
          ),
        ),
      ),
      h("p", { class: installHint },
        "Requires Bun ≥1.2 · macOS / Linux / WSL · ",
        h("a", { href: "https://github.com/lidessen/sikong/blob/main/README.md", target: "_blank", rel: "noopener noreferrer" }, "View README"),
      ),
    ),
  )
}

/** CTA section — open source community call-to-action. */
export function CTA(): JSXNode {
  return h("section", { class: [sectionPad, ctaSection] },
    h("div", { class: container },
      h("h2", { class: sectionTitle }, "Built in the open, for the community"),
      h("p", { class: sectionSub },
        "Sikong is MIT-licensed and developed in public. Contributions, issues, and ideas are welcome.",
      ),
      h("div", { class: ctaActions },
        h("a",
          {
            class: [btn, btnSolid, "sk-btn-primary"],
            href: "https://github.com/lidessen/sikong",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Star on GitHub",
        ),
        h("a",
          { class: [btn, btnOutline, "sk-btn-secondary"], href: "https://sikong.dev/docs" },
          "Read the Docs",
        ),
        h("a",
          {
            class: [btn, btnOutline, "sk-btn-secondary"],
            href: "https://github.com/lidessen/sikong/issues",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Report Issue",
        ),
      ),
    ),
  )
}

/** Footer — 4-column sitemap with copyright. */
export function Footer(): JSXNode {
  return h("footer", { class: footerMain },
    h("div", { class: footerInner },
      h("div", {},
        h("div", { class: footerBrand }, "Sikong (司空)"),
        h("p", { class: footerDesc },
          "Durable wake-loop workspaces for agent-driven development. ",
          "MIT licensed. Built with Bun, semajsx, and agent-loop.",
        ),
      ),
      h("div", {},
        h("div", { class: footerColTitle }, "Product"),
        h("ul", { class: footerColList },
          h("li", {}, h("a", { class: footerLink, href: "#features" }, "Features")),
          h("li", {}, h("a", { class: footerLink, href: "#architecture" }, "Architecture")),
          h("li", {}, h("a", { class: "sk-foot-link", href: "#install" }, "Install")),
          h("li", {}, h("a", { class: "sk-foot-link", href: "/changelog" }, "Changelog")),
        ),
      ),
      h("div", {},
        h("div", { class: footerColTitle }, "Community"),
        h("ul", { class: footerColList },
          h("li", {}, h("a", { class: "sk-foot-link", href: "https://github.com/lidessen/sikong", target: "_blank", rel: "noopener noreferrer" }, "GitHub")),
          h("li", {}, h("a", { class: "sk-foot-link", href: "https://github.com/lidessen/sikong/issues", target: "_blank", rel: "noopener noreferrer" }, "Issues")),
          h("li", {}, h("a", { class: "sk-foot-link", href: "https://sikong.dev/community" }, "Community")),
        ),
      ),
      h("div", {},
        h("div", { class: footerColTitle }, "Resources"),
        h("ul", { class: footerColList },
          h("li", {}, h("a", { class: "sk-foot-link", href: "https://sikong.dev/docs" }, "Documentation")),
          h("li", {}, h("a", { class: "sk-foot-link", href: "https://github.com/lidessen/sikong/blob/main/README.md", target: "_blank", rel: "noopener noreferrer" }, "README")),
          h("li", {}, h("a", { class: "sk-foot-link", href: "https://sikong.dev/install.sh" }, "install.sh")),
        ),
      ),
    ),
    h("div", { class: footerBottom },
      "Copyright ", String(new Date().getFullYear()), " — Sikong. MIT License. ",
      "Built with Bun, semajsx, and agent-loop.",
    ),
  )
}

/** Page — top-level layout composing all sections. */
export function Page(): JSXNode {
  return fragment({ children: [
    h("style", {}, KEYFRAMES),
    Nav(),
    Hero(),
    StatsBar(),
    Features(),
    Architecture(),
    RuntimeComparison(),
    Install(),
    CTA(),
    Footer(),
  ]})
}
