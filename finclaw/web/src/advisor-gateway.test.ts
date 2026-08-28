import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisorGateway } from "./advisor-gateway.ts";

/** 构造一条 SSE 事件文本 */
function sseEvent(event: string, data: unknown): string {
  return `event:${event}\ndata:${JSON.stringify(data)}\n\n`;
}

/** 流式响应：逐步吐出 chunk，最后 close */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
}

/** 悬挂流：吐出既有 chunk 后既不输出也不再 close，模拟 SSE 流迟迟不结束 */
function makeHangingStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      // chunk 耗尽后保持打开，不 close
    },
  });
}

function mockGateway(body: ReadableStream<Uint8Array>, runTimeoutMs?: number) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/health")) {
      return { ok: true, status: 200 } as unknown as Response;
    }
    return { ok: true, status: 200, body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);

  const gateway = new AdvisorGateway({
    url: "http://gateway.test",
    token: "t",
    onStatus: () => {},
    runTimeoutMs,
  });
  return { gateway, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendChat 流式结束与超时兜底", () => {
  it("收到 final 事件后即使流未关闭也提前结束，返回最终文本", async () => {
    const stream = makeHangingStream([
      sseEvent("message", { delta: "你" }),
      sseEvent("message", { delta: "好" }),
      sseEvent("final", { text: "你好" }),
    ]);
    const { gateway } = mockGateway(stream);
    await gateway.connect();

    const deltas: string[] = [];
    const result = await gateway.sendChat("k", "hi", {
      onMessage: (d) => deltas.push(d),
    });

    expect(result).toBe("你好");
    expect(deltas.join("")).toBe("你好");
  });

  it("流悬挂且已有部分回答时，超时后返回已收集文本而非报错", async () => {
    const stream = makeHangingStream([sseEvent("message", { delta: "部分回答" })]);
    const { gateway } = mockGateway(stream, 30);
    await gateway.connect();

    const result = await gateway.sendChat("k", "hi");
    expect(result).toBe("部分回答");
  });

  it("流悬挂且无任何输出时，超时后抛出明确错误", async () => {
    const stream = makeHangingStream([]);
    const { gateway } = mockGateway(stream, 30);
    await gateway.connect();

    await expect(gateway.sendChat("k", "hi")).rejects.toThrow("响应超时");
  });

  it("收到 error 事件时抛出对应错误", async () => {
    const stream = makeStream([sseEvent("error", { message: "工具执行失败" })]);
    const { gateway } = mockGateway(stream);
    await gateway.connect();

    await expect(gateway.sendChat("k", "hi")).rejects.toThrow("工具执行失败");
  });

  it("正常流关闭时返回最终文本", async () => {
    const stream = makeStream([
      sseEvent("thinking", {}),
      sseEvent("message", { delta: "完整" }),
      sseEvent("message", { delta: "回答" }),
      sseEvent("final", { text: "完整回答" }),
    ]);
    const { gateway } = mockGateway(stream);
    await gateway.connect();

    await expect(gateway.sendChat("k", "hi")).resolves.toBe("完整回答");
  });

  it("纯问答（无工具事件）流结束即返回，前端可正常结束而非挂起", async () => {
    // 模拟纯文本问答：仅 message 流 + final，无 thinking/tool_call/tool_result 事件，
    // 流正常关闭。sendChat 必须 resolve 返回完整文本，保证前端 finally 能执行（streaming 归零）。
    const stream = makeStream([
      sseEvent("message", { delta: "我是" }),
      sseEvent("message", { delta: "财富" }),
      sseEvent("message", { delta: "顾问" }),
      sseEvent("final", { text: "我是财富顾问" }),
    ]);
    const { gateway } = mockGateway(stream);
    await gateway.connect();

    const deltas: string[] = [];
    const result = await gateway.sendChat("k", "hi", { onMessage: (d) => deltas.push(d) });

    expect(result).toBe("我是财富顾问");
    expect(deltas.join("")).toBe("我是财富顾问");
  });

  it("纯问答收到 final 后即使流仍未关闭也提前结束，前端 finally 必执行", async () => {
    // 对应纯问答场景：服务端已发 final 但 SSE 连接未关闭（服务端仍在收尾），
    // sendChat 必须据 final 提前 resolve，前端 finally 才不会因等待流关闭而卡住。
    const stream = makeHangingStream([
      sseEvent("message", { delta: "纯文本" }),
      sseEvent("final", { text: "纯文本回答" }),
    ]);
    const { gateway } = mockGateway(stream);
    await gateway.connect();

    await expect(gateway.sendChat("k", "hi")).resolves.toBe("纯文本回答");
  });
});
