import { weatherTool, weatherDescriptor } from "./weather.js";
import { webSearchTool, webSearchDescriptor } from "./web-search.js";
import { webReadTool, webReadDescriptor } from "./web-read.js";
import { calculatorTool, calculatorDescriptor, safeCalculate } from "./calculator.js";
import { knowledgeSearchTool, knowledgeSearchDescriptor } from "./knowledge.js";
import { fileReadTool, fileReadDescriptor } from "./file-read.js";
import { memorySessionSearchTool, sessionMemoryDescriptor } from "./memory-session.js";
import { memoryUserSearchTool, memoryUserSaveTool, userMemorySearchDescriptor, userMemorySaveDescriptor } from "./memory-user.js";

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

export const tools = [
  weatherTool,
  webSearchTool,
  webReadTool,
  fileReadTool,
  calculatorTool,
  knowledgeSearchTool,
  memorySessionSearchTool,
  memoryUserSearchTool,
  memoryUserSaveTool,
];

/**
 * 工具名称 → ToolDescriptor 映射，用于 invokeTool 管线的权限/审计检查。
 */
export const toolDescriptors: Record<string, import("./contracts.js").ToolDescriptor> = {
  [weatherDescriptor.name]: weatherDescriptor,
  [webSearchDescriptor.name]: webSearchDescriptor,
  [webReadDescriptor.name]: webReadDescriptor,
  [calculatorDescriptor.name]: calculatorDescriptor,
  [knowledgeSearchDescriptor.name]: knowledgeSearchDescriptor,
  [fileReadDescriptor.name]: fileReadDescriptor,
  [sessionMemoryDescriptor.name]: sessionMemoryDescriptor,
  [userMemorySearchDescriptor.name]: userMemorySearchDescriptor,
  [userMemorySaveDescriptor.name]: userMemorySaveDescriptor,
};

/**
 * 工具名称 → Zod schema 映射，用于 invokeTool 管线的参数校验。
 */
export const toolSchemas: Record<string, { parse: (input: unknown) => unknown }> = {
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
