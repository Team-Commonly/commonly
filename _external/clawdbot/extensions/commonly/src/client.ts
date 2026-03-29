/**
 * Commonly REST API Client
 *
 * Handles all REST API calls to the Commonly backend.
 */

export interface CommonlyClientConfig {
  baseUrl: string;
  runtimeToken?: string;
  userToken?: string;
  agentName?: string;
  instanceId?: string;
}

export interface PodContext {
  pod?: {
    name: string;
    description?: string;
  };
  memory?: string;
  skills?: Array<{
    name: string;
    description?: string;
  }>;
  summaries?: Array<{
    content: string;
    createdAt: Date;
  }>;
  assets?: Array<{
    title: string;
    snippet?: string;
  }>;
}

export interface Message {
  id: string;
  content: string;
  userId?: {
    _id: string;
    username: string;
    profilePicture?: string;
  };
  username?: string;
  isBot?: boolean;
  createdAt: Date;
}

export class CommonlyClient {
  private config: CommonlyClientConfig;

  constructor(config: CommonlyClientConfig) {
    this.config = config;
  }

  /**
   * Get authorization headers
   */
  private get runtimeHeaders(): Record<string, string> {
    const token = this.config.runtimeToken?.trim();
    if (!token) {
      throw new Error('Commonly runtime token is required');
    }
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private get userHeaders(): Record<string, string> {
    const token = this.config.userToken?.trim() || this.config.runtimeToken?.trim();
    if (!token) {
      throw new Error('Commonly user token is required');
    }
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Returns env vars to inject into acpx subprocess so shell scripts in
   * HEARTBEAT.md tasks can authenticate against the Commonly API.
   */
  getApiEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    if (this.config.baseUrl) env.COMMONLY_API_URL = this.config.baseUrl;
    const token = this.config.runtimeToken?.trim();
    if (token) env.COMMONLY_API_TOKEN = token;
    return env;
  }

  getInstanceId(): string | undefined {
    return this.config.instanceId;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.baseUrl}/api/health`, {
        headers: { 'Content-Type': 'application/json' },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetch pending events for this agent
   */
  async fetchEvents(): Promise<unknown[]> {
    const url = new URL(`${this.config.baseUrl}/api/agents/runtime/events`);
    url.searchParams.append('agentName', this.config.agentName || 'openclaw');
    url.searchParams.append('instanceId', this.config.instanceId || 'default');

    const res = await fetch(url.toString(), { headers: this.runtimeHeaders });
    if (!res.ok) {
      throw new Error(`Failed to fetch events: ${res.status}`);
    }
    const data = await res.json();
    return data.events || [];
  }

  /**
   * Acknowledge an event
   */
  async ackEvent(eventId: string): Promise<void> {
    const res = await fetch(
      `${this.config.baseUrl}/api/agents/runtime/events/${eventId}/ack`,
      {
        method: 'POST',
        headers: this.runtimeHeaders,
      },
    );
    if (!res.ok) {
      throw new Error(`Failed to ack event: ${res.status}`);
    }
  }

  /**
   * Post a message to a pod
   */
  async postMessage(
    podId: string,
    content: string,
    metadata: Record<string, unknown> = {},
  ): Promise<Message> {
    const res = await fetch(
      `${this.config.baseUrl}/api/agents/runtime/pods/${podId}/messages`,
      {
        method: 'POST',
        headers: this.runtimeHeaders,
        body: JSON.stringify({
          content,
          messageType: 'text',
          metadata: {
            ...metadata,
            agentType: this.config.agentName,
            instanceId: this.config.instanceId,
          },
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`Failed to post message: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Post a comment to a thread
   */
  async postThreadComment(threadId: string, content: string, replyToCommentId?: string): Promise<unknown> {
    const body: Record<string, unknown> = { content };
    if (replyToCommentId) body.replyToCommentId = replyToCommentId;
    const res = await fetch(
      `${this.config.baseUrl}/api/agents/runtime/threads/${threadId}/comments`,
      {
        method: 'POST',
        headers: this.runtimeHeaders,
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`Failed to post thread comment: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Get assembled context for a pod
   */
  async getContext(podId: string, task?: string): Promise<PodContext | null> {
    const url = new URL(
      `${this.config.baseUrl}/api/agents/runtime/pods/${podId}/context`,
    );
    if (task) {
      url.searchParams.append('task', task);
    }

    const res = await fetch(url.toString(), { headers: this.runtimeHeaders });
    if (!res.ok) {
      console.warn(`Failed to get context: ${res.status}`);
      return null;
    }
    return res.json();
  }

  /**
   * Get recent messages for a pod
   */
  async getMessages(podId: string, limit = 10): Promise<Message[]> {
    const url = new URL(
      `${this.config.baseUrl}/api/agents/runtime/pods/${podId}/messages`,
    );
    url.searchParams.append('limit', limit.toString());

    const res = await fetch(url.toString(), { headers: this.runtimeHeaders });
    if (!res.ok) {
      console.warn(`Failed to get messages: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.messages || [];
  }

  /**
   * List public pods the agent can discover and potentially join
   */
  async listPods(limit = 20): Promise<unknown[]> {
    const url = new URL(`${this.config.baseUrl}/api/agents/runtime/pods`);
    url.searchParams.append('limit', limit.toString());

    const res = await fetch(url.toString(), { headers: this.runtimeHeaders });
    if (!res.ok) {
      console.warn(`Failed to list pods: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.pods || [];
  }

  /**
   * Get recent posts in a pod with comment data
   */
  async getPosts(podId: string, limit = 5): Promise<unknown[]> {
    const url = new URL(
      `${this.config.baseUrl}/api/agents/runtime/pods/${podId}/posts`,
    );
    url.searchParams.append('limit', limit.toString());

    const res = await fetch(url.toString(), { headers: this.runtimeHeaders });
    if (!res.ok) {
      console.warn(`Failed to get posts: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.posts || [];
  }

  /**
   * Search pod memory and assets
   */
  async search(podId: string, query: string): Promise<unknown[]> {
    const url = new URL(`${this.config.baseUrl}/api/v1/search/${podId}`);
    url.searchParams.append('q', query);

    const res = await fetch(url.toString(), { headers: this.userHeaders });
    if (!res.ok) {
      console.warn(`Failed to search: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.results || [];
  }

  /**
   * Read pod memory file
   */
  async readMemory(
    podId: string,
    path: string,
  ): Promise<{ content: string } | null> {
    const url = new URL(
      `${this.config.baseUrl}/api/v1/pods/${podId}/memory/${path}`,
    );

    const res = await fetch(url.toString(), { headers: this.userHeaders });
    if (!res.ok) {
      console.warn(`Failed to read memory: ${res.status}`);
      return null;
    }
    return res.json();
  }

  /**
   * Write to pod memory
   */
  async writeMemory(
    podId: string,
    target: 'daily' | 'memory' | 'skill',
    content: string,
    options: { tags?: string[]; source?: Record<string, unknown> } = {},
  ): Promise<unknown> {
    const res = await fetch(`${this.config.baseUrl}/api/v1/memory/${podId}`, {
      method: 'POST',
      headers: this.userHeaders,
      body: JSON.stringify({
        target,
        content,
        tags: options.tags || [],
        source: {
          ...options.source,
          agentType: this.config.agentName,
          instanceId: this.config.instanceId,
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to write memory: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Get recent summaries for a pod
   */
  async getSummaries(
    podId: string,
    hours = 24,
  ): Promise<Array<{ content: string; createdAt: Date }>> {
    const url = new URL(
      `${this.config.baseUrl}/api/v1/pods/${podId}/summaries`,
    );
    url.searchParams.append('hours', hours.toString());

    const res = await fetch(url.toString(), { headers: this.userHeaders });
    if (!res.ok) {
      console.warn(`Failed to get summaries: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.summaries || [];
  }

  /**
   * Create a new pod
   */
  async createPod(
    name: string,
    type: 'chat' | 'study' | 'games' | 'agent-ensemble' | 'agent-admin',
    description?: string,
  ): Promise<{ _id: string; name: string; type: string }> {
    const res = await fetch(`${this.config.baseUrl}/api/agents/runtime/pods`, {
      method: 'POST',
      headers: this.runtimeHeaders,
      body: JSON.stringify({ name, type, description }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create pod: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Create a post in a pod's feed
   */
  async createPost(
    content: string,
    options: {
      podId: string;
      category?: string;
      tags?: string[];
      sourceUrl?: string;
    },
  ): Promise<{ _id: string; content: string; podId: string }> {
    const body: Record<string, unknown> = {
      content,
      podId: options.podId,
      category: options.category || 'General',
      tags: options.tags || [],
    };
    if (options.sourceUrl) {
      body.source = { type: 'web', provider: 'web', url: options.sourceUrl };
    }
    const res = await fetch(`${this.config.baseUrl}/api/agents/runtime/posts`, {
      method: 'POST',
      headers: this.runtimeHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to create post: ${res.status}`);
    return res.json();
  }

  /**
   * Read this agent's personal MEMORY.md (stored in backend, persistent across sessions)
   */
  async readAgentMemory(): Promise<{ content: string }> {
    const res = await fetch(`${this.config.baseUrl}/api/agents/runtime/memory`, {
      headers: this.runtimeHeaders,
    });
    if (!res.ok) throw new Error(`Failed to read agent memory: ${res.status}`);
    return res.json();
  }

  /**
   * Write this agent's personal MEMORY.md (overwrites full content)
   */
  async writeAgentMemory(content: string): Promise<void> {
    const res = await fetch(`${this.config.baseUrl}/api/agents/runtime/memory`, {
      method: 'PUT',
      headers: this.runtimeHeaders,
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error(`Failed to write agent memory: ${res.status}`);
  }

  /**
   * Self-install this agent into an agent-owned pod
   */
  async selfInstall(podId: string): Promise<{ message: string; podId: string; alreadyInstalled?: boolean }> {
    const res = await fetch(`${this.config.baseUrl}/api/agents/runtime/pods/${podId}/self-install`, {
      method: 'POST',
      headers: this.runtimeHeaders,
    });
    if (!res.ok) {
      throw new Error(`Failed to self-install into pod: ${res.status}`);
    }
    return res.json();
  }

  /**
   * List tasks for a pod
   */
  async getTasks(
    podId: string,
    params: { assignee?: string; status?: string } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const url = new URL(`${this.config.baseUrl}/api/v1/tasks/${podId}`);
    if (params.assignee) url.searchParams.append('assignee', params.assignee);
    if (params.status) url.searchParams.append('status', params.status);
    const res = await fetch(url.toString(), { headers: this.userHeaders });
    if (!res.ok) {
      console.warn(`Failed to get tasks: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.tasks || [];
  }

  /**
   * Create a task in a pod
   */
  async createTask(
    podId: string,
    data: {
      title: string;
      assignee?: string;
      dep?: string;
      depMockOk?: boolean;
      source?: string;
      sourceRef?: string;
      githubIssueNumber?: number;
      githubIssueUrl?: string;
      createGithubIssue?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.config.baseUrl}/api/v1/tasks/${podId}`, {
      method: 'POST',
      headers: this.userHeaders,
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Failed to create task: ${res.status}`);
    // Returns { task, alreadyExists? } — pass through so tools.ts can inspect alreadyExists
    return res.json();
  }

  /**
   * Atomically claim a pending task
   */
  async claimTask(
    podId: string,
    taskId: string,
  ): Promise<{ task?: Record<string, unknown>; error?: string; claimedBy?: string; status?: string }> {
    const res = await fetch(
      `${this.config.baseUrl}/api/v1/tasks/${podId}/${taskId}/claim`,
      { method: 'POST', headers: this.userHeaders },
    );
    const data = await res.json();
    if (res.status === 409) return { error: data.error, claimedBy: data.claimedBy, status: data.status };
    if (!res.ok) throw new Error(`Failed to claim task: ${res.status}`);
    return { task: data.task };
  }

  /**
   * Mark a task as done
   */
  async completeTask(
    podId: string,
    taskId: string,
    data: { prUrl?: string; notes?: string } = {},
  ): Promise<Record<string, unknown>> {
    const res = await fetch(
      `${this.config.baseUrl}/api/v1/tasks/${podId}/${taskId}/complete`,
      {
        method: 'POST',
        headers: this.userHeaders,
        body: JSON.stringify(data),
      },
    );
    if (!res.ok) throw new Error(`Failed to complete task: ${res.status}`);
    const result = await res.json();
    return result.task;
  }

  /**
   * Append a progress update to a task (visible in the UI activity log)
   */
  async addTaskUpdate(
    podId: string,
    taskId: string,
    text: string,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(
      `${this.config.baseUrl}/api/v1/tasks/${podId}/${taskId}/updates`,
      {
        method: 'POST',
        headers: this.userHeaders,
        body: JSON.stringify({ text }),
      },
    );
    if (!res.ok) throw new Error(`Failed to add task update: ${res.status}`);
    const result = await res.json();
    return result.task;
  }

  /**
   * Update task fields
   */
  async updateTask(
    podId: string,
    taskId: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(
      `${this.config.baseUrl}/api/v1/tasks/${podId}/${taskId}`,
      {
        method: 'PATCH',
        headers: this.userHeaders,
        body: JSON.stringify(data),
      },
    );
    if (!res.ok) throw new Error(`Failed to update task: ${res.status}`);
    const result = await res.json();
    return result.task;
  }

  // ─── GitHub Issues ──────────────────────────────────────────────────────

  /**
   * List open GitHub issues (excludes pull requests).
   */
  async listGithubIssues(
    options?: { owner?: string; repo?: string; perPage?: number },
  ): Promise<Array<{ number: number; title: string; body: string; url: string; labels: string[] }>> {
    const params = new URLSearchParams();
    if (options?.owner) params.set('owner', options.owner);
    if (options?.repo) params.set('repo', options.repo);
    if (options?.perPage) params.set('per_page', String(options.perPage));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${this.config.baseUrl}/api/github/issues${qs}`, {
      headers: this.userHeaders,
    });
    if (!res.ok) throw new Error(`Failed to list GitHub issues: ${res.status}`);
    const result = await res.json();
    return result.issues;
  }

  /**
   * Create a new GitHub issue. Returns { number, title, url }.
   */
  async createGithubIssue(data: {
    title: string;
    body?: string;
    labels?: string[];
    owner?: string;
    repo?: string;
  }): Promise<{ number: number; title: string; url: string }> {
    const res = await fetch(`${this.config.baseUrl}/api/github/issues`, {
      method: 'POST',
      headers: this.userHeaders,
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Failed to create GitHub issue: ${res.status}`);
    return res.json();
  }

  // ────────────────────────────────────────────────────────────────────────

  /**
   * Report ensemble response
   */
  async reportEnsembleResponse(
    podId: string,
    ensembleId: string,
    content: string,
    messageId?: string,
  ): Promise<unknown> {
    const res = await fetch(
      `${this.config.baseUrl}/api/pods/${podId}/ensemble/response`,
      {
        method: 'POST',
        headers: this.runtimeHeaders,
        body: JSON.stringify({
          ensembleId,
          agentType: this.config.agentName,
          instanceId: this.config.instanceId,
          content,
          messageId,
        }),
      },
    );
    if (!res.ok) {
      console.warn(`Failed to report ensemble response: ${res.status}`);
    }
    return res.json();
  }
}
