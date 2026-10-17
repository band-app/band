/**
 * Prompt turns of an owned chat on the worker: the worker's counterpart of
 * the hub's `task-service.ts`.
 *
 * One turn per chat at a time. A message that arrives while a turn runs, or
 * while earlier messages wait, joins the queue (kept in the worker's store,
 * so it survives a restart) and runs when the turns before it end. A turn
 * logs its prompt and its start, sends `session/prompt` and logs how it
 * ended, with the usage. The hub learns all of it from the replicated rows.
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import type * as acp from "@agentclientprotocol/sdk";
import { findOption } from "@band-app/chat-runtime/config-options";
import {
  FAILED_STOP_REASONS,
  fileUri,
  sharedDirNote,
  turnUsage,
} from "@band-app/chat-runtime/turns";
import type { Logger } from "@band-app/logger";
import type { ChatEvent } from "@band-app/shared/chat-events";

import type { ChatRuntime } from "./runtime.ts";
import type { ChatStore, StoredQueuedMessage } from "./store.ts";

export type TurnOutcome = "done" | "failed" | "idle";

export interface RunningTurn {
  id: string;
  prompt: string;
  startedAt: number;
  cancelRequested: boolean;
}

/** What the turn runner needs from the worker around it. */
export interface TurnsEnv {
  store: ChatStore;
  log: Logger;
  runtime(chatId: string): ChatRuntime;
  subscribe(chatId: string, listener: (event: ChatEvent) => void): () => void;
  /** The URL path the chat renders a shared file from. */
  sharedUrl(chatId: string, filename: string): string;
  /** A turn started or ended, or the queue changed. */
  changed(chatId: string): void;
}

/** A file's media type from its name, for the shared-file cards. */
function mediaTypeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    json: "application/json",
    csv: "text/csv",
    zip: "application/zip",
  };
  return known[ext] ?? "application/octet-stream";
}

async function listShared(dir: string): Promise<Set<string>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  } catch {
    return new Set();
  }
}

export class Turns {
  private readonly running = new Map<string, RunningTurn>();

  constructor(private readonly env: TurnsEnv) {}

  task(chatId: string): RunningTurn | undefined {
    return this.running.get(chatId);
  }

  /**
   * Starts the turn now, or queues the message when the chat is busy: a turn
   * runs, or earlier messages still wait, so a message never jumps ahead.
   */
  submit(
    chatId: string,
    message: Omit<StoredQueuedMessage, "id">,
  ): { queued: boolean; id: string } {
    const id = randomUUID();
    const running = this.running.has(chatId);
    const busy = running || this.env.store.queue(chatId).length > 0;
    this.env.store.pushQueued(chatId, { ...message, id });
    // A queue a stopped or failed turn left behind starts draining with the next message.
    if (!running) this.drain(chatId);
    else this.env.changed(chatId);
    return { queued: busy, id };
  }

  /** Starts the chat's next queued message when no turn runs. */
  drain(chatId: string): boolean {
    if (this.running.has(chatId)) return false;
    const next = this.env.store.queue(chatId)[0];
    if (!next) return false;
    this.env.store.removeQueued(chatId, next.id);
    this.start(chatId, next);
    return true;
  }

  removeQueued(chatId: string, id: string): boolean {
    const removed = this.env.store.removeQueued(chatId, id);
    if (removed) this.env.changed(chatId);
    return removed;
  }

  updateQueued(chatId: string, id: string, text: string): boolean {
    const updated = this.env.store.updateQueued(chatId, id, text);
    if (updated) this.env.changed(chatId);
    return updated;
  }

  reorderQueue(chatId: string, ids: string[]): void {
    this.env.store.reorderQueue(chatId, ids);
    this.env.changed(chatId);
  }

  clearQueue(chatId: string): void {
    this.env.store.clearQueue(chatId);
    this.env.changed(chatId);
  }

  /** Stops the running turn. It ends when the agent answers `session/cancel`. */
  abort(chatId: string): boolean {
    const turn = this.running.get(chatId);
    if (!turn) return false;
    turn.cancelRequested = true;
    void this.env.runtime(chatId).cancel();
    return true;
  }

  private start(chatId: string, message: StoredQueuedMessage): void {
    const turn: RunningTurn = {
      // The message's id: for a message the hub forwarded, the task id the hub handed its caller,
      // so cancelling by that id reaches this turn.
      id: message.id,
      prompt: message.text,
      startedAt: Date.now(),
      cancelRequested: false,
    };
    this.running.set(chatId, turn);
    this.env.changed(chatId);
    this.run(chatId, turn, message).catch((err) => {
      this.env.log.error({ chatId, err }, "turn failed");
      this.finish(chatId, turn, "failed");
    });
  }

  private async run(
    chatId: string,
    turn: RunningTurn,
    message: StoredQueuedMessage,
  ): Promise<void> {
    const runtime = this.env.runtime(chatId);
    const record = this.env.store.ownedChat(chatId);
    if (!record) throw new Error(`Chat ${chatId} is not owned by this worker`);
    let info = record.info;
    if (message.codingAgentId && message.codingAgentId !== info.agentId) {
      runtime.stop();
      info = {
        ...info,
        agentId: message.codingAgentId,
        model: undefined,
        mode: undefined,
        activeSessionId: undefined,
        hasSummary: false,
      };
      this.env.store.saveChat(info);
    }
    if (message.sessionId && info.activeSessionId !== message.sessionId) {
      info = { ...info, activeSessionId: message.sessionId, hasSummary: true };
      this.env.store.saveChat(info);
    }

    let sessionId: string | null;
    try {
      sessionId = await runtime.ensureSession();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.env.log.warn({ chatId, err: text }, "agent failed to start");
      runtime.broadcastTransient({ type: "notice", level: "error", text });
      runtime.broadcastTransient({ type: "turn-ended", taskId: turn.id, error: text });
      this.finish(chatId, turn, "failed");
      return;
    }
    if (!sessionId) {
      this.finish(chatId, turn, "failed");
      return;
    }
    const current = this.env.store.ownedChat(chatId)?.info ?? info;
    const firstTurn = !current.hasSummary;
    if (firstTurn) this.env.store.saveChat({ ...current, hasSummary: true });

    if (message.model) await this.applyChoice(runtime, "model", message.model);
    if (message.mode) await this.applyChoice(runtime, "mode", message.mode);

    const sharedDir = this.env.store.ownedChat(chatId)?.launch?.sharedDir ?? null;
    const seen = sharedDir ? await listShared(sharedDir) : new Set<string>();
    let scan: Promise<void> = Promise.resolve();
    const unsubscribe = this.env.subscribe(chatId, (event) => {
      if (
        !sharedDir ||
        event.type !== "update" ||
        event.update.sessionUpdate !== "tool_call_update" ||
        event.update.status !== "completed"
      ) {
        return;
      }
      scan = scan
        .then(() => listShared(sharedDir))
        .then((names) => {
          for (const filename of names) {
            if (seen.has(filename)) continue;
            seen.add(filename);
            runtime.record({
              type: "file",
              mediaType: mediaTypeFor(filename),
              url: this.env.sharedUrl(chatId, filename),
              filename,
            });
          }
        })
        .catch((err) => this.env.log.warn({ chatId, err }, "could not list the shared directory"));
    });

    const previousCost = runtime.sessionCostUsd();
    runtime.record(
      {
        type: "prompt",
        taskId: turn.id,
        text: message.text,
        ...(message.files && message.files.length > 0
          ? {
              files: message.files.map((f) => ({
                mediaType: f.mediaType,
                url: f.url,
                filename: f.filename,
              })),
            }
          : {}),
        ...(message.codingAgentId ? { codingAgentId: message.codingAgentId } : {}),
        ...(message.model ? { model: message.model } : {}),
        ...(message.mode ? { mode: message.mode } : {}),
      },
      true,
    );
    runtime.record({ type: "turn-started", taskId: turn.id });

    try {
      const blocks = await this.promptBlocks(runtime, message, firstTurn ? sharedDir : null);
      const res = turn.cancelRequested
        ? ({ stopReason: "cancelled" } as acp.PromptResponse)
        : await runtime.prompt(blocks);
      runtime.record({
        type: "turn-ended",
        taskId: turn.id,
        stopReason: res.stopReason,
        durationMs: Date.now() - turn.startedAt,
        usage: turnUsage(res, {
          model: runtime.currentModel(),
          reportedCost: runtime.reportedCost(),
          previousCost,
        }),
      });
      const stopped = res.stopReason === "cancelled" || turn.cancelRequested;
      const failed = FAILED_STOP_REASONS.has(res.stopReason);
      this.finish(chatId, turn, stopped ? "idle" : failed ? "failed" : "done");
    } catch (err) {
      runtime.record({
        type: "turn-ended",
        taskId: turn.id,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - turn.startedAt,
      });
      this.finish(chatId, turn, "failed");
    } finally {
      unsubscribe();
    }
  }

  private async applyChoice(runtime: ChatRuntime, category: "model" | "mode", value: string) {
    try {
      const option = findOption(runtime.sessionState().configOptions, category);
      const configId = option?.id ?? (category === "model" ? "__legacy_model" : "__legacy_mode");
      await runtime.setConfigOption(configId, value);
      const record = this.env.store.ownedChat(runtime.chatId);
      if (record) this.env.store.saveChat({ ...record.info, [category]: value });
    } catch (err) {
      this.env.log.warn(
        { chatId: runtime.chatId, category, value, err },
        "could not apply setting",
      );
    }
  }

  private async promptBlocks(
    runtime: ChatRuntime,
    message: StoredQueuedMessage,
    sharedDir: string | null,
  ): Promise<acp.ContentBlock[]> {
    const caps = runtime.promptCapabilities;
    const blocks: acp.ContentBlock[] = [{ type: "text", text: message.text }];
    for (const file of message.files ?? []) {
      const name = file.filename ?? file.path.split("/").pop() ?? file.path;
      if (caps.image && file.mediaType.startsWith("image/")) {
        try {
          const data = (await readFile(file.path)).toString("base64");
          blocks.push({ type: "image", mimeType: file.mediaType, data, uri: fileUri(file.path) });
          continue;
        } catch (err) {
          this.env.log.warn({ path: file.path, err }, "could not read image attachment");
        }
      }
      blocks.push({
        type: "resource_link",
        uri: fileUri(file.path),
        name,
        mimeType: file.mediaType,
      });
    }
    if (sharedDir) blocks.push({ type: "text", text: sharedDirNote(sharedDir) });
    return blocks;
  }

  /** Settles a turn. The queue drains on unless the turn failed, as on the hub. */
  private finish(chatId: string, turn: RunningTurn, outcome: TurnOutcome): void {
    if (this.running.get(chatId) !== turn) return;
    this.running.delete(chatId);
    if (outcome === "failed" || !this.drain(chatId)) this.env.changed(chatId);
  }
}
