// @ts-nocheck
import { buildTelegramMessageContext } from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";

export const createTelegramMessageProcessor = (deps) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    resolveBotTopicsEnabled,
  } = deps;

  // Resolve bypassAuth from telegramCfg (for external integration)
  const bypassAuth = telegramCfg?.bypassAuth === true;

  return async (primaryCtx, allMedia, storeAllowFrom, options) => {
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
      bypassAuth,
    });
    if (!context) {
      return;
    }
    await dispatchTelegramMessage({
      context,
      bot,
      cfg,
      runtime,
      replyToMode,
      streamMode,
      textLimit,
      telegramCfg,
      opts,
      resolveBotTopicsEnabled,
    });
  };
};
