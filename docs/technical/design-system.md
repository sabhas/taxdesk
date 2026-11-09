---
title: Web design system
status: accepted
version: 1.0
owners: [engineering, design]
last_reviewed: 2026-11-10
related:
  - ../adr/0003-ui-foundation.md
  - ../product/definition-of-done.md
---

# Web design system

TaxDesk is a work tool that firm staff use all day: case lists, deadlines,
and amounts. The interface is calm and compact, with one brand color, and it
should look made for a tax practice, not like a generic template. The
foundation and the reasons for it are in
[ADR 0003](../adr/0003-ui-foundation.md).

## Where things live

| Path (under `packages/web/src/`) | Contents |
| --- | --- |
| `index.css` | Design tokens, base styles, the `ledger-rules` motif |
| `components/ui/` | shadcn/ui components on Base UI (owned by this repo) |
| `components/layout/` | `AuthLayout`, `PageHeader`, `BrandMark` |
| `components/AppShell.tsx` | Signed-in shell: ink sidebar, mobile sheet navigation |
| `components/feedback.tsx` | `ErrorAlert`, `SuccessNotice`, `InfoNotice`, `LoadingMessage`, `PermissionDenied`, `EmptyState` |

Add a base component with the shadcn CLI from `packages/web` (the pnpm store
setting is needed while `node_modules` uses the repo-local store):

```bash
npm_config_store_dir="$PWD/../../.pnpm-store" pnpm dlx shadcn@latest add <component>
```

Then run `pnpm format` and `pnpm lint`, and fix findings in the generated file.

## Tokens

Use semantic utilities (`bg-primary`, `text-muted-foreground`,
`border-input`). Never use raw hex values or Tailwind palette colors
(`bg-blue-600`) in feature code. The one exception is the QR code, which is
always black on white because scanners need that contrast.

| Token | Value | Use | Contrast |
| --- | --- | --- | --- |
| `background` | `#F5F7F7` | Page ("paper") | — |
| `foreground` | `#14212B` | Body text ("ink") | 15.2:1 on background |
| `card` | `#FFFFFF` | Cards, inputs, popovers | — |
| `primary` | `#0F5A4A` | Ledger green: primary actions, focus ring | 8.1:1 with white |
| `muted-foreground` | `#55646D` | Secondary text | 5.4:1 on muted, 6.1:1 on white |
| `accent` | `#E3EFEC` | Hover and selected tint | — |
| `destructive` | `#B42318` | Stamp red: destructive actions, overdue | 6.6:1 on white |
| `success` / `success-subtle` | `#17663F` / `#E8F5EE` | Done, enabled, paid | 6.2:1 |
| `warning` / `warning-subtle` | `#8A4B06` / `#FDF3E3` | Due soon, setup required | 6.2:1 |
| `border` | `#D5DEDD` | Card and table rules | decorative |
| `input` | `#7D8D97` | Form control borders | 3.0:1 on white, 3.2:1 on paper |
| `sidebar` | `#14212B` | Ink sidebar and brand panel | — |
| `sidebar-primary` | `#7FD1B9` | Active nav marker | 9.1:1 on sidebar |

Radius is `0.5rem` (`rounded-lg`). Tables, codes, and `.tabular` use tabular
figures so amounts and dates line up in columns.

## Typography

IBM Plex Sans (variable, self-hosted) for everything; the system monospace
stack for codes and IDs.

| Role | Classes |
| --- | --- |
| Page title (one `h1` per page) | `text-2xl font-semibold tracking-tight` via `PageHeader` |
| Card or section title (`h2`) | `CardTitle` |
| Body | `text-sm` (inputs use `text-base` on mobile to avoid iOS zoom) |
| Help and metadata | `text-sm text-muted-foreground` / `text-xs` |

Use sentence case everywhere. Do not use all-caps labels.

## Layout

- **Signed-in pages** render inside `AppShell` and start with `PageHeader`
  (title, one-line description, actions on the right). Content is cards and
  tables in a `max-w-6xl` column with `gap-5` between cards.
- **Pre-sign-in screens** (sign-in, MFA, activation, session states) use
  `AuthLayout`: an ink brand panel with the ledger rules on wide screens, and
  the form on paper. Use `width="wide"` for content wider than a form, such as
  MFA setup.
- **Lists** are a `Table` inside `Card className="gap-0 py-0"`. Empty lists
  render `EmptyState` with a next step. Row actions are `outline` `sm`
  buttons; reserve the `destructive` variant for irreversible or
  security-reducing actions (for example "Disable MFA"), not routine row
  actions.

## Components and states

| Need | Use |
| --- | --- |
| Primary action | `Button` (default); one per view |
| Secondary action | `Button variant="outline"` or `"ghost"` |
| Text field | `Field` + `FieldLabel` + `Input` (+ `FieldDescription` linked with `aria-describedby`) |
| Select | `NativeSelect` (keeps native keyboard and mobile pickers) |
| Status label | `Badge` with `success`, `warning`, `secondary`, or `outline` |
| Request failed | `ErrorAlert` (`role="alert"`, includes the reference ID) |
| Action succeeded | `SuccessNotice` (`role="status"`) |
| Loading | `LoadingMessage`, or a spinner inside the busy button with `aria-busy` |
| Missing permission | `PermissionDenied` |
| Confirm a destructive action | `AlertDialog` |

Every button keeps a visible text label, or an `aria-label` when it shows
only an icon. Icons are decorative (`aria-hidden="true"`).

### Confirming an action

Ask for confirmation only when an action revokes access or can't be undone in
one step, such as deactivating a user (it signs them out of every session).
Actions that are safe or reversible with one click, such as reactivating a
user, run immediately.

- Use one `AlertDialog` per page, opened from state (for example
  `pendingDeactivation`), not one per row. Without a `Trigger`, set
  `finalFocus` so focus returns to the row button that opened it.
- The title asks the question with its object: "Deactivate Staff Person?".
  The description says what happens and what is kept.
- The confirm button repeats the action and its object ("Deactivate Staff
  Person") and uses the `destructive` variant; `Cancel` comes first. Escape
  and `Cancel` never perform the action.
- While the request runs, the confirm button shows the busy spinner with
  `aria-busy` and both buttons are disabled. Close the dialog when the request
  finishes and report the result with the page's `SuccessNotice` or
  `ErrorAlert`.

## Local changes to generated components

Re-apply these after regenerating a component with the CLI:

- `button.tsx`: `forwardRef` for React 18; default height `h-9`, `sm` `h-8`,
  `lg` `h-10`, `icon` `size-9`; primary hover `bg-primary/90`.
- `input.tsx`, `native-select.tsx`: `h-9`, `bg-card`, `px-3`.
- `toggle.tsx`: default `h-9`.
- `alert.tsx`: roomier padding; `destructive` uses the subtle background;
  added `success` and `warning` variants.
- `badge.tsx`: added `success` and `warning` variants.
- `table.tsx`: `px-3` cells with `pl-4`/`pr-4` at the row edges; muted
  `text-xs` headers.
- `field.tsx`, `toggle-group.tsx`: lint fixes only.

## Motion

Motion only responds to what the user does: dialogs and sheets fade and
slide, busy buttons show a spinner. There is no decorative or entrance
animation. `prefers-reduced-motion` reduces all transitions to near zero.

## Dark mode

Not shipped. To add it, define a `.dark` block in `index.css` that redefines
the same variables, re-check every pair in the token table, and add a toggle
that follows the OS setting.
