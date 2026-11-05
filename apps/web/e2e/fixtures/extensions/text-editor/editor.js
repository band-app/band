// A small editor that speaks the Band extension protocol (docs/extensions.md) and edits text.
const text = document.getElementById("text");
const status = document.getElementById("status");
const probe = document.getElementById("probe");
const decoder = new TextDecoder();
const encoder = new TextEncoder();

let port = null;
let baseline = "";

function setLayout(value) {
  document.body.dataset.layout = value;
  document.getElementById("layout").textContent = value;
}

function setStatus(value) {
  status.textContent = value;
}

function report() {
  const result = { origin: String(window.origin) };
  const attempt = (name, fn) => {
    try {
      const value = fn();
      result[name] = value === "" || value == null ? "empty" : "readable";
    } catch {
      result[name] = "threw";
    }
  };
  attempt("cookie", () => document.cookie);
  attempt("localStorage", () => window.localStorage.length);
  attempt("parentDom", () => window.parent.document.title);
  attempt("parentStorage", () => window.parent.localStorage.length);
  probe.textContent = JSON.stringify(result);
}

function setDirty() {
  port?.postMessage({ type: "dirty", dirty: text.value !== baseline });
}

function load(bytes) {
  baseline = decoder.decode(bytes);
  text.value = baseline;
  setDirty();
}

function save() {
  const bytes = encoder.encode(text.value);
  port.postMessage({ type: "save", bytes: bytes.buffer }, [bytes.buffer]);
  setStatus("saving");
}

// The selection goes to Band as `selection` (extension protocol, optional), debounced.
let selectionTimer = null;
function reportSelection() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const start = text.selectionStart ?? 0;
    const end = text.selectionEnd ?? 0;
    const selection =
      end > start
        ? {
            address: `chars:${start}-${end}`,
            kind: "text",
            label: `chars ${start}-${end}`,
            text: text.value.slice(start, end),
          }
        : null;
    port?.postMessage({ type: "selection", selection });
  }, 250);
}
for (const type of ["select", "keyup", "mouseup", "input"]) {
  text.addEventListener(type, reportSelection);
}

text.addEventListener("input", setDirty);
text.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
});

function answerMcp(message) {
  if (message.method === "tools/list") {
    fetch("tools.json")
      .then((r) => r.json())
      .then((list) =>
        port.postMessage({
          type: "mcp",
          message: { jsonrpc: "2.0", id: message.id, result: list },
        }),
      );
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (name === "set_text") {
      text.value = String(args.text ?? "");
      setDirty();
      reportSelection();
    }
    if (name === "save_text") save();
    port.postMessage({
      type: "mcp",
      message: {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: name === "set_text" ? "ok" : text.value }] },
      },
    });
    return;
  }
  port.postMessage({
    type: "mcp",
    message: { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } },
  });
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "band:hello" || !event.ports[0]) return;
  port = event.ports[0];
  port.onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "init":
        load(msg.file.bytes);
        text.disabled = msg.file.readOnly;
        document.body.dataset.mode = msg.theme?.mode ?? "";
        setLayout(msg.layout ?? "none");
        report();
        setStatus("ready");
        port.postMessage({ type: "ready" });
        break;
      case "reload":
        load(msg.bytes);
        setStatus("reloaded");
        break;
      case "saved":
        baseline = text.value;
        setDirty();
        setStatus("saved");
        break;
      case "saveFailed":
        setStatus(`save failed: ${msg.error}`);
        break;
      case "requestSave":
        save();
        break;
      case "layout":
        setLayout(msg.layout);
        break;
      case "theme":
        document.body.dataset.mode = msg.mode ?? "";
        break;
      case "mcp":
        answerMcp(msg.message);
        break;
      default:
        break;
    }
  };
});
