import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommonlyClient } from "./client.js";

const createResponse = (data: unknown = {}) => ({
  ok: true,
  json: async () => data,
});

describe("CommonlyClient", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses runtime token for runtime endpoints", async () => {
    fetchMock.mockResolvedValue(createResponse({ id: "msg-1" }));
    const client = new CommonlyClient({
      baseUrl: "http://localhost:5000",
      runtimeToken: "rt",
    });

    await client.postMessage("pod-123", "hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5000/api/agents/runtime/pods/pod-123/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer rt" }),
      }),
    );
  });

  it("uses user token for user endpoints when provided", async () => {
    fetchMock.mockResolvedValue(createResponse({ results: [] }));
    const client = new CommonlyClient({
      baseUrl: "http://localhost:5000",
      runtimeToken: "rt",
      userToken: "ut",
    });

    await client.search("pod-123", "query");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5000/api/v1/search/pod-123?q=query",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ut" }),
      }),
    );
  });

  it("falls back to runtime token for user endpoints", async () => {
    fetchMock.mockResolvedValue(createResponse({ results: [] }));
    const client = new CommonlyClient({
      baseUrl: "http://localhost:5000",
      runtimeToken: "rt",
    });

    await client.search("pod-123", "query");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5000/api/v1/search/pod-123?q=query",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer rt" }),
      }),
    );
  });

  it("throws when runtime token is missing for runtime endpoints", async () => {
    fetchMock.mockResolvedValue(createResponse({}));
    const client = new CommonlyClient({ baseUrl: "http://localhost:5000" });

    await expect(client.postMessage("pod-123", "hello")).rejects.toThrow(
      "Commonly runtime token is required",
    );
  });
});
