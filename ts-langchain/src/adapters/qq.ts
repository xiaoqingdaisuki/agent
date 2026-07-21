/**
 * QQ 适配器 — OneBot v11 HTTP
 *
 * 协议层：LLOneBot（提供 OneBot v11 HTTP API）
 * 通信：HTTP 轮询 /get_message
 * 发送：POST /send_msg
 */

import { NormalizedMessage } from "./types.js";
import { registry } from "./commands/registry.js";

export interface QQAdapterConfig {
  baseUrl: string;        // LLOneBot HTTP API 地址，如 http://localhost:8080
  pollInterval: number;   // 轮询间隔（ms），默认 1000
}

export class QQAdapter {
  private baseUrl: string;
  private pollInterval: number;
  private running: boolean = false;
  private lastMessageId: string = "";

  constructor(config: QQAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.pollInterval = config.pollInterval || 1000;
  }

  /**
   * 启动监听
   */
  async start(onMessage: (msg: NormalizedMessage) => Promise<void>): Promise<void> {
    this.running = true;
    console.log(`QQ Adapter started, polling ${this.baseUrl}/get_message`);

    while (this.running) {
      try {
        await this.pollMessages(onMessage);
      } catch (error) {
        console.error("QQ poll error:", error);
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
    }
  }

  /**
   * 停止监听
   */
  stop(): void {
    this.running = false;
  }

  /**
   * 轮询消息
   */
  private async pollMessages(onMessage: (msg: NormalizedMessage) => Promise<void>): Promise<void> {
    const response = await fetch(`${this.baseUrl}/get_message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        group_id: null,
        user_id: null,
        message_id: this.lastMessageId || undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`OneBot API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.retcode !== 0 || !data.data) {
      return;
    }

    for (const rawMsg of data.data) {
      // 跳过已处理的消息
      if (rawMsg.message_id && rawMsg.message_id <= this.lastMessageId) {
        continue;
      }

      this.lastMessageId = rawMsg.message_id;

      // 转换为统一格式
      const normalized = this.normalize(rawMsg);
      if (normalized) {
        await onMessage(normalized);
      }
    }
  }

  /**
   * OneBot 消息 → NormalizedMessage
   */
  private normalize(raw: any): NormalizedMessage | null {
    const messageType = raw.message_type;
    const content = this.extractText(raw);
    const isDirect = messageType === "private";

    return {
      platform: "qq",
      messageId: raw.message_id || "",
      authorId: String(raw.user_id || ""),
      authorName: raw.sender?.nickname || `User_${raw.user_id}`,
      channelId: String(messageType === "group" ? raw.group_id : raw.user_id),
      content,
      mentions: this.extractMentions(raw),
      timestamp: raw.time || Date.now() / 1000,
      replyTo: raw.reply?.message_id || null,
      isDirect,
      raw,
    };
  }

  /**
   * 提取纯文本内容
   */
  private extractText(raw: any): string {
    if (typeof raw.raw_message === "string") {
      return raw.raw_message;
    }

    if (Array.isArray(raw.message)) {
      return raw.message
        .filter((seg: any) => seg.type === "text")
        .map((seg: any) => seg.data?.text || "")
        .join("");
    }

    return "";
  }

  /**
   * 提取 @ 列表
   */
  private extractMentions(raw: any): string[] {
    const mentions: string[] = [];

    if (Array.isArray(raw.message)) {
      for (const seg of raw.message) {
        if (seg.type === "at") {
          mentions.push(String(seg.data?.qq || ""));
        }
      }
    }

    return mentions;
  }

  /**
   * 发送消息
   */
  async send(channelId: string, content: string, isGroup: boolean = true): Promise<void> {
    const endpoint = isGroup ? "send_group_msg" : "send_private_msg";
    const idField = isGroup ? "group_id" : "user_id";

    const response = await fetch(`${this.baseUrl}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        [idField]: channelId,
        message: content,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.statusText}`);
    }
  }
}
