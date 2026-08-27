// 统一编码 SSE 事件，兼容旧客户端继续读取 data 字段。
export function encodeSseEvent(
  eventName: string,
  payload: unknown,
  eventId?: string,
): string {
  return `${eventId ? `id: ${eventId}\n` : ""}event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// 编码流结束事件，同时保留历史客户端使用的 [DONE] 标记。
export function encodeSseDone(eventId?: string): string {
  return `${eventId ? `id: ${eventId}\n` : ""}event: done\ndata: {"ok":true}\n\ndata: [DONE]\n\n`;
}

// 为单个 turn 的 SSE 事件生成单调 ID，并在 JSON 负载中保留相同标识。
export class SseEventSequencer {
  private sequence = 0;

  // 初始化指定 Turn 的 SSE 单调序号生成器。
  constructor(private readonly turnId: string) {}

  // 编码带事件 ID 的标准 SSE 业务事件。
  event(eventName: string, payload: Record<string, unknown>): string {
    const eventId = `${this.turnId}:${++this.sequence}`;
    return encodeSseEvent(eventName, { ...payload, event_id: eventId }, eventId);
  }

  // 编码带事件 ID 的流结束标记。
  done(): string {
    return encodeSseDone(`${this.turnId}:${++this.sequence}`);
  }
}

// 编码不会进入用户文本流的 SSE 心跳注释。
export function encodeSseHeartbeat(): string {
  return ": ping\n\n";
}
