/**
 * commonly_create_task — create a task on the pod board mid-turn.
 *
 * Hits `POST /api/v1/tasks/:podId` via agent auth. Moltbots already get
 * this via the openclaw extension's `commonly_*` block during heartbeat,
 * but MCP-driven agents (claude-code, codex, cursor) had no way to create
 * a task during a chat.mention turn — they could only describe the work
 * in chat. Closes #442 part 1.
 *
 * Idempotent on `sourceRef`: the backend returns the existing task with
 * `alreadyExists: true` if a task with the same `sourceRef` already lives
 * in the pod. Title-fuzzy dedup is intentionally NOT in the backend (it
 * was a prompt-judgment convention in task-clerk; never enforced in the
 * route). Callers who want title-level dedup should query first via
 * commonly_pods + a future commonly_list_tasks tool.
 */

import { CommonlyClient } from "../client.js";
import type { Config } from "../index.js";

export const definition = {
  name: "commonly_create_task",
  description:
    "Create a task on a pod's board mid-turn. Use this when a user " +
    "asks for a task to be captured, or when an agent needs to spawn " +
    "follow-up work. Requires COMMONLY_AGENT_TOKEN. Idempotent on " +
    "`sourceRef` — re-passing the same sourceRef returns the existing " +
    "task with `alreadyExists: true` rather than creating a duplicate. " +
    "Does NOT title-fuzzy-dedup; query first if duplicate-prevention " +
    "matters for your use case.",
  inputSchema: {
    type: "object" as const,
    properties: {
      podId: {
        type: "string",
        description:
          "Target pod id. If omitted, falls back to COMMONLY_DEFAULT_POD.",
      },
      title: {
        type: "string",
        description: "Task title. Required.",
      },
      assignee: {
        type: "string",
        description:
          "Optional assignee handle (instanceId or @-mention without the @).",
      },
      dep: {
        type: "string",
        description:
          "Optional task id this task blocks on (e.g. 'TASK-055').",
      },
      parentTask: {
        type: "string",
        description:
          "Optional parent task id — creates this as a sub-task.",
      },
      source: {
        type: "string",
        description:
          "Optional origin tag — e.g. 'chat', 'github', 'huddle'. " +
          "Default 'human' (set by backend).",
      },
      sourceRef: {
        type: "string",
        description:
          "Optional dedup key — re-passing the same sourceRef in the " +
          "same pod returns the existing task with `alreadyExists: true` " +
          "(and reopens it if previously completed).",
      },
    },
    required: ["title"],
  },
};

export interface CapCreateTaskArgs {
  podId?: string;
  title: string;
  assignee?: string;
  dep?: string;
  parentTask?: string;
  source?: string;
  sourceRef?: string;
}

export interface CapCreateTaskResult {
  taskId: string | undefined;
  taskNum: number | undefined;
  title: string;
  alreadyExists: boolean;
  podId: string;
}

export async function handler(
  client: CommonlyClient,
  args: CapCreateTaskArgs,
  config: Config
): Promise<CapCreateTaskResult> {
  const podId = args.podId || config.defaultPodId;
  if (!podId) {
    throw new Error(
      "podId is required for commonly_create_task (or set COMMONLY_DEFAULT_POD)"
    );
  }
  const response = await client.createTask(podId, {
    title: args.title,
    assignee: args.assignee,
    dep: args.dep,
    parentTask: args.parentTask,
    source: args.source,
    sourceRef: args.sourceRef,
  });
  const task: Record<string, unknown> = (response.task ?? {}) as Record<string, unknown>;
  const rawTaskId = task.taskId;
  const rawTaskNum = task.taskNum;
  return {
    taskId: typeof rawTaskId === "string" ? rawTaskId : undefined,
    taskNum: typeof rawTaskNum === "number" ? rawTaskNum : undefined,
    title: args.title,
    alreadyExists: response.alreadyExists === true,
    podId,
  };
}
