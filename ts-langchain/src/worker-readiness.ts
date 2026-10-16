export interface WorkerConfiguration {
  [key: string]: unknown;
}

// 在应用启动前检查 Worker 必需依赖，避免配置缺失使公开探针失效。
export function getWorkerReadiness(env: WorkerConfiguration) {
  const components = {
    model: Boolean(env.OPENAI_API_KEY && env.CLOUDFLARE_AI_GATEWAY_URL),
    authentication: Boolean(env.AGENT_API_SECRET),
    memory_gateway: env.MEMORY_ENABLED === "true" && Boolean(env.CLOUDFLARE_MEMORY_SECRET && env.MEMORY_GATEWAY),
  };
  const ready = Object.values(components).every(Boolean);
  return {
    status: ready ? "ok" : "degraded", ready, version: "0.2.0",
    components: Object.fromEntries(Object.entries(components).map(([key, value]) =>
      [key, value ? "configured" : "missing_configuration"])),
  };
}

// 公开存活探针始终可用；未就绪时阻止业务请求进入不完整的 Worker。
export function workerConfigurationResponse(request: Request, env: WorkerConfiguration): Response | undefined {
  const pathname = new URL(request.url).pathname;
  const healthPath = pathname.startsWith("/v1/")
    ? pathname.slice("/v1".length)
    : "";
  if ((request.method === "GET" || request.method === "HEAD") && ["/health", "/health/live"].includes(healthPath)) {
    return Response.json({ status: "ok", live: true, version: "0.2.0" });
  }
  const readiness = getWorkerReadiness(env);
  if ((request.method === "GET" || request.method === "HEAD") && healthPath === "/health/ready") {
    return Response.json(readiness, { status: readiness.ready ? 200 : 503 });
  }
  if (!readiness.ready) return Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "Worker dependencies are not configured" } }, { status: 503 });
}
