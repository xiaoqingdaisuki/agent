/**
 * tools/index — 工具 barrel 导出
 *
 * 职责：
 * 1. 聚合所有工具实例、Descriptor 和 Zod schema
 * 2. 对外统一导出 `tools` 数组（供 Agent 使用）
 * 3. 对外统一导出 `toolDescriptors` / `toolSchemas` 映射（供 Runtime 管线使用）
 */

import { weatherTool, weatherDescriptor } from "./weather.js";
import { webSearchTool, webSearchDescriptor } from "./web-search.js";
import { webReadTool, webReadDescriptor } from "./web-read.js";
import {
  calculatorTool,
  calculatorDescriptor,
  safeCalculate,
} from "./calculator.js";
import { knowledgeSearchTool, knowledgeSearchDescriptor } from "./knowledge.js";
import {
  memorySessionSearchTool,
  sessionMemoryDescriptor,
} from "./memory-session.js";
import {
  memoryUserSearchTool,
  memoryUserSaveTool,
  memoryUserListTool,
  memoryUserDeleteTool,
  userMemorySearchDescriptor,
  userMemorySaveDescriptor,
  userMemoryListDescriptor,
  userMemoryDeleteDescriptor,
} from "./memory-user.js";
import { config } from "../config/index.js";
import {
  currentTimeTool,
  currentTimeDescriptor,
  convertTimezoneTool,
  convertTimezoneDescriptor,
} from "./time.js";
import { fileSearchTool, fileSearchDescriptor } from "./file-search.js";
import { webExtractTool, webExtractDescriptor } from "./web-extract.js";

export { registry, getToolsForUser, getToolMetadata } from "./registry.js";

export {
  weatherTool,
  weatherDescriptor,
  webSearchTool,
  webSearchDescriptor,
  webReadTool,
  webReadDescriptor,
  calculatorTool,
  calculatorDescriptor,
  safeCalculate,
  knowledgeSearchTool,
  knowledgeSearchDescriptor,
  memorySessionSearchTool,
  sessionMemoryDescriptor,
  memoryUserSearchTool,
  memoryUserSaveTool,
  memoryUserListTool,
  memoryUserDeleteTool,
  userMemorySearchDescriptor,
  userMemorySaveDescriptor,
  userMemoryListDescriptor,
  userMemoryDeleteDescriptor,
  currentTimeTool,
  currentTimeDescriptor,
  convertTimezoneTool,
  convertTimezoneDescriptor,
  fileSearchTool,
  fileSearchDescriptor,
  webExtractTool,
  webExtractDescriptor,
};

// 所有可用工具的聚合列表，供 Agent 使用
const directTools = [
  weatherTool,
  webSearchTool,
  webReadTool,
  webExtractTool,
  fileSearchTool,
  calculatorTool,
  currentTimeTool,
  convertTimezoneTool,
];

// 关闭记忆模式时不向 Agent 暴露任何依赖 Cloudflare Gateway 的记忆和文档工具。
export const tools = config.MEMORY_ENABLED ? [
  ...directTools,
  knowledgeSearchTool,
  memorySessionSearchTool,
  memoryUserSearchTool,
  memoryUserListTool,
] : directTools;

/**
 * 工具名称 → ToolDescriptor 映射，用于 invokeTool 管线的权限/审计检查。
 */
export const toolDescriptors: Record<
  string,
  import("./contracts.js").ToolDescriptor
> = {
  [weatherTool.name]: weatherDescriptor,
  [webSearchTool.name]: webSearchDescriptor,
  [webReadTool.name]: webReadDescriptor,
  [webExtractTool.name]: webExtractDescriptor,
  [calculatorTool.name]: calculatorDescriptor,
  [currentTimeTool.name]: currentTimeDescriptor,
  [convertTimezoneTool.name]: convertTimezoneDescriptor,
  [knowledgeSearchTool.name]: knowledgeSearchDescriptor,
  [fileSearchTool.name]: fileSearchDescriptor,
  [memorySessionSearchTool.name]: sessionMemoryDescriptor,
  [memoryUserSearchTool.name]: userMemorySearchDescriptor,
  [memoryUserSaveTool.name]: userMemorySaveDescriptor,
  [memoryUserListTool.name]: userMemoryListDescriptor,
  [memoryUserDeleteTool.name]: userMemoryDeleteDescriptor,
};

/**
 * 工具名称 → Zod schema 映射，用于 invokeTool 管线的参数校验。
 */
export const toolSchemas: Record<
  string,
  { parse: (input: unknown) => unknown }
> = {
  [weatherTool.name]: weatherTool.schema as any,
  [webSearchTool.name]: webSearchTool.schema as any,
  [webReadTool.name]: webReadTool.schema as any,
  [webExtractTool.name]: webExtractTool.schema as any,
  [calculatorTool.name]: calculatorTool.schema as any,
  [currentTimeTool.name]: currentTimeTool.schema as any,
  [convertTimezoneTool.name]: convertTimezoneTool.schema as any,
  [knowledgeSearchTool.name]: knowledgeSearchTool.schema as any,
  [fileSearchTool.name]: fileSearchTool.schema as any,
  [memorySessionSearchTool.name]: memorySessionSearchTool.schema as any,
  [memoryUserSearchTool.name]: memoryUserSearchTool.schema as any,
  [memoryUserSaveTool.name]: memoryUserSaveTool.schema as any,
  [memoryUserListTool.name]: memoryUserListTool.schema as any,
  [memoryUserDeleteTool.name]: memoryUserDeleteTool.schema as any,
};
