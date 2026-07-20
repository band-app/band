# Band

IDE-agnostic agent orchestrator: a workspace dashboard that hosts coding-agent chats, terminals, browsers, and file editors in dockable panels.

## Language

### Shortcuts

**Dock**:
A focusable panel container in the workspace (chat, terminal, browser, files), each hosting its own tabs.
_Avoid_: Doc, pane, container (ambiguous)

**Global shortcut**:
A shortcut that fires anywhere in the workspace regardless of which dock has focus.

**Dock-scoped shortcut**:
A shortcut that fires only while its dock has focus. The same key combo may perform a different action in a different dock.
_Avoid_: Per-docs keys, local shortcut
