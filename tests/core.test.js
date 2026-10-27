// 執行：npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../js/core.js');

const root = path.join(__dirname, '..');
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), ctx);
const CFG = ctx.window.FOCUS_CONFIG;
const MIN = 60 * 1000;

// ---------- 格式 ----------
test('時間格式：24 小時、12 小時、不顯示秒', () => {
  const d = new Date(2026, 9, 20, 13, 5, 9);
  assert.equal(C.formatClock(d), '13:05:09');
  assert.equal(C.formatClock(d, { seconds: false }), '13:05');
  assert.equal(C.formatClock(d, { hour12: true }), '下午 1:05:09');
  assert.equal(C.formatClock(new Date(2026, 0, 1, 0, 7, 0), { hour12: true, seconds: false }), '上午 12:07');
});

test('日期格式：中文星期', () => {
  const d = new Date(2026, 9, 20, 8, 0, 0); // 2026-10-20 是星期二
  assert.equal(C.formatDateZh(d), '2026年10月20日 星期二');
  assert.equal(C.formatShortDateZh(d), '10月20日 週二');
  assert.equal(C.dateKey(d), '2026-10-20');
  assert.equal(C.formatKeyShort('2026-10-20'), '10/20（二）');
});

test('倒數格式：無條件進位、超過一小時、負數歸零', () => {
  assert.equal(C.formatCountdown(25 * MIN), '25:00');
  assert.equal(C.formatCountdown(1200), '00:02');
  assert.equal(C.formatCountdown(0), '00:00');
  assert.equal(C.formatCountdown(-5000), '00:00');
  assert.equal(C.formatCountdown(90 * MIN + 5000), '1:30:05');
  assert.equal(C.formatMinutes(59), '0 分鐘');
  assert.equal(C.formatMinutes(25 * 60), '25 分鐘');
  assert.equal(C.formatMinutes(65 * 60), '1 小時 5 分');
  assert.equal(C.formatMinutes(120 * 60), '2 小時');
});

test('日期加減：跨月、跨年、閏年', () => {
  assert.equal(C.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(C.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(C.addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(C.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(C.diffDays('2026-12-30', '2027-01-02'), 3);
  assert.equal(C.isDateKey('2026-02-29'), false);
  assert.equal(C.isDateKey('2028-02-29'), true);
  assert.equal(C.isDateKey('2026-1-5'), false);
});

// ---------- 計時器 ----------
test('計時器：開始後以結束時間計算剩餘，時間到轉 done', () => {
  const t0 = 1_000_000;
  let t = C.createTimer('focus', 25 * MIN);
  assert.equal(t.phase, 'idle');
  t = C.startTimer(t, t0);
  assert.equal(t.endAt, t0 + 25 * MIN);
  assert.equal(C.remainingMs(t, t0 + 10 * MIN), 15 * MIN);
  assert.equal(C.tickTimer(t, t0 + 10 * MIN), t, '還沒到不應改變');
  const done = C.tickTimer(t, t0 + 30 * MIN);
  assert.equal(done.phase, 'done');
  assert.equal(done.finishedAt, t0 + 25 * MIN, '完成時間是應該結束的時間，不是發現的時間');
  assert.equal(C.remainingMs(done, t0 + 30 * MIN), 0);
});

test('計時器：暫停期間不扣時間，繼續後接著倒數', () => {
  const t0 = 5_000_000;
  let t = C.startTimer(C.createTimer('focus', 25 * MIN), t0);
  t = C.pauseTimer(t, t0 + 10 * MIN);
  assert.equal(t.phase, 'paused');
  assert.equal(t.remainingMs, 15 * MIN);
  assert.equal(C.remainingMs(t, t0 + 60 * MIN), 15 * MIN, '暫停一小時，剩餘不變');
  t = C.resumeTimer(t, t0 + 60 * MIN);
  assert.equal(t.endAt, t0 + 75 * MIN);
  assert.equal(C.elapsedMs(t, t0 + 70 * MIN), 20 * MIN);
  assert.equal(C.startTimer(t, t0 + 61 * MIN), t, '執行中再按開始不變');
});

test('計時器：存成 JSON、重新整理後還原（含關掉期間已到期）', () => {
  const t0 = 9_000_000;
  const running = C.startTimer(C.createTimer('focus', 25 * MIN, 'tabc'), t0);
  const back = C.restoreTimer(JSON.parse(JSON.stringify(running)), null);
  assert.deepEqual(back, running);
  assert.equal(C.remainingMs(back, t0 + 5 * MIN), 20 * MIN);
  assert.equal(C.tickTimer(back, t0 + 2 * 3600 * 1000).phase, 'done');

  const paused = C.pauseTimer(running, t0 + 3 * MIN);
  const back2 = C.restoreTimer(JSON.parse(JSON.stringify(paused)), null);
  assert.equal(back2.phase, 'paused');
  assert.equal(C.remainingMs(back2, t0 + 999 * MIN), 22 * MIN);
});

test('計時器：壞掉的儲存資料回到預設', () => {
  const fb = C.createTimer('focus', 25 * MIN);
  assert.equal(C.restoreTimer(null, fb), fb);
  assert.equal(C.restoreTimer({ mode: 'nap', phase: 'idle', durationMs: 1000 }, fb), fb);
  assert.equal(C.restoreTimer({ mode: 'focus', phase: 'running', durationMs: 1000 }, fb), fb, '執行中但沒有 endAt');
  assert.equal(C.restoreTimer({ mode: 'focus', phase: 'paused', durationMs: 1000, remainingMs: 5000 }, fb), fb);
  assert.equal(C.restoreTimer({ mode: 'focus', phase: 'idle', durationMs: -1 }, fb), fb);
  assert.equal(C.restoreTimer({ mode: 'focus', phase: 'idle', durationMs: 'abc' }, fb), fb);
});

test('計時器：暫停在到期之後等於完成；重設保留綁定任務', () => {
  const t = C.startTimer(C.createTimer('short', 5 * MIN, 'tx'), 0);
  const p = C.pauseTimer(t, 6 * MIN);
  assert.equal(p.phase, 'done');
  const r = C.resetTimer(p, 10 * MIN);
  assert.equal(r.phase, 'idle');
  assert.equal(r.remainingMs, 10 * MIN);
  assert.equal(r.taskId, 'tx');
  assert.equal(r.mode, 'short');
});

test('番茄鐘循環：每 4 次專注一次長休息', () => {
  assert.equal(C.nextMode('focus', 1, 4), 'short');
  assert.equal(C.nextMode('focus', 3, 4), 'short');
  assert.equal(C.nextMode('focus', 4, 4), 'long');
  assert.equal(C.nextMode('focus', 8, 4), 'long');
  assert.equal(C.nextMode('short', 1, 4), 'focus');
  assert.equal(C.nextMode('long', 4, 4), 'focus');
});

// ---------- 任務 ----------
test('任務：新增、一天最多三件、空白標題、清理標題', () => {
  let tasks = [];
  for (let i = 0; i < 3; i++) {
    const r = C.addTask(tasks, { title: '  任務\n' + i + '  ', category: 'work', date: '2026-10-20' }, { max: 3, now: i, id: 'id' + i });
    assert.equal(r.error, undefined);
    tasks = r.tasks;
  }
  assert.equal(tasks[0].title, '任務 0');
  assert.equal(C.addTask(tasks, { title: '第四件', date: '2026-10-20' }, { max: 3 }).error, 'full');
  assert.equal(C.addTask(tasks, { title: '   ', date: '2026-10-21' }).error, 'empty');
  assert.equal(C.addTask(tasks, { title: '明天的事', date: '2026-10-21' }).error, undefined, '別天不受影響');
  assert.equal(C.addTask([], { title: 'x'.repeat(200), date: '2026-10-20' }).task.title.length, C.TITLE_MAX);
});

test('任務：編輯、完成、取消完成、刪除、累積專注時間', () => {
  let tasks = C.addTask([], { title: '寫企劃', category: 'work', date: '2026-10-20' }, { id: 'a' }).tasks;
  tasks = C.editTask(tasks, 'a', { title: '寫企劃書', category: 'learn' });
  assert.equal(tasks[0].title, '寫企劃書');
  assert.equal(tasks[0].category, 'learn');
  assert.equal(C.editTask(tasks, 'a', { title: '   ' })[0].title, '寫企劃書', '空白標題不覆蓋');
  tasks = C.addFocusSeconds(tasks, 'a', 1500);
  tasks = C.addFocusSeconds(tasks, 'a', 300.4);
  assert.equal(tasks[0].duration, 1800);
  tasks = C.setCompleted(tasks, 'a', true, '2026-10-21');
  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].completedOn, '2026-10-21');
  tasks = C.setCompleted(tasks, 'a', false, '2026-10-21');
  assert.equal(tasks[0].completedOn, null);
  assert.deepEqual(C.removeTask(tasks, 'a'), []);
});

// ---------- 跨日延續 ----------
test('跨日：找出以前沒完成的任務（舊的在前，不含今天、已完成）', () => {
  const tasks = [
    { id: '1', title: 'A', date: '2026-10-18', status: 'pending' },
    { id: '2', title: 'B', date: '2026-10-19', status: 'completed' },
    { id: '3', title: 'C', date: '2026-10-20', status: 'pending' },
    { id: '4', title: 'D', date: '2026-10-17', status: 'pending' },
    { id: '5', title: 'E', date: '2026-10-21', status: 'pending' },
  ];
  assert.deepEqual(C.findCarryOver(tasks, '2026-10-20').map(t => t.id), ['4', '1']);
  // 過了午夜，昨天的 C 也變成待延續
  assert.deepEqual(C.findCarryOver(tasks, '2026-10-21').map(t => t.id), ['4', '1', '3']);
});

test('跨日：搬到今天受三件上限限制，保留專注時間與原日期', () => {
  const tasks = [
    { id: '1', title: 'A', date: '2026-10-18', status: 'pending', duration: 600 },
    { id: '2', title: 'B', date: '2026-10-19', status: 'pending', duration: 0 },
    { id: '3', title: 'C', date: '2026-10-19', status: 'pending', duration: 0 },
    { id: 't', title: '今天的', date: '2026-10-20', status: 'pending', duration: 0 },
  ];
  const r = C.carryOver(tasks, ['1', '2', '3'], '2026-10-20', 3);
  assert.deepEqual(r.moved, ['1', '2']);
  assert.deepEqual(r.skipped, ['3']);
  const a = r.tasks.find(t => t.id === '1');
  assert.equal(a.date, '2026-10-20');
  assert.equal(a.carriedFrom, '2026-10-18');
  assert.equal(a.duration, 600);
  assert.equal(r.tasks.find(t => t.id === '3').date, '2026-10-19');
  assert.equal(C.tasksForDate(r.tasks, '2026-10-20').length, 3);
  // 再延續一次，carriedFrom 仍是最初的日期
  const again = C.carryOver(r.tasks.map(t => t.id === '1' ? Object.assign({}, t, { date: '2026-10-20' }) : t), ['1'], '2026-10-22', 3);
  assert.equal(again.tasks.find(t => t.id === '1').carriedFrom, '2026-10-18');
});

// ---------- 統計 ----------
test('統計：今天完成數、專注分鐘、次數', () => {
  let log = {};
  log = C.logFocus(log, '2026-10-20', 1500);
  log = C.logFocus(log, '2026-10-20', 750);
  log = C.logFocus(log, '2026-10-20', 30, false);
  const tasks = [
    { id: '1', date: '2026-10-19', status: 'completed', completedOn: '2026-10-20' }, // 延續後今天完成
    { id: '2', date: '2026-10-20', status: 'completed', completedOn: '2026-10-20' },
    { id: '3', date: '2026-10-20', status: 'pending' },
  ];
  const s = C.dayStats(tasks, log, '2026-10-20');
  assert.equal(s.completed, 2);
  assert.equal(s.focusSeconds, 2280);
  assert.equal(s.focusMinutes, 38);
  assert.equal(s.sessions, 2);
  assert.equal(C.lastNDays(tasks, log, '2026-10-20', 7).length, 7);
  assert.equal(C.lastNDays(tasks, log, '2026-10-20', 7)[6].focusMinutes, 38);
});

test('連續天數：跨月、今天還沒開始不算斷、中間斷一天就重算', () => {
  const log = {
    '2026-02-26': { seconds: 1500, sessions: 1 },
    '2026-02-27': { seconds: 1500, sessions: 1 },
    '2026-02-28': { seconds: 30, sessions: 0 },   // 不滿 1 分鐘不算
    '2026-03-02': { seconds: 1500, sessions: 1 },
  };
  const tasks = [{ id: 'x', date: '2026-02-28', status: 'completed', completedOn: '2026-02-28' }];
  // 2/26、2/27、2/28（完成任務）連續；3/1 斷掉
  assert.equal(C.streak(tasks, log, '2026-02-28'), 3);
  assert.equal(C.streak(tasks, log, '2026-03-01'), 3, '今天（3/1）還沒動，從昨天往回數');
  assert.equal(C.streak(tasks, log, '2026-03-02'), 1);
  assert.equal(C.streak(tasks, log, '2026-03-04'), 0);
  // 跨年
  const y = { '2026-12-31': { seconds: 600, sessions: 1 }, '2027-01-01': { seconds: 600, sessions: 1 } };
  assert.equal(C.streak([], y, '2027-01-01'), 2);
});

test('統計：每月分類時間', () => {
  const tasks = [
    { id: '1', date: '2026-10-01', category: 'work', duration: 600 },
    { id: '2', date: '2026-10-20', category: 'work', duration: 300 },
    { id: '3', date: '2026-10-20', category: 'health', duration: 60 },
    { id: '4', date: '2026-09-30', category: 'work', duration: 9999 },
  ];
  assert.deepEqual(C.categoryTotals(tasks, '2026-10'), { work: 900, health: 60 });
});

// ---------- 設定與備份 ----------
test('設定：超出範圍會夾回、型別錯誤用預設', () => {
  const s = C.normalizeSettings({ focusMinutes: 999, shortBreakMinutes: 0, longBreakMinutes: 'abc', sound: 'yes', theme: 'neon' }, CFG);
  assert.equal(s.focusMinutes, 180);
  assert.equal(s.shortBreakMinutes, 1);
  assert.equal(s.longBreakMinutes, CFG.longBreakMinutes);
  assert.equal(s.sound, CFG.sound);
  assert.equal(s.theme, 'system');
  assert.equal(C.modeMinutes(s, 'focus'), 180);
  assert.equal(C.modeMinutes(s, 'short'), 1);
});

test('備份：匯出再匯入資料一致', () => {
  const tasks = C.addTask([], { title: '讀書', category: 'learn', date: '2026-10-20' }, { id: 'a', now: 1 }).tasks;
  const data = { tasks, focusLog: { '2026-10-20': { seconds: 1500, sessions: 1 } }, settings: C.normalizeSettings({}, CFG) };
  const json = JSON.stringify(C.makeBackup(data, Date.UTC(2026, 9, 20)));
  const r = C.validateBackup(json, CFG);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.tasks, tasks);
  assert.deepEqual(r.data.focusLog, data.focusLog);
  assert.deepEqual(r.data.settings, data.settings);
});

test('備份：拒絕壞掉或不相干的檔案', () => {
  const good = { app: 'tw-focus-clock', version: 1, tasks: [] };
  const bad = [
    ['不是 JSON', '{oops'],
    ['null', 'null'],
    ['數字', 42],
    ['別的 App', { app: 'other', version: 1, tasks: [] }],
    ['版本太新', Object.assign({}, good, { version: 99 })],
    ['版本不是整數', Object.assign({}, good, { version: '1' })],
    ['tasks 不是陣列', Object.assign({}, good, { tasks: {} })],
    ['任務沒標題', Object.assign({}, good, { tasks: [{ id: 'a', title: ' ', date: '2026-10-20', status: 'pending' }] })],
    ['任務日期錯', Object.assign({}, good, { tasks: [{ id: 'a', title: 'x', date: '2026/10/20', status: 'pending' }] })],
    ['任務狀態錯', Object.assign({}, good, { tasks: [{ id: 'a', title: 'x', date: '2026-10-20', status: 'done' }] })],
    ['專注時間負數', Object.assign({}, good, { tasks: [{ id: 'a', title: 'x', date: '2026-10-20', status: 'pending', duration: -5 }] })],
    ['id 重複', Object.assign({}, good, { tasks: [
      { id: 'a', title: 'x', date: '2026-10-20', status: 'pending' },
      { id: 'a', title: 'y', date: '2026-10-20', status: 'pending' }] })],
    ['紀錄日期錯', Object.assign({}, good, { focusLog: { yesterday: { seconds: 1 } } })],
    ['紀錄一天超過 24 小時', Object.assign({}, good, { focusLog: { '2026-10-20': { seconds: 99999 } } })],
    ['紀錄是陣列', Object.assign({}, good, { focusLog: [] })],
  ];
  for (const [name, input] of bad) {
    const r = C.validateBackup(input, CFG);
    assert.equal(r.ok, false, name);
    assert.equal(typeof r.error, 'string', name);
  }
  assert.equal(C.validateBackup(good, CFG).ok, true);
});

test('備份：接受舊版「時。刻」網頁的任務陣列（數字 id）', () => {
  const legacy = [
    { id: 1760000000000, title: '散步', category: 'health', status: 'completed', date: '2026-10-19', duration: 1200, startTime: null },
    { id: 1760000000001, title: '<b>寫信</b>', category: 'work', status: 'pending', date: '2026-10-19', duration: 0, startTime: null },
  ];
  const r = C.validateBackup(JSON.stringify(legacy), CFG);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.tasks[0].id, '1760000000000');
  assert.equal(r.data.tasks[0].completedOn, '2026-10-19');
  assert.equal(r.data.tasks[1].title, '<b>寫信</b>', '原樣保留，畫面用 textContent 顯示');
});

test('設定檔：預設值合理、分類與語錄齊全', () => {
  assert.equal(CFG.locale, 'zh-TW');
  assert.ok(CFG.focusMinutes > 0 && CFG.shortBreakMinutes > 0 && CFG.longBreakMinutes > 0);
  assert.equal(CFG.maxTasksPerDay, 3);
  assert.ok(CFG.quotes.includes('不要緊，你正在前進。'));
  assert.equal(new Set(CFG.categories.map(c => c.id)).size, CFG.categories.length);
  for (const c of CFG.categories) assert.match(c.color, /^#[0-9a-f]{6}$/i);
  assert.equal(C.quoteOfDay(CFG.quotes, '2026-10-20'), C.quoteOfDay(CFG.quotes, '2026-10-20'));
});

test('不對外連線：網頁檔案裡沒有任何外部網址', () => {
  const files = ['index.html', 'css/style.css', 'config.js', 'js/core.js', 'js/app.js', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    // 只允許 SVG 的命名空間宣告，以及頁尾作者客製化 LINE 連結（使用者點了才開，不是載入的資源）
    const urls = (text.match(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi) || [])
      .filter(u => !/^http:\/\/www\.w3\.org\/2000\/svg$/.test(u))
      .filter(u => u !== 'https://line.me/R/ti/p/@812ibtir');
    assert.deepEqual(urls, [], f);
  }
});

test('頁尾有作者客製化資訊（安裝後看得到），且不擋操作', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<footer class="app-foot">\s*<p class="custom-ad">[^<]*<a href="https:\/\/line\.me\/R\/ti\/p\/@812ibtir" target="_blank" rel="noopener">@812ibtir<\/a>（留白事務所・林其衞）/);
  const css = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');
  assert.match(css, /@media print \{ \.custom-ad \{ display: none/);
  assert.match(css, /body\.immersive \.app-foot \{ display: none; \}/);
});
