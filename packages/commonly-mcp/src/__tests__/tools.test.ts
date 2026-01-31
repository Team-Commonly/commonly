import { describe, expect, it, vi } from "vitest";
import { handleToolCall } from "../tools/index.js";
import type { Config } from "../index.js";

describe("commonly_post_message", () => {
  it("posts a message with explicit podId", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue({ id: "msg_1" }),
    } as unknown as { postMessage: (podId: string, payload: unknown) => Promise<unknown> };

    const config: Config = {
      apiUrl: "https://api.commonly.app",
      apiToken: "token",
      debug: false,
    };

    const result = await handleToolCall(
      client as any,
      "commonly_post_message",
      { podId: "pod_123", content: "hello" },
      config
    );

    expect(client.postMessage).toHaveBeenCalledWith("pod_123", {
      content: "hello",
      messageType: undefined,
      attachments: undefined,
    });
    expect(result).toEqual({ id: "msg_1" });
  });

  it("uses defaultPodId when podId is omitted", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue({ id: "msg_2" }),
    } as unknown as { postMessage: (podId: string, payload: unknown) => Promise<unknown> };

    const config: Config = {
      apiUrl: "https://api.commonly.app",
      apiToken: "token",
      debug: false,
      defaultPodId: "pod_default",
    };

    await handleToolCall(
      client as any,
      "commonly_post_message",
      { content: "hello" },
      config
    );

    expect(client.postMessage).toHaveBeenCalledWith("pod_default", {
      content: "hello",
      messageType: undefined,
      attachments: undefined,
    });
  });
});
