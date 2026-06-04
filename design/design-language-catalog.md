# Design Language Catalog

The shared vocabulary for the design workflow (ADR 0022). A **design language is a
visual-expression philosophy, not a token set.** Each entry states *why* it exists
(what it deliberately **omits** and what it **elevates**), names **exemplars** who
embody it, then gives **derivation rules** — how that philosophy turns into concrete
parameters 因地制宜 in the `derive` stage.

These are grounded in real, well-regarded design philosophies (Dieter Rams' *Ten
Principles*, Apple's *Human Interface Guidelines*, the modern product-craft of
Linear/Vercel/Stripe) — not invented themes. The `language` stage picks 2-3
candidates suited to the `frame`, steelmans them, and converges on one; `derive`
then applies that language's rules to the specific frame. A language is a starting
philosophy to *adapt*, never a theme to paste. Extensible.

---

## 1. Reductive — "Less, but better" (Dieter Rams)

**Philosophy.** Rams' *Weniger, aber besser*: good design is **honest, unobtrusive,
long-lasting, and as little design as possible**. Strip to the essential so the
product's purpose speaks for itself. Restraint is not emptiness — it is *respect for
the user's attention*.
- **Omits:** ornament, borders, shadows, competing colors, chrome, trend-chasing, anything that doesn't serve function.
- **Elevates:** content, the single primary action, whitespace as structure, type hierarchy, durability over fashion.

**Exemplars.** Braun, Vitsœ, Muji, early iOS, Things, iA Writer.

**Derivation rules.**
- *Type:* one family; wide size/weight contrast carries the hierarchy; generous line-height.
- *Space:* whitespace is the primary layout tool; large, consistent rhythm (8px base, big section gaps).
- *Color:* near-monochrome + exactly one accent reserved for the primary action/state.
- *Shape:* flat; no or hairline (1px, low-contrast) borders; corners subtle or square.
- *Elevation:* none, or a single barely-there layer; depth via spacing, not shadow.
- *Components:* flat buttons, generous padding, one accent CTA; underline/hairline inputs.
- *Motion:* minimal, fast, functional — never decorative.

**Best fit:** docs, focused single-purpose products, reading, tools where content *is* the value.
**Risks:** can read cold/unfinished for consumer/onboarding; demands excellent content + type to carry it.

---

## 2. Apple — Clarity · Deference · Depth (HIG)

**Philosophy.** Apple's three pillars: **Clarity** (legible at every size, precise
icons, minimal adornment, zero ambiguity), **Deference** (the UI never competes with
the content — it recedes so the user's work/photos/words stay front and center), and
**Depth** (layers, materials, and realistic motion convey hierarchy and give the
interface life). The recent "Liquid Glass" turn restates it as *hierarchy, harmony,
consistency*. Design is *how it works*, made to feel inevitable and premium —
function and emotion fused with obsessive craft.
- **Omits:** decoration that competes with content, visual noise, gratuitous color, anything that breaks the illusion of effortlessness.
- **Elevates:** content, legibility, tactile depth/materials, fluid motion, craft you can feel, large confident imagery.

**Exemplars.** apple.com, iOS / macOS, Apple Music/Notes, Things 3, Bear.

**Derivation rules.**
- *Type:* one refined sans (SF-like); large, confident headline scale; precise optical sizing; high legibility everywhere.
- *Space:* very generous; content-first layouts; full-bleed imagery with breathing room.
- *Color:* mostly neutral canvas (light *or* deep dark) so content/material pops; restrained system accents; vibrancy/translucency for layered surfaces.
- *Shape:* soft, consistent radii; materials (blur/translucency, subtle gradients) rather than hard borders.
- *Elevation:* real depth — layered surfaces, soft diffuse shadows, glass/vibrancy; motion reinforces the layer model.
- *Components:* large touch targets, content-deferential chrome, fluid sheets/transitions, crisp iconography.
- *Motion:* physically-credible, smooth, purposeful — communicates hierarchy and continuity.

**Best fit:** premium products, marketing/launch pages, consumer apps where polish signals quality.
**Risks:** expensive to execute well (craft bar is high); depth/motion overdone becomes heavy; needs strong imagery.

---

## 3. Precision Product Craft (Linear · Vercel · Stripe)

**Philosophy.** The dominant modern dev-product language: **earn trust through
craft and restraint.** "We are infrastructure built by engineers who care about
detail" — said without saying it. Sharp, fast, exact; every choice reinforces the
product's value.
- **Omits:** stock illustration, rounded "friendly" softness, multi-color palettes, marketing fluff, slow decorative motion.
- **Elevates:** monochrome + one hard-working accent, generous whitespace ("whitespace is air"), real product UI, motion that demonstrates *speed*, dark mode.

**Exemplars.** Linear, Vercel, Stripe, Resend, Raycast.

**Derivation rules.**
- *Type:* tight, geometric, slightly cold sans (Inter/Geist lineage); high contrast; confident but not loud.
- *Space:* generous, deliberate; strong above-the-fold positioning; the eye always knows where to go.
- *Color:* near-monochrome (black/white/gray) + **one** accent used sparingly; dark mode first-class (default to system preference).
- *Shape:* small precise radii, hairline borders, crisp surfaces; subtle gradients/glows used with discipline.
- *Elevation:* restrained; thin borders + faint shadows; precision over softness.
- *Components:* real product screenshots/embeds (not stock), copyable code, precise tables, sharp nav.
- *Motion:* fast, functional, shows interface speed; never blocks the page.

**Best fit:** dev tools, infra/SaaS, API products, anything selling to engineers (e.g. sikong).
**Risks:** now so common it can read generic — needs a genuine point of view + real product visuals to stand out.

---

## 4. Editorial (Typographic)

**Philosophy.** Treat the page like print: **typography *is* the design.** Reading is
the experience; rhythm, measure, and contrast guide the eye.
- **Omits:** UI chrome, boxes, cards, heavy color — anything that interrupts reading.
- **Elevates:** type pairing, vertical rhythm, measure, pull quotes, the author's voice.

**Exemplars.** The New York Times, Medium, Stripe Press, Smashing Magazine, literary/press sites.

**Derivation rules.**
- *Type:* a deliberate pairing (serif display + humanist sans, or one strong serif); large headline scale; ligatures, hanging punctuation.
- *Space:* narrow measure (~60-72ch), strong baseline rhythm, generous leading.
- *Color:* paper-and-ink; restrained; one editorial accent for links/marks.
- *Shape:* essentially none — text on background; thin rules instead of boxes.
- *Components:* drop caps, pull quotes, footnotes, figure captions; minimal buttons.
- *Motion:* subtle, reading-respectful (smooth anchor scroll).

**Best fit:** blogs, articles, long-form, essays, content-led marketing.
**Risks:** poor for dense apps/dashboards or action-heavy products.

---

## 5. Swiss / Grid-Rational (International Typographic Style)

**Philosophy.** Objectivity and clarity through **system**. The grid is truth; design
is the honest organization of information, not persuasion.
- **Omits:** decoration, illustration-for-its-own-sake, emotional flourish, centered hero theatrics.
- **Elevates:** the grid, alignment, a modular scale, neutral sans type, data legibility.

**Exemplars.** IBM Carbon, Swiss poster tradition (Müller-Brockmann), Bloomberg-style data UIs, reference docs.

**Derivation rules.**
- *Type:* neutral grotesque/geometric sans (Helvetica/Inter/Univers lineage); tight systematic scale; flush-left.
- *Space:* a visible, strict modular grid; asymmetric balance; mathematical spacing.
- *Color:* restrained, functional; flat blocks; one or two signal colors for state/category.
- *Shape:* flat, square, rule-based; tables and data render beautifully.
- *Components:* dense-but-aligned tables/lists, clear labels, systematic nav.
- *Motion:* minimal, precise, non-decorative.

**Best fit:** docs, admin/dashboards, data-dense apps, reference, anything systematic.
**Risks:** can feel impersonal/corporate for consumer or playful brands.

---

## 6. Brutalist / Raw-Honest

**Philosophy.** Expose the material; **reject polish as deception.** The web's raw
defaults are honest and fast. Confidence over comfort.
- **Omits:** rounded corners, soft shadows, gradients, "friendly" smoothing, marketing gloss.
- **Elevates:** visible structure, system/monospace type, speed, directness, a strong point of view.

**Exemplars.** Hacker News, Craigslist, early Gumroad, Bloomberg terminal, indie/manifesto sites.

**Derivation rules.**
- *Type:* system stack or monospace; large loud headlines; minimal styling.
- *Space:* hard, deliberate; visible structure; sometimes intentionally tight/asymmetric.
- *Color:* high contrast, few colors; near-default link blue / stark black-on-white or inversions.
- *Shape:* hard edges, no radius, thick or no borders; raw boxes.
- *Components:* unembellished buttons/inputs; fast, no skeletons.
- *Motion:* little to none.

**Best fit:** power-user dev tools, manifestos, indie/hacker brands, "we ship, not theater."
**Risks:** alienates non-technical/consumer audiences; easy to do badly (ugly ≠ brutalist).

---

## 7. Terminal / Developer-Native

**Philosophy.** Speak the user's language — the **shell and the editor**. Credibility
comes from looking like the environment developers already trust.
- **Omits:** corporate polish, stock illustration, light-mode marketing sheen, rounded SaaS softness.
- **Elevates:** code as first-class, the terminal/IDE motif, dark canvas, monospace accents, precision.

**Exemplars.** Warp, Raycast, Fig, Charm/Bubble Tea sites, many CLI/infra products (and sikong itself).

**Derivation rules.**
- *Type:* clean sans for prose + strong monospace for code/accents/labels; code blocks are hero elements.
- *Space:* IDE-like density where useful; terminal "window" chrome (traffic lights, prompts).
- *Color:* dark base (deep navy/black); a syntax-highlight palette (cyan/green/magenta/violet) used sparingly; subtle glow.
- *Shape:* small radii, thin precise borders, panel/terminal framing.
- *Components:* copyable command blocks, syntax-highlighted snippets, status/prompt indicators, keyboard hints.
- *Motion:* sparing typing/cursor effects; otherwise crisp.

**Best fit:** CLIs, dev tools, infra/orchestration, API products.
**Risks:** overdone glow/neon reads gimmicky; poor for non-developer audiences. (Often best *blended* with Precision Product Craft — terminal motifs, dev-craft discipline.)

---

## 8. Humane / Soft (Warm-Approachable)

**Philosophy.** Lower the barrier; make software feel **safe, friendly, human.**
Comfort and clarity for people who are not experts.
- **Omits:** intimidating density, hard edges, jargon-forward chrome, stark contrast.
- **Elevates:** warmth, generous touch targets, gentle depth, plain language, approachable illustration.

**Exemplars.** Duolingo, Headspace, Notion (onboarding), Slack, consumer fintech.

**Derivation rules.**
- *Type:* friendly humanist/rounded sans; comfortable sizes; relaxed hierarchy.
- *Space:* generous padding, big tap targets, breathing room; few things per view.
- *Color:* warm, soft palette; gentle gradients; accessible but not harsh contrast.
- *Shape:* rounded corners, soft diffuse shadows, pill buttons.
- *Components:* large friendly buttons, helpful empty states, inline guidance, illustration slots.
- *Motion:* soft, reassuring micro-interactions.

**Best fit:** consumer apps, onboarding, approachable SaaS, anything for non-experts.
**Risks:** can feel toy-like or slow for power tools and dense data.

---

## Using the catalog (for the `language` and `derive` stages)

1. From the `frame`, shortlist 2-3 languages whose *philosophy* fits the content,
   audience, and key actions (a docs site ≠ a landing ≠ an admin console).
2. Steelman each (its omit/elevate, the feeling it creates, *why* it suits this
   frame); pre-mortem the favorite; converge — record the choice + rejected ones.
3. In `derive`, apply the chosen language's **derivation rules** to *this* frame,
   producing concrete params, and justify each against the philosophy.
4. Languages may be *adapted and blended* (e.g. Terminal structure + Precision
   Product Craft discipline, or Reductive purity + Apple depth), but a blend must
   still answer "what does it omit / elevate, and why" — a blend without a thesis
   is just a theme.

## Sources

- Dieter Rams — *Ten Principles for Good Design* ("less, but better"): Vitsœ / Design Museum.
- Apple — *Human Interface Guidelines* (Clarity, Deference, Depth; Liquid Glass: hierarchy/harmony/consistency).
- Modern product craft — design principles behind Stripe, Linear, Vercel (monochrome + one accent, whitespace, geometric type, motion-as-speed, dark-by-default).
