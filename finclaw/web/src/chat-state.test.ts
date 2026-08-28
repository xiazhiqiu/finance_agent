import { describe, expect, it } from "vitest";
import { ChatSessionState } from "./chat-state.ts";

describe("ChatSessionState", () => {
  it("streaming 进行中时输入框不可用，归零后可恢复", () => {
    const chat = new ChatSessionState();
    chat.streaming = true;
    expect(chat.canChat(true, false)).toBe(false);

    chat.streaming = false;
    expect(chat.canChat(true, false)).toBe(true);
  });

  it("canChat 受连接状态与画像待完善状态共同决定", () => {
    const chat = new ChatSessionState();
    chat.streaming = false;

    expect(chat.canChat(true, false)).toBe(true);
    expect(chat.canChat(false, false)).toBe(false);
    expect(chat.canChat(true, true)).toBe(false);
  });

  it("nextMessageId 按递增序号生成 m-prefixed id", () => {
    const chat = new ChatSessionState();
    expect(chat.nextMessageId()).toBe("m1");
    expect(chat.nextMessageId()).toBe("m2");
  });

  it("updateMessage 修改消息并返回是否命中", () => {
    const chat = new ChatSessionState();
    chat.messages.push({ id: "m1", role: "assistant", text: "" });

    expect(chat.updateMessage("m1", { streaming: false, toolStatus: "" })).toBe(true);
    expect(chat.messages[0].streaming).toBe(false);

    expect(chat.updateMessage("nope", { text: "x" })).toBe(false);
  });

  it("回归守卫：先归零 streaming 再（由调用方）渲染，才能让输入框恢复", () => {
    const chat = new ChatSessionState();
    // 模拟一次对话运行
    const assistantId = chat.nextMessageId();
    chat.messages.push({ id: assistantId, role: "assistant", text: "回答", streaming: true });
    chat.streaming = true;

    // 旧时序：此时调用方若先渲染（还未归零 streaming），输入框仍禁用
    expect(chat.canChat(true, false)).toBe(false);

    // 正确时序：先归零，再更新消息状态（渲染方随后读取到最新状态）
    chat.streaming = false;
    chat.updateMessage(assistantId, { streaming: false, toolStatus: "" });

    expect(chat.canChat(true, false)).toBe(true);
  });
});