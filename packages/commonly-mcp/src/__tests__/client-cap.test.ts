import { describe, expect, it, vi, beforeEach } from "vitest";
import { CommonlyClient, MCPClientError } from "../client.js";

/**
 * Client-level CAP tests. Focus: which axios instance is used for which call,
 * what URL prefix gets applied, what header sets the bearer token, and the
 * shape of the error when an auth mode isn't configured.
 *
 * We mock axios.create to capture the per-instance config (so we can assert
 * the Authorization header) and stub the per-instance .request/.get/.post.
 */

type MockAxios = {
  request: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  interceptors: { response: { use: ReturnType<typeof vi.fn> } };
  // expose the create-time config so tests can read which token was set
  _config: Record<string, unknown>;
};

const createdInstances: MockAxios[] = [];

vi.mock("axios", () => {
  const create = vi.fn((config: Record<string, unknown>) => {
    const inst: MockAxios = {
      request: vi.fn().mockResolvedValue({ data: { events: [] } }),
      get: vi.fn().mockResolvedValue({ data: {} }),
      post: vi.fn().mockResolvedValue({ data: {} }),
      put: vi.fn().mockResolvedValue({ data: {} }),
      interceptors: { response: { use: vi.fn() } },
      _config: config,
    };
    createdInstances.push(inst);
    return inst;
  });
  return {
    default: { create },
    create,
  };
});

beforeEach(() => {
  createdInstances.length = 0;
});

describe("CommonlyClient construction", () => {
  it("creates only the user axios instance when only userToken is set", () => {
    const client = new CommonlyClient({
      apiUrl: "https://api.commonly.app",
      userToken: "cm_user_x",
    });
    expect(createdInstances).toHaveLength(1);
    expect(client.hasUserAuth()).toBe(true);
    expect(client.hasAgentAuth()).toBe(false);
    const headers = (createdInstances[0]._config.headers as Record<string, string>);
    expect(headers.Authorization).toBe("Bearer cm_user_x");
  });

  it("creates only the agent axios instance when only agentToken is set", () => {
    const client = new CommonlyClient({
      apiUrl: "https://api.commonly.app",
      agentToken: "cm_agent_x",
    });
    expect(createdInstances).toHaveLength(1);
    expect(client.hasUserAuth()).toBe(false);
    expect(client.hasAgentAuth()).toBe(true);
    const headers = (createdInstances[0]._config.headers as Record<string, string>);
    expect(headers.Authorization).toBe("Bearer cm_agent_x");
  });

  it("creates both instances with separate tokens when both are set", () => {
    new CommonlyClient({
      apiUrl: "https://api.commonly.app",
      userToken: "cm_user_x",
      agentToken: "cm_agent_x",
    });
    expect(createdInstances).toHaveLength(2);
    const tokens = createdInstances.map(
      (i) => (i._config.headers as Record<string, string>).Authorization
    );
    expect(tokens).toContain("Bearer cm_user_x");
    expect(tokens).toContain("Bearer cm_agent_x");
  });

  it("throws MCPClientError when neither token is provided", () => {
    expect(
      () =>
        new CommonlyClient({
          apiUrl: "https://api.commonly.app",
        })
    ).toThrow(MCPClientError);
  });
});

describe("CommonlyClient CAP methods — URL construction", () => {
  it("pollEvents hits /api/agents/runtime/events with limit param", async () => {
    const client = new CommonlyClient({
      apiUrl: "https://api.commonly.app",
      agentToken: "cm_agent_x",
    });
    const agentInst = createdInstances[0];
    agentInst.request.mockResolvedValueOnce({ data: { events: [] } });

    await client.pollEvents({ limit: 5 });

    expect(agentInst.request).toHaveBeenCalledWith({
      method: "get",
      url: "/api/agents/runtime/events",
      data: undefined,
      params: { limit: 5 },
    });
  });

  it("pollEvents drops undefined params (no `since=undefined` in query)", async () => {
    const client = new CommonlyClient({
      apiUrl: "https://api.commonly.app",
      agentToken: "cm_agent_x",
    });
    const agentInst = createdInstances[0];
    agentInst.request.mockResolvedValueOnce({ data: { events: [] } });

    await client.pollEvents({});

    const call = agentInst.request.mock.calls[0][0];
    expect(call.params).toEqual({});
  });

  it("ackEvent URL-encodes the event id", async () => {
    const client = new CommonlyClient({
      apiUrl: "https://api.commonly.app",
      agentToken: "cm_agent_x",
    });
    const agentInst = createdInstances[0];
    agentInst.request.mockResolvedValueOnce({ data: { success: true } });

    await client.ackEvent("evt/with slash");

    expect(agentInst.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "post",
        url: "/api/agents/runtime/events/evt%2Fwith%20slash/ack",
      })
    );
  });

  it("postMessageCAP posts to /api/agents/runtime/pods/:podId/messages with full body", async () => {
    const client = new CommonlyClient({
      apiUrl: "https://api.commonly.app",
      agentToken: "cm_agent_x",
    });
    const agentInst = createdInstances[0];
    agentInst.request.mockResolvedValueOnce({ data: { success: true, message: {} } });

    await client.postMessageCAP("pod_xyz", {
      content: "hi",
      replyToMessageId: "msg_1",
      messageType: "text",
      metadata: { kind: "install-intro" },
    });

    expect(agentInst.request).toHaveBeenCalledWith({
      method: "post",
      url: "/api/agents/runtime/pods/pod_xyz/messages",
      data: {
        content: "hi",
        replyToMessageId: "msg_1",
        messageType: "text",
        metadata: { kind: "install-intro" },
      },
      params: undefined,
    });
  });

  it("readMemory hits /api/agents/runtime/memory", async () => {
    const client = new CommonlyClient({
      apiUrl: "https://api.commonly.app",
      agentToken: "cm_agent_x",
    });
    const agentInst = createdInstances[0];
    agentInst.request.mockResolvedValueOnce({ data: { content: "" } });

    await client.readMemory();

    expect(agentInst.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "get",
        url: "/api/agents/runtime/memory",
      })
    );
  });

  it("syncMemory posts /api/agents/runtime/memory/sync with mode + sections", async () => {
    const client = new CommonlyClient({
      apiUrl: "https://api.commonly.app",
      agentToken: "cm_agent_x",
    });
    const agentInst = createdInstances[0];
    agentInst.request.mockResolvedValueOnce({ data: { ok: true } });

    await client.syncMemory({
      sections: { soul: { content: "x" } },
      mode: "patch",
      sourceRuntime: "mcp-client",
    });

    expect(agentInst.request).toHaveBeenCalledWith({
      method: "post",
      url: "/api/agents/runtime/memory/sync",
      data: {
        sections: { soul: { content: "x" } },
        mode: "patch",
        sourceRuntime: "mcp-client",
      },
      params: undefined,
    });
  });

  it("CAP method throws MCPClientError when only userToken configured", async () => {
    const client = new CommonlyClient({
      apiUrl: "https://api.commonly.app",
      userToken: "cm_user_x",
    });

    await expect(client.pollEvents()).rejects.toThrow(MCPClientError);
    await expect(client.pollEvents()).rejects.toThrow(/agent token not configured/);
  });

  it("user-space method throws MCPClientError when only agentToken configured", async () => {
    const client = new CommonlyClient({
      apiUrl: "https://api.commonly.app",
      agentToken: "cm_agent_x",
    });

    await expect(client.listPods()).rejects.toThrow(MCPClientError);
    await expect(client.listPods()).rejects.toThrow(/user token not configured/);
  });

  it("syncMemory rejects invalid mode locally (no HTTP call)", async () => {
    const client = new CommonlyClient({
      apiUrl: "https://api.commonly.app",
      agentToken: "cm_agent_x",
    });
    const agentInst = createdInstances[0];

    await expect(
      // intentionally bad mode
      client.syncMemory({ sections: {}, mode: "weird" as unknown as "full" })
    ).rejects.toThrow(/mode must be/);
    expect(agentInst.request).not.toHaveBeenCalled();
  });
});
