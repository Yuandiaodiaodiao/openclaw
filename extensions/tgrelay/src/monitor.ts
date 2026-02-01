import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveMentionGatingWithBypass } from "openclaw/plugin-sdk";
import type { TgrelayUpdate, TgrelayMessage, TgrelayAccountConfig } from "./types.js";
import type { ResolvedTgrelayAccount } from "./accounts.js";
import { sendTgrelayText, sendTgrelayMedia } from "./api.js";
import { getTgrelayRuntime } from "./runtime.js";

export type TgrelayRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type TgrelayMonitorOptions = {
  account: ResolvedTgrelayAccount;
  config: OpenClawConfig;
  runtime: TgrelayRuntimeEnv;
  abortSignal: AbortSignal;
  webhookPath?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type TgrelayCoreRuntime = ReturnType<typeof getTgrelayRuntime>;

type WebhookTarget = {
  account: ResolvedTgrelayAccount;
  config: OpenClawConfig;
  runtime: TgrelayRuntimeEnv;
  core: TgrelayCoreRuntime;
  path: string;
  inboundSecret?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  mediaMaxMb: number;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

function logVerbose(core: TgrelayCoreRuntime, runtime: TgrelayRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[tgrelay] ${message}`);
  }
}

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    let resolved = false;
    const doResolve = (value: { ok: boolean; value?: unknown; error?: string }) => {
      if (resolved) {
        return;
      }
      resolved = true;
      req.removeAllListeners();
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        doResolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          doResolve({ ok: false, error: "empty payload" });
          return;
        }
        doResolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        doResolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      doResolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

export function registerTgrelayWebhookTarget(target: WebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

function verifyInboundSecret(
  req: IncomingMessage,
  url: URL,
  expectedSecret?: string,
): boolean {
  if (!expectedSecret) {
    return true;
  }
  // Check X-Telegram-Bot-Api-Secret-Token header (standard Telegram webhook secret)
  const headerSecret = req.headers["x-telegram-bot-api-secret-token"];
  if (headerSecret === expectedSecret) {
    return true;
  }
  // Check query param as fallback
  const querySecret = url.searchParams.get("secret");
  if (querySecret === expectedSecret) {
    return true;
  }
  // Check Authorization header
  const authHeader = req.headers.authorization ?? "";
  if (authHeader === `Bearer ${expectedSecret}`) {
    return true;
  }
  return false;
}

export async function handleTgrelayWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  const raw = body.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  const update = raw as TgrelayUpdate;
  if (typeof update.update_id !== "number") {
    res.statusCode = 400;
    res.end("invalid payload: missing update_id");
    return true;
  }

  let selected: WebhookTarget | undefined;
  for (const target of targets) {
    if (verifyInboundSecret(req, url, target.inboundSecret)) {
      selected = target;
      break;
    }
  }

  if (!selected) {
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }

  selected.statusSink?.({ lastInboundAt: Date.now() });
  processTgrelayUpdate(update, selected).catch((err) => {
    selected?.runtime.error?.(
      `[${selected.account.accountId}] tgrelay webhook failed: ${String(err)}`,
    );
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end("{}");
  return true;
}

async function processTgrelayUpdate(update: TgrelayUpdate, target: WebhookTarget) {
  const message = update.message ?? update.edited_message ?? update.channel_post;
  if (!message) {
    return;
  }

  await processMessageWithPipeline({
    message,
    account: target.account,
    config: target.config,
    runtime: target.runtime,
    core: target.core,
    statusSink: target.statusSink,
    mediaMaxMb: target.mediaMaxMb,
  });
}

function normalizeUserId(raw?: number | string | null): string {
  if (raw == null) {
    return "";
  }
  return String(raw).trim().toLowerCase();
}

export function isSenderAllowed(
  senderId: number | string,
  senderUsername: string | undefined,
  allowFrom: Array<string | number>,
) {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = normalizeUserId(senderId);
  const normalizedUsername = senderUsername?.trim().toLowerCase().replace(/^@/, "") ?? "";
  return allowFrom.some((entry) => {
    const normalized = String(entry).trim().toLowerCase().replace(/^@/, "");
    if (!normalized) {
      return false;
    }
    if (normalized === normalizedSenderId) {
      return true;
    }
    if (normalizedUsername && normalized === normalizedUsername) {
      return true;
    }
    if (normalized.replace(/^(tgrelay|telegram-relay|tg-relay):/i, "") === normalizedSenderId) {
      return true;
    }
    return false;
  });
}

function resolveGroupConfig(params: {
  groupId: number | string;
  groupName?: string | null;
  groups?: TgrelayAccountConfig["groups"];
}) {
  const { groupId, groupName, groups } = params;
  const entries = groups ?? {};
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return { entry: undefined, allowlistConfigured: false };
  }
  const normalizedName = groupName?.trim().toLowerCase();
  const candidates = [String(groupId), groupName ?? "", normalizedName ?? ""].filter(Boolean);
  let entry = candidates.map((candidate) => entries[candidate]).find(Boolean);
  if (!entry && normalizedName) {
    entry = entries[normalizedName];
  }
  const fallback = entries["*"];
  return { entry: entry ?? fallback, allowlistConfigured: true, fallback };
}

function extractMentionInfo(
  message: TgrelayMessage,
  botUsername?: string | null,
): { hasAnyMention: boolean; wasMentioned: boolean } {
  const entities = message.entities ?? message.caption_entities ?? [];
  const text = message.text ?? message.caption ?? "";
  const mentionEntities = entities.filter((e) => e.type === "mention" || e.type === "text_mention");
  const hasAnyMention = mentionEntities.length > 0;

  if (!botUsername) {
    return { hasAnyMention, wasMentioned: false };
  }

  const normalizedBot = botUsername.trim().toLowerCase().replace(/^@/, "");
  const wasMentioned = mentionEntities.some((entity) => {
    if (entity.type === "text_mention" && entity.user?.username) {
      return entity.user.username.toLowerCase() === normalizedBot;
    }
    if (entity.type === "mention") {
      const mentionText = text.slice(entity.offset, entity.offset + entity.length);
      return mentionText.toLowerCase().replace(/^@/, "") === normalizedBot;
    }
    return false;
  });

  return { hasAnyMention, wasMentioned };
}

async function processMessageWithPipeline(params: {
  message: TgrelayMessage;
  account: ResolvedTgrelayAccount;
  config: OpenClawConfig;
  runtime: TgrelayRuntimeEnv;
  core: TgrelayCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  mediaMaxMb: number;
}): Promise<void> {
  const { message, account, config, runtime, core, statusSink, mediaMaxMb: _mediaMaxMb } = params;
  const chat = message.chat;
  if (!chat) {
    return;
  }

  const chatId = chat.id;
  const chatType = chat.type;
  const isGroup = chatType === "group" || chatType === "supergroup" || chatType === "channel";
  const sender = message.from;
  const senderId = sender?.id ?? 0;
  const senderName = [sender?.first_name, sender?.last_name].filter(Boolean).join(" ");
  const senderUsername = sender?.username;

  // Skip bot messages unless configured
  const allowBots = account.config.dm?.policy === "open";
  if (!allowBots && sender?.is_bot) {
    logVerbose(core, runtime, `skip bot-authored message (${senderId})`);
    return;
  }

  const messageText = (message.text ?? message.caption ?? "").trim();
  const hasMedia = Boolean(
    message.photo?.length ||
      message.document ||
      message.audio ||
      message.video ||
      message.voice ||
      message.sticker,
  );
  const rawBody = messageText || (hasMedia ? "<media:attachment>" : "");
  if (!rawBody) {
    return;
  }

  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
  const groupConfigResolved = resolveGroupConfig({
    groupId: chatId,
    groupName: chat.title ?? null,
    groups: account.config.groups,
  });
  const groupEntry = groupConfigResolved.entry;
  const groupUsers = groupEntry?.users ?? account.config.groupAllowFrom ?? [];
  let effectiveWasMentioned: boolean | undefined;

  if (isGroup) {
    if (groupPolicy === "disabled") {
      logVerbose(core, runtime, `drop group message (groupPolicy=disabled, chat=${chatId})`);
      return;
    }
    const groupAllowlistConfigured = groupConfigResolved.allowlistConfigured;
    const groupAllowed = Boolean(groupEntry) || Boolean((account.config.groups ?? {})["*"]);
    if (groupPolicy === "allowlist") {
      if (!groupAllowlistConfigured) {
        logVerbose(
          core,
          runtime,
          `drop group message (groupPolicy=allowlist, no allowlist, chat=${chatId})`,
        );
        return;
      }
      if (!groupAllowed) {
        logVerbose(core, runtime, `drop group message (not allowlisted, chat=${chatId})`);
        return;
      }
    }
    if (groupEntry?.enabled === false || groupEntry?.allow === false) {
      logVerbose(core, runtime, `drop group message (chat disabled, chat=${chatId})`);
      return;
    }

    if (groupUsers.length > 0) {
      const ok = isSenderAllowed(senderId, senderUsername, groupUsers);
      if (!ok) {
        logVerbose(core, runtime, `drop group message (sender not allowed, ${senderId})`);
        return;
      }
    }
  }

  const dmPolicy = account.config.dm?.policy ?? "pairing";
  const configAllowFrom = account.config.dm?.allowFrom ?? [];
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    !isGroup && (dmPolicy !== "open" || shouldComputeAuth)
      ? await core.channel.pairing.readAllowFromStore("tgrelay").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const commandAllowFrom = isGroup ? groupUsers : effectiveAllowFrom;
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(senderId, senderUsername, commandAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  if (isGroup) {
    const requireMention = groupEntry?.requireMention ?? account.config.requireMention ?? true;
    const mentionInfo = extractMentionInfo(message, account.config.botUsername);
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg: config,
      surface: "tgrelay",
    });
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup: true,
      requireMention,
      canDetectMention: true,
      wasMentioned: mentionInfo.wasMentioned,
      implicitMention: false,
      hasAnyMention: mentionInfo.hasAnyMention,
      allowTextCommands,
      hasControlCommand: core.channel.text.hasControlCommand(rawBody, config),
      commandAuthorized: commandAuthorized === true,
    });
    effectiveWasMentioned = mentionGate.effectiveWasMentioned;
    if (mentionGate.shouldSkip) {
      logVerbose(core, runtime, `drop group message (mention required, chat=${chatId})`);
      return;
    }
  }

  if (!isGroup) {
    if (dmPolicy === "disabled") {
      logVerbose(core, runtime, `Blocked tgrelay DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;
      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "tgrelay",
            id: String(senderId),
            meta: { name: senderName || undefined, username: senderUsername },
          });
          if (created) {
            logVerbose(core, runtime, `tgrelay pairing request sender=${senderId}`);
            try {
              await sendTgrelayText({
                account,
                chatId,
                text: core.channel.pairing.buildPairingReply({
                  channel: "tgrelay",
                  idLine: `Your Telegram user id: ${senderId}`,
                  code,
                }),
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(core, runtime, `pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        } else {
          logVerbose(
            core,
            runtime,
            `Blocked unauthorized tgrelay sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }
  }

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `tgrelay: drop control command from ${senderId}`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "tgrelay",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: String(chatId),
    },
  });

  const fromLabel = isGroup
    ? chat.title || `chat:${chatId}`
    : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Telegram Relay",
    from: fromLabel,
    timestamp: message.date ? message.date * 1000 : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const groupSystemPrompt = groupConfigResolved.entry?.systemPrompt?.trim() || undefined;
  const threadId = message.message_thread_id;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `tgrelay:${senderId}`,
    To: `tgrelay:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "channel" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: String(senderId),
    SenderUsername: senderUsername,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    CommandAuthorized: commandAuthorized,
    Provider: "tgrelay",
    Surface: "tgrelay",
    MessageSid: String(message.message_id),
    MessageSidFull: `${chatId}:${message.message_id}`,
    ReplyToId: message.reply_to_message?.message_id
      ? String(message.reply_to_message.message_id)
      : undefined,
    MessageThreadId: threadId ? String(threadId) : undefined,
    GroupSpace: isGroup ? (chat.title ?? undefined) : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    OriginatingChannel: "tgrelay",
    OriginatingTo: `tgrelay:${chatId}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`tgrelay: failed updating session meta: ${String(err)}`);
    });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverTgrelayReply({
          payload,
          account,
          chatId,
          threadId,
          runtime,
          core,
          config,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(
          `[${account.accountId}] tgrelay ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
  });
}

async function deliverTgrelayReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  account: ResolvedTgrelayAccount;
  chatId: number;
  threadId?: number;
  runtime: TgrelayRuntimeEnv;
  core: TgrelayCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, account, chatId, threadId, runtime, core, config, statusSink } = params;
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? payload.text : undefined;
      first = false;
      try {
        await sendTgrelayMedia({
          account,
          chatId,
          mediaUrl,
          mediaType: "document",
          caption,
          replyToMessageId: payload.replyToId ? Number(payload.replyToId) : undefined,
          messageThreadId: threadId,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`tgrelay media send failed: ${String(err)}`);
      }
    }
    return;
  }

  if (payload.text) {
    const chunkLimit = account.config.mediaMaxMb ? 4096 : 4096;
    const chunkMode = core.channel.text.resolveChunkMode(config, "tgrelay", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);
    for (const chunk of chunks) {
      try {
        await sendTgrelayText({
          account,
          chatId,
          text: chunk,
          replyToMessageId: payload.replyToId ? Number(payload.replyToId) : undefined,
          messageThreadId: threadId,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`tgrelay message send failed: ${String(err)}`);
      }
    }
  }
}

export function monitorTgrelayProvider(options: TgrelayMonitorOptions): () => void {
  const core = getTgrelayRuntime();
  const webhookPath = options.webhookPath?.trim() || options.account.webhookPath;
  if (!webhookPath) {
    options.runtime.error?.(`[${options.account.accountId}] invalid webhook path`);
    return () => {};
  }

  const mediaMaxMb = options.account.config.mediaMaxMb ?? 20;

  const unregister = registerTgrelayWebhookTarget({
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    inboundSecret: options.account.config.inboundSecret,
    statusSink: options.statusSink,
    mediaMaxMb,
  });

  return unregister;
}

export async function startTgrelayMonitor(params: TgrelayMonitorOptions): Promise<() => void> {
  return monitorTgrelayProvider(params);
}

export function resolveTgrelayWebhookPath(params: { account: ResolvedTgrelayAccount }): string {
  return params.account.webhookPath || "/tgrelay";
}
