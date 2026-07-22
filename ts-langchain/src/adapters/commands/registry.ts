/**
 * 指令注册中心
 * 装饰器模式注册指令
 */

import { NormalizedMessage } from "../types.js";

export type CommandHandler = (msg: NormalizedMessage, args: string[]) => Promise<string>;

interface CommandEntry {
  name: string;
  description: string;
  handler: CommandHandler;
}

class CommandRegistryClass {
  private commands: Map<string, CommandEntry> = new Map();

  register(name: string, description: string) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
      const originalMethod = descriptor.value;
      descriptor.value = async function (...args: any[]) {
        return originalMethod.apply(target, args);
      };
      registry.registerHandler(name, description, descriptor.value);
      return descriptor;
    };
  }

  registerHandler(name: string, description: string, handler: CommandHandler) {
    this.commands.set(name, { name, description, handler });
  }

  async dispatch(msg: NormalizedMessage): Promise<string | null> {
    const parts = msg.content.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    const entry = this.commands.get(command);
    if (entry) {
      return entry.handler(msg, args);
    }

    return null; // 不是指令，交给 Agent 处理
  }

  list(): Array<{ name: string; description: string }> {
    return Array.from(this.commands.values()).map((c) => ({
      name: c.name,
      description: c.description,
    }));
  }
}

export const registry = new CommandRegistryClass();
