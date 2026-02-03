import { createServer } from "node:http";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  logWebhookError,
  logWebhookProcessed,
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { defaultRuntime } from "../runtime.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";

export async function startTelegramWebhook(opts: {
  token: string;
  accountId?: string;
  config?: OpenClawConfig;
  path?: string;
  port?: number;
  host?: string;
  secret?: string;
  runtime?: RuntimeEnv;
  fetch?: typeof fetch;
  abortSignal?: AbortSignal;
  healthPath?: string;
  publicUrl?: string;
  /**
   * Skip calling setWebhook on Telegram API.
   * Used in RPC mode where the relay-server manages the webhook registration,
   * and the container only needs to listen for forwarded updates.
   */
  skipSetWebhook?: boolean;
}) {
  const path = opts.path ?? "/telegram-webhook";
  const healthPath = opts.healthPath ?? "/healthz";
  const port = opts.port ?? 8787;
  const host = opts.host ?? "0.0.0.0";
  const runtime = opts.runtime ?? defaultRuntime;
  const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);
  const bot = createTelegramBot({
    token: opts.token,
    runtime,
    proxyFetch: opts.fetch,
    config: opts.config,
    accountId: opts.accountId,
  });

  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }

  // Initialize the bot (fetch bot info via getMe) before handling updates.
  // This is required for grammY's handleUpdate() to work properly.
  // In RPC mode, getMe is forwarded to the relay-server via rpc-transformer.
  await withTelegramApiErrorLogging({
    operation: "init",
    runtime,
    fn: () => bot.init(),
  });
  runtime.log?.(`bot initialized: @${bot.botInfo.username}`);

  const server = createServer((req, res) => {
    if (req.url === healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    const startTime = Date.now();
    if (diagnosticsEnabled) {
      logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
    }

    // Verify secret token before accepting
    const secretToken = req.headers["x-telegram-bot-api-secret-token"];
    if (opts.secret && secretToken !== opts.secret) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    // Read request body
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      // Immediately return 202 Accepted - processing will happen asynchronously
      // AI responses will be sent back via RPC calls to the relay-server
      res.writeHead(202);
      res.end("Accepted");

      // Process the update asynchronously
      try {
        const update = JSON.parse(body);
        // Use bot.handleUpdate directly for async processing
        void bot
          .handleUpdate(update)
          .then(() => {
            if (diagnosticsEnabled) {
              logWebhookProcessed({
                channel: "telegram",
                updateType: "telegram-post",
                durationMs: Date.now() - startTime,
              });
            }
          })
          .catch((err) => {
            const errMsg = formatErrorMessage(err);
            if (diagnosticsEnabled) {
              logWebhookError({
                channel: "telegram",
                updateType: "telegram-post",
                error: errMsg,
              });
            }
            runtime.log?.(`webhook handler failed: ${errMsg}`);
          });
      } catch (err) {
        const errMsg = formatErrorMessage(err);
        runtime.log?.(`webhook parse error: ${errMsg}`);
        if (diagnosticsEnabled) {
          logWebhookError({
            channel: "telegram",
            updateType: "telegram-post",
            error: errMsg,
          });
        }
      }
    });
  });

  const publicUrl =
    opts.publicUrl ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;

  // In RPC mode, skip setWebhook - the relay-server manages webhook registration
  if (!opts.skipSetWebhook) {
    await withTelegramApiErrorLogging({
      operation: "setWebhook",
      runtime,
      fn: () =>
        bot.api.setWebhook(publicUrl, {
          secret_token: opts.secret,
          allowed_updates: resolveTelegramAllowedUpdates(),
        }),
    });
  } else {
    runtime.log?.("webhook: skipping setWebhook (RPC mode)");
  }

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  runtime.log?.(`webhook listening on ${publicUrl}`);

  const shutdown = () => {
    server.close();
    void bot.stop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
  };
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", shutdown, { once: true });
  }

  return { server, bot, stop: shutdown };
}
