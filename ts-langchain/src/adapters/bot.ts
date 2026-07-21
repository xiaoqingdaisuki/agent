/**
 * Bot Service — QQ 机器人核心逻辑
 *
 * 消息流：
 * QQ Adapter → NormalizedMessage → BotService → 指令/Agent → 回复
 */

import { NormalizedMessage } from "./types.js";
import { registry } from "./commands/registry.js";
import { AgentService } from "../services/index.js";

export class BotService {
  private adapter: any;
  private agentService = AgentService;

  constructor(adapter: any) {
    this.adapter = adapter;
  }

  /**
   * 启动机器人
   */
  async start(): Promise<void> {
    await this.adapter.start(async (msg: NormalizedMessage) => {
      await this.handleMessage(msg);
    });
  }

  /**
   * 处理消息
   */
  private async handleMessage(msg: NormalizedMessage): Promise<void> {
    try {
      // 1. 先尝试匹配指令
      const commandResult = await registry.dispatch(msg);

      if (commandResult) {
        // 指令匹配成功，直接回复
        await this.adapter.send(msg.channelId, commandResult, !msg.isDirect);
        return;
      }

      // 2. 非指令消息，交给 Agent 处理
      const reply = await this.agentService.chat(msg.channelId, msg.content);
      await this.adapter.send(msg.channelId, reply.content, !msg.isDirect);
    } catch (error: any) {
      console.error("Bot handle message error:", error);
      const errorMsg = "抱歉，处理您的消息时出现错误，请稍后重试。";
      await this.adapter.send(msg.channelId, errorMsg, !msg.isDirect);
    }
  }

  /**
   * 获取可用指令列表
   */
  getCommands() {
    return registry.list();
  }
}
