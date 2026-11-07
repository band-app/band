---
paths:
  - "**/CenterTabStrip.ts"
  - "**/LayoutView.tsx"
  - "**/components/layout/layout.css"
  - "**/lib/layout-resizing.ts"
  - "**/model.ts"
  - "**/saved-layout.ts"
  - "**/serialized.ts"
  - "**/terminal-cache.ts"
  - "apps/web/e2e/pages/CenterLayout.ts"
  - "apps/web/src/components/layout/**"
  - "apps/web/tests/fixtures/layouts/**"
  - "apps/web/tests/layout-model.test.ts"
---

# Architecture: center layout

The center area of a worktree and the split panes of a terminal tab run on Band's own layout code in `apps/web/src/components/layout/`. It replaced the dockview library.

- `serialized.ts` types and parses the saved shape. `model.ts` is the pure model (`LayoutApi`, `LayoutGroup`, `LayoutPanel`): a tree of splits whose leaves are groups of tabbed panels, with add, remove, move, split, resize, maximize, `toJSON` and `fromJSON`. It has no DOM, and `apps/web/tests/layout-model.test.ts` drives it directly. `LayoutView.tsx` renders it: tab strips, drag with `@dnd-kit/core`, sashes, drop zones. `saved-layout.ts` holds the pure fixes applied to a saved blob before loading it (legacy edge groups, unknown panel kinds).
- The saved shape is the JSON dockview's `toJSON()` wrote, so layouts users already have keep opening, and an older Band build on the same device opens what this one writes. It is stored under `band:dockview-layout-v9:<worktreeId>` (plus Band's `maximizedGroup`) and, for a terminal tab's panes, `band:term-split:<worktreeId>:<leafId>`. The parser ignores fields it does not know. `band:center-tabs:<worktreeId>` is Band's own tab list and did not change. Fixtures in `apps/web/tests/fixtures/layouts/` were captured from dockview 6.0.6.
- Sizes are weights per child. The browser lays groups out in percent from the weights (`computeGeometry`), and `toJSON` writes pixels of the last container size. A group never moves in the DOM when the tree restructures, because groups are siblings under the root and keyed by id.
- A panel's content renders into `panel.element` through a portal, and the element moves with the panel between groups. The selected panel's element is in its group's content area. An `always` panel (terminals, browsers) stays attached and gets `display: none` while unselected, so a webview keeps its guest. Every other unselected panel is detached, with its React tree still mounted.
- Tabs sit in a plain flex list with native `overflow-x: auto` and `overscroll-behavior-x: contain`. Only a mostly vertical wheel is turned sideways. A mouse or pen press selects a tab at once. A touch selects on click, so a swipe scrolls without switching tabs. Tabs are `role="tab"` in a `tablist` with arrow-key navigation.
- A sash drag sets `data-band-layout-resizing` on `<html>` (`lib/layout-resizing.ts`). `terminal-cache.ts` skips its refit while it is set and fits once when the drag ends, so a PTY gets one resize, not one per pixel.
- Test hooks are `data-testid`s: `layout-root` (with `data-layout-kind="center"` or `"split"`), `layout-group`, `layout-header`, `layout-tab-list`, `layout-tab` (`data-selected`, `data-panel-id`), `layout-header-void`, `layout-sash`, `layout-drop-indicator`. `apps/web/e2e/pages/CenterLayout.ts` and `CenterTabStrip.ts` wrap them.
- Styles are `components/layout/layout.css`, with theme tokens only.
- Not built: floating groups, popouts and an overflow tab list. Dockview had them and Band never used them.
