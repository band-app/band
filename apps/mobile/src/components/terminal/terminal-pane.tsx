import { TerminalClient, type TerminalSink } from "@band-app/client/terminal-client";
import { memo, useEffect, useRef, useState } from "react";
import { AppState, Keyboard, Linking, StyleSheet, View } from "react-native";

import { type BandTerminalHandle, BandTerminalView } from "../../../modules/band-terminal";
import { useHubSession } from "../../lib/hub-session";
import { applyCtrl, type BarKey, barKeyBytes, scanCursorMode } from "../../lib/terminal/key-bar";
import { WriteBatcher } from "../../lib/terminal/write-batcher";
import { terminalColors } from "../../theme";
import { KeyBar } from "./key-bar";

const BACKGROUND = terminalColors.background;
const FOREGROUND = terminalColors.foreground;
/** Output a hidden pane may queue before it drops it and replays the screen on show. */
const HIDDEN_QUEUE_CAP = 1024 * 1024;
const encoder = new TextEncoder();

/**
 * One terminal of a worktree: the native view, the hub socket behind it and the key bar. The pane
 * keeps its socket while another tab is shown (`active` false), so the screen is current when the
 * user comes back, and reconnects with a replay after the app was in the background.
 */
export const TerminalPane = memo(function TerminalPane({
  terminalId,
  worktreeId,
  active,
}: {
  terminalId: string;
  worktreeId: string;
  active: boolean;
}) {
  const { hub } = useHubSession();
  const view = useRef<BandTerminalHandle>(null);
  const client = useRef<TerminalClient | null>(null);
  const size = useRef<{ cols: number; rows: number } | null>(null);
  const appCursor = useRef(false);
  const cursorTail = useRef<Uint8Array>(new Uint8Array(0));
  const batcherRef = useRef<WriteBatcher | null>(null);
  // Set when a hidden pane dropped queued output: the screen is stale until it replays.
  const needsReplay = useRef(false);
  const ctrlRef = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  // The keyboard covers the bottom of the screen, so the pane pads its foot by the overlap. The
  // pager this pane sits in breaks `KeyboardAvoidingView`'s arithmetic, so the overlap is
  // measured against where the pane's bottom edge sits with no keyboard up.
  const root = useRef<View>(null);
  const baseBottom = useRef(0);
  const [overlap, setOverlap] = useState(0);
  useEffect(() => {
    // A hidden pane ignores the keyboard, or it would resize the PTY the visible tabs share.
    if (!active) {
      setOverlap(0);
      return;
    }
    const change = Keyboard.addListener("keyboardWillChangeFrame", (e) => {
      setOverlap(Math.max(0, baseBottom.current - e.endCoordinates.screenY));
    });
    const hide = Keyboard.addListener("keyboardWillHide", () => setOverlap(0));
    return () => {
      change.remove();
      hide.remove();
    };
  }, [active]);
  const [status, setStatus] = useState<"connecting" | "open" | "reconnecting" | "ended">(
    "connecting",
  );

  const setCtrlBoth = (on: boolean) => {
    ctrlRef.current = on;
    setCtrl(on);
  };

  useEffect(() => {
    const batcher = new WriteBatcher(
      (bytes) => view.current?.write(bytes) ?? Promise.resolve(),
      () => {
        needsReplay.current = true;
      },
    );
    batcherRef.current = batcher;
    needsReplay.current = false;
    const notice = (text: string) =>
      batcher.push(encoder.encode(`\r\n\u001b[90m${text}\u001b[0m\r\n`), () => {});
    const sink: TerminalSink = {
      write: (bytes, parsed) => {
        // Only the cursor-key mode needs a look at the bytes.
        const scan = scanCursorMode(appCursor.current, bytes, cursorTail.current);
        appCursor.current = scan.mode;
        cursorTail.current = scan.tail;
        // After an overflow the screen is stale until the replay, so more output only adds to it.
        if (needsReplay.current) parsed();
        else batcher.push(bytes, parsed);
      },
      reset: () => {
        batcher.clear();
        needsReplay.current = false;
        appCursor.current = false;
        cursorTail.current = new Uint8Array(0);
        void view.current?.reset();
      },
      notice,
      ended: (reason) => {
        setStatus("ended");
        notice(reason === "exited" ? "[Process completed]" : "[Terminal unavailable]");
      },
      connection: (state) => setStatus(state),
    };
    const next = new TerminalClient({
      hubUrl: hub.url,
      token: hub.token,
      worktreeId,
      terminalId,
      sink,
      getDims: () => size.current,
      createSocket: (url, protocols) =>
        new WebSocket(url, protocols) as unknown as ReturnType<
          ConstructorParameters<typeof TerminalClient>[0]["createSocket"]
        >,
    });
    client.current = next;
    next.connect();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") next.resume();
    });
    return () => {
      sub.remove();
      batcher.clear();
      batcherRef.current = null;
      next.destroy();
      client.current = null;
    };
  }, [hub.url, hub.token, worktreeId, terminalId]);

  useEffect(() => {
    client.current?.setVisible(active);
    if (batcherRef.current) {
      batcherRef.current.queueCap = active ? Number.POSITIVE_INFINITY : HIDDEN_QUEUE_CAP;
    }
    if (!active) void view.current?.blur();
    else if (needsReplay.current) client.current?.connect();
  }, [active]);

  const send = (data: string) => {
    let out = data;
    if (ctrlRef.current) {
      const ctrled = applyCtrl(data);
      out = ctrled.data;
      // Ctrl stays armed through input it cannot apply to, such as an arrow's escape sequence.
      if (ctrled.applied) setCtrlBoth(false);
    }
    client.current?.send(out);
  };

  const onBarKey = (key: BarKey) => {
    setCtrlBoth(false);
    client.current?.send(barKeyBytes(key, appCursor.current));
  };

  return (
    <View
      ref={root}
      style={[styles.root, { paddingBottom: overlap }]}
      onLayout={() => {
        if (overlap === 0) {
          root.current?.measureInWindow((_x, y, _w, h) => {
            baseBottom.current = y + h;
          });
        }
      }}
      testID={`terminal__pane-${terminalId}`}
    >
      <View style={styles.screen}>
        <BandTerminalView
          ref={view}
          style={styles.screen}
          fontSize={13}
          background={BACKGROUND}
          foreground={FOREGROUND}
          onInput={send}
          onSize={(s) => {
            size.current = s;
            client.current?.resize(s);
          }}
          onOpenLink={(url) => {
            if (/^https?:\/\//.test(url)) void Linking.openURL(url).catch(() => {});
          }}
        />
      </View>
      <KeyBar
        ctrl={ctrl}
        onToggleCtrl={() => setCtrlBoth(!ctrlRef.current)}
        onKey={onBarKey}
        onKeyboard={() => void view.current?.focus()}
        status={status}
        keyboardUp={overlap > 0}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  root: { backgroundColor: BACKGROUND, flex: 1 },
  screen: { backgroundColor: BACKGROUND, flex: 1 },
});
