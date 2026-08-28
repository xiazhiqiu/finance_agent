const sections = [
  ["talkTemplates", "话术模板"],
  ["productPriority", "产品优先度"],
  ["stylePreference", "风格偏好"],
  ["compliance", "合规经验"],
  ["followUp", "跟进策略"],
];

export function parseKnowledgeMarkdown(markdown) {
  const value = String(markdown || "").replace(/\r\n/g, "\n");
  const matches = [...value.matchAll(/^###\s+(话术模板|产品优先度|风格偏好|合规经验|跟进策略)\s*$/gm)];
  const result = { talkTemplates: "", productPriority: "", stylePreference: "", compliance: "", followUp: "" };
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const section = sections.find(([, heading]) => heading === match[1]);
    if (!section || match.index === undefined) continue;
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? value.length;
    result[section[0]] = value.slice(start, end).trim();
  }
  return result;
}

export function composeKnowledgeMarkdown(fields) {
  return `${sections
    .map(([key, heading]) => `### ${heading}\n\n${String(fields?.[key] || "").trim()}`)
    .join("\n\n")}\n`;
}
