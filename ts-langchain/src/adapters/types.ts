/**
 * NormalizedMessage — 平台无关的统一消息格式
 * QQ 适配器将 OneBot 消息转换为此格式
 */

export interface NormalizedMessage {
  platform: "qq";
  messageId: string;
  authorId: string;
  authorName: string;
  channelId: string;       // 群 ID 或用户 ID
  content: string;         // 纯文本内容
  mentions: string[];      // @的用户列表
  timestamp: number;
  replyTo: string | null;  // 回复的消息 ID
  isDirect: boolean;       // 私聊 vs 群聊
  raw: Record<string, any>; // 原始数据
}
