/** 补充 Worker 环境中的路由兼容方法与模块类型声明 */

declare module "find-my-way/lib/handler-storage.js" {
  const HandlerStorage: { prototype: {
    constraints: string[];
    unconstrainedHandler: { constraints: Record<string, unknown> } | null;
    // 声明路由参数对象编译方法以支持 Worker 兼容替换
    _compileCreateParamsObject(params: string[]): (values: string[]) => Record<string, string>;
    // 声明约束匹配器编译方法以支持 Worker 兼容替换
    _compileGetHandlerMatchingConstraints(): void;
    // 声明按请求派生约束匹配路由处理器的方法
    _getHandlerMatchingConstraints(derived: Record<string, unknown>): { constraints: Record<string, unknown> } | null;
  } };
  export default HandlerStorage;
}
declare module "find-my-way/lib/node.js" {
  export const StaticNode: { prototype: {
    prefix: string;
    // 声明前缀匹配器编译方法以支持 Worker 兼容替换
    _compilePrefixMatch(): void;
    // 声明从指定位置匹配请求路径前缀的方法
    matchPrefix(path: string, index: number): boolean;
  } };
}
declare module "avvio/lib/debug.js" {
  const logger: { debug: (...args: unknown[]) => void };
  export default logger;
}
