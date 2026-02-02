import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedTgrelayAccount } from "./accounts.js";
import type { TgrelayOutboundMessage } from "./types.js";
import { getTgrelayRuntime } from "./runtime.js";

export type TgrelaySendResult = {
  ok: boolean;
  messageId?: string;
  chatId?: string;
  error?: string;
};

export type TgrelaySendTextParams = {
  account: ResolvedTgrelayAccount;
  chatId: number | string;
  text: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  disableNotification?: boolean;
};

export type TgrelaySendMediaParams = {
  account: ResolvedTgrelayAccount;
  chatId: number | string;
  mediaUrl: string;
  mediaType: "photo" | "document" | "audio" | "video" | "voice";
  caption?: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  disableNotification?: boolean;
};

async function sendToOutbound(
  account: ResolvedTgrelayAccount,
  payload: TgrelayOutboundMessage,
): Promise<TgrelaySendResult> {
  const outboundUrl = account.outboundUrl;
  if (!outboundUrl) {
    return {
      ok: false,
      error: "outboundUrl not configured for tgrelay account",
    };
  }

  const runtime = getTgrelayRuntime();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...account.outboundHeaders,
  };

  try {
    const response = await fetch(outboundUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      runtime.log?.(`tgrelay outbound failed: ${response.status} ${errorText}`);
      return {
        ok: false,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const result = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { message_id?: number; chat?: { id?: number } };
      message_id?: number;
      chat_id?: number | string;
    };

    // Support both Telegram API response format and simple format
    const messageId =
      result.result?.message_id?.toString() ?? result.message_id?.toString() ?? undefined;
    const chatId =
      result.result?.chat?.id?.toString() ?? result.chat_id?.toString() ?? String(payload.chat_id);

    return {
      ok: true,
      messageId,
      chatId,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    runtime.log?.(`tgrelay outbound error: ${errorMsg}`);
    return {
      ok: false,
      error: errorMsg,
    };
  }
}

export async function sendTgrelayText(params: TgrelaySendTextParams): Promise<TgrelaySendResult> {
  const payload: TgrelayOutboundMessage = {
    method: "sendMessage",
    chat_id: params.chatId,
    text: params.text,
    parse_mode: params.parseMode ?? "HTML",
    reply_to_message_id: params.replyToMessageId,
    message_thread_id: params.messageThreadId,
    disable_notification: params.disableNotification,
  };

  return sendToOutbound(params.account, payload);
}

export async function sendTgrelayMedia(params: TgrelaySendMediaParams): Promise<TgrelaySendResult> {
  const methodMap: Record<string, TgrelayOutboundMessage["method"]> = {
    photo: "sendPhoto",
    document: "sendDocument",
    audio: "sendAudio",
    video: "sendVideo",
    voice: "sendVoice",
  };

  const mediaUrl = params.mediaUrl;
  const isLocalFile = mediaUrl.startsWith("/") || mediaUrl.startsWith("./");

  let payload: TgrelayOutboundMessage;

  if (isLocalFile) {
    // Read local file and send as base64
    try {
      const fileBuffer = await fs.readFile(mediaUrl);
      const base64 = fileBuffer.toString("base64");
      const filename = path.basename(mediaUrl);
      const ext = path.extname(mediaUrl).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
        ".pdf": "application/pdf",
      };

      payload = {
        method: methodMap[params.mediaType] ?? "sendDocument",
        chat_id: params.chatId,
        caption: params.caption,
        parse_mode: params.parseMode ?? "HTML",
        reply_to_message_id: params.replyToMessageId,
        message_thread_id: params.messageThreadId,
        disable_notification: params.disableNotification,
        file_data: {
          base64,
          filename,
          mime_type: mimeMap[ext],
        },
      };
    } catch (err) {
      const runtime = getTgrelayRuntime();
      runtime.log?.(`tgrelay failed to read local file: ${err}`);
      return {
        ok: false,
        error: `Failed to read local file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    // URL or file_id - send directly
    payload = {
      method: methodMap[params.mediaType] ?? "sendDocument",
      chat_id: params.chatId,
      caption: params.caption,
      parse_mode: params.parseMode ?? "HTML",
      reply_to_message_id: params.replyToMessageId,
      message_thread_id: params.messageThreadId,
      disable_notification: params.disableNotification,
      [params.mediaType]: mediaUrl,
    };
  }

  return sendToOutbound(params.account, payload);
}

export async function probeTgrelay(account: ResolvedTgrelayAccount): Promise<{
  ok: boolean;
  error?: string;
  webhookPath?: string;
  outboundUrl?: string;
}> {
  // Basic probe - check if outbound URL is configured and reachable
  if (!account.outboundUrl) {
    return {
      ok: false,
      error: "outboundUrl not configured",
      webhookPath: account.webhookPath,
    };
  }

  // Optionally ping the outbound URL with a test request
  try {
    const response = await fetch(account.outboundUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...account.outboundHeaders,
      },
      body: JSON.stringify({ method: "getMe" }),
    });

    return {
      ok: response.ok,
      error: response.ok ? undefined : `HTTP ${response.status}`,
      webhookPath: account.webhookPath,
      outboundUrl: account.outboundUrl,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      webhookPath: account.webhookPath,
      outboundUrl: account.outboundUrl,
    };
  }
}
