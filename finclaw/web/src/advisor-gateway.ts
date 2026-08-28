import { extractMessageText } from "./result-parser.ts";
import type { GatewaySessionMessage, GatewaySessionSummary } from "./types.ts";

/**
 * SSE 事件解析器：从 ReadableStream 中解析 SSE event/data 行。
 */
function createSSEParser() {
  let buffer = "";
  let currentEvent = "";
  const events: { event: string; data: string }[] = [];

  function feed(chunk: string): void {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let dataLines: string[] = [];
    let eventType = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      } else if (line === "") {
        // 空行 = 事件结束
        if (eventType || dataLines.length) {
          events.push({ event: eventType, data: dataLines.join("\n") });
        }
        eventType = "";
        dataLines = [];
      }
    }
  }

  function drain(): { event: string; data: string }[] {
    const result = events.splice(0);
    return result;
  }

  return { feed, drain };
}

export interface ChatCallbacks {
  onThinking?: () => void;
  onToolCall?: (toolName: string, args: unknown) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
  onMessage?: (delta: string) => void;
}

export class AdvisorGateway {
  private connected = false;

  constructor(
    private readonly options: {
      url: string;
      token: string;
      onStatus: (connected: boolean, detail?: string) => void;
      /** 单轮对话总超时(ms)，默认 5 分钟；超时后主动结束流，避免 UI 卡在运行中 */
      runTimeoutMs?: number;
    },
  ) {}

  /**
   * 健康检查：通过 GET /health 确认 pi-gateway 可达。
   */
  async connect(): Promise<void> {
    this.disconnect();
    try {
      const resp = await fetch(`${this.options.url}/health`);
      if (resp.ok) {
        this.connected = true;
        this.options.onStatus(true, "pi-agent 已连接");
      } else {
        this.connected = false;
        this.options.onStatus(false, `pi-gateway 健康检查失败: ${resp.status}`);
      }
    } catch (error) {
      this.connected = false;
      const detail = error instanceof Error ? error.message : "连接失败";
      this.options.onStatus(false, detail);
    }
  }

  disconnect(): void {
    this.connected = false;
    this.options.onStatus(false, "连接已断开");
  }

  /**
   * 自由聊天：发送纯文本 message 并通过 SSE 流式接收响应。
   * body 为 { sessionKey, message: text, customer_id, manager_id }，消息统一走 Pi AgentSession 自由聊天，
   * 方案生成/优化由 Agent 在会话内调用 generate_plan / optimize_plan 工具完成。
   * 可选 context 携带 customer_id / manager_id，供后端注入会话上下文。
   * 解析 SSE 事件并回调 onThinking / onToolCall / onToolResult / onMessage；
   * final 事件返回最终文本；error 事件抛错。
   */
  async sendChat(
    sessionKey: string,
    text: string,
    callbacks: ChatCallbacks = {},
    context?: { customerId?: string; managerId?: string },
  ): Promise<string> {
    if (!this.connected) throw new Error("pi-gateway 尚未连接");

    const response = await fetch(`${this.options.url}/api/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionKey,
        message: text,
        customer_id: context?.customerId,
        manager_id: context?.managerId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`pi-gateway 请求失败: ${response.status} ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("无法读取响应流");

    const decoder = new TextDecoder();
    const parser = createSSEParser();
    let finalText = "";
    let errorMessage = "";
    let collectedText = "";

    // 流式超时兜底：当 SDK 端重试/网络异常导致 SSE 流迟迟不结束时，主动取消读取，
    // 保证 Promise 一定 settle，前端 finally 必执行，UI 不会永久卡在运行中。
    const timeoutMs = this.options.runTimeoutMs ?? 5 * 60 * 1000;
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {});
    }, timeoutMs);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const textChunk = decoder.decode(value, { stream: true });
        parser.feed(textChunk);

        for (const evt of parser.drain()) {
          try {
            const data = JSON.parse(evt.data);
            if (evt.event === "thinking") {
              callbacks.onThinking?.();
            } else if (evt.event === "tool_call") {
              callbacks.onToolCall?.(data.toolName, data.args);
            } else if (evt.event === "tool_result") {
              callbacks.onToolResult?.(data.toolName, data.result);
            } else if (evt.event === "message") {
              if (typeof data.delta === "string") {
                collectedText += data.delta;
                callbacks.onMessage?.(data.delta);
              }
            } else if (evt.event === "final") {
              finalText = extractMessageText(data.text);
            } else if (evt.event === "error") {
              errorMessage = data.message ?? "Agent 执行错误";
            }
          } catch {
            // 忽略单条事件解析错误，继续后续事件
          }
        }

        // 收到 final 即代表回答完整，无需等服务端关闭连接，提前结束本轮
        if (finalText) {
          await reader.cancel().catch(() => {});
          break;
        }
      }

      if (errorMessage) throw new Error(errorMessage);
      if (timedOut && !finalText && !collectedText) {
        throw new Error("Agent 响应超时，请重试");
      }
      const result = finalText || collectedText;
      if (!result) throw new Error("Agent 未返回最终结果");

      return result;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  /**
   * 读取 pi-gateway 历史会话摘要列表。
   */
  async listSessions(): Promise<GatewaySessionSummary[]> {
    const response = await fetch(`${this.options.url}/api/sessions`);
    if (!response.ok) {
      throw new Error(`pi-gateway 会话列表请求失败: ${response.status}`);
    }
    const data: unknown = await response.json();
    return Array.isArray(data) ? (data as GatewaySessionSummary[]) : [];
  }

  /**
   * 读取指定会话的完整消息列表。
   */
  async getSessionMessages(sessionKey: string): Promise<GatewaySessionMessage[]> {
    const response = await fetch(
      `${this.options.url}/api/sessions/${encodeURIComponent(sessionKey)}/messages`,
    );
    if (!response.ok) {
      throw new Error(`pi-gateway 会话消息请求失败: ${response.status}`);
    }
    const data: unknown = await response.json();
    return Array.isArray(data) ? (data as GatewaySessionMessage[]) : [];
  }

  /**
   * 删除 pi-gateway 会话（销毁内存会话并清理 jsonl 历史目录）。
   * 用于会话删除时级联清理孤儿对话历史。
   */
  async deleteSession(sessionKey: string): Promise<void> {
    const response = await fetch(
      `${this.options.url}/api/sessions/${encodeURIComponent(sessionKey)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      throw new Error(`pi-gateway 会话删除请求失败: ${response.status}`);
    }
  }
}
