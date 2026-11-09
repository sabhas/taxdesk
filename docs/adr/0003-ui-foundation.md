---
title: "ADR 0003: shadcn/ui on Base UI and Tailwind CSS as the web UI foundation"
status: accepted
version: 1.0
owners: [engineering, design]
last_reviewed: 2026-11-10
related:
  - ../technical/design-system.md
  - ../technical/architecture.md
---

# ADR 0003: shadcn/ui on Base UI and Tailwind CSS as the web UI foundation

## Context

The web app was styled by one global stylesheet with seven color variables,
no spacing or type scale, and raw `<button>`/`<input>` elements on every page.
Each new screen re-invented layout and feedback, and the result looked
inconsistent and unfinished. Epics 2–6 add many list, form, and dialog screens,
so the team needs a shared component set and design tokens before that work
starts, without hand-building every component.

Two constraints narrow the choice:

- The production content security policy (`packages/web/public/_headers`)
  allows only same-origin styles and fonts: `style-src 'self'` and
  `font-src 'self'`. Runtime CSS-in-JS (MUI, Chakra, Emotion), injected
  `<style>` tags, and CDN fonts are blocked. Cloudflare Pages serves static
  headers, so a per-request style nonce is not available.
- Accessibility is part of the Definition of Done and the web suite runs axe.

## Decision

- **Tailwind CSS v4** (Vite plugin) compiles every style into one static
  stylesheet served from the app's origin.
- **shadcn/ui** generates the base components into
  `packages/web/src/components/ui/`. The repository owns that code; it is
  linted, formatted, and edited like any other source. Add components with
  the shadcn CLI, then fix lint findings in place.
- **Base UI** (`@base-ui/react`) is the primitive layer under shadcn, not
  Radix. Radix dialogs lock scrolling through `react-remove-scroll`, which
  injects a `<style>` tag that the policy blocks. Base UI locks scrolling
  through element styles (allowed) and exposes `CSPProvider
  disableStyleElements`, which the app root sets so the two components that
  could inject styles (ScrollArea, Select) never do.
- **Design tokens** live as CSS variables in `packages/web/src/index.css`
  and are the only source of color, radius, and font. Components reference
  tokens through Tailwind utilities, never raw hex values.
- **IBM Plex Sans** (variable) is bundled through Fontsource and served
  from the app's origin. Lucide is the icon set.
- The theme ships light mode only. Tokens are structured so dark mode is a
  later `.dark` block, with no component changes.

## Consequences

- Verified on 2026-11-10: a production build served with the real policy
  showed no CSP violations on the sign-in, MFA, and signed-in pages, including
  with the mobile navigation sheet open. The bundle contains no
  `document.createElement('style')` calls.
- shadcn's Base UI components assume React 19, where `ref` is an ordinary
  prop. The web app is on React 18, so `Button` uses `forwardRef` to keep
  `render={<Button />}` triggers working. Remove that wrapper when the app
  moves to React 19.
- Upgrading a generated component means re-running the shadcn CLI and
  reviewing the diff. Local changes (control heights, status variants) are
  listed in `docs/technical/design-system.md`.
- Any future library that injects styles at runtime is incompatible with the
  policy and needs a superseding ADR.
