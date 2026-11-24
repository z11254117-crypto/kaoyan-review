import * as S from "./scheduler.js";

const LS_KEY = "kaoyan.v1";
const APP_VERSION = "1.0.0";
const SUBJECTS = ["数学", "英语", "政治", "408", "专业课", "其他"];
const RESULT_META = {
  mastered: { label: "完全掌握", hint: "按原计划继续" },
  shaky: { label: "有印象但不熟", hint: "今天补强，明天再测一次" },
  forgotten: { label: "基本遗忘", hint: "重新学，按短周期重排" },
};

const viewEl = document.getElementById("view");
const overlayEl = document.getElementById("overlay");
const sheetBodyEl = document.getElementById("sheetBody");
const toastEl = document.getElementById("toast");
const examPillEl = document.getElementById("examPill");

let db = loadDB();
let today = S.todayISO();
const ui = { view: "today", sheet: null, data: {} };
let toastTimer = null;

/* ================= 数据层 ================= */
function uid(prefix) {
  return String(prefix || "i") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function defaultDB() {
  return {
    v: 1,
    settings: { exam: S.EXAM_DEFAULT, bufferDays: S.DEFAULT_BUFFER_DAYS, profile: "exam" },
    items: [],
    meta: { onboarded: false, createdAt: new Date().toISOString() },
  };
}

function normalizeDB(parsed) {
  const base = defaultDB();
  const src = parsed && typeof parsed === "object" ? parsed : {};
  return {
    ...base,
    ...src,
    settings: { ...base.settings, ...(src.settings || {}) },
    meta: { ...base.meta, ...(src.meta || {}) },
    items: Array.isArray(src.items) ? src.items : [],
  };
}

function loadDB() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultDB();
    return normalizeDB(JSON.parse(raw));
  } catch (err) {
    console.warn("读取本地数据失败，已使用空数据", err);
    return defaultDB();
  }
}

function save() {
  db.meta.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(db));
  } catch (err) {
    console.error(err);
    toast("保存失败：手机存储空间不足");
  }
}

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

/* ================= 查询 ================= */
const activeItems = () => db.items.filter((i) => !i.archived);
const findItem = (id) => db.items.find((i) => i.id === id);
const pendingOf = (item) => item.reviews.filter((r) => !r.doneAt).slice().sort((a, b) => a.date.localeCompare(b.date));
const doneCount = (item) => item.reviews.filter((r) => r.doneAt).length;
const nextPending = (item) => pendingOf(item)[0] || null;
const isOverdue = (item) => {
  const n = nextPending(item);
  return Boolean(n && n.date < today);
};
const pendingAll = () => activeItems().flatMap((item) => pendingOf(item).map((review) => ({ item, review })));
const deadline = () => S.deadlineFor(db.settings.exam, db.settings.bufferDays);

/** 当前生效的曲线节点：预设，或用户自定义数组 */
function currentOffsets() {
  const s = db.settings;
  if (s.profile === "custom") {
    const custom = S.normalizeOffsets(s.customOffsets || []);
    return custom.length >= 2 ? custom : S.PROFILES.exam.offsets.slice();
  }
  return S.getProfile(s.profile).offsets.slice();
}

function curveDesc() {
  const s = db.settings;
  if (s.profile === "custom") return "自定义节点：第 " + currentOffsets().join(" · ") + " 天";
  return S.getProfile(s.profile).desc;
}

function parseCurveInput(text) {
  const nums = String(text || "")
    .split(/[^0-9]+/)
    .filter((x) => x !== "")
    .map(Number);
  const offsets = S.normalizeOffsets(nums);
  const errs = [];
  if (nums.length < 2) errs.push("至少写 2 个节点");
  if (nums.length > S.MAX_CURVE_POINTS) errs.push("最多 8 个节点");
  if (nums.some((n) => n > 120)) errs.push("最远 120 天");
  if (offsets.length !== nums.length) errs.push("节点要递增、不重复，且都大于 0");
  return { nums, offsets, ok: errs.length === 0, errs };
}

function curvePreviewHTML(text) {
  const parsed = parseCurveInput(text);
  if (!parsed.ok) return '<span style="color:var(--danger)">' + parsed.errs[0] + "</span>";
  const meta = S.planForItem({
    today,
    exam: db.settings.exam,
    bufferDays: db.settings.bufferDays,
    profile: parsed.offsets,
    mode: "learn",
  });
  if (meta.windowClosed) return "现在录入已经没有复习窗口了（只剩轻量回顾）";
  return "今天首次学习的话：" + meta.reviews
    .map((r) => fmtMD(r.date) + (r.kind === "final" ? " 总复习" : ""))
    .join(" · ");
}

function curveEditorHTML() {
  const draft = ui.data.curveDraft != null ? ui.data.curveDraft : currentOffsets().join(",");
  return (
    '<div class="curve-editor">' +
    '<div class="row-sub">首次学习后第几天复习：逗号分隔，2–8 个、递增，最远 120 天（例：1,2,4,7,14,21）</div>' +
    '<div class="curve-input-row"><input id="curveInput" class="field-input" type="text" inputmode="numeric" value="' +
    esc(String(draft)) + '" />' +
    '<button class="btn btn-primary btn-sm" data-action="save-curve" type="button">保存并重排</button></div>' +
    '<div class="row-sub" id="curvePreview">' + curvePreviewHTML(draft) + "</div>" +
    "</div>"
  );
}

function fmtMD(iso) {
  const p = String(iso).split("-").map(Number);
  return p[1] + "月" + p[2] + "日";
}
function fmtShort(iso) {
  const p = String(iso).split("-").map(Number);
  return p[1] + "." + String(p[2]).padStart(2, "0");
}
function daysLabel(iso) {
  return fmtMD(iso) + " 周" + S.weekdayCN(iso);
}
function fmtRel(iso) {
  const n = S.diffDays(today, iso);
  if (n === 0) return "今天";
  if (n === 1) return "明天";
  if (n === 2) return "后天";
  if (n === -1) return "昨天";
  if (n < 0) return "逾期 " + -n + " 天";
  return n + " 天后";
}
function reviewLabel(item, review) {
  if (review.kind === "final") return "考前总复习";
  if (review.kind === "extra") return "补强再测";
  const idx = item.reviews.findIndex((r) => r.id === review.id);
  return "第 " + (idx + 1) + " 次复习";
}

/* ================= 小部件 ================= */
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2300);
}

function ringSVG(progress) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, progress)) * c;
  return (
    '<svg class="ring-svg" viewBox="0 0 110 110" aria-hidden="true">' +
    '<circle class="ring-track" cx="55" cy="55" r="' + r + '"/>' +
    '<circle class="ring-bar" cx="55" cy="55" r="' + r + '" stroke-dasharray="' + dash.toFixed(1) + " " + c.toFixed(1) + '"/>' +
    "</svg>"
  );
}

function emptyArt() {
  return (
    '<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2" opacity="0.45">' +
    '<circle cx="48" cy="48" r="30" stroke-dasharray="3 6"/>' +
    '<circle cx="48" cy="48" r="6" fill="currentColor" stroke="none"/>' +
    '<circle cx="78" cy="48" r="3.5" fill="currentColor" stroke="none"/>' +
    '<circle cx="48" cy="18" r="3.5" fill="currentColor" stroke="none"/>' +
    '<circle cx="27" cy="27" r="3.5" fill="currentColor" stroke="none"/>' +
    "</svg>"
  );
}

function emptyBlock() {
  const hasItems = activeItems().length > 0;
  return (
    '<div class="empty">' +
    '<div class="empty-art">' + emptyArt() + "</div>" +
    '<p class="empty-title">' + (hasItems ? "今天没有要复习的" : "还没有开始记录") + "</p>" +
    '<p class="empty-sub">' +
    (hasItems
      ? "该复习的都清完了。可以去学点新的，或者休息一会儿。"
      : "把今天学的内容录进来，App 会按 1·2·4·7·14·21 天排好后续复习，并倒推到考前留白。") +
    "</p>" +
    '<button class="btn btn-primary" data-action="open-add" type="button">' + (hasItems ? "录入今天的学习" : "开始记录") + "</button>" +
    "</div>"
  );
}

function taskCard(item, review) {
  const over = review.date < today;
  const isFinal = review.kind === "final";
  const flag = over
    ? '<span class="flag">' + fmtRel(review.date) + "</span>"
    : isFinal
      ? '<span class="flag flag-final">' + fmtMD(deadline()) + " 前复习完</span>"
      : "";
  return (
    '<button class="task' + (over ? " is-overdue" : "") + (isFinal ? " is-final" : "") +
    '" data-action="open-task" data-item="' + item.id + '" data-review="' + review.id + '" type="button">' +
    '<span class="task-mark" aria-hidden="true"></span>' +
    '<span class="task-body">' +
    '<span class="task-title">' + esc(item.title) + "</span>" +
    '<span class="task-meta"><span class="chip">' + esc(item.subject || "未分科") + "</span><span>" +
    reviewLabel(item, review) + "</span>" + flag + "</span>" +
    "</span>" +
    '<span class="task-go">打卡</span>' +
    "</button>"
  );
}

/* ================= 视图：今日 ================= */
function viewToday() {
  const left = Math.max(0, S.daysLeft(today, db.settings.exam));
  const dl = deadline();
  const all = pendingAll();
  const overdue = all.filter((t) => t.review.date < today);
  const due = all.filter((t) => t.review.date === today);
  const upcoming = all
    .slice()
    .sort((a, b) => a.review.date.localeCompare(b.review.date))
    .filter((t) => t.review.date > today)
    .slice(0, 3);
  const doneToday = activeItems().reduce(
    (n, item) => n + item.reviews.filter((r) => r.doneAt === today).length,
    0
  );
  const startDay = (db.meta.createdAt || new Date().toISOString()).slice(0, 10);
  const span = Math.max(1, S.diffDays(startDay, db.settings.exam));
  const progress = Math.max(0, Math.min(1, S.diffDays(startDay, today) / span));

  const parts = [];
  parts.push(
    '<section class="hero">' +
    '<div class="hero-main">' +
    '<p class="hero-kicker">距离考研初试</p>' +
    '<p class="hero-days"><span class="num">' + left + '</span><span class="unit">天</span></p>' +
    '<p class="hero-meta">' + fmtMD(db.settings.exam) + " 周" + S.weekdayCN(db.settings.exam) + " · 留白 " + db.settings.bufferDays + ' 天</p>' +
    '<p class="hero-meta2">最后复习日 ' + fmtMD(dl) + "，之后只做轻量回顾</p>" +
    "</div>" +
    '<div class="ring">' + ringSVG(progress) + '<span class="ring-label">' + Math.round(progress * 100) + "<i>%</i></span></div>" +
    "</section>"
  );

  parts.push(
    '<div class="stat-row">' +
    '<div class="stat"><b>' + doneToday + "</b><span>今日已打卡</span></div>" +
    '<div class="stat"><b>' + activeItems().length + "</b><span>跟踪中的知识点</span></div>" +
    '<div class="stat"><b>' + all.length + "</b><span>待复习总数</span></div>" +
    "</div>"
  );

  if (overdue.length) {
    parts.push(
      '<div class="banner"><span>有 ' + overdue.length + ' 项逾期，拖久了记忆会掉</span>' +
      '<button class="banner-btn" data-action="catch-up" type="button">一键顺延</button></div>'
    );
    parts.push(
      '<section class="section"><div class="section-head"><h2 class="section-title">逾期先补</h2>' +
      '<span class="section-hint">' + overdue.length + ' 项</span></div><div class="task-list">' +
      overdue.map((t) => taskCard(t.item, t.review)).join("") +
      "</div></section>"
    );
  }

  let dueBlock;
  if (due.length) {
    dueBlock = '<div class="task-list">' + due.map((t) => taskCard(t.item, t.review)).join("") + "</div>";
  } else if (!activeItems().length) {
    dueBlock = emptyBlock();
  } else {
    dueBlock =
      '<div class="empty compact"><p class="empty-title">今天没有要复习的</p>' +
      '<p class="empty-sub">' +
      (upcoming.length
        ? "下一次在 " + fmtRel(upcoming[0].review.date) + "：" + esc(upcoming[0].item.title)
        : "所有复习都已完成，等考试吧。") +
      "</p></div>";
  }
  parts.push(
    '<section class="section"><div class="section-head"><h2 class="section-title">今日复习</h2>' +
    '<span class="section-hint">' + (due.length ? due.length + " 项" : activeItems().length ? "无" : "") + "</span></div>" +
    dueBlock +
    "</section>"
  );

  if (upcoming.length) {
    parts.push(
      '<section class="section"><div class="section-head"><h2 class="section-title">接下来</h2>' +
      '<span class="section-hint">最近 ' + upcoming.length + " 项</span></div>" +
      '<div class="upcoming">' +
      upcoming.map((t) =>
        '<button class="plan-task" data-action="open-item" data-item="' + t.item.id + '" type="button">' +
        "<span>" + esc(t.item.title) + "</span>" +
        '<span class="chip">' + fmtRel(t.review.date) + " · " + fmtMD(t.review.date) + "</span></button>"
      ).join("") +
      "</div></section>"
    );
  }

  const wk = S.examWeek({ today, exam: db.settings.exam, bufferDays: db.settings.bufferDays });
  const light = wk.filter((d) => d.kind === "light");
  if (light.length) {
    parts.push(
      '<p class="plan-week-note">' + fmtMD(light[0].date) + "–" + fmtMD(light[light.length - 1].date) +
      " 是留白期：只做闭卷回忆和查漏，不再塞新内容。" + fmtMD(db.settings.exam) + " 考试。</p>"
    );
  }
  return parts.join("");
}

/* ================= 视图：计划 ================= */
function viewPlan() {
  const dl = deadline();
  const byDate = new Map();
  for (const t of pendingAll()) {
    if (!byDate.has(t.review.date)) byDate.set(t.review.date, []);
    byDate.get(t.review.date).push(t);
  }
  const end = S.diffDays(today, db.settings.exam);
  const rows = [];
  let count = 0;
  for (let i = 0; i <= Math.max(0, end); i++) {
    const iso = S.addDays(today, i);
    const tasks = byDate.get(iso) || [];
    const isExam = iso === db.settings.exam;
    const isCut = iso === dl;
    const isLight = iso > dl && !isExam && !tasks.length;
    if (!tasks.length && !isExam && !isCut && !isLight) continue;

    // 连续留白日合并成一行，别让计划页被 13 行「轻量回顾」占满
    if (isLight) {
      let j = i;
      while (j + 1 < end) {
        const next = S.addDays(today, j + 1);
        if ((byDate.get(next) || []).length) break;
        j += 1;
      }
      const startISO = iso;
      const endISO = S.addDays(today, j);
      rows.push(
        '<div class="plan-day is-light">' +
        '<div class="plan-date"><b>' + fmtShort(startISO) + (j > i ? "–" + fmtShort(endISO) : "") +
        "</b>留白</div>" +
        '<div class="plan-main"><div class="plan-label"><span class="light">轻量回顾：闭卷回忆 + 查漏</span></div>' +
        '<span class="plan-empty">' + (j - i + 1) + " 天不安排新复习</span></div></div>"
      );
      i = j;
      continue;
    }
    count += tasks.length;
    let label = "";
    if (isExam) label = '<div class="plan-label"><span class="exam">考研初试</span></div>';
    else if (isCut) label = '<div class="plan-label"><span>考前总复习日 · 之后留白</span></div>';
    if (isLight) label = '<div class="plan-label"><span class="light">留白期 · 顺带补一次</span></div>';
    let body;
    if (tasks.length) {
      body = '<div class="plan-tasks">' + tasks.map((t) =>
        '<button class="plan-task" data-action="open-item" data-item="' + t.item.id + '" type="button">' +
        "<span>" + esc(t.item.title) + "</span>" +
        '<span class="chip">' + esc(t.item.subject || "未分类") + "</span></button>"
      ).join("") + "</div>";
    } else if (isExam) {
      body = '<span class="plan-empty">上岸</span>';
    } else {
      body = '<span class="plan-empty">不安排新复习</span>';
    }
    rows.push(
      '<div class="plan-day' + (i === 0 ? " is-today" : "") + (isExam ? " is-exam" : "") + '">' +
      '<div class="plan-date"><b>' + fmtShort(iso) + "</b>周" + S.weekdayCN(iso) +
      (i === 0 ? "<em>今天</em>" : "") + "</div>" +
      '<div class="plan-main">' + label + body + "</div>" +
      "</div>"
    );
  }
  if (!rows.length) return emptyBlock();
  return (
    '<section class="section"><div class="section-head"><h2 class="section-title">到考前的复习安排</h2>' +
    '<span class="section-hint">' + count + " 次 · 截止 " + fmtMD(dl) + "</span></div>" +
    '<div class="card" style="padding:4px 14px"><div class="plan">' + rows.join("") + "</div></div>" +
    "</section>" +
    '<p class="settings-note">计划会随打卡结果和考试日期自动调整：排不下就压缩间隔，绝不超过 ' + fmtMD(dl) + "。</p>"
  );
}

/* ================= 视图：知识点 ================= */
function itemCard(item) {
  const total = item.reviews.length;
  const done = doneCount(item);
  const next = nextPending(item);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const over = isOverdue(item);
  const state = item.archived
    ? "已归档"
    : !next
      ? "全部复习完"
      : over
        ? "逾期 " + -S.diffDays(today, next.date) + " 天"
        : fmtRel(next.date);
  return (
    '<button class="item-card' + (over ? " is-overdue" : "") + '" data-action="open-item" data-item="' + item.id + '" type="button">' +
    '<span class="item-top"><span class="item-title">' + esc(item.title) + "</span>" +
    '<span class="item-next">' + state + "</span></span>" +
    '<span class="progress"><span class="progress-bar" style="width:' + pct + '%"></span></span>' +
    '<span class="item-foot"><span>' + esc(item.subject || "未分类") + " · " +
    (item.mode === "review" ? "从第 " + item.reviewNo + " 次复习开始" : "首次学习") +
    "</span><span>" + done + "/" + total + " 次</span></span>" +
    "</button>"
  );
}

function viewItems() {
  const list = db.items.slice().sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    const na = nextPending(a);
    const nb = nextPending(b);
    if (!na && !nb) return String(b.createdAt).localeCompare(String(a.createdAt));
    if (!na) return 1;
    if (!nb) return -1;
    return na.date.localeCompare(nb.date);
  });
  if (!list.length) return emptyBlock();
  return (
    '<section class="section"><div class="section-head"><h2 class="section-title">知识点</h2>' +
    '<span class="section-hint">' + list.length + " 个</span></div>" +
    '<div class="item-list">' + list.map(itemCard).join("") + "</div></section>"
  );
}

/* ================= 视图：设置 ================= */
function viewSettings() {
  const s = db.settings;
  return (
    '<section class="section">' +
    '<div class="section-label">考试与曲线</div>' +
    '<div class="card">' +
    '<div class="row"><div><div class="row-label">初试日期</div>' +
    '<div class="row-sub">所有复习都倒推到这天之前完成</div></div>' +
    '<input type="date" id="examDate" value="' + s.exam + '" /></div>' +
    '<div class="row"><div><div class="row-label">考前留白</div>' +
    '<div class="row-sub">最后复习日 = 考试日 − ' + s.bufferDays + " 天（0–14）</div></div>" +
    '<div class="stepper"><button data-action="buffer-step" data-step="-1" type="button">−</button>' +
    '<input id="bufferInput" class="num-input" type="number" min="0" max="14" value="' + s.bufferDays + '" />' +
    '<button data-action="buffer-step" data-step="1" type="button">+</button></div></div>' +
    '<div class="row row-stack"><div><div class="row-label">复习曲线</div>' +
    '<div class="row-sub">' + curveDesc() + "</div></div>" +
    '<div class="seg">' +
    '<button data-action="set-profile" data-profile="exam" class="' + (s.profile === "exam" ? "is-active" : "") + '" type="button">压缩</button>' +
    '<button data-action="set-profile" data-profile="standard" class="' + (s.profile === "standard" ? "is-active" : "") + '" type="button">常规</button>' +
    '<button data-action="set-profile" data-profile="custom" class="' + (s.profile === "custom" ? "is-active" : "") + '" type="button">自定义</button>' +
    "</div></div>" +
    (s.profile === "custom" ? curveEditorHTML() : "") +
    "</div>" +
    '<p class="settings-note" style="padding:10px 6px 0">动态调整：新录入的知识点按曲线往后排，一旦超过最后复习日就自动压缩间隔（一天最多一次），' +
    "放不下就砍掉靠后的次数。打卡结果、逾期顺延、改考试日 / 留白 / 曲线都会触发重排。</p>" +
    '<div class="section-label">装到手机桌面</div>' +
    '<div class="card" style="padding:14px 16px"><p class="mini" style="line-height:1.8">' +
    "用手机浏览器打开这个页面 → 浏览器菜单（⋮ 或分享按钮）→「添加到主屏幕 / 安装应用」。<br/>" +
    "装好后是一个独立图标，全屏运行，不显示地址栏，断网也能打卡。" +
    "</p></div>" +
    '<div class="section-label">数据</div>' +
    '<div class="card">' +
    '<button class="row" data-action="export-data" type="button"><span><span class="row-label">导出备份</span>' +
    '<span class="row-sub">存成 JSON 文件，换手机也能导回</span></span><span class="row-value">导出 ›</span></button>' +
    '<button class="row" data-action="import-data" type="button"><span><span class="row-label">导入备份</span>' +
    '<span class="row-sub">用备份覆盖当前数据</span></span><span class="row-value">导入 ›</span></button>' +
    '<button class="row" data-action="clear-data" type="button"><span><span class="row-label">清空数据</span>' +
    '<span class="row-sub">删除本机全部知识点与打卡</span></span>' +
    '<span class="row-value" style="color:var(--danger)">清空 ›</span></button>' +
    "</div>" +
    '<input type="file" id="importFile" accept="application/json,.json" hidden />' +
    '<p class="settings-note">数据只保存在这台手机的浏览器里（localStorage），不上传任何服务器。' +
    "建议每周导出一次备份。版本 " + APP_VERSION + "</p>" +
    "</section>"
  );
}

/* ================= 底部弹层 ================= */
function previewHTML() {
  const d = ui.data;
  const meta = S.planForItem({
    today,
    exam: db.settings.exam,
    bufferDays: db.settings.bufferDays,
    profile: db.settings.profile,
    mode: d.mode,
    reviewNo: d.reviewNo,
  });
  if (meta.windowClosed) {
    return (
      '<div class="preview-title">排出来的计划</div>' +
      '<div class="preview-warn">复习窗口已经关闭（今天是留白期或考试日），这条只做记录，不再排复习。</div>'
    );
  }
  const chips = meta.reviews
    .map((r) =>
      '<span class="preview-chip' + (r.kind === "final" ? " is-final" : "") + '">' +
      fmtMD(r.date) + (r.kind === "final" ? " 总复习" : "") + "</span>"
    )
    .join("");
  const warn = meta.compressed
    ? '<div class="preview-warn">离考试太近，间隔已压缩（' +
      (meta.dropped ? "去掉 " + meta.dropped + " 次、" : "") +
      "每天最多一次），保证在 " + fmtMD(meta.deadline) + " 前复习完。</div>"
    : "";
  return '<div class="preview-title">将生成 ' + meta.reviews.length + " 次复习</div>" +
    '<div class="preview-dates">' + chips + "</div>" + warn;
}

function sheetAdd() {
  const d = ui.data;
  return (
    '<h3 class="sheet-title">录入今天的学习</h3>' +
    '<p class="sheet-sub">每行一条，可以一次录多个知识点</p>' +
    '<div class="field"><textarea id="addText" class="field-textarea" placeholder="例如：&#10;TCP 三次握手与四次挥手&#10;进程调度算法">' +
    esc(d.text || "") + "</textarea></div>" +
    '<div class="field"><span class="field-label">科目</span><div class="chips" id="subjChips">' +
    SUBJECTS.map((s) =>
      '<button class="chip-btn' + (d.subject === s ? " is-active" : "") +
      '" data-action="pick-subject" data-subject="' + s + '" type="button">' + s + "</button>"
    ).join("") +
    "</div></div>" +
    '<div class="field"><span class="field-label">今天这是</span><div class="seg" id="modeSeg">' +
    '<button data-action="pick-mode" data-mode="learn" class="' + (d.mode === "learn" ? "is-active" : "") + '" type="button">第一次学</button>' +
    '<button data-action="pick-mode" data-mode="review" class="' + (d.mode === "review" ? "is-active" : "") + '" type="button">第 n 次复习</button>' +
    "</div>" +
    '<div class="stepper" id="reviewStepper" style="align-self:flex-start;' + (d.mode === "review" ? "" : "display:none;") + '">' +
    '<button data-action="step-review" data-step="-1" type="button">−</button>' +
    '<span id="reviewNo">' + d.reviewNo + "</span>" +
    '<button data-action="step-review" data-step="1" type="button">+</button></div></div>' +
    '<div class="preview" id="planPreview">' + previewHTML() + "</div>" +
    '<div class="add-foot"><button class="btn btn-primary btn-block" data-action="save-add" type="button">生成复习计划</button></div>'
  );
}

function sheetTask() {
  const item = findItem(ui.data.itemId);
  const review = item && item.reviews.find((r) => r.id === ui.data.reviewId);
  if (!item || !review) return '<h3 class="sheet-title">找不到这项复习</h3>';
  const over = review.date < today;
  return (
    '<h3 class="sheet-title">' + esc(item.title) + "</h3>" +
    '<p class="sheet-sub">' + reviewLabel(item, review) + " · " + daysLabel(review.date) +
    (over ? ' · <span class="flag">' + fmtRel(review.date) + "</span>" : "") + "</p>" +
    '<p class="field-label">这次复习的效果？</p>' +
    '<div class="result-list">' +
    Object.keys(RESULT_META).map((k) =>
      '<button class="result" data-action="complete" data-result="' + k + '" type="button">' +
      '<span class="result-label">' + RESULT_META[k].label + "</span>" +
      '<span class="result-hint">' + RESULT_META[k].hint + "</span></button>"
    ).join("") +
    "</div>" +
    '<div class="sheet-actions"><button class="btn btn-ghost" data-action="close-sheet" type="button">稍后再说</button></div>'
  );
}

function sheetItem() {
  const item = findItem(ui.data.itemId);
  if (!item) return '<h3 class="sheet-title">找不到这个知识点</h3>';
  const total = item.reviews.length;
  const done = doneCount(item);
  const rows = item.reviews
    .map((r) => {
      const cls = r.doneAt ? "is-done" : r.date < today ? "is-overdue" : r.kind === "final" ? "is-final" : "";
      const state = r.doneAt
        ? "已完成 · " + (RESULT_META[r.result] ? RESULT_META[r.result].label : "")
        : r.date < today
          ? "逾期"
          : r.date === today
            ? "今天"
            : fmtRel(r.date);
      const inner =
        '<span class="tl-dot"></span><span class="tl-body">' +
        '<span class="tl-date">' + daysLabel(r.date) + "</span>" +
        '<span class="tl-sub">' + reviewLabel(item, r) + " · " + state + "</span></span>";
      if (r.doneAt) return '<li class="tl-item ' + cls + '">' + inner + "</li>";
      return (
        '<li class="tl-item ' + cls + '"><button class="tl-row" data-action="open-task" data-item="' +
        item.id + '" data-review="' + r.id + '" type="button">' + inner + "</button></li>"
      );
    })
    .join("");
  const confirm = ui.data.confirmDelete;
  return (
    '<h3 class="sheet-title">' + esc(item.title) + "</h3>" +
    '<p class="sheet-sub">' + esc(item.subject || "未分类") + " · 已完成 " + done + "/" + total + " 次复习</p>" +
    '<ul class="timeline">' + rows + "</ul>" +
    (item.compressed ? '<p class="mini">这条的计划被压缩过：为了赶上考前留白，间隔按可用天数收紧了。</p>' : "") +
    '<div class="sheet-actions">' +
    '<button class="btn btn-ghost btn-sm" data-action="replan-item" type="button">重新排期</button>' +
    '<button class="btn btn-ghost btn-sm" data-action="archive-item" type="button">' + (item.archived ? "取消归档" : "归档") + "</button>" +
    (confirm
      ? '<button class="btn btn-danger btn-sm" data-action="delete-item" type="button">确认删除</button>'
      : '<button class="btn btn-ghost btn-sm" data-action="ask-delete" type="button">删除</button>') +
    "</div>" +
    '<div class="sheet-actions"><button class="btn btn-ghost btn-block" data-action="close-sheet" type="button">关闭</button></div>'
  );
}

function sheetOnboard() {
  return (
    '<h3 class="sheet-title">你的复习曲线，已经装好了</h3>' +
    '<p class="sheet-sub">照你和 ChatGPT 定下的习惯做的：</p>' +
    '<ul class="timeline">' +
    '<li class="tl-item"><span class="tl-dot"></span><span class="tl-body">' +
    '<span class="tl-date">1 · 录入今天学的</span>' +
    '<span class="tl-sub">写题目或知识点，标明是第一次学还是第 n 次复习</span></span></li>' +
    '<li class="tl-item"><span class="tl-dot"></span><span class="tl-body">' +
    '<span class="tl-date">2 · 按 1·2·4·7·14·21 天排</span>' +
    '<span class="tl-sub">每次复习后打卡：掌握 / 不熟 / 遗忘，计划会跟着调</span></span></li>' +
    '<li class="tl-item"><span class="tl-dot"></span><span class="tl-body">' +
    '<span class="tl-date">3 · 倒推到考前留白</span>' +
    '<span class="tl-sub">所有复习都排在 ' + fmtMD(deadline()) + " 前，" + fmtMD(S.addDays(deadline(), 1)) + " 起只做轻量回顾</span></span></li>" +
    "</ul>" +
    '<div class="sheet-actions"><button class="btn btn-primary btn-block" data-action="finish-onboard" type="button">开始</button></div>'
  );
}

function sheetConfirmClear() {
  return (
    '<h3 class="sheet-title">清空全部数据？</h3>' +
    '<p class="sheet-sub">会删除 ' + db.items.length + " 个知识点和所有打卡记录，无法撤销。建议先导出备份。</p>" +
    '<div class="sheet-actions"><button class="btn btn-ghost" data-action="close-sheet" type="button">取消</button>' +
    '<button class="btn btn-danger" data-action="confirm-clear" type="button">确认清空</button></div>'
  );
}

/* ================= 渲染 ================= */
const SHEETS = { add: sheetAdd, task: sheetTask, item: sheetItem, onboard: sheetOnboard, confirmClear: sheetConfirmClear };

function refreshExamPill() {
  const left = S.daysLeft(today, db.settings.exam);
  examPillEl.textContent = left >= 0 ? "距考试 " + left + " 天" : "考试已结束";
}

function render() {
  refreshExamPill();
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-active", b.dataset.view === ui.view));
  const builders = { today: viewToday, plan: viewPlan, items: viewItems, settings: viewSettings };
  viewEl.innerHTML = (builders[ui.view] || viewToday)();
  renderSheet();
  window.scrollTo({ top: 0 });
}

function renderSheet() {
  if (!ui.sheet) {
    overlayEl.hidden = true;
    document.body.classList.remove("no-scroll");
    return;
  }
  overlayEl.hidden = false;
  document.body.classList.add("no-scroll");
  const fn = SHEETS[ui.sheet];
  sheetBodyEl.innerHTML = fn ? fn() : "";
  if (ui.sheet === "add") updateAddUI();
}

function updateAddUI() {
  const d = ui.data;
  const chips = sheetBodyEl.querySelector("#subjChips");
  if (chips) chips.querySelectorAll(".chip-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.subject === d.subject));
  const seg = sheetBodyEl.querySelector("#modeSeg");
  if (seg) seg.querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === d.mode));
  const st = sheetBodyEl.querySelector("#reviewStepper");
  if (st) st.style.display = d.mode === "review" ? "" : "none";
  const no = sheetBodyEl.querySelector("#reviewNo");
  if (no) no.textContent = String(d.reviewNo);
  const pv = sheetBodyEl.querySelector("#planPreview");
  if (pv) pv.innerHTML = previewHTML();
}

/* ================= 业务动作 ================= */
function openSheet(name, data) {
  ui.sheet = name;
  ui.data = data || {};
  render();
}

function openAddSheet(preset) {
  ui.sheet = "add";
  ui.data = Object.assign({ subject: "408", mode: "learn", reviewNo: 1, text: "" }, preset || {});
  render();
  setTimeout(() => {
    const ta = sheetBodyEl.querySelector("#addText");
    if (ta) ta.focus({ preventScroll: true });
  }, 120);
}

function closeSheet() {
  ui.sheet = null;
  ui.data = {};
  render();
}

function addItems(lines, subject, mode, reviewNo) {
  const { exam, bufferDays } = db.settings;
  const profile = currentOffsets();
  for (const title of lines) {
    const meta = S.planForItem({ today, exam, bufferDays, profile, mode, reviewNo });
    db.items.unshift({
      id: uid("it"),
      title: String(title).slice(0, 120),
      subject,
      mode,
      reviewNo: mode === "review" ? reviewNo : 0,
      pos: mode === "review" ? Math.max(1, reviewNo) : 0,
      createdAt: new Date().toISOString(),
      deadline: meta.deadline,
      compressed: meta.compressed,
      windowClosed: meta.windowClosed,
      reviews: meta.reviews.map((r) => ({ id: uid("r"), date: r.date, kind: r.kind, doneAt: null, result: null })),
      archived: false,
    });
  }
  save();
}

function applyPlan(item, meta) {
  const done = item.reviews.filter((r) => r.doneAt);
  item.reviews = done.concat(
    meta.reviews.map((r) => ({ id: uid("r"), date: r.date, kind: r.kind, doneAt: null, result: null }))
  );
  item.deadline = meta.deadline;
  item.compressed = meta.compressed;
  item.windowClosed = meta.windowClosed;
}

function saveAdd() {
  const ta = sheetBodyEl.querySelector("#addText");
  const raw = ta ? ta.value : ui.data.text || "";
  const lines = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) {
    toast("先写一条今天学的内容");
    if (ta) ta.focus();
    return;
  }
  addItems(lines, ui.data.subject, ui.data.mode, ui.data.reviewNo);
  ui.sheet = null;
  ui.data = {};
  ui.view = "today";
  render();
  toast(lines.length > 1 ? "已排好 " + lines.length + " 条复习计划" : "已排好复习计划");
}

function completeReview(itemId, reviewId, result) {
  const item = findItem(itemId);
  const review = item && item.reviews.find((r) => r.id === reviewId);
  if (!item || !review || review.doneAt) {
    toast("这项已经打过卡了");
    closeSheet();
    return;
  }
  review.doneAt = today;
  review.result = result;
  const { exam, bufferDays } = db.settings;
  const profile = currentOffsets();

  if (result === "forgotten") {
    item.pos = 0;
    const offsets = S.remainingOffsets(profile, 0, { includeToday: false }).offsets;
    applyPlan(item, S.plan({ today, exam, bufferDays, profile, offsets }));
  } else if (result === "shaky") {
    item.pos = Math.min(item.pos + 1, 6);
    const base = S.remainingOffsets(profile, item.pos, { includeToday: true }).offsets;
    applyPlan(item, S.plan({ today, exam, bufferDays, profile, offsets: base.map((n) => n + 1) }));
  } else {
    item.pos += 1;
  }

  ui.sheet = null;
  ui.data = {};
  save();
  render();
  toast(
    result === "mastered"
      ? "打卡完成，按计划继续"
      : result === "shaky"
        ? "已安排明天再测一次"
        : "已按重学重排短周期"
  );
}

function replanOne(itemId) {
  const item = findItem(itemId);
  if (!item) return;
  const pending = pendingOf(item);
  if (!pending.length) {
    toast("这条已经没有待复习了");
    return;
  }
  const { exam, bufferDays } = db.settings;
  const profile = currentOffsets();
  const includeToday = pending[0].date <= today;
  const offsets = S.remainingOffsets(profile, item.pos, { includeToday }).offsets;
  applyPlan(item, S.plan({ today, exam, bufferDays, profile, offsets }));
  ui.data.confirmDelete = false;
  save();
  render();
  toast(includeToday ? "逾期那次放到今天，后续已重排" : "已重新排期");
}

function catchUpAll() {
  const { exam, bufferDays } = db.settings;
  const profile = currentOffsets();
  let n = 0;
  for (const item of activeItems()) {
    const pending = pendingOf(item);
    if (!pending.length || pending[0].date >= today) continue;
    const offsets = S.remainingOffsets(profile, item.pos, { includeToday: true }).offsets;
    applyPlan(item, S.plan({ today, exam, bufferDays, profile, offsets }));
    n += 1;
  }
  save();
  render();
  toast(n ? "已顺延 " + n + " 项，逾期那次今天补" : "没有需要顺延的");
}

function toggleArchive(itemId) {
  const item = findItem(itemId);
  if (!item) return;
  item.archived = !item.archived;
  save();
  render();
  toast(item.archived ? "已归档，不再出现在今日复习" : "已取消归档");
}

function deleteItem(itemId) {
  db.items = db.items.filter((i) => i.id !== itemId);
  ui.sheet = null;
  ui.data = {};
  save();
  render();
  toast("已删除");
}

function replanAll(opts) {
  const force = Boolean(opts && opts.force);
  const { exam, bufferDays } = db.settings;
  const profile = currentOffsets();
  const dl = S.deadlineFor(exam, bufferDays);
  let n = 0;
  for (const item of activeItems()) {
    const pending = pendingOf(item);
    if (!pending.length) continue;
    const last = pending[pending.length - 1].date;
    const due = pending[0].date <= today;
    const onlyFinal = pending.length === 1 && pending[0].kind === "final";
    // 只剩「考前总复习」时，跟着留白天数一起挪到新的截止日
    if (!force && !due && last <= dl && (!onlyFinal || last === dl)) continue;
    const offsets = S.remainingOffsets(profile, item.pos, { includeToday: due }).offsets;
    applyPlan(item, S.plan({ today, exam, bufferDays, profile, offsets }));
    n += 1;
  }
  if (n) save(); // 重排后的日期必须落盘，否则刷新就回到旧计划
  return n;
}

function setBuffer(v) {
  const next = Math.max(0, Math.min(14, Number(v) || 0));
  if (next === db.settings.bufferDays) return;
  db.settings.bufferDays = next;
  save();
  const n = replanAll();
  render();
  if (n) toast("留白改为 " + next + " 天，已重排 " + n + " 条");
}

function setProfile(p) {
  if (["exam", "standard", "custom"].indexOf(p) < 0 || p === db.settings.profile) return;
  if (p === "custom") {
    const custom = S.normalizeOffsets(db.settings.customOffsets || []);
    if (custom.length < 2) db.settings.customOffsets = S.PROFILES.exam.offsets.slice();
  }
  db.settings.profile = p;
  ui.data.curveDraft = null;
  save();
  const n = replanAll({ force: true });
  render();
  toast("曲线已切到" + curveDesc() + (n ? "，重排 " + n + " 条" : ""));
}

function saveCurve(text) {
  const parsed = parseCurveInput(text);
  if (!parsed.ok) {
    toast(parsed.errs[0]);
    return false;
  }
  db.settings.customOffsets = parsed.offsets;
  db.settings.profile = "custom";
  ui.data.curveDraft = null;
  save();
  const n = replanAll({ force: true });
  render();
  toast("曲线已保存：" + parsed.offsets.join(" · ") + " 天" + (n ? "，重排 " + n + " 条" : ""));
  return true;
}

function setExam(iso) {
  if (!S.isISO(iso) || iso === db.settings.exam) return;
  db.settings.exam = iso;
  save();
  const n = replanAll();
  render();
  toast("考试日改为 " + fmtMD(iso) + (n ? "，重排 " + n + " 条" : ""));
}

function exportData() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "复习曲线备份-" + today + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast("已导出备份文件");
}

async function importData(file) {
  try {
    const txt = await file.text();
    const parsed = JSON.parse(txt);
    if (!parsed || !Array.isArray(parsed.items)) throw new Error("bad backup");
    db = normalizeDB(parsed);
    save();
    render();
    toast("已导入 " + db.items.length + " 个知识点");
  } catch (err) {
    console.error(err);
    toast("导入失败：文件格式不对");
  }
}

function clearAll() {
  db = defaultDB();
  db.meta.onboarded = true;
  ui.sheet = null;
  ui.data = {};
  ui.view = "today";
  save();
  render();
  toast("已清空");
}

/* ================= 事件 ================= */
function onClick(e) {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  switch (action) {
    case "open-add":
      openAddSheet();
      break;
    case "close-sheet":
      closeSheet();
      break;
    case "open-task":
      openSheet("task", { itemId: el.dataset.item, reviewId: el.dataset.review });
      break;
    case "open-item":
      openSheet("item", { itemId: el.dataset.item });
      break;
    case "pick-subject":
      ui.data.subject = el.dataset.subject;
      updateAddUI();
      break;
    case "pick-mode":
      ui.data.mode = el.dataset.mode;
      updateAddUI();
      break;
    case "step-review":
      ui.data.reviewNo = Math.max(1, Math.min(6, (Number(ui.data.reviewNo) || 1) + Number(el.dataset.step)));
      updateAddUI();
      break;
    case "save-add":
      saveAdd();
      break;
    case "complete":
      completeReview(ui.data.itemId, ui.data.reviewId, el.dataset.result);
      break;
    case "catch-up":
      catchUpAll();
      break;
    case "replan-item":
      replanOne(ui.data.itemId);
      break;
    case "archive-item":
      toggleArchive(ui.data.itemId);
      break;
    case "ask-delete":
      ui.data.confirmDelete = true;
      render();
      break;
    case "delete-item":
      deleteItem(ui.data.itemId);
      break;
    case "buffer-step":
      setBuffer(Number(db.settings.bufferDays) + Number(el.dataset.step));
      break;
    case "set-profile":
      setProfile(el.dataset.profile);
      break;
    case "export-data":
      exportData();
      break;
    case "import-data": {
      const input = document.getElementById("importFile");
      if (input) input.click();
      break;
    }
    case "clear-data":
      openSheet("confirmClear");
      break;
    case "confirm-clear":
      clearAll();
      break;
    case "save-curve": {
      const input = document.getElementById("curveInput");
      saveCurve(input ? input.value : "");
      break;
    }
    case "finish-onboard":
      db.meta.onboarded = true;
      save();
      closeSheet();
      break;
    default:
      break;
  }
}

function onInput(e) {
  if (!e.target) return;
  if (e.target.id === "addText") ui.data.text = e.target.value;
  if (e.target.id === "curveInput") {
    ui.data.curveDraft = e.target.value;
    const pv = document.getElementById("curvePreview");
    if (pv) pv.innerHTML = curvePreviewHTML(e.target.value);
  }
}

function onChange(e) {
  const t = e.target;
  if (!t) return;
  if (t.id === "bufferInput") {
    setBuffer(t.value);
    return;
  }
  if (t.id === "examDate") {
    if (S.isISO(t.value)) setExam(t.value);
    return;
  }
  if (t.id === "importFile" && t.files && t.files[0]) {
    importData(t.files[0]);
    t.value = "";
  }
}

function init() {
  render();
  if (!db.meta.onboarded) openSheet("onboard");
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("SW 注册失败", err));
    });
  }
}

document.getElementById("tabbar").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b || !b.dataset.view) return;
  ui.view = b.dataset.view;
  render();
});
document.getElementById("fab").addEventListener("click", () => openAddSheet());
document.addEventListener("click", onClick);
document.addEventListener("input", onInput);
document.addEventListener("change", onChange);
setInterval(() => {
  const t = S.todayISO();
  if (t !== today) {
    today = t;
    render();
  }
}, 60000);

init();
