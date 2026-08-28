// 洞察内容更新（updateLatestInsightContent）单元测试
// 使用独立临时 runtime 目录，不污染真实 .runtime/data
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "finclaw-insight-"));
process.env.FINANCE_RUNTIME_DIR = runtimeDir;
const { updateLatestInsightContent, getLatestInsightForCustomer } = await import("./store.mjs");

test.after(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

test("无洞察时 updateLatestInsightContent 返回 null", async () => {
  const result = await updateLatestInsightContent("CUST_NONE", "新内容");
  assert.equal(result, null);
});

test("更新最新一条洞察的 content，旧洞察保持不变", async () => {
  const insightsFile = path.join(runtimeDir, "insights.json");
  await writeFile(
    insightsFile,
    JSON.stringify({
      insights: [
        {
          insightId: "ins_old",
          customerId: "CUST_X",
          source: "llm",
          content: "旧洞察内容",
          tags: ["资产"],
          status: "pending",
          createdAt: "2026-01-01T00:00:00.000Z",
          confirmedAt: null,
        },
        {
          insightId: "ins_new",
          customerId: "CUST_X",
          source: "accepted",
          content: "最新洞察内容",
          tags: ["方案洞察"],
          status: "confirmed",
          createdAt: "2026-02-01T00:00:00.000Z",
          confirmedAt: "2026-02-02T00:00:00.000Z",
        },
      ],
    }),
  );

  const updated = await updateLatestInsightContent("CUST_X", "编辑后的最新洞察");
  assert.equal(updated.insightId, "ins_new");
  assert.equal(updated.content, "编辑后的最新洞察");
  // 元信息不变
  assert.equal(updated.createdAt, "2026-02-01T00:00:00.000Z");
  assert.equal(updated.status, "confirmed");

  const latest = await getLatestInsightForCustomer("CUST_X");
  assert.equal(latest.content, "编辑后的最新洞察");

  // 旧洞察未被触碰
  const data = JSON.parse(await (await import("node:fs/promises")).readFile(insightsFile, "utf8"));
  const old = data.insights.find((i) => i.insightId === "ins_old");
  assert.equal(old.content, "旧洞察内容");
});
