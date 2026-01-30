/**
 * Commonly API Client
 *
 * HTTP client for communicating with the Commonly Context API.
 */

import axios, { AxiosInstance, AxiosError } from "axios";

export interface ClientConfig {
  apiUrl: string;
  apiToken: string;
  timeout?: number;
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

export class CommonlyClient {
  private http: AxiosInstance;

  constructor(config: ClientConfig) {
    this.http = axios.create({
      baseURL: config.apiUrl,
      timeout: config.timeout || 30000,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
        "User-Agent": "commonly-mcp/0.1.0",
      },
    });

    // Error interceptor for better error messages
    this.http.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        if (error.response) {
          const data = error.response.data as { message?: string; error?: string };
          const message = data?.message || data?.error || error.message;
          throw new Error(`Commonly API Error (${error.response.status}): ${message}`);
        }
        throw error;
      }
    );
  }

  /**
   * List pods the authenticated user has access to
   */
  async listPods(): Promise<Pod[]> {
    const response = await this.http.get<{ pods: Pod[] }>("/api/v1/pods");
    return response.data.pods;
  }

  /**
   * Get a specific pod by ID
   */
  async getPod(podId: string): Promise<Pod> {
    const response = await this.http.get<Pod>(`/api/v1/pods/${podId}`);
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
    const params = new URLSearchParams();
    if (options.task) params.set("task", options.task);
    if (options.includeSkills !== undefined)
      params.set("includeSkills", String(options.includeSkills));
    if (options.includeMemory !== undefined)
      params.set("includeMemory", String(options.includeMemory));
    if (options.maxTokens) params.set("maxTokens", String(options.maxTokens));

    const response = await this.http.get<Context>(
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
    const params = new URLSearchParams();
    params.set("q", query);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.types) params.set("types", options.types.join(","));
    if (options.since) params.set("since", options.since);

    const response = await this.http.get<SearchResponse>(
      `/api/v1/search/${podId}?${params.toString()}`
    );
    return response.data;
  }

  /**
   * Read a specific asset from a pod
   */
  async readAsset(podId: string, assetId: string): Promise<Asset> {
    const response = await this.http.get<Asset>(
      `/api/v1/pods/${podId}/assets/${assetId}`
    );
    return response.data;
  }

  /**
   * Read a virtual memory file (MEMORY.md, daily logs, etc.)
   */
  async readMemoryFile(podId: string, path: string): Promise<string> {
    const response = await this.http.get<{ content: string }>(
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
    const response = await this.http.post<WriteResponse>(
      `/api/v1/memory/${podId}`,
      options
    );
    return response.data;
  }

  /**
   * Post a chat message into a pod
   */
  async postMessage(
    podId: string,
    options: {
      content: string;
      messageType?: string;
      attachments?: unknown[];
    }
  ): Promise<MessageResponse> {
    const response = await this.http.post<MessageResponse>(
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
    const params = new URLSearchParams();
    if (options.tags) params.set("tags", options.tags.join(","));
    if (options.limit) params.set("limit", String(options.limit));

    const response = await this.http.get<{ skills: Skill[] }>(
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
    const params = new URLSearchParams();
    if (options.hours) params.set("hours", String(options.hours));
    if (options.types) params.set("types", options.types.join(","));
    if (options.limit) params.set("limit", String(options.limit));

    const response = await this.http.get<{ summaries: Summary[] }>(
      `/api/v1/pods/${podId}/summaries?${params.toString()}`
    );
    return response.data.summaries;
  }
}
