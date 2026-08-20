import { DARK_MODE_PROMPT } from "../prompts/system.js";

export const DARK_MODE_COMMAND = "切换大公鸡模式";
export const DARK_MODE_ENABLED_REPLY = "已切换至大公鸡模式。";
export const DARK_MODE_DISABLED_REPLY = "已关闭大公鸡模式。";
const DARK_MODE_HISTORY_SUFFIX = "__dark_mode";

export interface AgentCommandResult {
  name: "toggle_dark_mode";
  reply: string;
}

const darkModeThreads = new Set<string>();

const TRANSCRIPT_MESSAGE_PATTERN =
  /(?:^|\n\n)(user|assistant|system): ([\s\S]*?)(?=\n\n(?:user|assistant|system): |$)/g;

// 从内容中提取所有用户消息（解析 transcript 格式）
function getTranscriptUserMessages(content: string): string[] {
  const messages: string[] = [];
  for (const match of content.matchAll(TRANSCRIPT_MESSAGE_PATTERN)) {
    if (match[1] === "user") messages.push(match[2].trim());
  }
  return messages;
}

// 设置指定线程的大公鸡模式开关状态
function setDarkMode(threadId: string, enabled: boolean): void {
  if (enabled) darkModeThreads.add(threadId);
  else darkModeThreads.delete(threadId);
}

// 根据已持久化的用户消息恢复指定线程的大公鸡模式状态
export function restoreAgentCommandState(
  threadId: string,
  userMessages: readonly string[],
): void {
  const darkModeCommandCount = userMessages.filter(
    (message) => message.trim() === DARK_MODE_COMMAND,
  ).length;
  setDarkMode(threadId, darkModeCommandCount % 2 === 1);
}

// 获取指定线程对应的大公鸡独立 Agent 历史标识
export function getDarkModeHistoryThreadId(threadId: string): string {
  return `${threadId}${DARK_MODE_HISTORY_SUFFIX}`;
}

// 判断历史标识是否对应大公鸡独立 Agent 会话
export function isDarkModeHistoryThreadId(threadId: string): boolean {
  return threadId.endsWith(DARK_MODE_HISTORY_SUFFIX);
}

// 从独立 Agent 历史标识还原 UI 会话标识
export function getConversationThreadIdFromHistoryThreadId(threadId: string): string {
  return isDarkModeHistoryThreadId(threadId)
    ? threadId.slice(0, -DARK_MODE_HISTORY_SUFFIX.length)
    : threadId;
}

// 切换指定线程的大公鸡模式，返回切换后的状态结果
function toggleDarkMode(threadId: string): AgentCommandResult {
  if (darkModeThreads.has(threadId)) {
    darkModeThreads.delete(threadId);
    return { name: "toggle_dark_mode", reply: DARK_MODE_DISABLED_REPLY };
  }

  darkModeThreads.add(threadId);
  return { name: "toggle_dark_mode", reply: DARK_MODE_ENABLED_REPLY };
}

const commandHandlers = new Map<
  string,
  (threadId: string) => AgentCommandResult
>([[DARK_MODE_COMMAND, toggleDarkMode]]);

// 执行 executeAgentCommand 对应的业务逻辑
export function executeAgentCommand(
  content: string,
  threadId: string,
): AgentCommandResult | undefined {
  const transcriptMessages = getTranscriptUserMessages(content);
  const commandContent = transcriptMessages.at(-1) ?? content.trim();
  const handler = commandHandlers.get(commandContent);
  if (!handler) return undefined;

  if (transcriptMessages.length === 0) return handler(threadId);

  const darkModeCommandCount = transcriptMessages.filter(
    (message) => message === DARK_MODE_COMMAND,
  ).length;
  const enabled = darkModeCommandCount % 2 === 1;
  setDarkMode(threadId, enabled);
  return {
    name: "toggle_dark_mode",
    reply: enabled ? DARK_MODE_ENABLED_REPLY : DARK_MODE_DISABLED_REPLY,
  };
}

// 获取 getAgentPromptOverride 对应的数据
export function getAgentPromptOverride(
  threadId: string,
  content?: string,
): string | undefined {
  if (content) {
    const transcriptMessages = getTranscriptUserMessages(content);
    const darkModeCommandCount = transcriptMessages.filter(
      (message) => message === DARK_MODE_COMMAND,
    ).length;
    if (darkModeCommandCount > 0) {
      return darkModeCommandCount % 2 === 1 ? DARK_MODE_PROMPT : undefined;
    }
  }

  return darkModeThreads.has(threadId) ? DARK_MODE_PROMPT : undefined;
}

// 删除或清理 clearAgentCommandState 对应的数据
export function clearAgentCommandState(threadId: string): void {
  darkModeThreads.delete(threadId);
}
