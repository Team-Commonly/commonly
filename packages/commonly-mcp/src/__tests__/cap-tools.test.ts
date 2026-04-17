import { describe, expect, it, vi } from "vitest";
import { handleToolCall } from "../tools/index.js";
import { CommonlyClient, MCPClientError } from "../client.js";
import type { Config } from "../index.js";

/**
 * CAP-tool tests (ADR-007 Phase 2).
 *
 * Mock pattern matches existing tools.test.ts: hand handleToolCall a stub
 * client object that has just the methods the tool will call. Each test
 * touches one tool so failures point straight at the broken tool.
 */

const baseConfig = (overrides: Partial<Config> = {}): Config => ({
  apiUrl: "https://api.commonly.app",
  agentToken: "cm_agent_test",
  debug: false,
  ...overrides,
});

describe("commonly_poll_events", () => {
  it("returns events from the client", async () => {
    const client = {
      pollEvents: vi
        .fn()
        .mockResolvedValue({ events: [{ id: "evt_1", type: "mention.received" }] }),
    } as unknown as CommonlyClient;

    const result = await handleToolCall(
      client,
      "commonly_poll_events",
      { limit: 10 },
      baseConfig()
    );

    expect(client.pollEvents).toHaveBeenCalledWith({ since: undefined, limit: 10 });
    expect(result).toEqual({ events: [{ id: "evt_1", type: "mention.received" }] });
  });

  it("returns {events: []} on empty queue (not an error)", async () => {
    const client = {
      pollEvents: vi.fn().mockResolvedValue({ events: [] }),
    } as unknown as CommonlyClient;

    const result = await handleToolCall(
      client,
      "commonly_poll_events",
      {},
      baseConfig()
    );

    expect(result).toEqual({ events: [] });
  });

  it("propagates 4xx errors from backend", async () => {
    const client = {
      pollEvents: vi
        .fn()
        .mockRejectedValue(new Error("Commonly CAP Error (401): unauthorized")),
    } as unknown as CommonlyClient;

    await expect(
      handleToolCall(client, "commonly_poll_events", {}, baseConfig())
    ).rejects.toThrow(/401/);
  });

  it("surfaces missing-agent-token error from client", async () => {
    // A real client without an agent token throws MCPClientError on call.
    const client = {
      pollEvents: vi
        .fn()
        .mockRejectedValue(
          new MCPClientError(
            "agent token not configured; set COMMONLY_AGENT_TOKEN to use CAP verbs"
          )
        ),
    } as unknown as CommonlyClient;

    await expect(
      handleToolCall(client, "commonly_poll_events", {}, baseConfig())
    ).rejects.toThrow(/agent token not configured/);
  });
});

describe("commonly_ack_event", () => {
  it("calls ackEvent with the eventId", async () => {
    const client = {
      ackEvent: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as CommonlyClient;

    const result = await handleToolCall(
      client,
      "commonly_ack_event",
      { eventId: "evt_123" },
      baseConfig()
    );

    expect(client.ackEvent).toHaveBeenCalledWith("evt_123");
    expect(result).toEqual({ ok: true });
  });

  it("rejects when eventId is missing", async () => {
    const client = { ackEvent: vi.fn() } as unknown as CommonlyClient;
    await expect(
      handleToolCall(client, "commonly_ack_event", {}, baseConfig())
    ).rejects.toThrow(/eventId/);
    expect(client.ackEvent).not.toHaveBeenCalled();
  });

  it("propagates 4xx from backend", async () => {
    const client = {
      ackEvent: vi
        .fn()
        .mockRejectedValue(new Error("Commonly CAP Error (404): event not found")),
    } as unknown as CommonlyClient;
    await expect(
      handleToolCall(client, "commonly_ack_event", { eventId: "x" }, baseConfig())
    ).rejects.toThrow(/404/);
  });
});

describe("commonly_post_message_cap", () => {
  it("posts via CAP and returns normalized shape", async () => {
    const client = {
      postMessageCAP: vi.fn().mockResolvedValue({
        success: true,
        message: {
          _id: "msg_42",
          podId: "pod_xyz",
          createdAt: "2026-04-16T10:00:00.000Z",
        },
      }),
    } as unknown as CommonlyClient;

    const result = await handleToolCall(
      client,
      "commonly_post_message_cap",
      { podId: "pod_xyz", content: "hello pod" },
      baseConfig()
    );

    expect(client.postMessageCAP).toHaveBeenCalledWith("pod_xyz", {
      content: "hello pod",
      replyToMessageId: undefined,
      messageType: undefined,
      metadata: undefined,
    });
    expect(result).toEqual({
      messageId: "msg_42",
      podId: "pod_xyz",
      createdAt: "2026-04-16T10:00:00.000Z",
    });
  });

  it("falls back to defaultPodId when podId omitted", async () => {
    const client = {
      postMessageCAP: vi.fn().mockResolvedValue({ success: true, message: {} }),
    } as unknown as CommonlyClient;

    await handleToolCall(
      client,
      "commonly_post_message_cap",
      { content: "hi" },
      baseConfig({ defaultPodId: "pod_default" })
    );

    expect(client.postMessageCAP).toHaveBeenCalledWith("pod_default", expect.any(Object));
  });

  it("rejects when content missing", async () => {
    const client = { postMessageCAP: vi.fn() } as unknown as CommonlyClient;
    await expect(
      handleToolCall(
        client,
        "commonly_post_message_cap",
        { podId: "pod_xyz" },
        baseConfig()
      )
    ).rejects.toThrow(/content/);
    expect(client.postMessageCAP).not.toHaveBeenCalled();
  });

  it("rejects when no podId resolvable", async () => {
    const client = { postMessageCAP: vi.fn() } as unknown as CommonlyClient;
    await expect(
      handleToolCall(
        client,
        "commonly_post_message_cap",
        { content: "hi" },
        baseConfig()
      )
    ).rejects.toThrow(/podId/);
  });

  it("propagates 4xx from backend", async () => {
    const client = {
      postMessageCAP: vi
        .fn()
        .mockRejectedValue(new Error("Commonly CAP Error (403): not in pod")),
    } as unknown as CommonlyClient;
    await expect(
      handleToolCall(
        client,
        "commonly_post_message_cap",
        { podId: "pod_xyz", content: "hi" },
        baseConfig()
      )
    ).rejects.toThrow(/403/);
  });
});

describe("commonly_memory_sync", () => {
  it("calls syncMemory with sections+mode", async () => {
    const client = {
      syncMemory: vi.fn().mockResolvedValue({ ok: true, schemaVersion: 2 }),
    } as unknown as CommonlyClient;

    const result = await handleToolCall(
      client,
      "commonly_memory_sync",
      {
        sections: { soul: { content: "x" } },
        mode: "patch",
        sourceRuntime: "mcp-client",
      },
      baseConfig()
    );

    expect(client.syncMemory).toHaveBeenCalledWith({
      sections: { soul: { content: "x" } },
      mode: "patch",
      sourceRuntime: "mcp-client",
    });
    expect(result).toEqual({
      updated: true,
      deduped: undefined,
      byteSize: undefined,
      schemaVersion: 2,
    });
  });

  it("passes through deduped=true and reports updated=false", async () => {
    const client = {
      syncMemory: vi.fn().mockResolvedValue({ ok: true, deduped: true }),
    } as unknown as CommonlyClient;

    const result = await handleToolCall(
      client,
      "commonly_memory_sync",
      { sections: {}, mode: "full" },
      baseConfig()
    );

    expect(result).toMatchObject({ updated: false, deduped: true });
  });

  it("rejects invalid mode", async () => {
    const client = { syncMemory: vi.fn() } as unknown as CommonlyClient;
    await expect(
      handleToolCall(
        client,
        "commonly_memory_sync",
        { sections: {}, mode: "weird" },
        baseConfig()
      )
    ).rejects.toThrow(/mode must be/);
    expect(client.syncMemory).not.toHaveBeenCalled();
  });

  it("rejects missing sections", async () => {
    const client = { syncMemory: vi.fn() } as unknown as CommonlyClient;
    await expect(
      handleToolCall(
        client,
        "commonly_memory_sync",
        { mode: "full" },
        baseConfig()
      )
    ).rejects.toThrow(/sections/);
  });

  it("propagates 4xx from backend", async () => {
    const client = {
      syncMemory: vi
        .fn()
        .mockRejectedValue(new Error("Commonly CAP Error (400): bad sections")),
    } as unknown as CommonlyClient;
    await expect(
      handleToolCall(
        client,
        "commonly_memory_sync",
        { sections: {}, mode: "full" },
        baseConfig()
      )
    ).rejects.toThrow(/400/);
  });
});
