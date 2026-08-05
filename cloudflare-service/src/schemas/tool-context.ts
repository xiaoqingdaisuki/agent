/**
 * 工具调用上下文 Zod Schemas
 *
 * 替代 contracts/tools/context.schema.json
 * 定义 ToolCallContext 的结构，由服务端注入。
 */

import { z } from "zod";

/** 调用者类型 */
export const ActorTypeSchema = z.enum(["user", "agent", "service"]);

/** 工具调用上下文 */
export const ToolCallContextSchema = z.object({
  request_id: z.string(),
  trace_id: z.string(),
  conversation_id: z.string(),
  tenant_id: z.string(),
  user_id: z.string(),
  actor_type: ActorTypeSchema,
  agent_id: z.string().optional(),
  locale: z.string(),
  deadline: z.string().datetime().optional(),
});

export type ToolCallContext = z.infer<typeof ToolCallContextSchema>;
