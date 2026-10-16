import type { FastifyReply, FastifyRequest } from "fastify";
import { BusinessError, BusinessErrorCode, TurnService } from "../services/index.js";
import type { AgentStreamEvent, Message } from "../services/index.js";
import { retainBackgroundTask } from "../runtime.js";
import { logRequestError } from "./middleware/error.js";
import { SseEventSequencer, encodeSseHeartbeat } from "./sse.js";

// 在终态写入失败时保留有界后台重试，只有网关确认成功才视为完成。
export async function terminateStreamTurn(turnId: string, userId: string, cancelled: boolean, code: string): Promise<boolean> {
  try {
    await TurnService.terminate(turnId, userId, cancelled, code);
    return true;
  } catch (error) {
    console.error("Turn settlement failed; retrying", turnId, error);
    // 使用后台生命周期重试原始终态，失败次数有界并保留诊断日志。
    const retry = async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        try {
          await TurnService.terminate(turnId, userId, cancelled, code);
          return;
        } catch (retryError) {
          if (attempt === 2) console.error("Turn settlement retries exhausted", turnId, retryError);
        }
      }
    };
    retainBackgroundTask(retry());
    return false;
  }
}

// 写入 SSE 并等待背压解除，连接关闭后由取消信号结束上游工作。
async function writeSse(raw: FastifyReply["raw"], data: string): Promise<void> {
  if (raw.writableEnded || raw.destroyed) return;
  if (!raw.write(data)) {
    await new Promise<void>((resolve) => {
      // 移除背压和断连监听，避免长流累积监听器。
      const finish = () => {
        raw.removeListener("drain", finish);
        raw.removeListener("close", finish);
        resolve();
      };
      raw.once("drain", finish);
      raw.once("close", finish);
    });
  }
}

// 将两类外部路由统一映射到稳定的 SSE 事件协议。
function encodeAgentEvent(sequencer: SseEventSequencer, event: AgentStreamEvent): string {
  if (event.type === "text") return sequencer.event("text", {
    delta: event.text, text: event.text, partial: event.partial ?? false,
  });
  if (event.type === "tool") return sequencer.event("tool", {
    event: "tool", tool_name: event.toolName, status: event.status,
    call_id: event.callId, duration_ms: event.durationMs ?? null,
  });
  return sequencer.event(event.event, { state: event.state, stop_reason: event.stopReason, react: event.react });
}

interface StreamOptions {
  conversationId: string;
  userId: string;
  turnId: string;
  completed: Message | null;
  // 提供当前轮次事件来源，附件准备和 Agent 执行共享取消信号。
  events(signal: AbortSignal): AsyncIterable<AgentStreamEvent>;
}

// 统一维护 SSE 取消、超时、重放、事件编码与 Turn 终态持久化。
export async function streamTurn(request: FastifyRequest, reply: FastifyReply, options: StreamOptions): Promise<void> {
  reply.hijack();
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.flushHeaders();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new BusinessError(
    BusinessErrorCode.AGENT_TIMEOUT, "AI助手响应超时，请稍后重试。", 504,
  )), 270_000);
  timer.unref?.();
  // 连接断开时立即取消模型和工具执行。
  const disconnect = () => {
    if (!reply.raw.writableEnded) controller.abort(new Error("Client disconnected"));
  };
  request.raw.once("aborted", disconnect);
  reply.raw.once("close", disconnect);
  const heartbeat = setInterval(() => {
    void writeSse(reply.raw, encodeSseHeartbeat()).catch(disconnect);
  }, 15_000);
  heartbeat.unref?.();
  const sequencer = new SseEventSequencer(options.turnId);
  let completed = Boolean(options.completed);
  let settlementRequested = false;
  let fullAnswer = "";
  try {
    await writeSse(reply.raw, sequencer.event("meta", {
      conversation_id: options.conversationId, thread_id: options.conversationId, turn_id: options.turnId,
    }));
    if (options.completed) {
      await writeSse(reply.raw, sequencer.event("text", {
        delta: options.completed.content, text: options.completed.content, partial: false, replayed: true,
      }));
      return;
    }
    controller.signal.throwIfAborted();
    for await (const event of options.events(controller.signal)) {
      controller.signal.throwIfAborted();
      if (event.type === "text") fullAnswer += event.text;
      await writeSse(reply.raw, encodeAgentEvent(sequencer, event));
    }
    controller.signal.throwIfAborted();
    await TurnService.complete(options.turnId, options.userId, {
      id: crypto.randomUUID(), role: "assistant", content: fullAnswer, createdAt: new Date().toISOString(),
    });
    completed = true;
  } catch (error) {
    const failure = controller.signal.aborted ? controller.signal.reason : error;
    const cancelled = controller.signal.aborted && !(failure instanceof BusinessError && failure.code === BusinessErrorCode.AGENT_TIMEOUT);
    const businessError = failure instanceof BusinessError ? failure : new BusinessError(
      BusinessErrorCode.INTERNAL_ERROR, "处理请求时发生错误", 500,
    );
    if (!completed) {
      settlementRequested = true;
      completed = await terminateStreamTurn(options.turnId, options.userId, cancelled, cancelled ? "CLIENT_CANCELLED" : businessError.code);
    }
    logRequestError(request, failure, { conversation_id: options.conversationId, user_id: options.userId, stream: true });
    await writeSse(reply.raw, sequencer.event("error", { ok: false, error: businessError.toJSON().error })).catch(() => undefined);
  } finally {
    if (!completed && !settlementRequested) await terminateStreamTurn(options.turnId, options.userId, true, "CLIENT_CANCELLED");
    clearTimeout(timer);
    clearInterval(heartbeat);
    request.raw.removeListener("aborted", disconnect);
    reply.raw.removeListener("close", disconnect);
    try {
      await writeSse(reply.raw, sequencer.done());
    } catch {
      // 连接已关闭时无需发送结束标记。
    } finally {
      reply.raw.end();
    }
  }
}
