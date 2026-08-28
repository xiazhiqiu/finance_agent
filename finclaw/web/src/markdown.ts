import { marked } from "marked";
import { escapeHtml } from "./render-utils.ts";

// 渲染 Markdown 为 HTML。渲染前先整体转义原文，使任何原始 HTML 标签无法注入。
export function renderMarkdown(text: string): string {
  return marked.parse(escapeHtml(text), { gfm: true, breaks: true }) as string;
}
