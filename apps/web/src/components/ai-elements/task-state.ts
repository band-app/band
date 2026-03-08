import type { ToolCallItem } from "./tool-call";

export interface TaskItem {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  owner?: string;
  blockedBy?: string[];
}

export type TaskMap = Map<string, TaskItem>;

export const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);

export function isTaskTool(toolName: string): boolean {
  return TASK_TOOL_NAMES.has(toolName);
}

function parseTaskFromOutput(output: unknown): TaskItem | null {
  if (!output) return null;
  try {
    const data = typeof output === "string" ? JSON.parse(output) : output;
    if (!data || typeof data !== "object") return null;
    const obj = data as Record<string, unknown>;
    if (!obj.id || !obj.subject) return null;
    return {
      id: String(obj.id),
      subject: String(obj.subject),
      description: obj.description ? String(obj.description) : undefined,
      status: validateStatus(obj.status),
      activeForm: obj.activeForm ? String(obj.activeForm) : undefined,
      owner: obj.owner ? String(obj.owner) : undefined,
      blockedBy: Array.isArray(obj.blockedBy) ? obj.blockedBy.map(String) : undefined,
    };
  } catch {
    return null;
  }
}

function validateStatus(val: unknown): "pending" | "in_progress" | "completed" {
  if (val === "pending" || val === "in_progress" || val === "completed") {
    return val;
  }
  return "pending";
}

function parseTaskListOutput(output: unknown): TaskItem[] | null {
  try {
    const data = typeof output === "string" ? JSON.parse(output) : output;
    if (!Array.isArray(data)) return null;
    const tasks: TaskItem[] = [];
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as Record<string, unknown>;
      if (!obj.id || !obj.subject) continue;
      tasks.push({
        id: String(obj.id),
        subject: String(obj.subject),
        description: obj.description ? String(obj.description) : undefined,
        status: validateStatus(obj.status),
        activeForm: obj.activeForm ? String(obj.activeForm) : undefined,
        owner: obj.owner ? String(obj.owner) : undefined,
        blockedBy: Array.isArray(obj.blockedBy) ? obj.blockedBy.map(String) : undefined,
      });
    }
    return tasks;
  } catch {
    return null;
  }
}

export function applyTaskToolCall(map: TaskMap, item: ToolCallItem): TaskMap {
  const next = new Map(map);

  if (item.toolName === "TaskList") {
    const tasks = parseTaskListOutput(item.output);
    if (!tasks) return next;
    next.clear();
    for (const task of tasks) {
      next.set(task.id, task);
    }
    return next;
  }

  // TaskCreate, TaskUpdate, TaskGet — upsert from output
  const task = parseTaskFromOutput(item.output);
  if (!task) return next;

  // Check for deletion via TaskUpdate input
  if (item.toolName === "TaskUpdate") {
    const input = item.input as Record<string, unknown> | null;
    if (input?.status === "deleted") {
      next.delete(task.id);
      return next;
    }
  }

  if (task.status === ("deleted" as string)) {
    next.delete(task.id);
    return next;
  }

  const existing = next.get(task.id);
  if (existing) {
    next.set(task.id, { ...existing, ...task });
  } else {
    next.set(task.id, task);
  }
  return next;
}

export function buildTaskMapFromItems(items: ToolCallItem[]): TaskMap {
  let map: TaskMap = new Map();
  for (const item of items) {
    if (isTaskTool(item.toolName)) {
      map = applyTaskToolCall(map, item);
    }
  }
  return map;
}
