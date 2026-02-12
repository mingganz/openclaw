import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { fortivoicePlugin } from "./src/channel.js";
import { setFortivoiceRuntime } from "./src/runtime.js";

const plugin = {
  id: "fortivoice",
  name: "FortiVoice",
  description: "FortiVoice channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setFortivoiceRuntime(api.runtime);
    api.registerChannel({ plugin: fortivoicePlugin });
  },
};

export default plugin;
