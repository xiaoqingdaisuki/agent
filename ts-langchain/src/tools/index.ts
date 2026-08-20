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
import { fileReadTool, fileReadDescriptor } from "./file-read.js";
import {
  memorySessionSearchTool,
  sessionMemoryDescriptor,
} from "./memory-session.js";
import {
  memoryUserSearchTool,
  memoryUserSaveTool,
  userMemorySearchDescriptor,
  userMemorySaveDescriptor,
} from "./memory-user.js";
import { config } from "../config/index.js";

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
  fileReadTool,
  fileReadDescriptor,
  memorySessionSearchTool,
  sessionMemoryDescriptor,
  memoryUserSearchTool,
  memoryUserSaveTool,
  userMemorySearchDescriptor,
  userMemorySaveDescriptor,
};

// 所有可用工具的聚合列表，供 Agent 使用
const directTools = [
  weatherTool,
  webSearchTool,
  webReadTool,
  fileReadTool,
  calculatorTool,
];

// 关闭记忆模式时仅排除依赖 Cloudflare 向量库的知识库工具。
export const tools = config.MEMORY_ENABLED ? [
  ...directTools,
  knowledgeSearchTool,
  memorySessionSearchTool,
  memoryUserSearchTool,
  memoryUserSaveTool,
] : [
  ...directTools,
  memorySessionSearchTool,
  memoryUserSearchTool,
  memoryUserSaveTool,
];

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
  [calculatorTool.name]: calculatorDescriptor,
  [knowledgeSearchTool.name]: knowledgeSearchDescriptor,
  [fileReadTool.name]: fileReadDescriptor,
  [memorySessionSearchTool.name]: sessionMemoryDescriptor,
  [memoryUserSearchTool.name]: userMemorySearchDescriptor,
  [memoryUserSaveTool.name]: userMemorySaveDescriptor,
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
  [calculatorTool.name]: calculatorTool.schema as any,
  [knowledgeSearchTool.name]: knowledgeSearchTool.schema as any,
  [fileReadTool.name]: fileReadTool.schema as any,
  [memorySessionSearchTool.name]: memorySessionSearchTool.schema as any,
  [memoryUserSearchTool.name]: memoryUserSearchTool.schema as any,
  [memoryUserSaveTool.name]: memoryUserSaveTool.schema as any,
};
