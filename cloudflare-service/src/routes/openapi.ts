/**
 * OpenAPI 规范路由
 *
 * GET /internal/v1/openapi.json
 * 自动生成 Gateway 的 OpenAPI 3.0.3 规范
 * 替代 contracts/memory/gateway.openapi.yaml
 *
 * 该规范是 Gateway API 的单一事实来源，
 * SDK 可在构建时拉取此端点进行契约校验。
 */

import { z } from "zod";
import {
  MemorySchema, ConversationSchema, MemorySaveRequestSchema,
  MemorySearchRequestSchema, MemorySearchResultSchema,
  MemoryCategorySchema, ConversationModeSchema, MessageRoleSchema,
  ProfileSaveSchema, ConversationCreateSchema, MessageBatchSchema,
  GatewayResponseSchema,
} from "../schemas/memory-models.js";
import {
  DocumentSchema,
  ChunkSchema,
  DocumentUploadRequestSchema,
  DocumentSearchRequestSchema,
  DocumentSearchResultSchema,
} from "../schemas/document-models.js";

// ============ Schema 引用辅助函数 ==========

/**
 * 将 Zod schema 转换为 OpenAPI Schema Object
 * 基于 Zod 4 API
 */
/**
 * 将 Zod Schema 实例属性提取为 OpenAPI 约束条件（Zod 4 兼容）
 */
// 获取 getStringConstraints 对应的数据
function getStringConstraints(schema: any): Record<string, unknown> {
  const constraints: Record<string, unknown> = {};
  if (schema.minLength != null) constraints.minLength = schema.minLength;
  if (schema.maxLength != null) constraints.maxLength = schema.maxLength;
  return constraints;
}

/**
 * 将 Zod Schema 实例的数字约束提取为 OpenAPI 约束条件（Zod 4 兼容）
 */
// 获取 getNumberConstraints 对应的数据
function getNumberConstraints(schema: any): Record<string, unknown> {
  const constraints: Record<string, unknown> = {};
  if (schema.isInt) constraints.type = "integer";
  if (schema.minValue != null) constraints.minimum = schema.minValue;
  if (schema.maxValue != null) constraints.maximum = schema.maxValue;
  return constraints;
}

/**
 * 获取 Zod schema 内部类型标识（Zod 4: _def.type / Zod 3: _def.typeName）
 */
// 获取 getSchemaType 对应的数据
function getSchemaType(schema: any): string {
  return schema._def?.type || "";
}

/**
 * 将 Zod Schema 转换为 OpenAPI Schema Object
 * 适配 Zod 4 内部 API（_def.type 替代 _def.typeName，实例属性替代 checks[].kind）
 */
// 执行 zodToOpenApi 对应的业务逻辑
function zodToOpenApi(schema: z.ZodTypeAny): Record<string, unknown> {
  const anySchema = schema as any;
  const type = getSchemaType(anySchema);

  // String
  if (type === "string") {
    const result: Record<string, unknown> = { type: "string" };
    Object.assign(result, getStringConstraints(anySchema));
    // Regex pattern (best-effort, Zod 4 存储在 _def.checks 中)
    const checks = anySchema._def?.checks || [];
    for (const check of checks) {
      const checkDef = check._def || check;
      if ((checkDef as any)?.check === "regex" && (checkDef as any)?.regex) {
        result.pattern = (checkDef as any).regex.source;
      }
    }
    return result;
  }

  // Number
  if (type === "number") {
    const result: Record<string, unknown> = { type: "number" };
    Object.assign(result, getNumberConstraints(anySchema));
    return result;
  }

  // Boolean
  if (type === "boolean") {
    return { type: "boolean" };
  }

  // Array
  if (type === "array") {
    return {
      type: "array",
      items: zodToOpenApi((anySchema._def?.element as z.ZodTypeAny) || z.unknown() as any),
    };
  }

  // Optional
  if (type === "optional") {
    return zodToOpenApi((anySchema._def?.innerType as z.ZodTypeAny) || z.unknown() as any);
  }

  // Default
  if (type === "default") {
    return zodToOpenApi((anySchema._def?.innerType as z.ZodTypeAny) || z.unknown() as any);
  }

  // Nullable
  if (type === "nullable") {
    return zodToOpenApi((anySchema._def?.innerType as z.ZodTypeAny) || z.unknown() as any);
  }

  // Enum
  if (type === "enum") {
    return { type: "string", enum: Object.values(anySchema._def?.entries || {}) };
  }

  // Object
  if (type === "object") {
    const shape = anySchema._def?.shape || {};
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToOpenApi(value as z.ZodTypeAny);
      const valAny = value as any;
      const valType = getSchemaType(valAny);
      const isOptional = valType === "optional" || valType === "default";
      if (!isOptional) {
        required.push(key);
      }
    }
    return { type: "object", properties, required };
  }

  // Record
  if (type === "record") {
    return { type: "object", additionalProperties: {} };
  }

  // Union
  if (type === "union") {
    const options = (anySchema._def?.options || []).map((o: any) => zodToOpenApi(o));
    return options.length === 1 ? options[0] : { oneOf: options };
  }

  return {};
}

// ============ OpenAPI 规范定义 ==========

// 获取 getOpenApiSpec 对应的数据
function getOpenApiSpec(): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    openapi: "3.0.3",
    info: {
      title: "Cloudflare Service API",
      description: "Agent 长期存储统一服务内部 API。所有路径前缀 /internal/v1。响应格式: { ok, data, error, meta }。",
      version: "1.0.0",
      contact: { name: "Agent Memory Team" },
    },
    servers: [
      { url: "http://localhost:6100", description: "本地开发" },
    ],
    security: [{ BearerAuth: [] }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Service Secret",
        },
      },
      schemas: {
        UserProfile: zodToOpenApi(
          z.object({
            user_id: z.string(),
            name: z.string(),
            preferences_json: z.string(),
            created_at: z.string(),
            updated_at: z.string(),
          }),
        ),
        Conversation: zodToOpenApi(ConversationSchema),
        Message: zodToOpenApi(
          z.object({
            id: z.string(),
            conversation_id: z.string(),
            user_id: z.string(),
            sequence_no: z.coerce.number().int().nonnegative(),
            role: MessageRoleSchema,
            content_json: z.string(),
            created_at: z.string(),
          }),
        ),
        Memory: zodToOpenApi(MemorySchema),
        MemorySaveRequest: zodToOpenApi(MemorySaveRequestSchema),
        MemorySearchRequest: zodToOpenApi(MemorySearchRequestSchema),
        MemorySearchResult: zodToOpenApi(MemorySearchResultSchema),
        MemoryCategory: zodToOpenApi(MemoryCategorySchema),
        ConversationMode: zodToOpenApi(ConversationModeSchema),
        MessageRole: zodToOpenApi(MessageRoleSchema),
        Document: zodToOpenApi(DocumentSchema),
        Chunk: zodToOpenApi(ChunkSchema),
        DocumentUploadRequest: zodToOpenApi(DocumentUploadRequestSchema),
        DocumentSearchRequest: zodToOpenApi(DocumentSearchRequestSchema),
        DocumentSearchResult: zodToOpenApi(DocumentSearchResultSchema),
        GatewayResponse: zodToOpenApi(GatewayResponseSchema),
      },
      responses: {
        NotFound: {
          description: "资源不存在",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GatewayResponse" },
              example: {
                ok: false,
                data: null,
                error: { code: "MEMORY_USER_NOT_FOUND", message: "用户不存在" },
                meta: { request_id: "req_xxx" },
              },
            },
          },
        },
        Unauthenticated: {
          description: "未认证",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GatewayResponse" },
              example: {
                ok: false,
                data: null,
                error: { code: "MEMORY_UNAUTHENTICATED", message: "缺少或无效的认证凭证" },
                meta: { request_id: "req_xxx" },
              },
            },
          },
        },
        Forbidden: {
          description: "越权访问",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GatewayResponse" },
              example: {
                ok: false,
                data: null,
                error: { code: "MEMORY_FORBIDDEN", message: "无权访问该资源" },
                meta: { request_id: "req_xxx" },
              },
            },
          },
        },
      },
    },
    paths: {
      "/internal/v1/health": {
        get: {
          tags: ["Health"],
          summary: "健康检查",
          security: [],
          responses: {
            "200": {
              description: "服务正常",
              content: {
                "application/json": {
                  schema: { type: "object" },
                  example: {
                    status: "ok",
                    components: { d1: "ok", vectorize: "ok", ai: "ok", gateway: "ok" },
                    timestamp: new Date().toISOString(),
                  },
                },
              },
            },
          },
        },
      },
      "/internal/v1/users/{user_id}/profile": {
        put: {
          tags: ["Profile"],
          summary: "创建或更新用户画像",
          parameters: [
            { name: "user_id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: zodToOpenApi(ProfileSaveSchema),
              },
            },
          },
          responses: {
            "200": {
              description: "画像已保存",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GatewayResponse" },
                  example: {
                    ok: true,
                    data: { user_id: "usr_001", name: "Alice", preferences_json: "{}", created_at: "2026-08-05T08:00:00.000Z", updated_at: "2026-08-05T08:00:00.000Z" },
                    error: null,
                    meta: { request_id: "req_xxx" },
                  },
                },
              },
            },
            "400": { $ref: "#/components/responses/NotFound" },
          },
        },
        get: {
          tags: ["Profile"],
          summary: "获取用户画像",
          parameters: [
            { name: "user_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "画像信息",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GatewayResponse" },
                },
              },
            },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/internal/v1/conversations": {
        post: {
          tags: ["Conversation"],
          summary: "创建会话",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: zodToOpenApi(ConversationCreateSchema),
              },
            },
          },
          responses: {
            "201": {
              description: "会话已创建",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GatewayResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/internal/v1/users/{user_id}/conversations": {
        get: {
          tags: ["Conversation"],
          summary: "列出用户的所有会话",
          parameters: [
            { name: "user_id", in: "path", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: {
            "200": {
              description: "会话列表",
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      { $ref: "#/components/schemas/GatewayResponse" },
                      { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Conversation" } } } },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      "/internal/v1/conversations/{conversation_id}": {
        get: {
          tags: ["Conversation"],
          summary: "获取会话详情",
          parameters: [
            { name: "conversation_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "会话详情",
              content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } },
            },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
        delete: {
          tags: ["Conversation"],
          summary: "删除会话（软删除）",
          parameters: [
            { name: "conversation_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "会话已标记删除",
              content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } },
            },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/internal/v1/conversations/{conversation_id}/turns": {
        post: {
          tags: ["Turn"],
          summary: "创建或复用幂等 Turn",
          parameters: [
            { name: "conversation_id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["user_id", "client_message_id"],
                  properties: {
                    id: { type: "string", maxLength: 128 },
                    user_id: { type: "string", maxLength: 128 },
                    client_message_id: { type: "string", maxLength: 128 },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "已存在的 Turn", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } },
            "201": { description: "Turn 已创建", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } },
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { description: "会话中已有活动 Turn", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } },
          },
        },
      },
      "/internal/v1/turns/{turn_id}": {
        get: {
          tags: ["Turn"],
          summary: "读取 Turn 状态",
          parameters: [
            { name: "turn_id", in: "path", required: true, schema: { type: "string" } },
            { name: "user_id", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "Turn 状态", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
        patch: {
          tags: ["Turn"],
          summary: "更新 Turn 状态",
          parameters: [
            { name: "turn_id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["user_id", "status"],
                  properties: {
                    user_id: { type: "string", maxLength: 128 },
                    status: { type: "string", enum: ["pending", "streaming", "completed", "failed", "cancelled"] },
                    user_message_id: { type: "string", maxLength: 128 },
                    assistant_message_id: { type: "string", maxLength: 128 },
                    assistant_content_json: { type: "string", maxLength: 1000000 },
                    error_code: { type: "string", maxLength: 128 },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Turn 已更新", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } },
            "404": { $ref: "#/components/responses/NotFound" },
            "409": { description: "非法状态迁移", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } },
          },
        },
      },
      "/internal/v1/conversations/{conversation_id}/messages:batch": {
        post: {
          tags: ["Message"],
          summary: "批量写入消息（完整 turn）",
          parameters: [
            { name: "conversation_id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: zodToOpenApi(MessageBatchSchema),
              },
            },
          },
          responses: {
            "200": {
              description: "消息已写入",
              content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } },
            },
            "400": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/internal/v1/conversations/{conversation_id}/messages": {
        get: {
          tags: ["Message"],
          summary: "获取会话消息列表",
          parameters: [
            { name: "conversation_id", in: "path", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "direction", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "asc" } },
          ],
          responses: {
            "200": {
              description: "消息列表",
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      { $ref: "#/components/schemas/GatewayResponse" },
                      { type: "object", properties: { data: { type: "object", properties: { messages: { type: "array", items: { $ref: "#/components/schemas/Message" } }, total: { type: "integer" } } } } },
                    ],
                  },
                },
              },
            },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
        delete: {
          tags: ["Message"],
          summary: "清空会话消息",
          parameters: [
            { name: "conversation_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "消息已清空",
              content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } },
            },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/internal/v1/users/{user_id}/memories": {
        get: {
          tags: ["Memory"],
          summary: "列出用户的长期记忆",
          parameters: [
            { name: "user_id", in: "path", required: true, schema: { type: "string" } },
            { name: "category", in: "query", schema: { $ref: "#/components/schemas/MemoryCategory" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 100 } },
          ],
          responses: {
            "200": {
              description: "记忆列表",
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      { $ref: "#/components/schemas/GatewayResponse" },
                      { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Memory" } } } },
                    ],
                  },
                },
              },
            },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
        delete: {
          tags: ["Memory"],
          summary: "清空用户所有记忆",
          parameters: [
            { name: "user_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "所有记忆已标记删除",
              content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } },
            },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/internal/v1/users/{user_id}/memories/{memory_id}": {
        put: {
          tags: ["Memory"],
          summary: "保存记忆（幂等）",
          parameters: [
            { name: "user_id", in: "path", required: true, schema: { type: "string" } },
            { name: "memory_id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: zodToOpenApi(MemorySaveRequestSchema),
              },
            },
          },
          responses: {
            "200": {
              description: "记忆已保存",
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      { $ref: "#/components/schemas/GatewayResponse" },
                      { type: "object", properties: { data: { $ref: "#/components/schemas/Memory" } } },
                    ],
                  },
                },
              },
            },
            "400": { description: "参数错误或内容重复", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
        patch: {
          tags: ["Memory"],
          summary: "更新记忆",
          parameters: [
            { name: "user_id", in: "path", required: true, schema: { type: "string" } },
            { name: "memory_id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    content: { type: "string", maxLength: 500 },
                    category: { $ref: "#/components/schemas/MemoryCategory" },
                    importance: { type: "integer", minimum: 1, maximum: 5 },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "记忆已更新",
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      { $ref: "#/components/schemas/GatewayResponse" },
                      { type: "object", properties: { data: { $ref: "#/components/schemas/Memory" } } },
                    ],
                  },
                },
              },
            },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
        delete: {
          tags: ["Memory"],
          summary: "删除记忆（软删除 + 向量清理）",
          parameters: [
            { name: "user_id", in: "path", required: true, schema: { type: "string" } },
            { name: "memory_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "记忆已标记删除",
              content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } },
            },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/internal/v1/users/{user_id}/memories:search": {
        post: {
          tags: ["Memory"],
          summary: "语义搜索记忆",
          parameters: [
            { name: "user_id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: zodToOpenApi(MemorySearchRequestSchema),
              },
            },
          },
          responses: {
            "200": {
              description: "搜索结果",
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      { $ref: "#/components/schemas/GatewayResponse" },
                      { type: "object", properties: { data: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/MemorySearchResult" } }, degraded: { type: "boolean" } } } } },
                    ],
                  },
                },
              },
            },
            "400": { $ref: "#/components/responses/NotFound" },
            "503": {
              description: "存储服务暂时不可用",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GatewayResponse" },
                  example: {
                    ok: true,
                    data: { items: [], degraded: true },
                    error: null,
                    meta: { request_id: "req_xxx", warnings: ["Vectorize unavailable, degraded to SQL"] },
                  },
                },
              },
            },
          },
        },
      },
      "/internal/v1/documents": {
        post: {
          tags: ["Document"],
          summary: "上传并索引文档",
          requestBody: { required: true, content: { "application/json": { schema: zodToOpenApi(DocumentUploadRequestSchema) } } },
          responses: { "201": { description: "文档已上传", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } } },
        },
        get: {
          tags: ["Document"],
          summary: "列出用户文档",
          parameters: [
            { name: "user_id", in: "query", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "category", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "文档列表", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } } },
        },
      },
      "/internal/v1/documents/{document_id}": {
        get: {
          tags: ["Document"],
          summary: "获取文档及分块",
          parameters: [{ name: "document_id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "文档详情", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } }, "404": { $ref: "#/components/responses/NotFound" } },
        },
        delete: {
          tags: ["Document"],
          summary: "删除文档",
          parameters: [{ name: "document_id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "文档已删除", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } }, "404": { $ref: "#/components/responses/NotFound" } },
        },
      },
      "/internal/v1/documents/{document_id}/reindex": {
        post: {
          tags: ["Document"],
          summary: "重建文档索引",
          parameters: [{ name: "document_id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "索引已重建", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } }, "404": { $ref: "#/components/responses/NotFound" } },
        },
      },
      "/internal/v1/documents:search": {
        post: {
          tags: ["Document"],
          summary: "语义搜索文档",
          requestBody: { required: true, content: { "application/json": { schema: zodToOpenApi(DocumentSearchRequestSchema) } } },
          responses: { "200": { description: "文档搜索结果", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } } },
        },
      },
      "/internal/v1/checkpoints/{thread_id}": {
        post: {
          tags: ["Checkpoint"],
          summary: "保存 LangGraph checkpoint",
          parameters: [{ name: "thread_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["checkpoint_id"], properties: { checkpoint_id: { type: "string" }, parent_checkpoint_id: { type: "string", nullable: true }, checkpoint_data: { type: "object" }, metadata: { type: "object" } } } } } },
          responses: { "200": { description: "checkpoint 已保存", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } } },
        },
        get: {
          tags: ["Checkpoint"],
          summary: "读取最新 checkpoint",
          parameters: [{ name: "thread_id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "checkpoint 数据", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } }, "404": { $ref: "#/components/responses/NotFound" } },
        },
        delete: {
          tags: ["Checkpoint"],
          summary: "删除线程 checkpoint",
          parameters: [{ name: "thread_id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "checkpoint 已删除", content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayResponse" } } } } },
        },
      },
    },
  };

  return spec;
}

// ============ 路由注册 ==========

// 创建或注册 registerOpenApiRoute 所需的数据
export function registerOpenApiRoute(app: any) {
  app.get("/internal/v1/openapi.json", async (c: any) => {
    const spec = getOpenApiSpec();
    return c.json(spec);
  });
}
