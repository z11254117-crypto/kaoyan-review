// 复习曲线引擎（纯函数，无 DOM，可单测）
// 曲线来自用户 ChatGPT 对话里形成的习惯：
//   1) 首次学习后按 1 / 2 / 4 / 7 / 14 / 21 天复习（考前压缩版）
//   2) 今天是「第 n 次复习」时，从该级梯子继续往后排
//   3) 所有复习必须落在 (考试日 - 留白天数) 之前，排不下就整体压缩
//   4) 最后补一次「考前总复习」，再把 考前留白期 留给轻量回顾

const DAY = 86400000;

export const EXAM_DEFAULT = "2026-12-19";
export const DEFAULT_BUFFER_DAYS = 3;

export const PROFILES = {
  exam: {
    id: "exam",
    name: "考前压缩版",
    desc: "首次学习后的复习节点：1 · 2 · 4 · 7 · 14 · 21 天",
    offsets: [1, 2, 4, 7, 14, 21],
  },
  standard: {
    id: "standard",
    name: "常规 1·3·7·15·30",
    desc: "首次学习后的复习节点：1 · 3 · 7 · 15 · 30 天",
    offsets: [1, 3, 7, 15, 30],
  },
};

export function getProfile(id) {
  return PROFILES[id] ?? PROFILES.exam;
}

/** 曲线节点清洗：只留正整数，去重并强制递增，最多保留 MAX_CURVE_POINTS 个 */
export const MAX_CURVE_POINTS = 8;
export function normalizeOffsets(list) {
  const nums = (Array.isArray(list) ? list : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.min(365, Math.round(n)));
  const out = [];
  for (const n of nums) {
    if (!out.length || n > out[out.length - 1]) out.push(n);
  }
  return out.slice(0, MAX_CURVE_POINTS);
}

/** 接受预设 id（exam/standard）或自定义节点数组，统一得到节点列表 */
export function resolveOffsets(profile) {
  if (Array.isArray(profile)) {
    const custom = normalizeOffsets(profile);
    return custom.length ? custom : PROFILES.exam.offsets.slice();
  }
  return getProfile(profile).offsets.slice();
}

export function parseISO(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function toISO(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export const addDays = (iso, n) => toISO(parseISO(iso) + n * DAY);
export const diffDays = (fromISO, toISO_) => Math.round((parseISO(toISO_) - parseISO(fromISO)) / DAY);
export const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(parseISO(s));

export function weekdayCN(iso) {
  return "日一二三四五六"[new Date(parseISO(iso)).getUTCDay()];
}

export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function deadlineFor(exam, bufferDays = DEFAULT_BUFFER_DAYS) {
  const b = Math.max(0, Math.min(14, Number(bufferDays) || 0));
  return addDays(exam, -b);
}

/**
 * 从「已经复习完 completed 次」的位置，向后排剩余复习的相对天数。
 * 锚点 = 今天。
 *   includeToday=true  → 今天还要补一次复习（逾期补课），偏移从 0 开始
 *   includeToday=false → 今天这次已经做完（刚录入 / 刚打卡），偏移从下一级开始
 */
export function remainingOffsets(profileId, completed = 0, { includeToday = false } = {}) {
  const L = resolveOffsets(profileId);
  const M = L.length;
  const c = Math.max(0, Math.min(Number(completed) || 0, M));
  const gap = (k) => (k === 0 ? L[0] : L[k] - L[k - 1]);
  const out = [];
  let t = 0;
  if (includeToday) out.push(0);
  for (let k = includeToday ? c + 1 : c; k < M; k++) {
    t += gap(k);
    out.push(t);
  }
  return { offsets: out, rungs: out.map((_, i) => c + i) };
}

/**
 * 由偏移生成具体复习计划。
 * 若最远的一级超过 deadline，则整体压缩；连一天一次都放不下就截断。
 */
export function plan({ today, exam, bufferDays = DEFAULT_BUFFER_DAYS, profile = "exam", offsets = [], includeFinal = true }) {
  const deadline = deadlineFor(exam, bufferDays);
  const span = diffDays(today, deadline);
  const list = (offsets || []).filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  const meta = { deadline, span, compressed: false, windowClosed: span < 1, dropped: 0, reviews: [] };

  if (span < 1) return meta;

  if (list.length === 0) {
    // 梯子已经走完（或只剩「补一次总复习」）：今天之后的唯一安排就是考前总复习
    if (includeFinal) meta.reviews = [{ date: deadline, kind: "final" }];
    return meta;
  }

  const last = list[list.length - 1];
  let dates;
  if (last <= span) {
    dates = list.map((o) => ({ date: addDays(today, o), kind: "review" }));
  } else {
    meta.compressed = true;
    const fit = Math.min(list.length, span); // 最多能放几次：一天一次
    if (span >= list.length) {
      // 还能保住所有次数：按比例压到 deadline
      const scaled = list.map((o) => (o === 0 ? 0 : Math.max(1, Math.round((o * span) / last))));
      for (let i = 1; i < scaled.length; i++) {
        if (scaled[i] <= scaled[i - 1]) scaled[i] = scaled[i - 1] + 1;
      }
      dates = scaled.map((o) => ({ date: addDays(today, o), kind: "review" }));
    } else {
      meta.dropped = list.length - fit;
      dates = [];
      for (let i = 1; i <= fit; i++) dates.push({ date: addDays(today, i), kind: "review" });
    }
  }

  if (includeFinal) {
    const lastDate = dates.length ? dates[dates.length - 1].date : null;
    if (!lastDate) {
      dates.push({ date: deadline, kind: "final" });
    } else if (diffDays(lastDate, deadline) >= 1) {
      dates.push({ date: deadline, kind: "final" });
    } else if (lastDate === deadline) {
      dates[dates.length - 1].kind = "final";
    }
  }

  meta.reviews = dates;
  return meta;
}

/** 录入 / 重排的统一入口 */
export function planForItem({
  today,
  exam,
  bufferDays = DEFAULT_BUFFER_DAYS,
  profile = "exam",
  mode = "learn",       // 'learn' 今天第一次学 | 'review' 今天是第 n 次复习
  reviewNo = 0,
  includeToday = false,
}) {
  const completed = mode === "learn" ? 0 : Math.max(1, Number(reviewNo) || 1);
  const { offsets, rungs } = remainingOffsets(profile, completed, { includeToday });
  const meta = plan({ today, exam, bufferDays, profile, offsets });
  meta.reviews = meta.reviews.map((r, i) => ({ ...r, rung: r.kind === "review" ? rungs[i] ?? null : null }));
  return meta;
}

/** 考前留白期：deadline 之后到考试前一天 = 轻量回顾 */
export function examWeek({ today, exam, bufferDays = DEFAULT_BUFFER_DAYS }) {
  const deadline = deadlineFor(exam, bufferDays);
  const out = [];
  const end = diffDays(today, exam);
  for (let i = diffDays(today, deadline) + 1; i < end; i++) {
    out.push({ date: addDays(today, i), kind: "light" });
  }
  if (end >= 0) out.push({ date: exam, kind: "exam" });
  return out;
}

/** 考试倒计时（天）；已考完为负数 */
export function daysLeft(today, exam) {
  return diffDays(today, exam);
}

/** 复习压力：某天挂了多少次复习 */
export function loadByDate(reviews) {
  const map = new Map();
  for (const r of reviews) map.set(r.date, (map.get(r.date) ?? 0) + 1);
  return map;
}
