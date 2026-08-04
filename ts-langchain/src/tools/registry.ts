/**
 * Tool Registry — 工具注册、发现和动态裁剪
 *
 * 职责:
 * 1. 注册所有可用工具及其 Descriptor
 * 2. 根据用户权限动态裁剪可见工具集
 * 3. 提供工具元数据查询（/tools API 使用）
 */

import type { ToolDescriptor } from "./contracts.js";
import { weatherTool, weatherDescriptor } from "./weather.js";
import { webSearchTool, webSearchDescriptor } from "./web-search.js";
import { webReadTool, webReadDescriptor } from "./web-read.js";
import { calculatorTool, calculatorDescriptor } from "./calculator.js";
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
import type { DynamicStructuredTool } from "langchain/tools";

// ============ 工具注册表 ============

interface ToolEntry {
  tool: DynamicStructuredTool;
  descriptor: ToolDescriptor;
}

class ToolRegistry {
  private tools = new Map<string, ToolEntry>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.register(weatherTool, weatherDescriptor);
    this.register(webSearchTool, webSearchDescriptor);
    this.register(webReadTool, webReadDescriptor);
    this.register(calculatorTool, calculatorDescriptor);
    this.register(knowledgeSearchTool, knowledgeSearchDescriptor);
    this.register(fileReadTool, fileReadDescriptor);
    this.register(memorySessionSearchTool, sessionMemoryDescriptor);
    this.register(memoryUserSearchTool, userMemorySearchDescriptor);
    this.register(memoryUserSaveTool, userMemorySaveDescriptor);
  }

  register(tool: DynamicStructuredTool, descriptor: ToolDescriptor): void {
    this.tools.set(descriptor.name, { tool, descriptor });
  }

  getDescriptor(name: string): ToolDescriptor | undefined {
    return this.tools.get(name)?.descriptor;
  }

  getDescriptors(): ToolDescriptor[] {
    return Array.from(this.tools.values()).map((e) => e.descriptor);
  }

  getTool(name: string): DynamicStructuredTool | undefined {
    return this.tools.get(name)?.tool;
  }

  getAllTools(): DynamicStructuredTool[] {
    return Array.from(this.tools.values()).map((e) => e.tool);
  }

  getVisibleTools(userPermissions: string[]): DynamicStructuredTool[] {
    const visible: DynamicStructuredTool[] = [];

    for (const entry of this.tools.values()) {
      const d = entry.descriptor;
      // R0 工具始终可见
      if (d.risk_level === "R0") {
        visible.push(entry.tool);
        continue;
      }

      const required = d.required_permissions ?? [];
      if (required.length === 0) {
        visible.push(entry.tool);
        continue;
      }

      // 用户拥有任一所需权限
      if (required.some((p) => userPermissions.includes(p))) {
        visible.push(entry.tool);
      }
    }

    return visible;
  }

  getVisibleDescriptors(
    userPermissions: string[],
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    for (const entry of this.tools.values()) {
      const d = entry.descriptor;
      const required = d.required_permissions ?? [];
      const available =
        d.risk_level === "R0" ||
        required.length === 0 ||
        required.some((p) => userPermissions.includes(p));

      result.push({
        name: d.name,
        title: d.title,
        description: d.description,
        category: d.category,
        risk_level: d.risk_level,
        available,
      });
    }

    return result;
  }

  getCategories(): Record<
    string,
    Array<{ name: string; title: string; risk_level: string }>
  > {
    const categories: Record<
      string,
      Array<{ name: string; title: string; risk_level: string }>
    > = {};

    for (const d of this.getDescriptors()) {
      if (!categories[d.category]) {
        categories[d.category] = [];
      }
      categories[d.category].push({
        name: d.name,
        title: d.title,
        risk_level: d.risk_level,
      });
    }

    return categories;
  }
}

// ============ 全局单例 ============

export const registry = new ToolRegistry();

export function getToolsForUser(
  userPermissions: string[] = ["*"],
): DynamicStructuredTool[] {
  // Default: return all tools (no filtering)
  if (userPermissions.includes("*")) {
    return registry.getAllTools();
  }
  return registry.getVisibleTools(userPermissions);
}

export function getToolMetadata(
  userPermissions: string[] = ["*"],
): Array<Record<string, unknown>> {
  if (userPermissions.includes("*")) {
    return registry.getDescriptors().map((d) => ({
      name: d.name,
      title: d.title,
      description: d.description,
      category: d.category,
      risk_level: d.risk_level,
      available: true,
    }));
  }
  return registry.getVisibleDescriptors(userPermissions);
}
