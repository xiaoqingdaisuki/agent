/**
 * 内置指令：/help
 */

import { registry } from "./registry.js";
import { NormalizedMessage } from "../types.js";

registry.registerHandler("/help", "列出所有可用指令", async (msg: NormalizedMessage) => {
  const commands = registry.list();
  const lines = commands.map((c) => `  ${c.name} - ${c.description}`);
  return `可用指令：\n${lines.join("\n")}`;
});
