import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { tgrelayDock, tgrelayPlugin } from "./src/channel.js";
import { handleTgrelayWebhookRequest } from "./src/monitor.js";
import { setTgrelayRuntime } from "./src/runtime.js";

const plugin = {
  id: "tgrelay",
  name: "Telegram Relay",
  description: "OpenClaw Telegram Relay channel plugin - HTTP webhook bridge for Telegram",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTgrelayRuntime(api.runtime);
    api.registerChannel({ plugin: tgrelayPlugin, dock: tgrelayDock });
    api.registerHttpHandler(handleTgrelayWebhookRequest);
  },
};

export default plugin;
