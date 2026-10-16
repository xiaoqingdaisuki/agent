import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestRuntime {
  waitUntil(task: Promise<unknown>): void;
  gatewayFetch?: typeof fetch;
  generateImage?: (model: string, input: FormData | Record<string, unknown>) => Promise<Response>;
}

const runtime = new AsyncLocalStorage<RequestRuntime>();

// 将 Worker 请求生命周期与网关绑定隔离到当前异步调用链。
export function runWithRequestRuntime<T>(context: RequestRuntime, callback: () => T): T {
  return runtime.run(context, callback);
}

// 把当前请求创建的后台任务注册到 Worker 生命周期。
export function retainBackgroundTask(task: Promise<unknown>): void {
  runtime.getStore()?.waitUntil(task);
}

// 优先通过内部 Service Binding 请求存储网关，Node 环境沿用 HTTP。
export function fetchMemoryGateway(input: string, init: RequestInit): Promise<Response> {
  return (runtime.getStore()?.gatewayFetch ?? fetch)(input, init);
}

// 在 Worker 中通过 Workers AI 绑定生图，Node 环境沿用 HTTP 调用。
export function generateBoundImage(model: string, input: FormData | Record<string, unknown>): Promise<Response> | undefined {
  return runtime.getStore()?.generateImage?.(model, input);
}
