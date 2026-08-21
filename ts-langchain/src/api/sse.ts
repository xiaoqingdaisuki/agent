// 统一编码 SSE 事件，兼容旧客户端继续读取 data 字段。
export function encodeSseEvent(
  eventName: string,
  payload: unknown,
): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// 编码流结束事件，同时保留历史客户端使用的 [DONE] 标记。
export function encodeSseDone(): string {
  return 'event: done\ndata: {"ok":true}\n\ndata: [DONE]\n\n';
}
