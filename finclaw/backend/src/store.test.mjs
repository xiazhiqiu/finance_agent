import assert from "node:assert/strict";
import test from "node:test";
import { uniqueSessionTitle } from "./store.mjs";

test("同一客户下标题重复时自动追加 (2)", () => {
  const sessions = [{ sessionId: "s1", customerId: "c1", title: "张三 - 营销会话 - 20260814" }];
  assert.equal(
    uniqueSessionTitle(sessions, "c1", "张三 - 营销会话 - 20260814"),
    "张三 - 营销会话 - 20260814 (2)",
  );
});

test("标题不重复时原样返回", () => {
  const sessions = [{ sessionId: "s1", customerId: "c1", title: "A" }];
  assert.equal(uniqueSessionTitle(sessions, "c1", "B"), "B");
});

test("不同客户允许同名", () => {
  const sessions = [{ sessionId: "s1", customerId: "c1", title: "A" }];
  assert.equal(uniqueSessionTitle(sessions, "c2", "A"), "A");
});

test("已存在 (2) 时继续追加 (3)", () => {
  const sessions = [
    { sessionId: "s1", customerId: "c1", title: "X" },
    { sessionId: "s2", customerId: "c1", title: "X (2)" },
  ];
  assert.equal(uniqueSessionTitle(sessions, "c1", "X"), "X (3)");
});

test("更新场景排除自身后标题不重复", () => {
  const sessions = [
    { sessionId: "s1", customerId: "c1", title: "X" },
    { sessionId: "s2", customerId: "c1", title: "X (2)" },
  ];
  // s2 自己保持 "X (2)" 不变（排除自身）
  assert.equal(uniqueSessionTitle(sessions, "c1", "X (2)", "s2"), "X (2)");
  // s1 想改成 "X" 时，因 s1 自身已占用，仍会追加 (2) 与其自身冲突？排除自身后 s1 无冲突
  assert.equal(uniqueSessionTitle(sessions, "c1", "X", "s1"), "X");
});
