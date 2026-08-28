import type { GenerateResult } from "./types.ts";

function isGenerateResult(value: unknown): value is GenerateResult {
  return Boolean(
    value && typeof value === "object" && Array.isArray((value as GenerateResult).plans),
  );
}

export function extractMessageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return "";
  return record.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

// 移除文本中包裹 JSON 的 ```json / ``` 代码块（含围栏行），其余内容原样保留。
export function stripJsonFence(text: string): string {
  return text.replace(/```(?:json)?[\s\S]*?```/gi, "");
}

export function parseGenerateResult(text: string): GenerateResult {
  const candidates = [text.trim()];
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(
    (match) => match[1]?.trim() ?? "",
  );
  candidates.push(...fences.reverse());
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace)
    candidates.push(text.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isGenerateResult(parsed)) return parsed;
    } catch {
      // Try the next candidate; models sometimes wrap the JSON in a code fence.
    }
  }
  throw new Error("Agent 未返回可识别的方案 JSON，请检查财富顾问 Agent 的 PASSTHROUGH 指令。");
}
