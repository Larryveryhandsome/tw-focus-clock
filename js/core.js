/*
 * tw-focus-clock 核心（純函式，不碰畫面、不碰 localStorage）
 * 瀏覽器：window.FocusCore；Node：require('./core.js')
 *
 * 內容：時間格式（zh-TW）、計時器狀態機（以時間戳記計算）、任務操作、
 *       跨日延續未完成任務、每日統計與連續天數、備份檔驗證。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FocusCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 日期與格式 ----------
  const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const WEEKDAYS_SHORT = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const pad2 = n => String(n).padStart(2, '0');

  function toDate(d) { return d instanceof Date ? d : new Date(d); }

  /** 本地時間的日期字串 YYYY-MM-DD（用來分「哪一天」） */
  function dateKey(d) {
    d = toDate(d);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function isDateKey(s) {
    const m = KEY_RE.exec(String(s));
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }

  /** 日期字串加減天數（用 UTC 算，不受夏令時間影響；自動跨月、跨年、閏年） */
  function addDays(key, n) {
    const m = KEY_RE.exec(String(key));
    if (!m) throw new Error('日期格式錯誤：' + key);
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }

  /** 兩個日期字串相差幾天（b - a） */
  function diffDays(a, b) {
    const pa = KEY_RE.exec(a), pb = KEY_RE.exec(b);
    if (!pa || !pb) return NaN;
    return Math.round((Date.UTC(+pb[1], +pb[2] - 1, +pb[3]) - Date.UTC(+pa[1], +pa[2] - 1, +pa[3])) / 86400000);
  }

  /** 13:05:09；hour12 時為「下午 1:05:09」 */
  function formatClock(d, opts) {
    d = toDate(d);
    const o = opts || {};
    const sec = o.seconds === false ? '' : ':' + pad2(d.getSeconds());
    if (o.hour12) {
      const h = d.getHours();
      const ap = h < 12 ? '上午' : '下午';
      return `${ap} ${h % 12 || 12}:${pad2(d.getMinutes())}${sec}`;
    }
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${sec}`;
  }

  /** 2026年10月20日 星期二 */
  function formatDateZh(d) {
    d = toDate(d);
    return `${d.getFullYear()}年${pad2(d.getMonth() + 1)}月${pad2(d.getDate())}日 ${WEEKDAYS[d.getDay()]}`;
  }

  /** 10月20日 週二 */
  function formatShortDateZh(d) {
    d = toDate(d);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS_SHORT[d.getDay()]}`;
  }

  /** 日期字串 → 10/20（週二） */
  function formatKeyShort(key) {
    const m = KEY_RE.exec(key);
    if (!m) return String(key);
    const wd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
    return `${+m[2]}/${+m[3]}（${WEEKDAYS_SHORT[wd].slice(1)}）`;
  }

  /** 倒數顯示：剩 1.2 秒顯示 00:02（無條件進位，歸零那一刻才顯示 00:00） */
  function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  }

  /** 秒數 → 「25 分鐘」「1 小時 5 分」 */
  function formatMinutes(seconds) {
    const min = Math.floor(Math.max(0, Number(seconds) || 0) / 60);
    if (min < 60) return `${min} 分鐘`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
  }

  // ---------- 計時器狀態機 ----------
  // 狀態只存「結束時間戳記」或「暫停時剩多少」，不靠每秒累加，
  // 所以分頁被節流、手機鎖屏、重新整理後都算得準。
  const MODES = ['focus', 'short', 'long'];
  const PHASES = ['idle', 'running', 'paused', 'done'];
  const MAX_DURATION = 24 * 3600 * 1000;

  function createTimer(mode, durationMs, taskId) {
    return {
      phase: 'idle',
      mode: MODES.includes(mode) ? mode : 'focus',
      durationMs: durationMs,
      remainingMs: durationMs,
      endAt: null,
      startedAt: null,
      finishedAt: null,
      taskId: taskId == null ? null : taskId,
    };
  }

  function startTimer(t, now) {
    if (t.phase === 'running') return t;
    const remaining = t.phase === 'done' ? t.durationMs : t.remainingMs;
    if (!(remaining > 0)) return Object.assign({}, t, { phase: 'done', remainingMs: 0, endAt: null, finishedAt: now });
    return Object.assign({}, t, {
      phase: 'running',
      endAt: now + remaining,
      remainingMs: remaining,
      startedAt: t.phase === 'done' || t.startedAt == null ? now : t.startedAt,
      finishedAt: null,
    });
  }

  function pauseTimer(t, now) {
    if (t.phase !== 'running') return t;
    const r = Math.max(0, t.endAt - now);
    if (r === 0) return Object.assign({}, t, { phase: 'done', remainingMs: 0, endAt: null, finishedAt: t.endAt });
    return Object.assign({}, t, { phase: 'paused', remainingMs: r, endAt: null });
  }

  const resumeTimer = startTimer;

  function remainingMs(t, now) {
    if (t.phase === 'running') return Math.max(0, t.endAt - now);
    if (t.phase === 'done') return 0;
    return t.remainingMs;
  }

  function elapsedMs(t, now) {
    return Math.max(0, t.durationMs - remainingMs(t, now));
  }

  function progress(t, now) {
    return t.durationMs > 0 ? Math.min(1, elapsedMs(t, now) / t.durationMs) : 0;
  }

  /** 時間到了就轉成 done；finishedAt 是「應該結束的時間」，不是發現的時間 */
  function tickTimer(t, now) {
    if (t.phase === 'running' && now >= t.endAt) {
      return Object.assign({}, t, { phase: 'done', remainingMs: 0, finishedAt: t.endAt, endAt: null });
    }
    return t;
  }

  function resetTimer(t, durationMs) {
    return createTimer(t.mode, durationMs == null ? t.durationMs : durationMs, t.taskId);
  }

  /** 專注完下一段：每 every 次專注後長休息，其餘短休息；休息完回到專注 */
  function nextMode(mode, focusCount, every) {
    if (mode !== 'focus') return 'focus';
    const n = Math.max(1, Math.floor(every) || 4);
    return focusCount > 0 && focusCount % n === 0 ? 'long' : 'short';
  }

  /** 從 localStorage 讀回來的計時器：格式不對就用 fallback */
  function restoreTimer(raw, fallback) {
    if (!raw || typeof raw !== 'object') return fallback;
    if (!MODES.includes(raw.mode) || !PHASES.includes(raw.phase)) return fallback;
    const d = raw.durationMs;
    if (!Number.isFinite(d) || d <= 0 || d > MAX_DURATION) return fallback;
    const t = createTimer(raw.mode, d, typeof raw.taskId === 'string' ? raw.taskId : null);
    t.phase = raw.phase;
    t.startedAt = Number.isFinite(raw.startedAt) ? raw.startedAt : null;
    t.finishedAt = Number.isFinite(raw.finishedAt) ? raw.finishedAt : null;
    if (raw.phase === 'running') {
      if (!Number.isFinite(raw.endAt)) return fallback;
      t.endAt = raw.endAt;
      t.remainingMs = Math.min(d, Math.max(0, raw.remainingMs || d));
    } else if (raw.phase === 'paused') {
      if (!Number.isFinite(raw.remainingMs) || raw.remainingMs <= 0 || raw.remainingMs > d) return fallback;
      t.remainingMs = raw.remainingMs;
    } else if (raw.phase === 'done') {
      t.remainingMs = 0;
    }
    return t;
  }

  // ---------- 任務 ----------
  const TITLE_MAX = 80;

  function sanitizeTitle(s) {
    return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  }

  function newId(now, rand) {
    const r = Math.floor((rand == null ? Math.random() : rand) * 1e8).toString(36);
    return 't' + Math.floor(now).toString(36) + r;
  }

  function tasksForDate(tasks, key) {
    return tasks.filter(t => t.date === key);
  }

  /** 新增任務；一天最多 max 件（預設 3，就是「今日三件事」） */
  function addTask(tasks, input, opts) {
    const o = opts || {};
    const max = o.max || 3;
    const title = sanitizeTitle(input && input.title);
    if (!title) return { tasks, error: 'empty' };
    if (!isDateKey(input.date)) return { tasks, error: 'date' };
    if (tasksForDate(tasks, input.date).length >= max) return { tasks, error: 'full' };
    const now = o.now == null ? Date.now() : o.now;
    const task = {
      id: o.id || newId(now),
      title,
      category: String(input.category || 'work'),
      date: input.date,
      status: 'pending',
      duration: 0,
      createdAt: now,
      completedOn: null,
    };
    return { tasks: tasks.concat(task), task };
  }

  function editTask(tasks, id, patch) {
    return tasks.map(t => {
      if (t.id !== id) return t;
      const next = Object.assign({}, t);
      if (patch.title !== undefined) {
        const title = sanitizeTitle(patch.title);
        if (title) next.title = title;
      }
      if (patch.category !== undefined) next.category = String(patch.category);
      return next;
    });
  }

  function setCompleted(tasks, id, done, todayKey) {
    return tasks.map(t => t.id !== id ? t
      : Object.assign({}, t, { status: done ? 'completed' : 'pending', completedOn: done ? todayKey : null }));
  }

  function removeTask(tasks, id) {
    return tasks.filter(t => t.id !== id);
  }

  function addFocusSeconds(tasks, id, seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (!id || !s) return tasks;
    return tasks.map(t => t.id !== id ? t : Object.assign({}, t, { duration: (t.duration || 0) + s }));
  }

  // ---------- 跨日延續 ----------
  /** 以前的日子還沒完成的任務（舊的在前） */
  function findCarryOver(tasks, todayKey) {
    return tasks
      .filter(t => t.status === 'pending' && isDateKey(t.date) && t.date < todayKey)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /**
   * 把選定的未完成任務搬到今天（保留已專注時間，記下原本日期 carriedFrom）。
   * 今天放不下的留在原日期，回傳在 skipped。
   */
  function carryOver(tasks, ids, todayKey, max) {
    const limit = max || 3;
    let room = Math.max(0, limit - tasksForDate(tasks, todayKey).length);
    const wanted = new Set(ids);
    const moved = [], skipped = [];
    const candidates = findCarryOver(tasks, todayKey).filter(t => wanted.has(t.id));
    const moveIds = new Set();
    for (const t of candidates) {
      if (room > 0) { moveIds.add(t.id); moved.push(t.id); room--; } else skipped.push(t.id);
    }
    const next = tasks.map(t => !moveIds.has(t.id) ? t
      : Object.assign({}, t, { date: todayKey, carriedFrom: t.carriedFrom || t.date }));
    return { tasks: next, moved, skipped };
  }

  // ---------- 統計 ----------
  /** 記一筆專注時間到某天：log = { 'YYYY-MM-DD': { seconds, sessions } } */
  function logFocus(log, key, seconds, countSession) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    const prev = log[key] || { seconds: 0, sessions: 0 };
    const next = Object.assign({}, log);
    next[key] = { seconds: prev.seconds + s, sessions: prev.sessions + (countSession === false ? 0 : 1) };
    return next;
  }

  function completedOnDay(t) { return t.completedOn || t.date; }

  function dayStats(tasks, log, key) {
    const entry = log[key] || { seconds: 0, sessions: 0 };
    return {
      date: key,
      completed: tasks.filter(t => t.status === 'completed' && completedOnDay(t) === key).length,
      focusSeconds: entry.seconds,
      focusMinutes: Math.floor(entry.seconds / 60),
      sessions: entry.sessions,
    };
  }

  /** 「有在前進」的日子：當天完成至少 1 件，或專注滿 1 分鐘 */
  function activeDays(tasks, log) {
    const set = new Set();
    for (const t of tasks) if (t.status === 'completed' && isDateKey(completedOnDay(t))) set.add(completedOnDay(t));
    for (const k of Object.keys(log)) if (log[k] && log[k].seconds >= 60) set.add(k);
    return set;
  }

  /** 連續天數：今天還沒動也不算斷，從昨天往回數 */
  function streak(tasks, log, todayKey) {
    const set = activeDays(tasks, log);
    let d = set.has(todayKey) ? todayKey : addDays(todayKey, -1);
    let n = 0;
    while (set.has(d)) { n++; d = addDays(d, -1); }
    return n;
  }

  function lastNDays(tasks, log, todayKey, n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(dayStats(tasks, log, addDays(todayKey, -i)));
    return out;
  }

  /** 某個月（'2026-10'）各分類累積的專注秒數 */
  function categoryTotals(tasks, monthPrefix) {
    const out = {};
    for (const t of tasks) {
      if (!String(t.date).startsWith(monthPrefix)) continue;
      out[t.category] = (out[t.category] || 0) + (t.duration || 0);
    }
    return out;
  }

  // ---------- 設定 ----------
  function clampInt(v, lo, hi, def) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  }

  function normalizeSettings(raw, defaults) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const d = defaults || {};
    const bool = (v, def) => (typeof v === 'boolean' ? v : !!def);
    return {
      focusMinutes: clampInt(r.focusMinutes, 1, 180, d.focusMinutes || 25),
      shortBreakMinutes: clampInt(r.shortBreakMinutes, 1, 60, d.shortBreakMinutes || 5),
      longBreakMinutes: clampInt(r.longBreakMinutes, 1, 90, d.longBreakMinutes || 15),
      longBreakEvery: clampInt(r.longBreakEvery, 1, 12, d.longBreakEvery || 4),
      sound: bool(r.sound, d.sound !== false),
      keepAwake: bool(r.keepAwake, d.keepAwake !== false),
      autoStartNext: bool(r.autoStartNext, d.autoStartNext),
      theme: ['system', 'light', 'dark'].includes(r.theme) ? r.theme : (d.theme || 'system'),
      clockStyle: ['both', 'digital'].includes(r.clockStyle) ? r.clockStyle : (d.clockStyle || 'both'),
      hour12: bool(r.hour12, d.hour12),
    };
  }

  function modeMinutes(settings, mode) {
    return mode === 'short' ? settings.shortBreakMinutes : mode === 'long' ? settings.longBreakMinutes : settings.focusMinutes;
  }

  // ---------- 備份 ----------
  const APP_ID = 'tw-focus-clock';
  const BACKUP_VERSION = 1;
  const MAX_TASKS = 20000;

  function makeBackup(data, now) {
    return {
      app: APP_ID,
      version: BACKUP_VERSION,
      exportedAt: new Date(now == null ? Date.now() : now).toISOString(),
      tasks: data.tasks || [],
      focusLog: data.focusLog || {},
      settings: data.settings || {},
    };
  }

  /** 驗證一筆任務，回傳整理過的任務；不合格回傳錯誤字串 */
  function validateTask(t) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return '不是物件';
    const id = typeof t.id === 'number' && Number.isFinite(t.id) ? String(t.id) : t.id;
    if (typeof id !== 'string' || !id || id.length > 64) return 'id 錯誤';
    const title = sanitizeTitle(t.title);
    if (!title) return '沒有標題';
    if (!isDateKey(t.date)) return '日期錯誤';
    if (t.status !== 'pending' && t.status !== 'completed') return '狀態錯誤';
    const duration = t.duration == null ? 0 : Number(t.duration);
    if (!Number.isFinite(duration) || duration < 0 || duration > 1e8) return '專注時間錯誤';
    if (t.completedOn != null && !isDateKey(t.completedOn)) return '完成日期錯誤';
    const out = {
      id, title,
      category: typeof t.category === 'string' && t.category ? t.category.slice(0, 32) : 'work',
      date: t.date,
      status: t.status,
      duration: Math.round(duration),
      createdAt: Number.isFinite(t.createdAt) ? t.createdAt : null,
      completedOn: t.status === 'completed' ? (t.completedOn || t.date) : null,
    };
    if (isDateKey(t.carriedFrom)) out.carriedFrom = t.carriedFrom;
    return out;
  }

  /**
   * 驗證備份檔（JSON 字串或物件）。也接受舊版「時。刻」網頁的 moment_tasks_web 任務陣列。
   * 任何一筆不合格就整個拒絕，避免匯入一半。
   */
  function validateBackup(input, defaults) {
    let obj = input;
    if (typeof input === 'string') {
      try { obj = JSON.parse(input); } catch (e) { return { ok: false, error: '不是有效的 JSON 檔' }; }
    }
    let tasksRaw, logRaw = {}, settingsRaw = {};
    if (Array.isArray(obj)) {
      tasksRaw = obj; // 舊版格式
    } else {
      if (!obj || typeof obj !== 'object') return { ok: false, error: '檔案內容不是備份格式' };
      if (obj.app !== APP_ID) return { ok: false, error: '這不是「時。刻 專注時鐘」的備份檔' };
      if (!Number.isInteger(obj.version) || obj.version < 1) return { ok: false, error: '備份檔版本錯誤' };
      if (obj.version > BACKUP_VERSION) return { ok: false, error: '備份檔來自較新的版本，請先更新網頁' };
      if (!Array.isArray(obj.tasks)) return { ok: false, error: '備份檔缺少任務清單' };
      tasksRaw = obj.tasks;
      logRaw = obj.focusLog == null ? {} : obj.focusLog;
      settingsRaw = obj.settings == null ? {} : obj.settings;
      if (typeof logRaw !== 'object' || Array.isArray(logRaw)) return { ok: false, error: '專注紀錄格式錯誤' };
    }
    if (tasksRaw.length > MAX_TASKS) return { ok: false, error: '任務太多筆，檔案可能有誤' };
    const tasks = [], seen = new Set();
    for (let i = 0; i < tasksRaw.length; i++) {
      const v = validateTask(tasksRaw[i]);
      if (typeof v === 'string') return { ok: false, error: `第 ${i + 1} 筆任務${v}` };
      if (seen.has(v.id)) return { ok: false, error: `第 ${i + 1} 筆任務 id 重複` };
      seen.add(v.id);
      tasks.push(v);
    }
    const focusLog = {};
    for (const k of Object.keys(logRaw)) {
      const e = logRaw[k];
      if (!isDateKey(k) || !e || typeof e !== 'object') return { ok: false, error: `專注紀錄 ${k} 格式錯誤` };
      const s = Number(e.seconds), n = Number(e.sessions || 0);
      if (!Number.isFinite(s) || s < 0 || s > 86400 || !Number.isFinite(n) || n < 0 || n > 1000) {
        return { ok: false, error: `專注紀錄 ${k} 數值錯誤` };
      }
      focusLog[k] = { seconds: Math.round(s), sessions: Math.round(n) };
    }
    return { ok: true, data: { tasks, focusLog, settings: normalizeSettings(settingsRaw, defaults) } };
  }

  /** 每天固定一句（同一天看到同一句） */
  function quoteOfDay(quotes, key) {
    if (!quotes || !quotes.length) return '';
    let h = 0;
    for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return quotes[h % quotes.length];
  }

  return {
    WEEKDAYS, MODES, APP_ID, BACKUP_VERSION, TITLE_MAX,
    pad2, dateKey, isDateKey, addDays, diffDays,
    formatClock, formatDateZh, formatShortDateZh, formatKeyShort, formatCountdown, formatMinutes,
    createTimer, startTimer, pauseTimer, resumeTimer, remainingMs, elapsedMs, progress, tickTimer, resetTimer, nextMode, restoreTimer,
    sanitizeTitle, newId, tasksForDate, addTask, editTask, setCompleted, removeTask, addFocusSeconds,
    findCarryOver, carryOver,
    logFocus, dayStats, activeDays, streak, lastNDays, categoryTotals,
    normalizeSettings, modeMinutes,
    makeBackup, validateTask, validateBackup, quoteOfDay,
  };
});
