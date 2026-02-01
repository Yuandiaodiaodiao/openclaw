import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { TgrelayAccountConfig } from "./types.js";

export type ResolvedTgrelayAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: TgrelayAccountConfig;
  webhookPath: string;
  outboundUrl?: string;
  outboundHeaders?: Record<string, string>;
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.["tgrelay"]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listTgrelayAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultTgrelayAccountId(cfg: OpenClawConfig): string {
  const channel = cfg.channels?.["tgrelay"] as { defaultAccount?: string } | undefined;
  if (channel?.defaultAccount?.trim()) {
    return channel.defaultAccount.trim();
  }
  const ids = listTgrelayAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TgrelayAccountConfig | undefined {
  const accounts = cfg.channels?.["tgrelay"]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as TgrelayAccountConfig | undefined;
}

function mergeTgrelayAccountConfig(cfg: OpenClawConfig, accountId: string): TgrelayAccountConfig {
  const raw = (cfg.channels?.["tgrelay"] ?? {}) as Record<string, unknown>;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as TgrelayAccountConfig;
}

export function resolveTgrelayAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTgrelayAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.["tgrelay"]?.enabled !== false;
  const merged = mergeTgrelayAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const webhookPath =
    merged.webhookPath?.trim() ||
    (accountId === DEFAULT_ACCOUNT_ID ? "/tgrelay" : `/tgrelay/${accountId}`);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    config: merged,
    webhookPath,
    outboundUrl: merged.outboundUrl?.trim() || undefined,
    outboundHeaders: merged.outboundHeaders,
  };
}

export function listEnabledTgrelayAccounts(cfg: OpenClawConfig): ResolvedTgrelayAccount[] {
  return listTgrelayAccountIds(cfg)
    .map((accountId) => resolveTgrelayAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
