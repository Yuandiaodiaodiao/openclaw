import { describe, expect, it, vi } from "vitest";
import { createRpcTransformer, isRpcEnabled } from "./rpc-transformer.js";

describe("isRpcEnabled", () => {
  it("returns false when rpc is undefined", () => {
    expect(isRpcEnabled(undefined)).toBe(false);
  });

  it("returns false when enabled is false", () => {
    expect(isRpcEnabled({ enabled: false, rpcUrl: "http://localhost" })).toBe(false);
  });

  it("returns false when rpcUrl is empty", () => {
    expect(isRpcEnabled({ enabled: true, rpcUrl: "" })).toBe(false);
  });

  it("returns true when enabled and rpcUrl are set", () => {
    expect(isRpcEnabled({ enabled: true, rpcUrl: "http://localhost:3001/rpc" })).toBe(true);
  });
});

describe("createRpcTransformer", () => {
  it("forwards API calls to RPC endpoint", async () => {
    const mockResponse = { ok: true, result: { message_id: 123 } };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const transformer = createRpcTransformer({
      rpcUrl: "http://localhost:3001/api/telegram-rpc",
      rpcHeaders: { Authorization: "Bearer secret" },
    });

    const prev = vi.fn();
    const result = await transformer(
      prev,
      "sendMessage",
      { chat_id: 123, text: "hello" },
      undefined,
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/telegram-rpc",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret",
        },
        body: JSON.stringify({ method: "sendMessage", chat_id: 123, text: "hello" }),
      }),
    );
    expect(prev).not.toHaveBeenCalled();
    expect(result).toEqual(mockResponse);
  });

  it("excludes specified methods and calls prev", async () => {
    const transformer = createRpcTransformer({
      rpcUrl: "http://localhost:3001/rpc",
      excludeMethods: ["getMe"],
    });

    const mockResult = { ok: true, result: { id: 1, username: "bot" } };
    const prev = vi.fn().mockResolvedValue(mockResult);

    const result = await transformer(prev, "getMe", {}, undefined);

    expect(prev).toHaveBeenCalledWith("getMe", {}, undefined);
    expect(result).toEqual(mockResult);
  });

  it("calls onError when RPC fails", async () => {
    const onError = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const transformer = createRpcTransformer({
      rpcUrl: "http://localhost:3001/rpc",
      onError,
    });

    const prev = vi.fn();
    await expect(transformer(prev, "sendMessage", { chat_id: 1 }, undefined)).rejects.toThrow(
      "RPC HTTP 500",
    );
    expect(onError).toHaveBeenCalledWith("sendMessage", expect.any(Error));
  });
});
