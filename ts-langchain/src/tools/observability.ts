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

  record(metric: ToolCallMetric): void {
    this.metrics.push(metric);
    if (this.metrics.length > this.maxEvents) {
      this.metrics = this.metrics.slice(-this.maxEvents);
    }
  }

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

  getEvents(limit = 100): ToolCallMetric[] {
    return this.metrics.slice(-limit);
  }

  clear(): void {
    this.metrics = [];
  }
}

// ============ 全局单例 ============

const metricsCollector = new MetricsCollector();

export function getMetricsCollector(): MetricsCollector {
  return metricsCollector;
}

export function recordToolMetric(
  metric: Omit<ToolCallMetric, "timestamp">,
): void {
  metricsCollector.record({
    ...metric,
    timestamp: new Date().toISOString(),
  });
}

export function getMetricsSnapshot(): MetricsSnapshot {
  return metricsCollector.snapshot();
}

export { MetricsCollector, type MetricsSnapshot, type ToolCallMetric };
