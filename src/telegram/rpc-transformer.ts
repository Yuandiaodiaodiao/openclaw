import type { Transformer } from "grammy";
import type { TelegramRpcConfig } from "../config/types.telegram.js";

export type RpcTransformerOptions = {
  rpcUrl: string;
  rpcHeaders?: Record<string, string>;
  rpcTimeout?: number;
  excludeMethods?: string[];
  onError?: (method: string, error: Error) => void;
};

/**
 * Creates a grammY transformer that forwards all bot.api.* calls to an external RPC endpoint.
 * This allows relay servers to handle Telegram API calls instead of the bot calling Telegram directly.
 */
export function createRpcTransformer(opts: RpcTransformerOptions): Transformer {
  const excludeMethods = new Set(opts.excludeMethods ?? []);
  const timeout = opts.rpcTimeout ?? 30000;

  return async (prev, method, payload, signal) => {
    if (excludeMethods.has(method)) {
      return prev(method, payload, signal);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    if (signal) {
      signal.addEventListener("abort", () => controller.abort());
    }

    try {
      const response = await fetch(opts.rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...opts.rpcHeaders,
        },
        body: JSON.stringify({ method, ...payload }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`RPC HTTP ${response.status}`);
      }
      return response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      opts.onError?.(method, error as Error);
      throw error;
    }
  };
}

/**
 * Check if RPC mode is enabled based on config.
 */
export function isRpcEnabled(rpc?: TelegramRpcConfig): boolean {
  return Boolean(rpc?.enabled && rpc.rpcUrl);
}
