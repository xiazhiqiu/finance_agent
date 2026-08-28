const OLD_PLACEHOLDER_TITLE_RE = /^\d{4}-\d{2}-\d{2} 对话$/;
const ISO_DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})/;

function formatYyyymmdd(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

// 生成默认标题「客户名 - 营销会话 - YYYYMMDD」，日期取自 createdAt 的日期部分。
// customerName 为空或全空白时返回空字符串，由调用方自行回退。
export function defaultSessionTitle(customerName: string, createdAt: string): string {
  const name = customerName.trim();
  if (!name) return "";
  const match = ISO_DATE_PREFIX_RE.exec(createdAt.trim());
  const yyyymmdd =
    match && !Number.isNaN(new Date(createdAt).getTime())
      ? `${match[1]}${match[2]}${match[3]}`
      : formatYyyymmdd(new Date());
  return `${name} - 营销会话 - ${yyyymmdd}`;
}

// 判断标题是否为旧占位名（形如「2026-08-14 对话」）。
export function isOldPlaceholderTitle(title: string): boolean {
  return OLD_PLACEHOLDER_TITLE_RE.test(title);
}
