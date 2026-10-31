Portboard is a dashboard of the TCP ports, devices and dev worktrees on one Linux server. Its interface is a dense
tool for a person who already knows what a port is: warm neutral greys, one blue accent, four status colours, system
fonts and hairline borders. Build new screens from the tokens and components below so they read as the same app.

## Content fundamentals

- Every string a person reads exists in English and Korean. Write both. Never hard-code a label in one language.
- English: sentence case, short labels, verbs on buttons: "Open ↗", "Copy SSH", "Unexpose", "Pin to top".
- Korean: polite 해요체 in sentences ("저장했어요", "소유자 토큰 없이 직접 열었어요"), plain nouns in labels ("재시작", "알림 채널").
- State facts, not feelings. A status line reads "As of 10:42:07 · 24 ports", not "Everything looks great!".
- Separate facts with a middle dot: "Down alerts · no alert channel".
- Write a settings path with "›": "Settings › Display › Language".
- End a label with "↗" when it opens a new tab, and with "…" when it opens a dialog or a menu ("Where to run…").
- Address the reader as "you" only when you tell them what to do. Do not write "we".
- Put example values in docs and previews: ports 3000, 5173, 8080, the names my-app and desktop, and `desktop.example.ts.net`. Never put a real host name, tailnet name, address or home path.
- No decorative emoji. 🔔 means a down alert and ☆/★ means pin. They are controls, not ornaments.

## Visual foundations

### Colour

- Grounds rise in three steps: `side-bg` token (sidebar), `bg` token (page), `surface` token (cards, rows, dialogs, buttons). In dark mode each step is lighter than the one below it, so depth comes from lightness, not from shadows.
- Text has three levels: `text` token for names and primary text, `muted` token (an alias of the `text-2` token) for meta lines, and the `text-3` token for counts, separators and section headings in the sidebar.
- Use the `line` token for every border and divider. Set surfaces apart with a 1px `line` border, not with a shadow.
- Use the `neutral-bg` token for quiet fills: tags, badges, key caps and meter tracks.
- The `accent` token is for action and focus only: links, the primary button, focus outlines, the selected item and the "new" badge. Do not use it for decoration or for status.
- Status colours carry meaning: `ok` token (up), `warn` token (degraded or needs a look), `danger` token (down, failed, destructive), `info` token (informational marks). `ok`, `warn` and `info` have a fill for a badge or a notice behind status text: the `ok-bg` token, the `warn-bg` token and the `info-bg` token. A danger fill is a `color-mix()` tint of `danger` (see Not synced).
- On an accent or danger fill, set text in the `accent-text` token or the `danger-text` token. In dark mode these are near-black, because the dark accent and danger are light.
- Every text colour (`text`, `text-2`, `text-3`, `accent`, `ok`, `warn`, `info`, `danger`) reaches 4.5:1 on `bg`, `side-bg`, `surface`, `neutral-bg` and `info-bg` in both themes. Keep that true when you add a pair.
- Pair a status colour with a word or a title. A colour alone does not say the state.
- Settings use their own quiet tones: the `st-divider` token between rows, the `st-hover` token and the `st-current` token for tabs and menu options, the `st-seg-bg` token and the `st-seg-on` token for segmented controls, and the `st-backdrop` token behind modals.
- The app follows the system theme. A person can force light or dark (Settings › Display › Theme); the page then sets `data-theme="light"` or `data-theme="dark"` on `<html>`.

### Type

- Use the system font stack (the `sans` family): no web fonts. "Apple SD Gothic Neo" and "Noto Sans KR" in the stack cover Korean.
- Body text is 14px with a line height of 1.45 (`fs-4`): row names, sidebar view rows, inputs and the settings window.
- 13px (`fs-3`) is for shell tabs, secondary sidebar items, the inspector body, list group heads and toasts. Buttons are 13px too.
- Meta lines, sidebar counts and the section headings of the sidebar and the inspector use 12px (`fs-2`); key caps and log text 11px (`fs-1`); the page title and the inspector title 15px (`fs-5`).
- Hierarchy comes mostly from the three text colours and from weight 600, not from size.
- Set port numbers, addresses, commands and paths in the `mono` family. The base port figure is the `figure-port` style (600, 18px). In the dashboard list it drops to 13px on desktop and 15px on a phone. Other hosts' port lists use the `figure-port-sm` style (600, 13px).

### Shape and space

- Controls (buttons, inputs, selects) use the `radius-8` token. Cards, dialogs and the command palette use the `radius-12` token. Device cards on the devices tab use the `radius-14` token.
- A list is one bordered `surface` container with flat rows split by `line` dividers: 8px corners on desktop (`radius-8` token), 10px on a phone (`radius-10` token).
- Badges, chips and tags are pills (`radius-pill` token). Status dots are round (`radius-round` token), 8px wide.
- Spacing is literal in the CSS; there are no spacing tokens. Keep the rhythm the CSS uses: buttons 6px 11px, list rows 6px 12px (10px 12px on a phone), gaps of 4 to 8px between controls.
- Shadows are rare and mark layers that float. The command palette and the keyboard shortcuts dialog use the `shadow-dialog` token, toasts the `shadow-toast` token, the sidebar drawer the `shadow-drawer` token and the inspector sheet the `shadow-sheet` token. Other shadows (the settings modal, menus, the device detail panel, the current tab and segment) are literal (see Not synced).

### Layout

- The shell is a top bar (`bar-h` token, 48px), a left sidebar (`side-w` token, 288px), a main column of at most 808px (`col-max` token; 960px on the devices tab, `col-wide` token) with 20px side padding (`col-pad` token), and on some pages a right inspector of 300px.
- From 1200px wide the inspector is a column. Under 1200px it is a right sheet. Under 768px inputs are 16px, and from 641px to 767px the column has no side padding. Under 704px the sidebar is a drawer. At 640px and below the bar wraps into the phone layout.
- Lists are single columns of rows. Do not put a list in a multi-column grid unless the items are cards (the devices tab).

### Motion and states

- Motion is short and functional: drawers and sheets slide in .16s, fades take .12s. Switching the theme turns transitions off. Honour `prefers-reduced-motion`.
- Focus is a 2px solid outline in the `accent` token. Do not remove it without a replacement.
- Hover raises a border to the `muted` token or fills with the `st-hover` token. Disabled is opacity .5.
- A control that changes the server carries `data-write="1"`. On a read-only page (`html[data-readonly]`) those controls are greyed out and a note says why.

## Iconography

- There is no icon font and no sprite. Controls use text glyphs: ↻ refresh, ⋯ more, ☆/★ pin, 🔔 down alert, ← back, ↗ opens a new tab, × close, ⌘K the command palette. A few controls draw small inline SVG strokes in the `text-3` token.
- The app icon (Logos › icon.svg) is three rounded bars and a green dot on a blue square. It keeps its own blue `#2f6feb` and green `#5fe08d`; they are not UI tokens. Use the icon as is, at 16px and up. There is no wordmark: set the name "Portboard" in the `sans` family.

## Components

The components are static renditions of the dashboard's real markup, styled by the dashboard's own stylesheets
(`components/bundle.css`). Use the same element types, class names, wrappers and attributes. Each component's
guidelines say what the consumer supplies.

## Not synced

- Spacing has no tokens; many font sizes in the CSS are literals (12.5px, 13.5px, 11.5px and others) outside the `fs-1` to `fs-5` scale.
- `color-mix()` tints (for example the border of a down row, the serve tag in dark mode) and a few literal colours (the pin's gold `#d4a72c`, the toggle knob `#fff`) stay in `components/bundle.css` and are not tokens.
- Radius and shadow names exist only in the design system; the CSS writes the values directly.
- Shadows outside the four tokens stay literal: the settings modal, menu panels and lists, the device detail panel, the current shell tab, the chosen segment and the toggle knob.
- Components are hand-written static renditions, not a built library: the dashboard is plain DOM code without a component bundle.
- Most font sizes in the CSS repeat the `fs-1` to `fs-5` values as px literals instead of `var(--fs-*)`; only `shell.css` uses the variables widely.
- The serve tag uses literal purples (`#8250df`, `#d2a8ff` in dark mode), and the devices view switch uses a literal `#000` shadow tint.
- `public/features/digest.js` reads `var(--card)`, but no stylesheet declares that property; it falls back to `transparent`.
- There are no `link`, `focus`, chart, size, z-index or motion tokens, and no `danger-bg` or `on-ok` / `on-warn` / `on-info` colours. Charts use `accent`, `ok`, `warn` and `danger` directly.
- `line` is a hairline: on `surface` it is 1.25:1 in light and 1.35:1 in dark, under 3:1 for control borders.
- Three status dots carry no word: the sidebar dots (state in a hover title), an online device chip, and an online machine card.
- Motion has no table here: durations run from .1s to .18s (and 1.6s for the palette flash), and `prefers-reduced-motion` stops only some of them.
- This brand book has no principles, no contrast table and no component list, and its layout section does not cover the development tab, the service page or the settings window.
- Components have no types and no state or keyboard sections. The app still builds a modal, dialog and sheet, copy button, logs viewer, tables, sparklines, a filter popover, tabs, the inspector and the network tree without a design-system component.
