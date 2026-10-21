# Visual mode for HTML files

An HTML file in the file viewer has a Visual button next to the code button, like Markdown's preview. Visual renders the page in an iframe with its CSS, images and scripts. With "Edit text" on, a click on text that comes straight from the source makes it editable. Enter or leaving the field commits the edit, Escape reverts it. A commit changes only the characters of that text in the file.

## What is editable

An element is editable when its only text is one text node from the source and it has no element children. `<h1>Title</h1>` and the `<b>` in `<p>Plain <b>mixed</b> text</p>` qualify, the `<p>` does not. Text a script inserts is not editable (the hover says so). Text in `script`, `style`, `pre`, `textarea`, `title`, SVG and `template` is skipped.

Edits are plain text. The new text has `&`, `<` and `>` escaped, and non-breaking spaces written as `&nbsp;`. The white space around the text in the source stays as it was.

## How it works

- The preview route `/api/worktree-preview/<worktreeId>/<grant>/<path>` takes `?band-edit=<nonce>` for an HTML file. The hub parses the source with parse5 and adds `data-band-src="<start>:<end>"` to each editable element. The numbers are UTF-16 offsets of the text node in the original file, measured before any attribute is inserted. One script is appended. The signed grant covers the same directory as before, and every other file is served unchanged. `services/_utils/html-visual-edit.ts` has the annotation and the page script. Files above 2 MB are served unannotated, and the page tells the viewer that edit mode is unavailable.
- The viewer (`HtmlVisualEditor.tsx`) loads that URL in `<iframe sandbox="allow-scripts">`. There is no `allow-same-origin`, so the page cannot read Band's token, cookies or storage. The page and the viewer talk with `postMessage`. The viewer accepts a message only from that iframe's window and only with the nonce it put in the URL.
- On a commit the viewer reads the current text (the unsaved buffer, else the file on disk), checks that the range still shows the old text, and replaces it (`lib/html-visual-edit.ts`). It then saves through the viewer's normal save, so the unsaved buffer and other devices behave as for a typed edit. If the range no longer matches, nothing is written, the page reloads and a notice shows.
- The page reloads when the file changes on disk, and keeps its scroll position. A reload waits while an edit is in progress, and the commit is then checked against the new file.

Tests: `apps/hub/tests/worktree-preview-edit.test.ts`, `apps/web/e2e/html-visual-edit.spec.ts`.

Not done: style or attribute editing, editing script-generated text, rich text inside an edit, and the desktop browser tab (the Preview button still opens that).
