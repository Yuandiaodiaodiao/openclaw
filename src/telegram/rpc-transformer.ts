import type { Transformer } from "grammy";
import { InputFile } from "grammy";
import type { TelegramRpcConfig } from "../config/types.telegram.js";

export type RpcTransformerOptions = {
  rpcUrl: string;
  rpcHeaders?: Record<string, string>;
  rpcTimeout?: number;
  excludeMethods?: string[];
  onError?: (method: string, error: Error) => void;
};

/**
 * Converts an InputFile to a base64-encoded file_data object for RPC transport.
 */
async function inputFileToFileData(
  inputFile: InputFile,
): Promise<{ base64: string; filename?: string }> {
  // Access internal fileData property
  const fileData = (inputFile as unknown as { fileData: unknown }).fileData;
  const filename = inputFile.filename;

  let buffer: Buffer;

  if (fileData instanceof Buffer || fileData instanceof Uint8Array) {
    buffer = Buffer.from(fileData);
  } else if (typeof fileData === "string") {
    // File path - read the file
    const fs = await import("node:fs/promises");
    buffer = await fs.readFile(fileData);
  } else if (fileData instanceof URL) {
    if (fileData.protocol === "file:") {
      const fs = await import("node:fs/promises");
      buffer = await fs.readFile(fileData.pathname);
    } else {
      const response = await fetch(fileData);
      buffer = Buffer.from(await response.arrayBuffer());
    }
  } else if (typeof fileData === "object" && fileData !== null && "url" in fileData) {
    const response = await fetch((fileData as { url: string }).url);
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error(`Unsupported InputFile data type for RPC: ${typeof fileData}`);
  }

  return { base64: buffer.toString("base64"), filename };
}

/**
 * Process payload to convert any InputFile instances to file_data format.
 * Returns a new payload object suitable for JSON serialization.
 */
async function processPayloadForRpc(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (value instanceof InputFile) {
      // Convert InputFile to file_data format
      result.file_data = await inputFileToFileData(value);
      // Keep the original key as placeholder for the relay server to identify the media type
      result[key] = "file_data";
    } else if (Array.isArray(value)) {
      // Handle arrays (e.g., media groups)
      result[key] = await Promise.all(
        value.map(async (item) => {
          if (item instanceof InputFile) {
            return { file_data: await inputFileToFileData(item) };
          }
          if (typeof item === "object" && item !== null) {
            return processPayloadForRpc(item as Record<string, unknown>);
          }
          return item;
        }),
      );
    } else if (typeof value === "object" && value !== null) {
      // Recursively process nested objects
      result[key] = await processPayloadForRpc(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

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
      // Process payload to convert InputFile instances to file_data format
      const processedPayload = payload
        ? await processPayloadForRpc(payload as Record<string, unknown>)
        : {};

      const response = await fetch(opts.rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...opts.rpcHeaders,
        },
        body: JSON.stringify({ method, ...processedPayload }),
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
