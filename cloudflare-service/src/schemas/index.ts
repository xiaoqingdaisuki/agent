/**
 * Schemas — Gateway API 契约的单一事实来源
 *
 * 本目录替代 contracts/ 目录，提供：
 * - memory-models.ts:   Memory API 数据模型（替代 models.schema.json）
 * - error-codes.ts:     Gateway 错误码常量（替代 error-codes.json）
 * - tool-manifest.ts:   工具描述符 schema（替代 manifest.schema.json）
 * - tool-result.ts:     工具返回信封 schema（替代 error.schema.json）
 * - tool-context.ts:    工具调用上下文 schema（替代 context.schema.json）
 *
 * 所有路由 handlers 使用这些 schemas 做运行时校验，
 * OpenAPI spec 从这些 schemas 自动生成。
 */

export * from "./error-codes.js";
export * from "./memory-models.js";
export * from "./tool-result.js";
export * from "./tool-context.js";
export * from "./tool-manifest.js";
