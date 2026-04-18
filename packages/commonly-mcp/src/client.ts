/**
 * Commonly API Client
 *
 * HTTP client for communicating with the Commonly Context API.
 *
 * Two auth modes are supported in parallel:
 *
 * - **User token** (`cm_*`) — used for the `/api/v1/*` user-space surface
 *   (pods, search, context, memory files, write, post-message). This is what
 *   end-users carry from their account settings.
 * - **Agent token** (`cm_agent_*`) — used for the `/api/agents/runtime/*`
 *   CAP surface (poll, ack, post, memory; per ADR-004). Issued per
 *   installation; lets the MCP client act AS a Commonly agent.
 *
 * The two surfaces are intentionally kept on separate code paths. They are
 * different kernels (user-space vs agent-runtime), with different auth, error
 * shapes, and lifecycle. Folding them together would hide bugs.
 */

import axios, { AxiosInstance, AxiosError } from "axios";

export interface ClientConfig {
  apiUrl: string;
  /**
   * User token (`cm_*`). Required for `/api/v1/*` methods.
   * If omitted, those methods throw MCPClientError.
   */
  userToken?: string;
  /**
   * Agent runtime token (`cm_agent_*`). Required for CAP methods.
   * If omitted, CAP methods throw MCPClientError.
   */
  agentToken?: string;
  /**
   * Legacy alias for `userToken`. Deprecated; prefer `userToken`.
   */
  apiToken?: string;
  timeout?: number;
}

/**
 * Error thrown when the client is misused — e.g. calling a CAP method
 * without an agent token configured. Distinct from upstream HTTP errors so
 * callers can tell "you forgot to set the env var" from "the server said no."
 */
export class MCPClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MCPClientError";
  }
}

/**
 * Single CAP event as returned by GET /api/agents/runtime/events.
 * Shape per ADR-004 §Event model. `payload` is type-specific and opaque
 * to the client.
 */
export interface CAPEvent {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
  attempts?: number;
  createdAt?: string;
  [key: string]: unknown;
}

export interface CAPEventsResponse {
  events: CAPEvent[];
}

export interface CAPAckResponse {
  success?: boolean;
  ok?: boolean;
  [key: string]: unknown;
}

export interface CAPPostMessageOptions {
  content: string;
  replyToMessageId?: string;
  messageType?: string;
  metadata?: Record<string, unknown>;
}

export interface CAPPostMessageResponse {
  success?: boolean;
  message?: {
    id?: string;
    podId?: string;
    createdAt?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CAPMemorySections {
  [section: string]: unknown;
}

export interface CAPMemoryResponse {
  content?: string;
  sections?: CAPMemorySections;
  sourceRuntime?: string;
  schemaVersion?: number;
}

export interface CAPMemorySyncOptions {
  sections: CAPMemorySections;
  mode: "full" | "patch";
  sourceRuntime?: string;
}

export interface CAPMemorySyncResponse {
  ok?: boolean;
  deduped?: boolean;
  byteSize?: number;
  schemaVersion?: number;
  [key: string]: unknown;
}

export interface Pod {
  id: string;
  name: string;
  description?: string;
  type: string;
  role: "admin" | "member" | "viewer";
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tags: string[];
  sourceAssetIds: string[];
}

export interface Asset {
  id: string;
  title: string;
  type: string;
  snippet?: string;
  content?: string;
  source: {
    type: string;
    ref?: string;
  };
  tags: string[];
  relevance?: number;
}

export interface Summary {
  id: string;
  type: string;
  content: string;
  period: {
    start: string;
    end: string;
  };
  metadata?: Record<string, unknown>;
}

export interface Context {
  pod: Pod;
  memory?: string;
  skills: Skill[];
  assets: Asset[];
  summaries: Summary[];
  meta: {
    tokenEstimate: number;
    assembledAt: string;
  };
}

export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
  source: {
    type: string;
    ref?: string;
  };
  relevance: number;
  matchType: "vector" | "keyword" | "hybrid";
}

export interface SearchResponse {
  results: SearchResult[];
  meta: {
    query: string;
    totalResults: number;
    searchTime: number;
  };
}

export interface WriteResponse {
  success: boolean;
  assetId?: string;
  message?: string;
}

export interface MessageResponse {
  id?: string;
  content?: string;
  messageType?: string;
  createdAt?: string;
  [key: string]: unknown;
}

/**
 * Shared response interceptor — converts upstream HTTP errors to friendlier
 * Error messages while preserving status code in the text. Used identically
 * for both user-auth and agent-auth axios instances so error shape is
 * consistent regardless of which surface failed.
 */
function attachErrorInterceptor(http: AxiosInstance, label: string): void {
  http.interceptors.response.use(
    (response) => response,
    (error: AxiosError) => {
      if (error.response) {
        const data = error.response.data as { message?: string; error?: string };
        const message = data?.message || data?.error || error.message;
        throw new Error(`${label} (${error.response.status}): ${message}`);
      }
      throw error;
    }
  );
}

export class CommonlyClient {
  private userHttp: AxiosInstance | null = null;
  private agentHttp: AxiosInstance | null = null;

  constructor(config: ClientConfig) {
    const userToken = config.userToken || config.apiToken;
    const agentToken = config.agentToken;
    const timeout = config.timeout || 30000;

    if (!userToken && !agentToken) {
      throw new MCPClientError(
        "CommonlyClient requires at least one of `userToken` or `agentToken`"
      );
    }

    if (userToken) {
      this.userHttp = axios.create({
        baseURL: config.apiUrl,
        timeout,
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/json",
          "User-Agent": "commonly-mcp/0.1.0",
        },
      });
      attachErrorInterceptor(this.userHttp, "Commonly API Error");
    }

    if (agentToken) {
      this.agentHttp = axios.create({
        baseURL: config.apiUrl,
        timeout,
        headers: {
          Authorization: `Bearer ${agentToken}`,
          "Content-Type": "application/json",
          "User-Agent": "commonly-mcp/0.1.0",
        },
      });
      attachErrorInterceptor(this.agentHttp, "Commonly CAP Error");
    }
  }

  /**
   * Whether this client can call user-auth (`/api/v1/*`) methods.
   */
  hasUserAuth(): boolean {
    return this.userHttp !== null;
  }

  /**
   * Whether this client can call CAP (`/api/agents/runtime/*`) methods.
   */
  hasAgentAuth(): boolean {
    return this.agentHttp !== null;
  }

  private requireUserHttp(): AxiosInstance {
    if (!this.userHttp) {
      throw new MCPClientError(
        "user token not configured; set COMMONLY_USER_TOKEN to use user-space tools"
      );
    }
    return this.userHttp;
  }

  private requireAgentHttp(): AxiosInstance {
    if (!this.agentHttp) {
      throw new MCPClientError(
        "agent token not configured; set COMMONLY_AGENT_TOKEN to use CAP verbs"
      );
    }
    return this.agentHttp;
  }

  // --- HTTP helper for CAP routes ---
  // Kept distinct from the user-auth `http` instance on purpose. Sharing the
  // helper would mean one bug at the path-prefix or auth layer breaks BOTH
  // surfaces. They're separate kernels; keep them separate in code.
  private async _capRequest<T>(
    method: "get" | "post" | "put" | "delete",
    path: string,
    body?: unknown,
    params?: Record<string, string | number | undefined>
  ): Promise<T> {
    const http = this.requireAgentHttp();
    const url = `/api/agents/runtime${path}`;
    const cleanedParams: Record<string, string | number> | undefined = params
      ? Object.fromEntries(
          Object.entries(params).filter(([, v]) => v !== undefined)
        ) as Record<string, string | number>
      : undefined;
    const response = await http.request<T>({
      method,
      url,
      data: body,
      params: cleanedParams,
    });
    return response.data;
  }

  // ===========================================================================
  // User-auth surface (`/api/v1/*`). Uses `userToken`. Requires user-auth.
  // ===========================================================================

  /**
   * List pods the authenticated user has access to
   */
  async listPods(): Promise<Pod[]> {
    const http = this.requireUserHttp();
    const response = await http.get<{ pods: Pod[] }>("/api/v1/pods");
    return response.data.pods;
  }

  /**
   * Get a specific pod by ID
   */
  async getPod(podId: string): Promise<Pod> {
    const http = this.requireUserHttp();
    const response = await http.get<Pod>(`/api/v1/pods/${podId}`);
    return response.data;
  }

  /**
   * Get assembled context for a pod
   */
  async getContext(
    podId: string,
    options: {
      task?: string;
      includeSkills?: boolean;
      includeMemory?: boolean;
      maxTokens?: number;
    } = {}
  ): Promise<Context> {
    const http = this.requireUserHttp();
    const params = new URLSearchParams();
    if (options.task) params.set("task", options.task);
    if (options.includeSkills !== undefined)
      params.set("includeSkills", String(options.includeSkills));
    if (options.includeMemory !== undefined)
      params.set("includeMemory", String(options.includeMemory));
    if (options.maxTokens) params.set("maxTokens", String(options.maxTokens));

    const response = await http.get<Context>(
      `/api/v1/context/${podId}?${params.toString()}`
    );
    return response.data;
  }

  /**
   * Search pod memory using hybrid vector + keyword search
   */
  async search(
    podId: string,
    query: string,
    options: {
      limit?: number;
      types?: string[];
      since?: string;
    } = {}
  ): Promise<SearchResponse> {
    const http = this.requireUserHttp();
    const params = new URLSearchParams();
    params.set("q", query);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.types) params.set("types", options.types.join(","));
    if (options.since) params.set("since", options.since);

    const response = await http.get<SearchResponse>(
      `/api/v1/search/${podId}?${params.toString()}`
    );
    return response.data;
  }

  /**
   * Read a specific asset from a pod
   */
  async readAsset(podId: string, assetId: string): Promise<Asset> {
    const http = this.requireUserHttp();
    const response = await http.get<Asset>(
      `/api/v1/pods/${podId}/assets/${assetId}`
    );
    return response.data;
  }

  /**
   * Read a virtual memory file (MEMORY.md, daily logs, etc.)
   */
  async readMemoryFile(podId: string, path: string): Promise<string> {
    const http = this.requireUserHttp();
    const response = await http.get<{ content: string }>(
      `/api/v1/pods/${podId}/memory/${encodeURIComponent(path)}`
    );
    return response.data.content;
  }

  /**
   * Write to pod memory
   */
  async write(
    podId: string,
    options: {
      target: "daily" | "memory" | "skill";
      content: string;
      tags?: string[];
      source?: {
        agent?: string;
        sessionId?: string;
      };
    }
  ): Promise<WriteResponse> {
    const http = this.requireUserHttp();
    const response = await http.post<WriteResponse>(
      `/api/v1/memory/${podId}`,
      options
    );
    return response.data;
  }

  /**
   * Post a chat message into a pod (user auth — `/api/messages/:podId`).
   * Distinct from `postMessageCAP` which uses agent auth and the CAP route.
   */
  async postMessage(
    podId: string,
    options: {
      content: string;
      messageType?: string;
      attachments?: unknown[];
    }
  ): Promise<MessageResponse> {
    const http = this.requireUserHttp();
    const response = await http.post<MessageResponse>(
      `/api/messages/${podId}`,
      {
        content: options.content,
        messageType: options.messageType,
        attachments: options.attachments,
      }
    );
    return response.data;
  }

  /**
   * Get pod skills
   */
  async getSkills(
    podId: string,
    options: {
      tags?: string[];
      limit?: number;
    } = {}
  ): Promise<Skill[]> {
    const http = this.requireUserHttp();
    const params = new URLSearchParams();
    if (options.tags) params.set("tags", options.tags.join(","));
    if (options.limit) params.set("limit", String(options.limit));

    const response = await http.get<{ skills: Skill[] }>(
      `/api/v1/pods/${podId}/skills?${params.toString()}`
    );
    return response.data.skills;
  }

  /**
   * Get recent summaries for a pod
   */
  async getSummaries(
    podId: string,
    options: {
      hours?: number;
      types?: string[];
      limit?: number;
    } = {}
  ): Promise<Summary[]> {
    const http = this.requireUserHttp();
    const params = new URLSearchParams();
    if (options.hours) params.set("hours", String(options.hours));
    if (options.types) params.set("types", options.types.join(","));
    if (options.limit) params.set("limit", String(options.limit));

    const response = await http.get<{ summaries: Summary[] }>(
      `/api/v1/pods/${podId}/summaries?${params.toString()}`
    );
    return response.data.summaries;
  }

  // ===========================================================================
  // CAP surface (`/api/agents/runtime/*`). Uses `agentToken`. Per ADR-004.
  // Each verb maps to one CAP route. No retries, no dedup, no in-memory state
  // — drivers are responsible for idempotency (ADR-004 §Load-bearing #3).
  // ===========================================================================

  /**
   * CAP verb #1 — poll. `GET /api/agents/runtime/events`.
   *
   * `since` is accepted for forward-compat with a future server-side cursor;
   * the v1 backend does not currently filter by it (ADR-004 §Open Q #2/#3),
   * but passing it through is harmless and keeps the client API stable.
   */
  async pollEvents(
    options: {
      since?: string;
      limit?: number;
    } = {}
  ): Promise<CAPEventsResponse> {
    return this._capRequest<CAPEventsResponse>("get", "/events", undefined, {
      since: options.since,
      limit: options.limit,
    });
  }

  /**
   * CAP verb #2 — ack. `POST /api/agents/runtime/events/:id/ack`.
   * Drivers MUST call this after successful handling, or the event will
   * re-deliver on the next poll (ADR-004 §Event model).
   */
  async ackEvent(eventId: string): Promise<CAPAckResponse> {
    if (!eventId) {
      throw new MCPClientError("ackEvent requires a non-empty eventId");
    }
    return this._capRequest<CAPAckResponse>(
      "post",
      `/events/${encodeURIComponent(eventId)}/ack`,
      {}
    );
  }

  /**
   * CAP verb #3 — post. `POST /api/agents/runtime/pods/:podId/messages`.
   *
   * This is the agent-auth post path (CAP). Distinct from `postMessage`
   * which uses user-auth and a different backend route. Both exist on
   * purpose so end users can pick which auth mode they want exposed.
   */
  async postMessageCAP(
    podId: string,
    options: CAPPostMessageOptions
  ): Promise<CAPPostMessageResponse> {
    if (!podId) {
      throw new MCPClientError("postMessageCAP requires a non-empty podId");
    }
    if (!options.content) {
      throw new MCPClientError("postMessageCAP requires content");
    }
    return this._capRequest<CAPPostMessageResponse>(
      "post",
      `/pods/${encodeURIComponent(podId)}/messages`,
      {
        content: options.content,
        replyToMessageId: options.replyToMessageId,
        messageType: options.messageType,
        metadata: options.metadata,
      }
    );
  }

  /**
   * CAP verb #4a — read memory. `GET /api/agents/runtime/memory`.
   * Returns the v2 envelope (`sections` + `sourceRuntime` + `schemaVersion`)
   * with `content` for v1 readers (per ADR-003).
   */
  async readMemory(): Promise<CAPMemoryResponse> {
    return this._capRequest<CAPMemoryResponse>("get", "/memory");
  }

  /**
   * CAP verb #4b — sync memory. `POST /api/agents/runtime/memory/sync`.
   * `mode: 'full'` replaces, `'patch'` merges (per ADR-003 Phase 2).
   * Server passes `deduped: true` if the same payload was synced earlier
   * in the same UTC day; we surface that field through unchanged.
   */
  async syncMemory(options: CAPMemorySyncOptions): Promise<CAPMemorySyncResponse> {
    if (!options || typeof options !== "object") {
      throw new MCPClientError("syncMemory requires an options object");
    }
    if (options.mode !== "full" && options.mode !== "patch") {
      throw new MCPClientError("syncMemory mode must be 'full' or 'patch'");
    }
    if (!options.sections || typeof options.sections !== "object") {
      throw new MCPClientError("syncMemory requires sections object");
    }
    return this._capRequest<CAPMemorySyncResponse>(
      "post",
      "/memory/sync",
      {
        sections: options.sections,
        mode: options.mode,
        sourceRuntime: options.sourceRuntime,
      }
    );
  }
}
