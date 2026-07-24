import { weatherTool } from "./weather.js";
import { webSearchTool } from "./web-search.js";
import { webReadTool } from "./web-read.js";
import { calculatorTool } from "./calculator.js";

export { registry, getToolsForUser, getToolMetadata } from "./registry.js";
export { weatherDescriptor } from "./weather.js";
export { webSearchDescriptor } from "./web-search.js";
export { webReadDescriptor } from "./web-read.js";
export { calculatorDescriptor, safeCalculate } from "./calculator.js";

export const tools = [
  weatherTool,
  webSearchTool,
  webReadTool,
  calculatorTool,
];
