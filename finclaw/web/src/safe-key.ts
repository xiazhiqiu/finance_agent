/** 归一化 sessionKey 为安全文件名（对齐 pi-gateway 的 safeKey） */
export function safeKey(sessionKey: string): string {
  return (sessionKey ?? "").replace(/[^a-zA-Z0-9_-]/g, "-");
}
