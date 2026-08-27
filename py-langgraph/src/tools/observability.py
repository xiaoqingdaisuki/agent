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

from src.config.settings import settings


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
            self._metrics = self._metrics[-self._max_events :]

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
                    snap.error_distribution[m.error_code] = (
                        snap.error_distribution.get(m.error_code, 0) + 1
                    )

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
            events.append(
                {
                    "tool": m.tool_name,
                    "version": m.tool_version,
                    "ok": m.ok,
                    "error": m.error_code,
                    "duration_ms": m.duration_ms,
                    "risk": m.risk_level,
                    "user_id": m.user_id,
                    "timestamp": m.timestamp,
                }
            )
        return events

    # 读取最早一批待上传指标但暂不确认删除。
    def peek_pending(self, limit: int = 500) -> list[ToolCallMetric]:
        return list(self._metrics[:limit])

    # 成功上传后确认删除指定数量的队首指标。
    def acknowledge(self, count: int) -> None:
        del self._metrics[:count]

    # 清空所有已记录的指标事件
    def clear(self) -> None:
        self._metrics.clear()


# ============ 全局单例 ==========

_metrics = MetricsCollector()
_metrics_flush_inflight = False


# 获取 get metrics collector 对应的数据
def get_metrics_collector() -> MetricsCollector:
    return _metrics


# 异步批量刷入 Gateway（不阻塞工具执行）
def _flush_metrics() -> None:
    """将工具指标批量写入 Gateway D1"""
    if not settings.memory_enabled:
        return
    global _metrics_flush_inflight
    if _metrics_flush_inflight:
        return
    events = _metrics.peek_pending()
    if not events:
        return
    _metrics_flush_inflight = True
    try:
        import asyncio

        from src.clients.memory_gateway import CloudflareMemoryClient

        client = CloudflareMemoryClient()
        entries = [
            {
                "tool_name": e.tool_name,
                "tool_version": e.tool_version,
                "ok": e.ok,
                "error_code": e.error_code,
                "duration_ms": e.duration_ms,
                "risk_level": e.risk_level,
                "user_id": e.user_id,
                "tenant_id": e.tenant_id,
            }
            for e in events
        ]

        # 执行 do flush 对应的业务逻辑
        async def _do_flush():
            global _metrics_flush_inflight
            try:
                await client.write_tool_metrics(entries)
                _metrics.acknowledge(len(events))
            finally:
                await client.close()
                _metrics_flush_inflight = False

        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.ensure_future(_do_flush())
            else:
                loop.run_until_complete(_do_flush())
        except RuntimeError:
            asyncio.run(_do_flush())
    except Exception:
        _metrics_flush_inflight = False


# 更新或保存 record tool metric 对应的数据
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
    _metrics.record(
        ToolCallMetric(
            tool_name=tool_name,
            tool_version=tool_version,
            ok=ok,
            error_code=error_code,
            duration_ms=duration_ms,
            risk_level=risk_level,
            user_id=user_id,
            tenant_id=tenant_id,
            timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )
    )

    # 每 500 条异步刷入 Gateway
    if len(_metrics._metrics) >= 500:
        _flush_metrics()


# ============ 导出 ============

__all__ = [
    "MetricsCollector",
    "MetricsSnapshot",
    "ToolCallMetric",
    "get_metrics_collector",
    "record_tool_metric",
]
