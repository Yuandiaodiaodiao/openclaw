import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  migrateBaseNameToDefaultAccount,
  missingTargetError,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  type ChannelDock,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  listTgrelayAccountIds,
  resolveDefaultTgrelayAccountId,
  resolveTgrelayAccount,
  type ResolvedTgrelayAccount,
} from "./accounts.js";
import { sendTgrelayText, probeTgrelay } from "./api.js";
import { resolveTgrelayWebhookPath, startTgrelayMonitor } from "./monitor.js";
import { getTgrelayRuntime } from "./runtime.js";

const meta = getChatChannelMeta("tgrelay");

const formatAllowFromEntry = (entry: string | number) =>
  String(entry)
    .trim()
    .replace(/^(tgrelay|telegram-relay|tg-relay):/i, "")
    .replace(/^@/, "")
    .toLowerCase();

export const tgrelayDock: ChannelDock = {
  id: "tgrelay",
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    reactions: false,
    media: true,
    threads: true,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 4096 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveTgrelayAccount({ cfg, accountId }).config.dm?.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId }) =>
      resolveTgrelayAccount({ cfg, accountId }).config.requireMention ?? true,
  },
  threading: {
    resolveReplyToMode: ({ cfg }) =>
      (cfg.channels?.["tgrelay"] as { replyToMode?: string } | undefined)?.replyToMode ?? "off",
    buildToolContext: ({ context, hasRepliedRef }) => {
      const threadId = context.MessageThreadId ?? context.ReplyToId;
      return {
        currentChannelId: context.To?.trim() || undefined,
        currentThreadTs: threadId != null ? String(threadId) : undefined,
        hasRepliedRef,
      };
    },
  },
};

export const tgrelayPlugin: ChannelPlugin<ResolvedTgrelayAccount> = {
  id: "tgrelay",
  meta: { ...meta, label: "Telegram Relay", blurb: "Telegram-compatible HTTP webhook relay." },
  pairing: {
    idLabel: "telegramUserId",
    normalizeAllowEntry: (entry) => formatAllowFromEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveTgrelayAccount({ cfg });
      if (!account.outboundUrl) {
        return;
      }
      const chatId = Number(id) || id;
      await sendTgrelayText({
        account,
        chatId,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    reactions: false,
    threads: true,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.tgrelay"] },
  config: {
    listAccountIds: (cfg) => listTgrelayAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveTgrelayAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultTgrelayAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "tgrelay",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "tgrelay",
        accountId,
        clearBaseFields: [
          "webhookPath",
          "inboundSecret",
          "outboundUrl",
          "outboundHeaders",
          "botUsername",
          "name",
        ],
      }),
    isConfigured: (account) => Boolean(account.outboundUrl),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.outboundUrl),
      webhookPath: account.webhookPath,
      outboundUrl: account.outboundUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveTgrelayAccount({ cfg, accountId }).config.dm?.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.["tgrelay"]?.accounts?.[resolvedAccountId]);
      const allowFromPath = useAccountPath
        ? `channels.tgrelay.accounts.${resolvedAccountId}.dm.`
        : "channels.tgrelay.dm.";
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: account.config.dm?.allowFrom ?? [],
        allowFromPath,
        approveHint: formatPairingApproveHint("tgrelay"),
        normalizeEntry: (raw) => formatAllowFromEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy === "open") {
        warnings.push(
          `- Telegram Relay groups: groupPolicy="open" allows any group to trigger (mention-gated). Set channels.tgrelay.groupPolicy="allowlist" and configure channels.tgrelay.groups.`,
        );
      }
      if (account.config.dm?.policy === "open") {
        warnings.push(
          `- Telegram Relay DMs are open to anyone. Set channels.tgrelay.dm.policy="pairing" or "allowlist".`,
        );
      }
      return warnings;
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId }) =>
      resolveTgrelayAccount({ cfg, accountId }).config.requireMention ?? true,
  },
  threading: {
    resolveReplyToMode: ({ cfg }) =>
      (cfg.channels?.["tgrelay"] as { replyToMode?: string } | undefined)?.replyToMode ?? "off",
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw?.trim();
      if (!trimmed) {
        return null;
      }
      return trimmed.replace(/^(tgrelay|telegram-relay|tg-relay):/i, "");
    },
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = normalized ?? raw.trim();
        return /^-?\d+$/.test(value) || /^@\w+$/.test(value);
      },
      hint: "<chat_id|@username>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveTgrelayAccount({ cfg, accountId });
      const q = query?.trim().toLowerCase() || "";
      const allowFrom = account.config.dm?.allowFrom ?? [];
      const peers = Array.from(
        new Set(
          allowFrom
            .map((entry) => String(entry).trim())
            .filter((entry) => Boolean(entry) && entry !== "*"),
        ),
      )
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
      return peers;
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveTgrelayAccount({ cfg, accountId });
      const groups = account.config.groups ?? {};
      const q = query?.trim().toLowerCase() || "";
      const entries = Object.keys(groups)
        .filter((key) => key && key !== "*")
        .filter((key) => (q ? key.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
      return entries;
    },
  },
  resolver: {
    resolveTargets: async ({ inputs, kind }) => {
      const resolved = inputs.map((input) => {
        const normalized = input.trim().replace(/^(tgrelay|telegram-relay|tg-relay):/i, "");
        if (!normalized) {
          return { input, resolved: false, note: "empty target" };
        }
        if (kind === "user" && /^-?\d+$/.test(normalized)) {
          return { input, resolved: true, id: normalized };
        }
        if (kind === "group" && /^-?\d+$/.test(normalized)) {
          return { input, resolved: true, id: normalized };
        }
        if (/^@\w+$/.test(normalized)) {
          return { input, resolved: true, id: normalized };
        }
        return {
          input,
          resolved: false,
          note: "use numeric chat_id or @username",
        };
      });
      return resolved;
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "tgrelay",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.outboundUrl) {
        return "Telegram Relay requires --outbound-url for sending replies.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "tgrelay",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "tgrelay",
            })
          : namedConfig;
      const configPatch = {
        ...(input.webhookPath ? { webhookPath: input.webhookPath } : {}),
        ...(input.outboundUrl ? { outboundUrl: input.outboundUrl } : {}),
        ...(input.inboundSecret ? { inboundSecret: input.inboundSecret } : {}),
        ...(input.botUsername ? { botUsername: input.botUsername } : {}),
      };
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            tgrelay: {
              ...next.channels?.["tgrelay"],
              enabled: true,
              ...configPatch,
            },
          },
        } as OpenClawConfig;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          tgrelay: {
            ...next.channels?.["tgrelay"],
            enabled: true,
            accounts: {
              ...next.channels?.["tgrelay"]?.accounts,
              [accountId]: {
                ...next.channels?.["tgrelay"]?.accounts?.[accountId],
                enabled: true,
                ...configPatch,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getTgrelayRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4096,
    resolveTarget: ({ to, allowFrom, mode }) => {
      const trimmed = to?.trim() ?? "";
      const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
      const allowList = allowListRaw.filter((entry) => entry !== "*");

      if (trimmed) {
        const normalized = trimmed.replace(/^(tgrelay|telegram-relay|tg-relay):/i, "");
        if (!normalized) {
          if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
            return { ok: true, to: allowList[0] };
          }
          return {
            ok: false,
            error: missingTargetError(
              "Telegram Relay",
              "<chat_id|@username> or channels.tgrelay.dm.allowFrom[0]",
            ),
          };
        }
        return { ok: true, to: normalized };
      }

      if (allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }
      return {
        ok: false,
        error: missingTargetError(
          "Telegram Relay",
          "<chat_id|@username> or channels.tgrelay.dm.allowFrom[0]",
        ),
      };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
      const account = resolveTgrelayAccount({ cfg, accountId });
      const chatId = /^-?\d+$/.test(to) ? Number(to) : to;
      const result = await sendTgrelayText({
        account,
        chatId,
        text,
        replyToMessageId: replyToId ? Number(replyToId) : undefined,
        messageThreadId: threadId ? Number(threadId) : undefined,
      });
      return {
        channel: "tgrelay",
        messageId: result.messageId ?? "",
        chatId: result.chatId ?? String(chatId),
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId }) => {
      if (!mediaUrl) {
        throw new Error("Telegram Relay mediaUrl is required.");
      }
      const account = resolveTgrelayAccount({ cfg, accountId });
      const chatId = /^-?\d+$/.test(to) ? Number(to) : to;
      const { sendTgrelayMedia } = await import("./api.js");
      const result = await sendTgrelayMedia({
        account,
        chatId,
        mediaUrl,
        mediaType: "document",
        caption: text,
        replyToMessageId: replyToId ? Number(replyToId) : undefined,
        messageThreadId: threadId ? Number(threadId) : undefined,
      });
      return {
        channel: "tgrelay",
        messageId: result.messageId ?? "",
        chatId: result.chatId ?? String(chatId),
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled || !configured) {
          return [];
        }
        const issues = [];
        if (!entry.outboundUrl) {
          issues.push({
            channel: "tgrelay",
            accountId,
            kind: "config",
            message: "Telegram Relay outboundUrl is missing.",
            fix: "Set channels.tgrelay.outboundUrl to your Telegram bot API endpoint.",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      webhookPath: snapshot.webhookPath ?? null,
      outboundUrl: snapshot.outboundUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => probeTgrelay(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.outboundUrl),
      webhookPath: account.webhookPath,
      outboundUrl: account.outboundUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dm?.policy ?? "pairing",
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Telegram Relay webhook`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        webhookPath: resolveTgrelayWebhookPath({ account }),
      });
      const unregister = await startTgrelayMonitor({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.webhookPath,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
      return () => {
        unregister?.();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };
    },
  },
};
