"""
可观测性模块 — 轻量级指标 + 追踪

提供:
1. Tool 调用指标收集（调用量、成功率、延迟）
2. 结构化事件日志
3. 审计日志导出

不依赖外部 APM 系统，适合中小规模部署。
生产环境可替换为 OpenTelemetry + Prometheus。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


# ============ 指标模型 ============

@dataclass
class ToolCallMetric:
    """单次工具调用指标"""
    tool_name: str
    tool_version: str
    ok: bool
    error_code: str | None = None
    duration_ms: int = 0
    risk_level: str = "R0"
    user_id: str = ""
    tenant_id: str = ""
    timestamp: str = ""


@dataclass
class MetricsSnapshot:
    """指标快照"""
    total_calls: int = 0
    success_calls: int = 0
    failed_calls: int = 0
    total_duration_ms: int = 0
    by_tool: dict[str, dict[str, int]] = field(default_factory=dict)
    by_risk: dict[str, int] = field(default_factory=dict)
    error_distribution: dict[str, int] = field(default_factory=dict)


# ============ 指标收集器 ============

class MetricsCollector:
    """指标收集器 — 内存实现"""

    # 初始化指标收集器，设置最大事件数
    def __init__(self, max_events: int = 10_000):
        self._metrics: list[ToolCallMetric] = []
        self._max_events = max_events

    # 记录一条工具调用指标
    def record(self, metric: ToolCallMetric) -> None:
        self._metrics.append(metric)
        if len(self._metrics) > self._max_events:
            self._metrics = self._metrics[-self._max_events:]

    # 生成当前指标快照（汇总统计）
    def snapshot(self) -> MetricsSnapshot:
        snap = MetricsSnapshot()
        for m in self._metrics:
            snap.total_calls += 1
            if m.ok:
                snap.success_calls += 1
            else:
                snap.failed_calls += 1
                if m.error_code:
                    snap.error_distribution[m.error_code] = snap.error_distribution.get(m.error_code, 0) + 1

            snap.total_duration_ms += m.duration_ms

            # by tool
            if m.tool_name not in snap.by_tool:
                snap.by_tool[m.tool_name] = {"calls": 0, "success": 0, "fail": 0}
            snap.by_tool[m.tool_name]["calls"] += 1
            if m.ok:
                snap.by_tool[m.tool_name]["success"] += 1
            else:
                snap.by_tool[m.tool_name]["fail"] += 1

            # by risk
            snap.by_risk[m.risk_level] = snap.by_risk.get(m.risk_level, 0) + 1

        return snap

    # 获取最近的指标事件列表
    def get_events(self, limit: int = 100) -> list[dict]:
        """获取最近的事件"""
        events = []
        for m in self._metrics[-limit:]:
            events.append({
                "tool": m.tool_name,
                "version": m.tool_version,
                "ok": m.ok,
                "error": m.error_code,
                "duration_ms": m.duration_ms,
                "risk": m.risk_level,
                "user_id": m.user_id,
                "timestamp": m.timestamp,
            })
        return events

    # 清空所有已记录的指标事件
    def clear(self) -> None:
        self._metrics.clear()


# ============ 全局单例 ============

_metrics = MetricsCollector()


def get_metrics_collector() -> MetricsCollector:
    return _metrics


# 记录一次工具调用指标到全局收集器
def record_tool_metric(
    tool_name: str,
    tool_version: str,
    ok: bool,
    error_code: str | None = None,
    duration_ms: int = 0,
    risk_level: str = "R0",
    user_id: str = "",
    tenant_id: str = "",
) -> None:
    """记录一次工具调用指标"""
    _metrics.record(ToolCallMetric(
        tool_name=tool_name,
        tool_version=tool_version,
        ok=ok,
        error_code=error_code,
        duration_ms=duration_ms,
        risk_level=risk_level,
        user_id=user_id,
        tenant_id=tenant_id,
        timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    ))


# ============ 导出 ============

__all__ = [
    "MetricsCollector",
    "MetricsSnapshot",
    "ToolCallMetric",
    "get_metrics_collector",
    "record_tool_metric",
]
