# Console UI Generation Spec

> **Status:** ✗ Superseded  
> **Replacement:** None — the console UI generation is being reworked in the Rust mainline.  
> **Reason:** This document describes the Go/Bun-era console UI generation rules and design tokens, which are being replaced as part of the Rust mainline migration.  
> **Last reviewed:** 2026-06-22  

This document defines the visual generation rules for Sikong's console UI.
Generated components and pages should feel compact, operational, status-driven,
dark-first, and consistent with the same semantic color and interaction model.

## Output Contract

When generating UI code, output sections in this order:

1. `Design Tokens` - CSS variables or theme object.
2. `Base Styles` - typography, reset, focus, and utilities.
3. `Core Primitives` - button, input, chip, badge, panel, table, and layout.
4. `Composed Components` - page-specific blocks.
5. `Fidelity + Extension Checklist` - short self-check.

If a section is intentionally omitted, explain why.

## Visual Intent

The product type is an operations console, not a marketing website.

The visual tone should be quiet, dense, professional, and low-saturation.

Prioritize:

1. readability;
2. status clarity;
3. information density;
4. consistency.

Avoid:

- oversized spacing;
- decorative gradients or glow effects;
- playful styling;
- consumer-card aesthetics;
- marketing-page composition.

## Core Design DNA

### Tokenized Theming

Use semantic tokens, not hardcoded component colors.

Required semantic groups:

- surfaces: `bg`, `bg-elev`, `surface`, `surface-2`, `sidebar`, `muted`,
  `muted-2`;
- text: `fg`, `fg-2`, `fg-3`, `fg-4`;
- borders: `border`, `border-strong`, `border-soft`, `divider`;
- semantic: `accent`, `ok`, `warn`, `err`, `info`, `neutral`, plus soft and
  dim variants where useful.

### Density Baseline

- Base font size is `13px`.
- Controls are compact.
- Spacing rhythm is tight.
- Content areas use minimal chrome.
- The interface should feel like a working surface, not a presentation page.

### Interaction Completeness

Every interactive primitive should cover:

- default;
- hover;
- active when meaningful;
- focus-visible;
- disabled when meaningful.

### Status Semantics

Use stable status color mappings:

- success -> `ok`;
- warning or pending -> `warn`;
- error or failure -> `err`;
- running or info -> `info`;
- emphasis or highlight -> `accent`.

Status should be perceivable through text plus color, not color alone.

## Reference Tokens

Use these default theme values. Extensions should happen through token override,
not component-level hardcoding.

```css
:root,
.theme-dark {
  --bg: #0a0a0b;
  --bg-elev: #111113;
  --surface: #121214;
  --surface-2: #16161a;
  --sidebar: #0d0d0f;
  --muted: #1a1a1f;
  --muted-2: #1f1f25;

  --border: rgba(255, 255, 255, 0.06);
  --border-strong: rgba(255, 255, 255, 0.1);
  --border-soft: rgba(255, 255, 255, 0.035);
  --divider: rgba(255, 255, 255, 0.04);

  --fg: #e7e7e9;
  --fg-2: #a8a8ad;
  --fg-3: #6f6f77;
  --fg-4: #4a4a52;

  --accent: #f59e0b;
  --accent-soft: #f59e0b14;
  --accent-dim: #f59e0b33;
  --accent-fg: #0a0a0b;

  --ok: #4ade80;
  --warn: #f59e0b;
  --err: #f87171;
  --info: #60a5fa;
  --neutral: #9ca3af;

  --ok-soft: #4ade8014;
  --warn-soft: #f59e0b14;
  --err-soft: #f8717114;
  --info-soft: #60a5fa14;

  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;

  --shadow-sheet: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 30px 60px -20px rgba(0, 0, 0, 0.55);
}

.theme-light {
  --bg: #fafaf9;
  --bg-elev: #ffffff;
  --surface: #ffffff;
  --surface-2: #f6f5f2;
  --sidebar: #f2f1ec;
  --muted: #efeeea;
  --muted-2: #e7e5df;

  --border: rgba(20, 20, 20, 0.08);
  --border-strong: rgba(20, 20, 20, 0.14);
  --border-soft: rgba(20, 20, 20, 0.045);
  --divider: rgba(20, 20, 20, 0.06);

  --fg: #15151a;
  --fg-2: #53535b;
  --fg-3: #8a8a92;
  --fg-4: #b5b5bc;

  --accent: #b45309;
  --accent-soft: #b4530914;
  --accent-dim: #b4530933;
  --accent-fg: #ffffff;

  --ok: #15803d;
  --warn: #b45309;
  --err: #b91c1c;
  --info: #1d4ed8;
  --neutral: #525252;

  --ok-soft: #15803d14;
  --warn-soft: #b4530914;
  --err-soft: #b91c1c14;
  --info-soft: #1d4ed814;

  --shadow-sheet: 0 1px 0 rgba(255, 255, 255, 0.7) inset, 0 30px 60px -20px rgba(0, 0, 0, 0.12);
}
```

## Base Style Requirements

Global baseline:

- apply `box-sizing: border-box` globally;
- body margin is `0`;
- `html` and `body` height is `100%`;
- body overflow is hidden by default;
- font family is `Geist, system-ui, sans-serif`;
- font size is `13px`;
- line height is `1.45`.

Expected utility classes:

- `.mono`;
- `.tnum`;
- `.truncate`;
- `.hstack`;
- `.vstack`;
- `.muted`;
- `.grow`;
- `.wrap`.

Focus style:

```css
:focus-visible {
  outline: 1.5px solid var(--accent);
  outline-offset: 1px;
}
```

Scrollbar styling should be subtle, low-contrast, and token-based.

## Core Primitive Specs

Preferred metrics:

- top bar height: about `46px`;
- rail width: about `286px`;
- button height: about `26px`;
- small button height: about `22px`;
- input height: about `28px`;
- segmented item height: about `20px`;
- badge height: about `18px`;
- chip height: about `22px`;
- sheet width: about `560px`;
- modal width: about `420px`.

These are preferred defaults, not rigid constants. Keep visual proportions
close unless usability requires adjustment.

### Button

Variants:

- default;
- primary;
- ghost;
- danger;
- accent, optional;
- icon-only;
- small.

Each variant should cover default, hover, active, focus-visible, and disabled
states where meaningful.

### Input

Variants:

- text;
- search;
- textarea;
- select.

Inputs should be compact, low-chrome, clearly focused, and tokenized.
Placeholder text should use `fg-3` or `fg-4`.

### Badge

Badge colors map to semantic states:

- `ok`;
- `warn`;
- `err`;
- `info`;
- `neutral`;
- `accent`.

Do not create page-specific arbitrary colors for status badges.

### Panel, Card, and Table

Panels, cards, and tables should share:

- border language;
- radius scale;
- spacing rhythm;
- background tokens;
- hover and selected states.

Cards should support grouping and scanning. They should not feel decorative.

## Layout System

### App Shell

The base shell is:

```text
topbar
workspace
  rail
  main
overlays
```

Requirements:

- the main area can scroll;
- the rail can scroll independently;
- the topbar remains stable;
- the shell should not use a marketing hero layout.

### Page Scaffolding

Preferred composition:

```text
page-shell
  page-header
    title
    description
    actions
  content
    panel / grid / table / timeline
```

### Overlay Hierarchy

Layering order:

1. scrim;
2. sheet;
3. modal;
4. toast.

Use clear z-index ordering and restrained transitions. Sheet and modal surfaces
should use `--shadow-sheet`.

## Extension Policy

Extensions are allowed when requirements differ.

Allowed extensions:

- new classes;
- new components;
- new grid structures;
- dimensions adjusted roughly within `10%` to `15%` for usability;
- additional states or variants.

Constraints:

- inherit the token system;
- preserve the density baseline;
- preserve semantic status mapping;
- avoid introducing a second visual language.

When adding a primitive, document:

- what is new;
- why existing primitives were insufficient;
- which existing tokens it reuses.

## Anti-Drift Rules

Before final output, verify:

1. Does this still look like the same product family?
2. Is it still compact and operational?
3. Are status colors semantically consistent?
4. Are interactive states complete?
5. Are tokens used instead of raw component-level colors?
6. Did any component break typography, radius, or spacing rhythm?

If drift is detected, revise before final output.

## Responsiveness

Preferred breakpoints:

- about `1100px`: dense multi-column layouts become simpler multi-column
  layouts;
- about `820px`: side-heavy layouts collapse;
- about `720px`: key panels fall back to single column.

Do not blindly hide critical actions on mobile. Preserve functional paths.
Text should not overflow or occlude controls. Fixed-format UI elements should
have stable responsive constraints.

## Accessibility and UX Baseline

Requirements:

- keyboard focus is visible;
- contrast is sufficient in dark and light themes;
- hover is not the only state signal;
- status is perceivable through text plus color;
- IDs, timestamps, counters, and durations use mono or tabular numbers where
  helpful.

## Iconography and Content Tone

Iconography:

- use a consistent icon system;
- prefer SVG or a shared icon component;
- icon-only buttons must have an accessible label or tooltip.

Content:

- short;
- technical;
- action-oriented;
- not marketing-oriented.

Examples:

- `Retry`;
- `Cancel`;
- `Review`;
- `Running`;
- `Failed`;
- `Pending`;
- `Last run`;
- `Worker runs`.

## Implementation Modes

### `strict_clone`

Use when high-fidelity reproduction is required.

Requirements:

- preserve reference metrics closely;
- preserve class patterns closely;
- avoid structural expansion unless necessary.

### `evolve_clone`

Default mode.

Requirements:

- preserve the visual DNA;
- allow structural and usability improvements;
- allow moderate component extension.

If no mode is specified, use `evolve_clone`.

## Final Self-Check Template

Append this checklist after generated UI:

```text
- Mode: strict_clone | evolve_clone
- Tokenized theming: pass/fail
- Density baseline preserved: pass/fail
- Status semantics preserved: pass/fail
- Interaction states complete: pass/fail
- Extensions introduced: list or none
- Drift risk: low/medium/high + reason
```
