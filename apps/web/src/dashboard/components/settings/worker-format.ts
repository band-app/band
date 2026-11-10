import { crossOriginHub } from "../../../lib/hub-config";
import type { trpc } from "../../../lib/trpc-client";

export type HostList = Awaited<ReturnType<typeof trpc.workers.list.query>>["hosts"];
export type HostItem = HostList[number];
export type TokenList = Awaited<ReturnType<typeof trpc.tokens.list.query>>["tokens"];
export type TokenView = TokenList[number];
export type AuditEntries = Awaited<ReturnType<typeof trpc.workers.audit.query>>["entries"];

export const HOSTS_KEY = ["hosts.list"] as const;
export const AUDIT_KEY = ["hosts.audit"] as const;
export const TOKENS_KEY = ["tokens.list"] as const;

/** What a host reported per agent (installed, version, logged in), else the configured list from its hello. */
export function agentSummary(host: HostItem): string {
  const report = host.report;
  if (!report) return host.agents.length > 0 ? host.agents.join(", ") : "none found";
  if (report.agents.length === 0) return "none found";
  return report.agents
    .map((a) => {
      if (!a.installed) return `${a.type} not installed`;
      const login =
        a.loggedIn === false ? "not logged in" : a.loggedIn ? "logged in" : "login unknown";
      return `${a.type}${a.version ? ` ${a.version}` : ""} ${login}`;
    })
    .join(", ");
}

export interface AgentLine {
  type: string;
  version: string | null;
  /** The login state in words, and the tone the drawer colors it with. */
  state: { label: string; tone: "ok" | "warn" | "bad" | "muted" };
}

/** One line per agent the worker reported (installed, version, login), else the configured names. */
export function agentLines(host: HostItem): AgentLine[] {
  const report = host.report;
  if (!report) {
    return host.agents.map((type) => ({
      type,
      version: null,
      state: { label: "Not reported", tone: "muted" as const },
    }));
  }
  return report.agents.map((a) => {
    if (!a.installed)
      return {
        type: a.type,
        version: null,
        state: { label: "Not installed", tone: "bad" as const },
      };
    const state =
      a.loggedIn === false
        ? { label: "Not logged in", tone: "warn" as const }
        : a.loggedIn
          ? { label: "Logged in", tone: "ok" as const }
          : { label: "Login unknown", tone: "muted" as const };
    return { type: a.type, version: a.version ?? null, state };
  });
}

/** The capabilities a host reported, one label each. */
export function capabilityList(host: HostItem): string[] {
  return host.capabilities.map((c) => CAPABILITY_LABELS[c] ?? c);
}

const CAPABILITY_LABELS: Record<string, string> = {
  desktop: "Desktop",
  git: "Git",
  gh: "GitHub CLI",
  pty: "Terminals",
  acp: "Agents",
  lsp: "Language servers",
  search: "Search",
  fsWatch: "File watching",
};

/** The capabilities a host reported, as words. "Desktop" means the desktop extension runs on it. */
export function capabilitySummary(host: HostItem): string {
  if (host.capabilities.length === 0) return "none reported";
  return host.capabilities.map((c) => CAPABILITY_LABELS[c] ?? c).join(", ");
}

/** The operating system and architecture a host reported, or "unknown" before its first connect. */
export function osOf(host: HostItem): string {
  const info = host.info as { os?: unknown; arch?: unknown } | null;
  if (typeof info?.os !== "string") return "unknown";
  return typeof info.arch === "string" ? `${info.os} ${info.arch}` : info.os;
}

/** Status pill colors by worker status. Anything not listed reads as muted. */
export const STATUS_PILL: Record<string, string> = {
  online: "bg-success-bg text-success",
  lost: "bg-warning-bg text-warning",
};

export const TRUST_LEVELS = ["restricted", "standard", "admin"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const TRUST_LABEL: Record<TrustLevel, string> = {
  restricted: "Restricted",
  standard: "Standard",
  admin: "Admin",
};

export const TRUST_HINT: Record<TrustLevel, string> = {
  restricted: "Agents on this worker can only use their own worktrees.",
  standard:
    "Agents on this worker work on their own worker, and start worktrees elsewhere when Settings > Agents allows it.",
  admin:
    "Agents on this worker can work on any worker, change hub settings and manage repos and cronjobs. Tokens, the vault and trust levels stay out of reach.",
};

export const KIND_LABEL: Record<TokenView["kind"], string> = {
  device: "Device",
  worker_bootstrap: "Worker bootstrap",
  worker_session: "Worker session",
  device_pairing: "Pairing code",
};

export function formatTime(at: number | null): string {
  return at == null ? "Never" : new Date(at).toLocaleString();
}

/** The hub URL a worker dials: the one this page reaches the hub at. */
export function hubUrl(): string {
  return crossOriginHub()?.origin ?? window.location.origin;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
