---
paths:
  - "**/HtmlVisualEditor.tsx"
  - "**/lib/html-visual-edit.ts"
  - "apps/hub/src/server/services/_utils/html-visual-edit.ts"
  - "apps/hub/tests/worktree-preview-edit.test.ts"
  - "apps/web/e2e/html-visual-edit.spec.ts"
  - "docs/html-visual-edit.md"
---

# Architecture: HTML visual edit

An HTML file in the file viewer has a Visual mode with click-to-edit text (guide: `docs/html-visual-edit.md`). The signed preview route takes `?band-edit=<nonce>`: the hub annotates the previewed file with parse5 (`services/_utils/html-visual-edit.ts`, `data-band-src="<start>:<end>"` offsets into the original source) and appends one script, and serves every other file as before. The viewer (`HtmlVisualEditor.tsx`) shows it in `<iframe sandbox="allow-scripts">` with no same-origin, accepts `postMessage` only from that frame with its nonce, patches the range in the current source (`lib/html-visual-edit.ts`) and saves through the viewer's normal save. A range that no longer matches writes nothing. Tests: `apps/hub/tests/worktree-preview-edit.test.ts`, `apps/web/e2e/html-visual-edit.spec.ts`.
