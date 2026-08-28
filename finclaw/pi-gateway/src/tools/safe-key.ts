/** 归一化 sessionKey 为安全文件名 */
export function safeKey(sessionKey: string): string {
	return (sessionKey ?? "").replace(/[^a-zA-Z0-9_-]/g, "-");
}
