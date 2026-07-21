/**
 * 内置指令：/clear
 */

import { registry } from "./registry.js";
import { NormalizedMessage } from "../types.js";
import { clearHistory } from "../../memory/conversation.js";

registry.registerHandler("/clear", "清除当前会话记忆", async (msg: NormalizedMessage) => {
  clearHistory(msg.channelId);
  return `已清除会话 ${msg.channelId} 的对话历史`;
});
