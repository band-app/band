# Appearance

Settings > Appearance sets the mode, a theme preset, three colors, two fonts and two font sizes. Every part of the web UI follows them, because components use semantic tokens and never a fixed color.

## What you can set

- **Mode.** System, Light or Dark, shown as preview cards. The mode is stored per device (`localStorage["band-theme"]`), so System follows each device's OS.
- **Theme.** Band (the default look), GitHub, Solarized, Nord or Catppuccin, each with a light and a dark variant. A preset sets the whole palette, including the terminal's 16 ANSI colors, the syntax colors and the status colors.
- **Accent, Background, Foreground.** A swatch and a hex field. Overrides are stored per mode: while the page is dark, you edit the dark palette and the light one keeps the preset. The Theme field reads "Custom" while a mode has an override. Choosing a preset clears the overrides.
- **UI font and code font.** System plus a few choices. Each font has a fallback stack, so a font that is not installed falls back to the system font. Band ships no web fonts.
- **UI font size** (default 16) scales the interface, which is sized in rem. **Code font size** (unset by default, so each surface keeps its own size: 14px in chat and markdown code, 13px elsewhere; typing a number sets all of them) applies to chat code blocks, the editor, diffs and the terminal, and the terminal refits its columns.
- **Reset to default** restores the Band preset, the default fonts and the default sizes. It leaves the mode alone.
- **Translucent sidebar** is the macOS desktop toggle that was already here.

The preset, colors, fonts and sizes live in synced client state (`band-appearance`, scope `all`), so every browser and the desktop app signed in to one hub show the same theme.

## How it works

`apps/web/src/lib/theme/` holds the model:

- `model.ts` reads and validates the stored appearance and resolves it to CSS variables for a mode.
- `derive.ts` turns accent, background and foreground into the surface tokens (card, popover, muted, border, input, ring, sidebar, selection, terminal) and nudges text colors until they reach a 4.6:1 contrast against the surfaces they sit on (4.5:1 is the WCAG AA minimum). It also builds the semantic, terminal and syntax colors from a preset's hues.
- `presets.ts` holds the preset data.
- `apply.ts` sets the variables and the `dark` class on `<html>` and fires `band-theme-changed`. Nothing re-renders the React tree.

The Band preset with no overrides sets no variables, so `styles/globals.css` is the Band look. Any other choice sets variables inline on `<html>`, which win over the stylesheet.

A change does not reload anything. The terminal listens for `band-theme-changed` and updates xterm's theme, font and size in place. CodeMirror styles (`dashboard/lib/codemirror-theme.ts`) and chat code blocks (`components/shiki-band-theme.ts`) use `var(--syntax-*)`, so they change with the variables.

### No flash on load

`apply.ts` caches the resolved variables for both modes in `localStorage["band-theme-vars"]`. The blocking script in `<head>` (`lib/theme/init-script.ts`) applies the device's mode and the matching variables before first paint.

## Tokens

`apps/web/src/styles/globals.css` defines them for light (`:root`) and dark (`.dark`), and `@theme inline` exposes each as a Tailwind utility (`bg-selection`, `text-success`, `border-selection-border`, ...).

| Group | Tokens |
| --- | --- |
| Surfaces | `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `sidebar`, `border`, `input`, `ring`, `link` (each surface with a `-foreground`) |
| Selection and focus | `highlight`, `selection`, `selection-border`, `selection-foreground`, `drop-target`, `focus-ring` |
| Git and diff | `git-added`, `git-modified`, `git-deleted`, `git-renamed`, `git-untracked`, `git-conflict`, `git-ahead`, `git-behind`, `git-diverged`, `diff-added-bg`, `diff-removed-bg`, `diff-added-marker`, `diff-removed-marker` |
| Status | `success`, `warning`, `danger`, `info`, `merged`, each with `-foreground` and `-bg`; `status-working`, `status-question`, `status-done`, `status-failed`, `status-foreground` |
| Find and editor | `search-match`, `search-match-current`, `editor-active-line` |
| Terminal | `terminal-background`, `terminal-foreground`, `terminal-selection`, `ansi-0` to `ansi-15` |
| Syntax | `syntax-comment`, `-keyword`, `-control`, `-string`, `-number`, `-function`, `-variable`, `-type`, `-property`, `-operator`, `-tag`, `-attribute`, `-punctuation`, `-constant`, `-regexp`, `-heading`, `-inserted`, `-deleted`, `-invalid` |
| Fonts | `font-ui`, `font-code`, `code-font-size` (unset until chosen) |

## Using tokens in code

Use a token, not a palette class or a color literal. `bg-blue-500`, `text-green-600 dark:text-green-400`, `#ff0000` and `rgba(...)` in `.ts` and `.tsx` files fail `node scripts/check-theme-tokens.mjs`, which runs in `pnpm lint`, `pnpm check` and CI. Pick the token by meaning: a passing check is `text-success`, a modified file's letter is `text-git-modified`, a selected row is `bg-selection`. A token a feature needs and the list lacks belongs in `globals.css`, with a light and a dark value.

A color that must not follow the theme (a QR code's white background, a brand color, the remote desktop viewer's dark frame) takes a marker and a reason:

- `// theme-lint-ignore-line: <reason>` on the line, or on the line above it
- `// theme-lint-ignore-file: <reason>` in the first five lines of a file

The theme engine itself (`apps/web/src/lib/theme/`) and test files are exempt. The desktop app's standalone `error-html.ts` page is outside the scanned directories because it renders before the UI loads.

## Tests

- `apps/web/tests/theme-derive.test.ts`: the derivation keeps foreground and muted foreground at 4.5:1 or better for very dark, very light, mid-grey and saturated inputs, and every preset variant.
- `apps/web/tests/theme-lint.test.ts`: the lint fails on a fixture with `bg-blue-500` or `#ff0000`, honors the markers, and passes on the real tree.
- `apps/web/e2e/appearance.spec.ts`: the Appearance page, a preset change restyling the Explorer, Changes and a live terminal, font sizes, a second browser context, the no-flash init script and Reset to default.
