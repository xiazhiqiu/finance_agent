/**
 * 聊天会话纯状态层（无 DOM、可单测）。
 *
 * 将对话区相关状态（消息列表、流式进行中标记、消息序号）从 FinanceAdvisorApp
 * 分离出来，并把"输入框/发送按钮是否可用"的判定收敛到这里。
 *
 * 核心约定：通过 updateMessage / 直接字段变更后，渲染方（FinanceAdvisorApp）
 * 应在状态已归零之后调用 renderAgentPane()，保证 UI 读到最新状态。
 * typical 的误用：先渲染（streaming 仍为 true）再归零，导致按钮卡死——此类
 * 时序 bug 可由本层的 canChat 纯函数单测拦截。
 */

import type { ChatMessage } from "./types.ts";

export class ChatSessionState {
  messages: ChatMessage[] = [];
  /** 是否有对话正在进行中（流式输出 / 输入框禁用） */
  streaming = false;
  /** 消息序号生成器 */
  seq = 0;

  /** 生成下一条消息 id（沿用原有 `m${++seq}` 规则） */
  nextMessageId(): string {
    return `m${++this.seq}`;
  }

  /**
   * 更新一条消息并返回是否真的找到了它。
   * 仅改数据，不负责渲染——渲染由调用方在状态落定后触发。
   */
  updateMessage(id: string, patch: Partial<ChatMessage>): boolean {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return false;
    Object.assign(msg, patch);
    return true;
  }

  /**
   * 输入框/发送按钮是否可用。
   * @param connected pi-gateway 是否已连接
   * @param isPending 客户画像是否待完善（阻断对话）
   */
  canChat(connected: boolean, isPending: boolean): boolean {
    return connected && !isPending && !this.streaming;
  }
}