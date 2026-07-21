/**
 * 内置指令：/status
 */

import { registry } from "./registry.js";
import { NormalizedMessage } from "../types.js";

registry.registerHandler("/status", "查看机器人状态", async (msg: NormalizedMessage) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  return `运行中 | 在线时间: ${hours}小时${minutes}分钟 | 平台: QQ`;
});
