import { DARK_MODE_PROMPT } from "../prompts/system.js";

export const DARK_MODE_COMMAND = "切换黑暗模式";
export const DARK_MODE_ENABLED_REPLY = "已切换至黑暗模式。";
export const DARK_MODE_DISABLED_REPLY = "已关闭黑暗模式。";

export interface AgentCommandResult {
  name: "toggle_dark_mode";
  reply: string;
}

const darkModeThreads = new Set<string>();

function toggleDarkMode(threadId: string): AgentCommandResult {
  if (darkModeThreads.has(threadId)) {
    darkModeThreads.delete(threadId);
    return { name: "toggle_dark_mode", reply: DARK_MODE_DISABLED_REPLY };
  }

  darkModeThreads.add(threadId);
  return { name: "toggle_dark_mode", reply: DARK_MODE_ENABLED_REPLY };
}

const commandHandlers = new Map<string, (threadId: string) => AgentCommandResult>([
  [DARK_MODE_COMMAND, toggleDarkMode],
]);

export function executeAgentCommand(
  content: string,
  threadId: string,
): AgentCommandResult | undefined {
  return commandHandlers.get(content.trim())?.(threadId);
}

export function getAgentPromptOverride(threadId: string): string | undefined {
  return darkModeThreads.has(threadId) ? DARK_MODE_PROMPT : undefined;
}

export function clearAgentCommandState(threadId: string): void {
  darkModeThreads.delete(threadId);
}
