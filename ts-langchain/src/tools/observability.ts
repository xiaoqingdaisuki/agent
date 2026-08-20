/**
 * 可观测性模块 — 轻量级指标 + 追踪
 *
 * 提供:
 * 1. Tool 调用指标收集（调用量、成功率、延迟）
 * 2. 结构化事件日志
 *
 * 不依赖外部 APM 系统，适合中小规模部署。
 * 生产环境可替换为 OpenTelemetry + Prometheus。
 */

// ============ 指标模型 ============

interface ToolCallMetric {
  tool_name: string;
  tool_version: string;
  ok: boolean;
  error_code?: string;
  duration_ms: number;
  risk_level: string;
  user_id: string;
  tenant_id: string;
  timestamp: string;
}

interface MetricsSnapshot {
  total_calls: number;
  success_calls: number;
  failed_calls: number;
  total_duration_ms: number;
  by_tool: Record<string, { calls: number; success: number; fail: number }>;
  by_risk: Record<string, number>;
  error_distribution: Record<string, number>;
}

// ============ 指标收集器 ============

class MetricsCollector {
  private metrics: ToolCallMetric[] = [];
  private maxEvents = 10_000;

  // 更新或保存 record 对应的数据
  record(metric: ToolCallMetric): void {
    this.metrics.push(metric);
    if (this.metrics.length > this.maxEvents) {
      this.metrics = this.metrics.slice(-this.maxEvents);
    }
  }

  // 执行 snapshot 对应的业务逻辑
  snapshot(): MetricsSnapshot {
    const snap: MetricsSnapshot = {
      total_calls: 0,
      success_calls: 0,
      failed_calls: 0,
      total_duration_ms: 0,
      by_tool: {},
      by_risk: {},
      error_distribution: {},
    };

    for (const m of this.metrics) {
      snap.total_calls++;
      if (m.ok) {
        snap.success_calls++;
      } else {
        snap.failed_calls++;
        if (m.error_code) {
          snap.error_distribution[m.error_code] =
            (snap.error_distribution[m.error_code] || 0) + 1;
        }
      }

      snap.total_duration_ms += m.duration_ms;

      if (!(m.tool_name in snap.by_tool)) {
        snap.by_tool[m.tool_name] = { calls: 0, success: 0, fail: 0 };
      }
      snap.by_tool[m.tool_name].calls++;
      if (m.ok) {
        snap.by_tool[m.tool_name].success++;
      } else {
        snap.by_tool[m.tool_name].fail++;
      }

      snap.by_risk[m.risk_level] = (snap.by_risk[m.risk_level] || 0) + 1;
    }

    return snap;
  }

  // 获取 getEvents 对应的数据
  getEvents(limit = 100): ToolCallMetric[] {
    return this.metrics.slice(-limit);
  }

  // 删除或清理 clear 对应的数据
  clear(): void {
    this.metrics = [];
  }
}

// ============ 全局单例 ============

const metricsCollector = new MetricsCollector();
let gatewayClient: any = null;

// 获取 getGatewayClient 对应的数据
function getGatewayClient() {
  if (!gatewayClient) {
    const { CloudflareMemoryClient } = require("../../clients/memory_gateway.js");
    gatewayClient = new CloudflareMemoryClient({
      baseUrl: process.env.CLOUDFLARE_MEMORY_BASE_URL || "http://localhost:8787",
      secret: process.env.CLOUDFLARE_MEMORY_SECRET || "",
    });
  }
  return gatewayClient;
}

// 批量刷新指标到 Gateway（异步，不阻塞）
async function flushToolMetrics(): Promise<void> {
  if (process.env.MEMORY_ENABLED?.toLowerCase() === "false") return;
  const events = metricsCollector.getEvents(metricsCollector["maxEvents"]);
  if (events.length === 0) return;
  const toFlush = events.splice(0, events.length);
  try {
    const client = getGatewayClient();
    await client.writeToolMetrics(
      toFlush.map((m) => ({
        tool_name: m.tool_name,
        tool_version: m.tool_version,
        ok: m.ok,
        error_code: m.error_code,
        duration_ms: m.duration_ms,
        risk_level: m.risk_level,
        user_id: m.user_id,
        tenant_id: m.tenant_id,
      })),
    );
  } catch (err) {
    console.warn("[metrics] Failed to flush tool metrics to Gateway:", err);
  }
}

// 获取 getMetricsCollector 对应的数据
export function getMetricsCollector(): MetricsCollector {
  return metricsCollector;
}

// 更新或保存 recordToolMetric 对应的数据
export function recordToolMetric(
  metric: Omit<ToolCallMetric, "timestamp">,
): void {
  metricsCollector.record({
    ...metric,
    timestamp: new Date().toISOString(),
  });

  // 每 500 条异步刷入 Gateway
  if (metricsCollector["metrics"].length >= 500) {
    void flushToolMetrics();
  }
}

// 获取 getMetricsSnapshot 对应的数据
export function getMetricsSnapshot(): MetricsSnapshot {
  return metricsCollector.snapshot();
}

export { MetricsCollector, type MetricsSnapshot, type ToolCallMetric };
