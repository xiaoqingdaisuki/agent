import HandlerStorage from "find-my-way/lib/handler-storage.js";
import { StaticNode } from "find-my-way/lib/node.js";
import avvioDebug from "avvio/lib/debug.js";

let installed = false;

interface RouteHandler {
  constraints: Record<string, unknown>;
}

// 显式安装固定版本路由器兼容层，并在依赖内部接口变化时立即报错。
export function installWorkerRouterCompatibility(): void {
  if (installed) return;
  const expected = [
    StaticNode.prototype._compilePrefixMatch,
    HandlerStorage.prototype._compileCreateParamsObject,
    HandlerStorage.prototype._compileGetHandlerMatchingConstraints,
  ];
  if (expected.some((method) => typeof method !== "function")) {
    throw new Error("Unsupported find-my-way internals; verify Worker router compatibility before upgrading");
  }
  // 避免 Workers 的 debuglog 兼容实现输出大量启动调试日志，保留正式请求日志。
  avvioDebug.debug = () => undefined;

  // 保留原有基数树查找，只将静态路径前缀的动态代码替换为原生字符串匹配。
  StaticNode.prototype._compilePrefixMatch = function () {
    const suffix = this.prefix.slice(1);
    // 首字符已由路由树分支匹配，此处仅比较剩余前缀。
    this.matchPrefix = (path: string, index: number) => path.startsWith(suffix, index + 1);
  };

  // 使用闭包生成路由参数，避免 find-my-way 的 new Function 触发 Worker 禁止动态执行限制。
  HandlerStorage.prototype._compileCreateParamsObject = function (params: string[]) {
    // 根据注册顺序构建具名路由参数。
    return (values: string[]) => Object.fromEntries(params.map((name, index) => [name, values[index]]));
  };

  // 当前 API 未使用版本或域名约束，遇到新增约束时立即拒绝启动，避免错误匹配。
  HandlerStorage.prototype._compileGetHandlerMatchingConstraints = function () {
    if (this.constraints.length > 0) {
      throw new Error("Worker router requires routes without host/version constraints");
    }
    // 与默认 version 策略一致，带版本头的请求不能匹配没有版本的路由。
    this._getHandlerMatchingConstraints = (derived: Record<string, unknown>): RouteHandler | null =>
      derived.version === undefined ? this.unconstrainedHandler : null;
  };
  installed = true;
}
