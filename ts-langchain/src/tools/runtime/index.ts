/**
 * tools/runtime/index — Runtime 管线 barrel 导出
 *
 * 统一执行管线的公共 API 入口。
 * 所有工具必须通过此模块导出的函数执行，禁止绕过。
 */

export {
  invokeTool,
  type ToolExecutor,
  permissionCheck,
  validateInput,
  sanitizeResult,
  budgetGuard,
  resetRoundBudget,
  recordAudit,
  getAuditLog,
  clearAuditLog,
} from "./executor.js";
