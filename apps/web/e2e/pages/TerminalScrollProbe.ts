import { type Page, test } from "@playwright/test";

/** p50 / p90 / p99 / max of one measurement, in ms. */
export interface Spread {
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export interface ScrollReport {
  wheelEvents: number;
  /** Wheel reports sent to the PTY (a wheel event can carry several). */
  reports: number;
  /** Wheel events whose scroll position reached the screen. */
  painted: number;
  /** Wheel event to the socket send that carried its reports. */
  wheelToSend: Spread;
  /** Send to the first output frame showing the new position. */
  sendToArrival: Spread;
  /** That frame coming off the socket to xterm finishing its parse. */
  arrivalToParsed: Spread;
  /** Parse to the render that drew it. */
  parsedToPaint: Spread;
  wheelToPaint: Spread;
  /** Time between renders that changed the scroll position, while scrolling. */
  paintGaps: Spread;
  /** Renders that changed the scroll position. */
  positionPaints: number;
  /** Gaps between those renders over 33 ms / 50 ms / 100 ms. */
  gapsOver33: number;
  gapsOver50: number;
  gapsOver100: number;
  /** Gaps over 40 ms: when they started (ms after the first wheel event) and
   *  how long they were, and the stage that was slow for the paint after. */
  bigGaps: { at: number; gap: number }[];
  /** requestAnimationFrame intervals over the run: dropped browser frames. */
  rafGaps: Spread;
  rafOver25: number;
  /** Output frames that arrived, and their sizes. */
  outputFrames: number;
  outputBytes: Spread;
  /** Output frames xterm was handed per render (1 = every frame drawn). */
  framesPerPaint: number;
  /** Renders that changed the screen content, and the gaps between them. */
  screenChanges: number;
  changeGaps: Spread;
  changeGapsOver33: number;
  changeGapsOver50: number;
  /** A socket send to the first render after it that changed the screen. */
  sendToChange: Spread;
  outputTotalBytes: number;
  bytesPerSend: number;
  /** DEC 2026 frames begun in the output. */
  syncFrames: number;
  /** Per 250 ms from the first wheel event: sends, output KB, sync frames, screen changes. */
  timeline: { t: number; sends: number; kb: number; syncs: number; changes: number }[];
  /** Long animation frames and where their script time went. */
  longFrames: number;
  longFrameMs: number;
  byInvoker: Record<string, number>;
}

/**
 * Measures how smoothly a fullscreen TUI scrolls in the visible terminal.
 *
 * The TUI under test prints its scroll position as `OFF=<n>` on its top row
 * and moves one row per wheel report, so the n-th report sent is on screen
 * once the top row shows `OFF>=n`. Every stamp is taken in the page:
 *
 *   wheel    the wheel event's own timestamp
 *   send     the `/terminal` socket send carrying its reports
 *   arrival  the first output frame containing `OFF>=n` came off the socket
 *   parsed   xterm finished parsing a write that left `OFF>=n` on the top row
 *   paint    xterm's first render showing `OFF>=n`
 *
 * `install()` wraps `WebSocket` before the app loads (test instrumentation,
 * no production change); `start()` hooks the terminal through its public
 * xterm API on the module-level terminal cache. One terminal per worktree.
 */
export class TerminalScrollProbe {
  constructor(
    private readonly page: Page,
    private readonly worktreeId: string,
  ) {}

  /** Wrap `WebSocket` so terminal socket sends and arrivals are stamped. Call before `goto`. */
  async install(): Promise<void> {
    await this.page.addInitScript(() => {
      interface Probe {
        active: boolean;
        sends: { at: number; reports: number }[];
        arrivals: { at: number; off: number; bytes: number; syncs: number }[];
      }
      const probe: Probe = { active: false, sends: [], arrivals: [] };
      (window as unknown as { __scrollProbe: Probe }).__scrollProbe = probe;
      const decoder = new TextDecoder("latin1");
      const offPattern = /OFF=(\d+)/g;
      const Native = window.WebSocket;
      const nativeSend = Native.prototype.send;
      const terminalSockets = new WeakSet<WebSocket>();
      Native.prototype.send = function (this: WebSocket, data) {
        if (probe.active && terminalSockets.has(this) && typeof data === "string") {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR wheel reports start with ESC
          const reports = (data.match(/\x1b\[<6[45];/g) ?? []).length;
          if (reports > 0) probe.sends.push({ at: performance.now(), reports });
        }
        return nativeSend.call(this, data);
      };
      class ProbedWebSocket extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (!String(url).includes("/terminal?")) return;
          terminalSockets.add(this);
          this.addEventListener("message", (event) => {
            if (!probe.active || !(event.data instanceof ArrayBuffer)) return;
            const text = decoder.decode(event.data);
            let off = -1;
            for (const match of text.matchAll(offPattern)) off = Number(match[1]);
            const syncs = text.split("\x1b[?2026h").length - 1;
            probe.arrivals.push({
              at: performance.now(),
              off,
              bytes: event.data.byteLength,
              syncs,
            });
          });
        }
      }
      window.WebSocket = ProbedWebSocket as typeof WebSocket;
    });
  }

  /** Start recording wheel events, parses, renders and browser frames. */
  async start(): Promise<void> {
    await test.step("Start the scroll probe", async () => {
      const ok = await this.page.evaluate((id) => {
        type Term = {
          element?: HTMLElement;
          onRender(listener: () => void): { dispose(): void };
          onWriteParsed(listener: () => void): { dispose(): void };
          buffer: {
            active: {
              viewportY: number;
              getLine(y: number): { translateToString(trim: boolean): string } | undefined;
            };
          };
        };
        const cache = (
          globalThis as unknown as {
            __bandTerminalCache__?: Map<string, { worktreeId: string; getTerminal(): unknown }>;
          }
        ).__bandTerminalCache__;
        const entry = [...(cache?.values() ?? [])].find((e) => e.worktreeId === id);
        const term = entry?.getTerminal() as Term | null;
        if (!term?.element) return false;
        const store = window as unknown as {
          __scrollProbe: {
            active: boolean;
            sends: unknown[];
            arrivals: unknown[];
            wheels?: number[];
            parses?: { at: number; off: number }[];
            renders?: { at: number; off: number; hash: number }[];
            rafs?: number[];
            loaf?: PerformanceEntry[];
            stop?: () => void;
          };
        };
        const probe = store.__scrollProbe;
        const screenHash = () => {
          const buffer = term.buffer.active;
          let hash = 0;
          for (let y = 0; y < 60; y++) {
            const text = buffer.getLine(buffer.viewportY + y)?.translateToString(true);
            if (text === undefined) break;
            for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
            hash = (hash * 31 + 10) | 0;
          }
          return hash;
        };
        const topOff = () => {
          const buffer = term.buffer.active;
          const match = buffer
            .getLine(buffer.viewportY)
            ?.translateToString(true)
            .match(/OFF=(\d+)/);
          return match ? Number(match[1]) : -1;
        };
        probe.sends = [];
        probe.arrivals = [];
        probe.wheels = [];
        probe.parses = [];
        probe.renders = [];
        probe.rafs = [];
        probe.loaf = [];
        const wheels = probe.wheels;
        const parses = probe.parses;
        const renders = probe.renders;
        const rafs = probe.rafs;
        const loaf = probe.loaf;
        const onWheel = (event: WheelEvent) => wheels.push(event.timeStamp);
        term.element.addEventListener("wheel", onWheel, { capture: true, passive: true });
        const parsed = term.onWriteParsed(() =>
          parses.push({ at: performance.now(), off: topOff() }),
        );
        const rendered = term.onRender(() =>
          renders.push({ at: performance.now(), off: topOff(), hash: screenHash() }),
        );
        let rafId = 0;
        const tick = (at: number) => {
          rafs.push(at);
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        const observer = new PerformanceObserver((list) => loaf.push(...list.getEntries()));
        observer.observe({ type: "long-animation-frame", buffered: false });
        probe.stop = () => {
          term.element?.removeEventListener("wheel", onWheel, { capture: true });
          parsed.dispose();
          rendered.dispose();
          cancelAnimationFrame(rafId);
          observer.disconnect();
        };
        probe.active = true;
        return true;
      }, this.worktreeId);
      if (!ok) throw new Error("terminal not loaded");
    });
  }

  /** The scroll position on the terminal's top row; -1 when it shows none. */
  async readTopOffset(): Promise<number> {
    return await this.page.evaluate((id) => {
      type Term = {
        buffer: {
          active: {
            viewportY: number;
            getLine(y: number): { translateToString(trim: boolean): string } | undefined;
          };
        };
      };
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { worktreeId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      const entry = [...(cache?.values() ?? [])].find((e) => e.worktreeId === id);
      const term = entry?.getTerminal() as Term | null;
      if (!term) return -1;
      const buffer = term.buffer.active;
      const match = buffer
        .getLine(buffer.viewportY)
        ?.translateToString(true)
        .match(/OFF=(\d+)/);
      return match ? Number(match[1]) : -1;
    }, this.worktreeId);
  }

  /** Wheel reports sent since `start()`. */
  async readReportsSent(): Promise<number> {
    return await this.page.evaluate(() =>
      (
        window as unknown as { __scrollProbe: { sends: { reports: number }[] } }
      ).__scrollProbe.sends.reduce((sum, s) => sum + s.reports, 0),
    );
  }

  /** xterm's modes and active buffer, as JSON. */
  async readModes(): Promise<string> {
    return await this.page.evaluate((id) => {
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { worktreeId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      const entry = [...(cache?.values() ?? [])].find((e) => e.worktreeId === id);
      const term = entry?.getTerminal() as { modes: unknown; buffer: { active: { type: string } } };
      return JSON.stringify({
        modes: term.modes,
        buffer: term.buffer.active.type,
        now: Math.round(performance.now()),
      });
    }, this.worktreeId);
  }

  /** A hash of the text on screen, to tell when a TUI has stopped drawing. */
  async readScreenHash(): Promise<number> {
    return await this.page.evaluate((id) => {
      type Term = {
        buffer: {
          active: {
            viewportY: number;
            getLine(y: number): { translateToString(trim: boolean): string } | undefined;
          };
        };
      };
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { worktreeId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      const entry = [...(cache?.values() ?? [])].find((e) => e.worktreeId === id);
      const term = entry?.getTerminal() as Term | null;
      if (!term) return 0;
      const buffer = term.buffer.active;
      let hash = 0;
      for (let y = 0; y < 60; y++) {
        const text = buffer.getLine(buffer.viewportY + y)?.translateToString(true);
        if (text === undefined) break;
        for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
        hash = (hash * 31 + 10) | 0;
      }
      return hash;
    }, this.worktreeId);
  }

  /** Stop recording and reduce the stamps to a report. `baseOffset` is the
   *  scroll position when `start()` ran. */
  async stop(baseOffset: number): Promise<ScrollReport> {
    return await this.page.evaluate((base) => {
      interface Loaf extends PerformanceEntry {
        scripts: { invoker: string; duration: number; sourceFunctionName: string }[];
      }
      const probe = (
        window as unknown as {
          __scrollProbe: {
            active: boolean;
            sends: { at: number; reports: number }[];
            arrivals: { at: number; off: number; bytes: number; syncs: number }[];
            wheels: number[];
            parses: { at: number; off: number }[];
            renders: { at: number; off: number; hash: number }[];
            rafs: number[];
            loaf: Loaf[];
            stop: () => void;
          };
        }
      ).__scrollProbe;
      probe.active = false;
      probe.stop();
      const { sends, arrivals, wheels, parses, renders, rafs, loaf } = probe;

      const spread = (values: number[]) => {
        if (values.length === 0) return { n: 0, p50: 0, p90: 0, p99: 0, max: 0 };
        const sorted = [...values].sort((a, b) => a - b);
        const at = (p: number) =>
          Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 10) / 10;
        return { n: values.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: at(1) };
      };
      const firstAtOrAfter = <T extends { at: number; off: number }>(
        list: T[],
        from: number,
        off: number,
      ) => list.find((e) => e.at >= from && e.off >= off);

      // Wheel events and sends pair up in order: each wheel event that moved
      // the TUI produced one send (the input queue can join several into one
      // message, which then carries the later event's target too).
      const wheelToSend: number[] = [];
      const sendToArrival: number[] = [];
      const arrivalToParsed: number[] = [];
      const parsedToPaint: number[] = [];
      const wheelToPaint: number[] = [];
      let cumulative = base;
      let painted = 0;
      let wheelIndex = 0;
      for (const send of sends) {
        cumulative += send.reports;
        // The wheel event that caused this send: the last one before it.
        while (wheelIndex + 1 < wheels.length && wheels[wheelIndex + 1] <= send.at) wheelIndex++;
        const wheelAt = wheels[wheelIndex] ?? send.at;
        wheelToSend.push(send.at - wheelAt);
        const arrival = firstAtOrAfter(arrivals, send.at, cumulative);
        if (!arrival) continue;
        const parse = firstAtOrAfter(parses, arrival.at, cumulative);
        if (!parse) continue;
        const paint = firstAtOrAfter(renders, parse.at, cumulative);
        if (!paint) continue;
        painted++;
        sendToArrival.push(arrival.at - send.at);
        arrivalToParsed.push(parse.at - arrival.at);
        parsedToPaint.push(paint.at - parse.at);
        wheelToPaint.push(paint.at - wheelAt);
      }

      // Renders that moved the scroll position, from the first wheel event to
      // the last one plus 200 ms.
      const from = wheels[0] ?? 0;
      const until = (wheels[wheels.length - 1] ?? 0) + 200;
      const moves: number[] = [];
      let lastOff = base;
      for (const render of renders) {
        if (render.at < from || render.at > until) continue;
        if (render.off !== lastOff) {
          moves.push(render.at);
          lastOff = render.off;
        }
      }
      const gaps = moves.slice(1).map((at, i) => at - moves[i]);
      const rafGaps = rafs.slice(1).map((at, i) => at - rafs[i]);
      const byInvoker: Record<string, number> = {};
      let longFrameMs = 0;
      for (const entry of loaf) {
        longFrameMs += entry.duration;
        for (const script of entry.scripts) {
          const key = `${script.invoker} ${script.sourceFunctionName}`.trim();
          byInvoker[key] = Math.round((byInvoker[key] ?? 0) + script.duration);
        }
      }
      const outputFrames = arrivals.filter((a) => a.at >= from && a.at <= until);
      // Content-based view, for a TUI that prints no OFF marker: renders that
      // changed the screen, and for each send the first such render after it.
      const changes: number[] = [];
      let lastHash: number | null = null;
      for (const render of renders) {
        if (render.at < from || render.at > until) continue;
        if (render.hash !== lastHash) {
          if (lastHash !== null) changes.push(render.at);
          lastHash = render.hash;
        }
      }
      const changeGaps = changes.slice(1).map((at, i) => at - changes[i]);
      const sendToChange: number[] = [];
      for (const send of sends) {
        const change = changes.find((at) => at > send.at);
        if (change !== undefined) sendToChange.push(change - send.at);
      }
      const outputTotal = outputFrames.reduce((sum, a) => sum + a.bytes, 0);
      return {
        wheelEvents: wheels.length,
        reports: cumulative - base,
        painted,
        wheelToSend: spread(wheelToSend),
        sendToArrival: spread(sendToArrival),
        arrivalToParsed: spread(arrivalToParsed),
        parsedToPaint: spread(parsedToPaint),
        wheelToPaint: spread(wheelToPaint),
        paintGaps: spread(gaps),
        positionPaints: moves.length,
        gapsOver33: gaps.filter((g) => g > 33).length,
        gapsOver50: gaps.filter((g) => g > 50).length,
        gapsOver100: gaps.filter((g) => g > 100).length,
        bigGaps: gaps
          .map((gap, i) => ({ at: Math.round(moves[i] - from), gap: Math.round(gap) }))
          .filter((g) => g.gap > 40),
        rafGaps: spread(rafGaps),
        rafOver25: rafGaps.filter((g) => g > 25).length,
        outputFrames: outputFrames.length,
        outputBytes: spread(outputFrames.map((a) => a.bytes)),
        framesPerPaint: Math.round((outputFrames.length / Math.max(1, moves.length)) * 100) / 100,
        screenChanges: changes.length,
        changeGaps: spread(changeGaps),
        changeGapsOver33: changeGaps.filter((g) => g > 33).length,
        changeGapsOver50: changeGaps.filter((g) => g > 50).length,
        sendToChange: spread(sendToChange),
        outputTotalBytes: outputTotal,
        bytesPerSend: Math.round(outputTotal / Math.max(1, sends.length)),
        syncFrames: outputFrames.reduce((sum, a) => sum + a.syncs, 0),
        timeline: (() => {
          const end = Math.max(until, renders[renders.length - 1]?.at ?? until);
          const rows = [];
          for (let t = from; t < end; t += 250) {
            const inBucket = (at: number) => at >= t && at < t + 250;
            rows.push({
              t: Math.round(t - from),
              sends: sends.filter((x) => inBucket(x.at)).length,
              kb: Math.round(
                arrivals.filter((x) => inBucket(x.at)).reduce((sum, x) => sum + x.bytes, 0) / 1024,
              ),
              syncs: arrivals.filter((x) => inBucket(x.at)).reduce((sum, x) => sum + x.syncs, 0),
              changes: changes.filter(inBucket).length,
            });
          }
          return rows;
        })(),
        longFrames: loaf.length,
        longFrameMs: Math.round(longFrameMs),
        byInvoker,
      };
    }, baseOffset);
  }
}
