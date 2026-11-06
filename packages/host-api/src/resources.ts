/** What a Band process on a machine is for. */
export type ResourceKind =
  | "worker"
  | "hub"
  | "terminal-daemon"
  | "agent-daemon"
  | "terminal"
  | "agent"
  | "lsp"
  | "browser"
  | "simulator"
  | "mcp"
  | "other";

/** One Band process, with the processes it started summed into it. */
export interface ResourceProcess {
  pid: number;
  kind: ResourceKind;
  /** Short name: the shell, the agent adapter, the language server. */
  name: string;
  /** The command line, cut to 200 characters. */
  command: string;
  /** Resident memory of the process and its children, in bytes. */
  rssBytes: number;
  /** CPU of the process and its children over the sampling window, in percent of one core. */
  cpuPercent: number;
  /** How many processes the numbers cover (the process and its descendants). */
  processCount: number;
  /** The working directory, when it could be read. */
  cwd?: string;
  /** Ids from the process environment (`BAND_WORKTREE_ID`, `BAND_CHAT_ID`, `BAND_TERMINAL_ID`). */
  worktreeId?: string;
  chatId?: string;
  terminalId?: string;
}

export interface ResourceDisk {
  /** The folder the numbers describe. */
  path: string;
  totalBytes: number;
  freeBytes: number;
}

export interface ResourceSnapshot {
  hostname: string;
  os: string;
  cores: number;
  /** RAM of the machine and what is in use, in bytes. */
  memTotalBytes: number;
  memUsedBytes: number;
  /** Machine CPU over the sampling window, 0 to 100. Null when it could not be read. */
  machineCpuPercent: number | null;
  loadAverage: number;
  /** How long the sampling window was, in milliseconds. */
  windowMs: number;
  takenAt: number;
  processes: ResourceProcess[];
}

export interface ResourceStorageRequest {
  /** Worktree folders to measure, by the hub's id for them. */
  worktrees: { id: string; path: string }[];
}

export interface ResourceStorage {
  worktrees: { id: string; sizeBytes: number; error?: string }[];
  /** The immediate children of the host's state folder, each measured. */
  state: { name: string; sizeBytes: number }[];
  /** The disk that holds the state folder. */
  disk: ResourceDisk | null;
}

export interface HostResources {
  /** Memory and CPU of the machine and of its Band processes. Samples CPU over about half a second and caches for 3 seconds. */
  snapshot(): Promise<ResourceSnapshot>;
  /** Disk use of the given worktrees and of the host's state folder. At most 3 `du` run at once. */
  storage(request: ResourceStorageRequest): Promise<ResourceStorage>;
}
