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
