// 纯渲染辅助函数：无状态、不依赖任何业务上下文，可安全复用。

export const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

export const money = (value?: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency", currency: "CNY", maximumFractionDigits: 0,
  }).format(value ?? 0);

/**
 * 解析三段式诊断字符串为 [{ title, content }]。
 * 输入形如 "【资产配置】内容 | 【风险诊断】内容 | 【任务诊断】内容"：
 * - 按 【标签】 提取段落（标签取「」内文本，内容取到下一标签或结尾）
 * - 每段内容尾部可能带用户约定的 " | " 分隔符，解析时剔除
 * 解析不到任何段落时返回空数组（调用方 fallback 原样展示）。
 */
export const parseDiagnosisSections = (
  diagnosis: string | undefined,
): Array<{ title: string; content: string }> => {
  if (!diagnosis) return [];
  const sections: Array<{ title: string; content: string }> = [];
  const re = /【([^】]+)】([\s\S]*?)(?=【|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(diagnosis)) !== null) {
    const content = match[2]?.replace(/\s*\|\s*$/, "").trim() ?? "";
    if (match[1]?.trim()) sections.push({ title: match[1].trim(), content });
  }
  return sections;
};