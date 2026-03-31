# DTSB Design Language

The current UI language is split into three layers:

1. `assets/css/common.css`
Base application styles and legacy shared components.

2. `assets/css/design-language.css`
Shared playful/game-like language used across `index.html`, `results.html`, `list.html`, `list_graph.html`, and `results_graph.html`.

3. Page-local styles
Layout, chart sizing, map behavior, and data-view rules that are specific to one page.

## Core Principles

- Keep the existing purple/blue palette and make interactions feel lighter, chunkier, and more game-like.
- Use rounded surfaces, visible depth, and soft gradients instead of flat panels.
- Reserve the strongest elevation for actions, progress states, and current-step UI.
- Keep data-heavy areas readable first; decorative treatment should wrap around them, not compete with them.

## Shared Tokens

Defined in `assets/css/design-language.css`:

- `--fun-violet`
- `--fun-violet-deep`
- `--fun-indigo`
- `--fun-lilac`
- `--fun-ink`
- `--fun-card`
- `--fun-border`
- `--fun-shadow`

## Shared Components

Owned by `assets/css/design-language.css`:

- Breadcrumb/button dressing
  - `.breadcrumb-arrow li.step a`
  - `.c-table thead th`

- Mission / quest UI
  - `.dtsb-headnav`
  - `.dtsb-mission*`
  - `.dtsb-hero*`
  - `.dtsb-chip*`
  - `.dtsb-progress*`
  - `.dtsb-stage-card*`
  - `.dtsb-quest-btn*`

- Results / comparison UI
  - `.dtsb-fun-panel`
  - `.dtsb-stat-card*`
  - `.dtsb-compare-*`
  - `.dtsb-chart-card*`
  - `.dtsb-compare-table*`
  - `.dtsb-meta-chip`

- AI story UI
  - `.dtsb-story-panel*`
  - `.dtsb-story-chip*`
  - `.dtsb-story-bubble*`
  - `.dtsb-story-box__head`
  - target select card styling inside `.p-result__story-box`

## Page Ownership

- `index.html`
  - Dynamic route controls
  - Route-source switcher
  - Frequency slider styling

- `results.html`
  - Map/result page layout
  - Station people widgets
  - Result-page-only spacing rules

- `results_graph.html`
  - Graph-page layout, chart sizing, and panel sizing

- `list.html`
  - Table presentation and compare selection behavior

- `list_graph.html`
  - Graph comparison page layout adjustments

## Editing Rules

- If a style is reused across multiple pages, move it into `assets/css/design-language.css`.
- If a style controls one page’s structure, chart sizing, or data-specific behavior, keep it local to that page.
- Prefer extending existing `dtsb-*` components over adding new one-off visual classes.
- When adding a new reusable component, document it here and keep the naming inside the `dtsb-*` namespace.
