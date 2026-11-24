import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays, diffDays, deadlineFor, remainingOffsets, plan, planForItem, examWeek, daysLeft, todayISO,
  normalizeOffsets,
} from "../js/scheduler.js";

const EXAM = "2026-12-19";

test("日期工具：加减与相差", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-12-01", -1), "2026-11-30");
  assert.equal(diffDays("2026-11-24", "2026-12-19"), 25);
  assert.equal(deadlineFor(EXAM, 3), "2026-12-16");
  assert.equal(deadlineFor(EXAM, 0), "2026-12-19");
});

test("首次学习：按 1/2/4/7/14/21 天排，末尾补考前总复习", () => {
  const m = planForItem({ today: "2026-11-24", exam: EXAM, bufferDays: 3, profile: "exam", mode: "learn" });
  assert.deepEqual(m.reviews.map((r) => r.date), [
    "2026-11-25", "2026-11-26", "2026-11-28", "2026-12-01", "2026-12-08", "2026-12-15", "2026-12-16",
  ]);
  // 12/16 是考前总复习
  const f = m.reviews.at(-1);
  assert.equal(f.date, "2026-12-16");
  assert.equal(f.kind, "final");
  assert.equal(m.compressed, false);
});

test("今天是第 1 次复习：下一级从明天开始，逐级 1/3/6/13/20 天", () => {
  const m = planForItem({ today: "2026-11-24", exam: EXAM, bufferDays: 3, mode: "review", reviewNo: 1 });
  assert.deepEqual(m.reviews.map((r) => r.date), [
    "2026-11-25", "2026-11-27", "2026-11-30", "2026-12-07", "2026-12-14", "2026-12-16",
  ]);
  assert.equal(m.reviews.at(-1).kind, "final");
});

test("今天是第 4 次复习：只剩第 5、6 次 + 总复习", () => {
  const m = planForItem({ today: "2026-11-24", exam: EXAM, bufferDays: 3, mode: "review", reviewNo: 4 });
  // L=[1,2,4,7,14,21]；完成 4 次 → 剩余 gap5=7, gap6=7
  assert.deepEqual(m.reviews.map((r) => r.date), ["2026-12-01", "2026-12-08", "2026-12-16"]);
  assert.equal(m.reviews.at(-1).kind, "final");
});

test("今天是第 6 次复习：只补一次考前总复习", () => {
  const m = planForItem({ today: "2026-11-24", exam: EXAM, bufferDays: 3, mode: "review", reviewNo: 6 });
  assert.deepEqual(m.reviews.map((r) => r.date), ["2026-12-16"]);
  assert.equal(m.reviews[0].kind, "final");
});

test("第 n 次复习超出梯子（n=9）：夹到最后一档，不报错", () => {
  const m = planForItem({ today: "2026-11-24", exam: EXAM, bufferDays: 3, mode: "review", reviewNo: 9 });
  assert.deepEqual(m.reviews.map((r) => r.date), ["2026-12-16"]);
});

test("临近考试才学：整体压缩，全部落在 12/16 前，最后一天是总复习", () => {
  const m = planForItem({ today: "2026-12-10", exam: EXAM, bufferDays: 3, mode: "learn" });
  assert.equal(m.compressed, true);
  const dates = m.reviews.map((r) => r.date);
  assert.equal(dates.at(-1), "2026-12-16");
  assert.ok(dates.every((d) => d <= "2026-12-16"), dates.join(","));
  assert.equal(m.reviews.at(-1).kind, "final");
  // 相对天数必须是严格递增的
  const rel = dates.map((d) => diffDays("2026-12-10", d));
  for (let i = 1; i < rel.length; i++) assert.ok(rel[i] > rel[i - 1], rel.join(","));
});

test("只剩 3 天窗口（12/13 学）：一天一次，压到 3 次", () => {
  const m = planForItem({ today: "2026-12-13", exam: EXAM, bufferDays: 3, mode: "learn" });
  assert.equal(m.compressed, true);
  assert.deepEqual(m.reviews.map((r) => r.date), ["2026-12-14", "2026-12-15", "2026-12-16"]);
  assert.ok(m.dropped > 0);
});

test("窗口已关闭（12/16 当日及以后录入）：不再排复习，只提示轻量回顾", () => {
  const closed = planForItem({ today: "2026-12-16", exam: EXAM, bufferDays: 3, mode: "learn" });
  assert.equal(closed.windowClosed, true);
  assert.deepEqual(closed.reviews, []);
  const after = planForItem({ today: "2026-12-18", exam: EXAM, bufferDays: 3, mode: "review", reviewNo: 1 });
  assert.deepEqual(after.reviews, []);
});

test("逾期补课 includeToday：今天先补一次，再往后排", () => {
  // 已复习 2 次，原定下一次 11/27，但拖到今天 11/30 才补
  const { offsets } = remainingOffsets("exam", 2, { includeToday: true });
  assert.equal(offsets[0], 0);
  const m = plan({ today: "2026-11-30", exam: EXAM, bufferDays: 3, offsets });
  assert.equal(m.reviews[0].date, "2026-11-30");
  const dates = m.reviews.map((r) => r.date);
  for (let i = 1; i < dates.length; i++) assert.ok(dates[i] > dates[i - 1], dates.join(","));
  assert.ok(dates.at(-1) <= "2026-12-16");
});

test("常规曲线 1/3/7/15/30 也能排，且在考试前会被压缩", () => {
  const m = planForItem({ today: "2026-11-24", exam: EXAM, bufferDays: 3, profile: "standard", mode: "learn" });
  assert.equal(m.compressed, true);
  assert.ok(m.reviews.map((r) => r.date).at(-1) <= "2026-12-16");
});

test("考前留白期：12/17、12/18 轻量回顾，12/19 考试", () => {
  const wk = examWeek({ today: "2026-11-24", exam: EXAM, bufferDays: 3 });
  assert.deepEqual(wk.map((r) => r.date), ["2026-12-17", "2026-12-18", "2026-12-19"]);
  assert.equal(wk.at(-1).kind, "exam");
  assert.equal(daysLeft("2026-11-24", EXAM), 25);
});

test("今天默认值可用", () => {
  assert.match(todayISO(new Date(2026, 10, 24)), /^2026-11-24$/);
});

test("留白天数支持 0–14 天", () => {
  assert.equal(deadlineFor(EXAM, 0), "2026-12-19");
  assert.equal(deadlineFor(EXAM, 14), "2026-12-05");
  assert.equal(deadlineFor(EXAM, 99), "2026-12-05");
  assert.equal(deadlineFor(EXAM, -3), "2026-12-19");
});

test("自定义曲线：节点清洗（去重、递增、夹紧）", () => {
  // 保持输入顺序，只丢掉不递增/非正数（排序交给 UI 校验提示，不静默改写）
  assert.deepEqual(normalizeOffsets([3, 1, 2]), [3]);
  assert.deepEqual(normalizeOffsets([2, 2, 5]), [2, 5]);
  assert.deepEqual(normalizeOffsets([-1, 0, 4]), [4]);
  assert.deepEqual(normalizeOffsets([1, 2, 3, 4, 5, 6, 7, 8, 9]), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("自定义曲线：任意节点直接排期", () => {
  const m = planForItem({ today: "2026-11-24", exam: EXAM, bufferDays: 3, mode: "learn", profile: [2, 5, 9, 20] });
  assert.deepEqual(m.reviews.map((r) => r.date), ["2026-11-26", "2026-11-29", "2026-12-03", "2026-12-14", "2026-12-16"]);
  assert.equal(m.compressed, false);
  assert.equal(m.reviews.at(-1).kind, "final");
});

test("自定义曲线：离考试近时同样自动压缩", () => {
  const m = planForItem({ today: "2026-12-10", exam: EXAM, bufferDays: 3, mode: "learn", profile: [5, 10, 20, 40] });
  assert.equal(m.compressed, true);
  assert.deepEqual(m.reviews.map((r) => r.date), ["2026-12-11", "2026-12-12", "2026-12-13", "2026-12-16"]);
});

test("自定义留白不会越过考试日", () => {
  const m = planForItem({ today: "2026-11-24", exam: EXAM, bufferDays: 14, mode: "learn", profile: [2, 5, 9, 20] });
  assert.ok(m.reviews.every((r) => r.date <= "2026-12-05"));
  assert.equal(m.reviews.at(-1).date, "2026-12-05");
});
