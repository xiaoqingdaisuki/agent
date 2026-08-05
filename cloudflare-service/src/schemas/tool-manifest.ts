/**
 * 工具描述符 Zod Schemas
 *
 * 替代 contracts/tools/manifest.schema.json
 * 定义 ToolDescriptor 的结构，供工具注册和运行时使用。
 */

import { z } from "zod";

/** 工具类别枚举值 */
export const ToolCategoryValues = ["READ", "SEARCH", "ACTION", "COMPUTE", "MEMORY", "CONTROL", "GUARD"] as const;

/** 工具类别 schema */
export const ToolCategorySchema = z.enum(ToolCategoryValues);

/** 风险等级枚举值 */
export const RiskLevelValues = ["R0", "R1", "R2", "R3"] as const;

/** 风险等级 schema */
export const RiskLevelSchema = z.enum(RiskLevelValues);

/** 副作用类型枚举值 */
export const SideEffectValues = ["none", "read", "write", "external"] as const;

/** 副作用类型 schema */
export const SideEffectSchema = z.enum(SideEffectValues);

/** 工具描述符 schema */
export const ToolDescriptorSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  title: z.string().max(100),
  description: z.string().max(500),
  category: ToolCategorySchema,
  risk_level: RiskLevelSchema,
  side_effect: SideEffectSchema,
  idempotent: z.boolean(),
  timeout_ms: z.coerce.number().int().min(100).max(300_000),
  required_permissions: z.array(z.string()),
  approval_policy: z.enum(["never", "conditional", "always"]),
  input_schema: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  data_classification: z.array(z.enum(["public", "internal", "confidential", "pii"])),
  owner: z.string().optional(),
  tags: z.array(z.string()),
});

export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;
export type ToolCategory = z.infer<typeof ToolCategorySchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type SideEffect = z.infer<typeof SideEffectSchema>;
