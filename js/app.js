/*
 * tw-focus-clock 畫面邏輯
 * 計算都交給 js/core.js（FocusCore）；這裡只負責畫面、儲存、全螢幕、防休眠、聲音。
 */
(function () {
  'use strict';

  const C = window.FocusCore;
  const CFG = window.FOCUS_CONFIG || {};
  const KEY = 'tw-focus-clock:v1';
  const LEGACY_KEY = 'moment_tasks_web'; // 舊版「時。刻」網頁的資料，第一次開啟時自動帶入
  const MAX = CFG.maxTasksPerDay || 3;
  const CATS = Array.isArray(CFG.categories) && CFG.categories.length ? CFG.categories : [{ id: 'work', name: '工作', color: '#f59e0b' }];
  const QUOTES = Array.isArray(CFG.quotes) && CFG.quotes.length ? CFG.quotes : ['不要緊，你正在前進。'];
  const VIEWS = ['clock', 'focus', 'tasks', 'stats'];
  const MODE_NAMES = { focus: '專注', short: '短休息', long: '長休息' };
  const $ = id => document.getElementById(id);

  // ---------- 儲存（瀏覽器不給存也照常運作） ----------
  const storage = (function () {
    try {
      const k = '__tw_focus_test__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
    } catch (e) {
      return { ok: false, get: () => null, set: () => false };
    }
    return {
      ok: true,
      get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
      set(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    };
  })();

  const today = () => C.dateKey(new Date());
  const catOf = id => CATS.find(c => c.id === id) || { id, name: id || '未分類', color: '#8a8a8a' };
  const minutesMs = (settings, mode) => C.modeMinutes(settings, mode) * 60000;

  function loadState() {
    let raw = null, migrated = 0;
    const text = storage.get(KEY);
    if (text) {
      try { raw = JSON.parse(text); } catch (e) {
        // 壞掉的資料先另存一份，不直接覆蓋
        storage.set(KEY + ':broken-' + Date.now(), text);
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = null;
    const settings = C.normalizeSettings(raw && raw.settings, CFG);
    let tasks = [], focusLog = {};
    if (raw) {
      // 一筆一筆檢查，壞掉的單筆略過，不讓整份資料消失
      const seen = new Set();
      for (const t of Array.isArray(raw.tasks) ? raw.tasks : []) {
        const v = C.validateTask(t);
        if (typeof v !== 'string' && !seen.has(v.id)) { seen.add(v.id); tasks.push(v); }
      }
      const log = raw.focusLog && typeof raw.focusLog === 'object' ? raw.focusLog : {};
      for (const k of Object.keys(log)) {
        const e = log[k];
        if (C.isDateKey(k) && e && Number.isFinite(e.seconds) && e.seconds >= 0) {
          focusLog[k] = { seconds: Math.round(e.seconds), sessions: Math.max(0, Math.round(Number(e.sessions) || 0)) };
        }
      }
    } else {
      let legacy = null;
      try { legacy = JSON.parse(storage.get(LEGACY_KEY) || 'null'); } catch (e) { legacy = null; }
      if (Array.isArray(legacy) && legacy.length) {
        const v = C.validateBackup(legacy, CFG);
        if (v.ok) { tasks = v.data.tasks; migrated = tasks.length; }
      }
    }
    const timer = C.restoreTimer(raw && raw.timer, C.createTimer('focus', minutesMs(settings, 'focus')));
    const cycle = raw && raw.cycle && C.isDateKey(raw.cycle.date) && Number.isInteger(raw.cycle.count) && raw.cycle.count >= 0
      ? raw.cycle : { date: today(), count: 0 };
    return {
      tasks, focusLog, settings, timer, cycle, migrated,
      carryPromptDate: raw && typeof raw.carryPromptDate === 'string' ? raw.carryPromptDate : '',
      view: raw && VIEWS.includes(raw.view) ? raw.view : 'clock',
    };
  }

  const state = loadState();
  let selectedCat = CATS[0].id;
  let editingId = null;
  let currentDay = today();
  let immersive = false;
  let fullscreenActive = false;
  let wakeState = 'off';
  let fullscreenUnsupported = false;

  function save() {
    storage.set(KEY, JSON.stringify({
      v: 1,
      tasks: state.tasks,
      focusLog: state.focusLog,
      settings: state.settings,
      timer: state.timer,
      cycle: state.cycle,
      carryPromptDate: state.carryPromptDate,
      view: state.view,
    }));
  }

  // ---------- 小工具 ----------
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'style') n.setAttribute('style', v);
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of [].concat(children || [])) if (c != null) n.append(c);
    return n;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('class', 'ico');
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(SVG_NS, 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
  }
  function setIcon(svg, name) { svg.querySelector('use').setAttribute('href', '#i-' + name); }

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 3200);
  }

  // ---------- 對話框 ----------
  let lastFocus = null;
  function openModal(m) {
    lastFocus = document.activeElement;
    m.hidden = false;
    const f = m.querySelector('input:not([type=hidden]):not(.sr-only), select, button:not([data-close]), button');
    if (f) setTimeout(() => f.focus(), 30);
  }
  function closeModal(m) {
    if (m.hidden) return;
    m.hidden = true;
    if (m.id === 'modal-confirm' && confirmResolve) { confirmResolve(false); confirmResolve = null; }
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-close]')) closeModal(m);
    });
  });
  let confirmResolve = null;
  function confirmDialog(title, text, okLabel) {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text || '';
    $('btn-confirm-ok').textContent = okLabel || '確定';
    openModal($('modal-confirm'));
    return new Promise(res => { confirmResolve = res; });
  }
  $('btn-confirm-ok').addEventListener('click', () => {
    const r = confirmResolve; confirmResolve = null;
    closeModal($('modal-confirm'));
    if (r) r(true);
  });

  // ---------- 深淺色 ----------
  function applyTheme() {
    const t = state.settings.theme;
    const root = document.documentElement;
    if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
    setIcon($('btn-theme').querySelector('svg'), t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'auto');
    const label = { system: '跟隨系統', light: '淺色', dark: '深色' }[t];
    $('btn-theme').setAttribute('aria-label', '深淺色：' + label + '（點一下切換）');
    $('btn-theme').title = '深淺色：' + label;
    const dark = t === 'dark' || (t === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#0a0a0a' : '#f6f5f2');
  }
  $('btn-theme').addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % order.length];
    applyTheme();
    save();
    toast({ system: '深淺色：跟隨系統', light: '深淺色：淺色', dark: '深淺色：深色' }[state.settings.theme], 1600);
  });
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', applyTheme);
  }

  // ---------- 分頁 ----------
  function showView(v, opts) {
    if (!VIEWS.includes(v)) v = 'clock';
    state.view = v;
    for (const name of VIEWS) $('view-' + name).hidden = name !== v;
    document.querySelectorAll('.tab').forEach(b => {
      if (b.dataset.tab === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (v === 'tasks') renderTasks();
    if (v === 'stats') renderStats();
    if (v === 'focus') { renderFocusTaskSelect(); renderTimer(); }
    syncAnalogLoop();
    if (!(opts && opts.noSave)) save();
    try { history.replaceState(null, '', '#' + v); } catch (e) { /* file:// 某些瀏覽器不允許，忽略 */ }
  }
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showView(b.dataset.tab)));
  window.addEventListener('hashchange', () => {
    const v = (location.hash || '').slice(1);
    if (VIEWS.includes(v) && v !== state.view) showView(v);
  });

  // ---------- 時鐘 ----------
  (function buildTicks() {
    const box = $('ticks');
    for (let i = 0; i < 60; i++) {
      box.appendChild(el('div', { class: 'tick' + (i % 5 === 0 ? ' major' : ''), style: `transform:rotate(${i * 6}deg)` }, el('i')));
    }
  })();

  let lastDigital = '', lastDate = '';
  function renderClockText(now) {
    const d = C.formatClock(now, { hour12: state.settings.hour12 });
    if (d !== lastDigital) {
      lastDigital = d;
      $('digital-time').textContent = d;
      $('digital-time').setAttribute('aria-label', '現在時間 ' + d);
    }
    const ds = C.formatDateZh(now);
    if (ds !== lastDate) {
      lastDate = ds;
      $('clock-date').textContent = ds;
      $('hdr-date').textContent = C.formatShortDateZh(now);
    }
    // 時鐘畫面上也看得到專注進度
    const t = state.timer, pill = $('clock-focus');
    if (t.phase === 'running' || t.phase === 'paused') {
      const left = C.formatCountdown(C.remainingMs(t, now.getTime()));
      const label = t.mode === 'focus' ? (t.phase === 'running' ? '專注中' : '專注暫停') : (t.phase === 'running' ? '休息中' : '休息暫停');
      pill.textContent = `${label} ${left}`;
      pill.hidden = false;
    } else pill.hidden = true;
  }

  function renderAnalog(now) {
    const ms = now.getMilliseconds(), s = now.getSeconds(), m = now.getMinutes(), h = now.getHours();
    $('hand-sec').style.transform = `rotate(${(s + ms / 1000) * 6}deg)`;
    $('hand-min').style.transform = `rotate(${(m + s / 60) * 6}deg)`;
    $('hand-hour').style.transform = `rotate(${((h % 12) + m / 60) * 30}deg)`;
  }

  let rafId = 0;
  function analogFrame() {
    rafId = 0;
    const now = new Date();
    renderAnalog(now);
    renderClockText(now);
    rafId = requestAnimationFrame(analogFrame);
  }
  function syncAnalogLoop() {
    const want = state.view === 'clock' && state.settings.clockStyle === 'both' && document.visibilityState !== 'hidden';
    if (want && !rafId) rafId = requestAnimationFrame(analogFrame);
    if (!want && rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  function applyClockStyle() {
    document.body.classList.toggle('clock-digital-only', state.settings.clockStyle === 'digital');
    syncAnalogLoop();
  }

  // ---------- 全螢幕＋防休眠 ----------
  const wake = {
    sentinel: null,
    async set(want) {
      if (!want) {
        const s = this.sentinel;
        this.sentinel = null;
        if (s) { try { await s.release(); } catch (e) { /* 已釋放 */ } }
        return 'off';
      }
      if (!('wakeLock' in navigator)) return 'unsupported';
      if (this.sentinel && !this.sentinel.released) return 'on';
      try {
        const s = await navigator.wakeLock.request('screen');
        s.addEventListener('release', () => { if (this.sentinel === s) this.sentinel = null; });
        this.sentinel = s;
        return 'on';
      } catch (e) {
        return 'denied';
      }
    },
  };
  const wantWake = () => immersive || (state.settings.keepAwake && state.timer.phase === 'running');
  let wakeBusy = Promise.resolve();
  function refreshWake() {
    wakeBusy = wakeBusy.then(async () => {
      wakeState = await wake.set(wantWake());
      renderWakeStatus();
      return wakeState;
    });
    return wakeBusy;
  }

  let statusTimer = null;
  function renderWakeStatus() {
    const st = $('wake-status');
    clearTimeout(statusTimer);
    if (!immersive) { st.textContent = ''; return; }
    let msg;
    if (wakeState === 'on') msg = '螢幕常亮中。輕觸螢幕可顯示「離開」按鈕。';
    else if (wakeState === 'unsupported') msg = '這個瀏覽器不支援防休眠，螢幕可能會自動關閉；可到系統設定把「自動鎖定／螢幕逾時」調長。';
    else if (wakeState === 'denied') msg = '防休眠沒有啟用（可能是省電模式或瀏覽器不允許），螢幕仍可能自動關閉。';
    else msg = '';
    if (fullscreenUnsupported) msg += (msg ? ' ' : '') + '這個瀏覽器不支援全螢幕，已改用沉浸畫面。';
    st.textContent = msg;
    // 正常時幾秒後淡出，避免烙印；有問題的訊息多留一會兒
    statusTimer = setTimeout(() => { st.textContent = ''; }, wakeState === 'on' && !fullscreenUnsupported ? 5000 : 15000);
  }

  let shiftTimer = null, controlsTimer = null;
  function pixelShift() {
    const x = Math.floor(Math.random() * 33) - 16, y = Math.floor(Math.random() * 33) - 16;
    $('clock-stage').style.transform = `translate(${x}px, ${y}px)`;
  }
  function showControls() {
    document.body.classList.add('show-controls');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => document.body.classList.remove('show-controls'), 3500);
  }

  async function enterImmersive() {
    if (immersive) { showControls(); return; }
    immersive = true;
    if (state.view !== 'clock') showView('clock');
    document.body.classList.add('immersive');
    const root = document.documentElement;
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    fullscreenUnsupported = !req;
    if (req) {
      // 不等全螢幕的結果（有些環境永遠不回應），失敗就照樣用沉浸畫面
      try {
        const p = req.call(root);
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* 不允許全螢幕 */ }
    }
    clearInterval(shiftTimer);
    shiftTimer = setInterval(pixelShift, 60000);
    await refreshWake();
  }

  function exitImmersive() {
    if (!immersive) return;
    immersive = false;
    document.body.classList.remove('immersive', 'show-controls');
    clearInterval(shiftTimer);
    $('clock-stage').style.transform = '';
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) { try { const p = exit.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) { /* 忽略 */ } }
    }
    refreshWake();
  }

  function onFullscreenChange() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) fullscreenActive = true;
    else if (fullscreenActive) { fullscreenActive = false; exitImmersive(); } // 按 Esc 離開全螢幕
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  $('clock-stage').addEventListener('click', e => {
    if (e.target.closest('#btn-exit-immersive')) return;
    if (immersive) showControls(); else enterImmersive();
  });
  $('clock-stage').addEventListener('dblclick', () => { if (immersive) exitImmersive(); });
  $('btn-exit-immersive').addEventListener('click', e => { e.stopPropagation(); exitImmersive(); });
  document.addEventListener('mousemove', () => { if (immersive) showControls(); });

  // ---------- 聲音（WebAudio 合成，不用音檔） ----------
  let audioCtx = null;
  function unlockAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) { try { audioCtx = new AC(); } catch (e) { return null; } }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  function beep() {
    const ctx = unlockAudio();
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.05;
    [0, 0.35, 0.7].forEach((d, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = i === 2 ? 1046.5 : 880;
      g.gain.setValueAtTime(0.0001, t0 + d);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.28);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(t0 + d);
      o.stop(t0 + d + 0.3);
    });
  }
  function alertDone() {
    if (state.settings.sound) beep();
    const activated = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    if (navigator.vibrate && activated) { try { navigator.vibrate([200, 100, 200]); } catch (e) { /* 不支援 */ } }
  }

  // ---------- 專注計時 ----------
  const RING_LEN = 2 * Math.PI * 100;
  $('ring-fg').style.strokeDasharray = String(RING_LEN);

  function syncCycleDay() {
    const d = today();
    if (state.cycle.date !== d) state.cycle = { date: d, count: 0 };
  }

  function renderTimer() {
    const now = Date.now(), t = state.timer;
    const left = C.formatCountdown(C.remainingMs(t, now));
    $('timer-text').textContent = left;
    $('timer-text').setAttribute('aria-label', `${MODE_NAMES[t.mode]}剩下 ${left}`);
    $('ring-fg').style.strokeDashoffset = String(RING_LEN * (1 - C.progress(t, now)));
    const label = $('timer-label');
    let text;
    if (t.phase === 'running') text = t.mode === 'focus' ? '專注中...' : '休息中...';
    else if (t.phase === 'paused') text = '已暫停';
    else text = t.mode === 'focus' ? '準備開始' : '休息一下';
    if (label.textContent !== text) label.textContent = text;
    label.classList.toggle('breathing', t.phase === 'running');

    const running = t.phase === 'running';
    setIcon($('start-ico'), running ? 'pause' : 'play');
    $('start-text').textContent = running ? '暫停' : t.phase === 'paused' ? '繼續' : '開始';
    $('btn-start').setAttribute('aria-label', running ? '暫停' : t.phase === 'paused' ? '繼續' : '開始');
    document.querySelectorAll('.mode-chips .chip').forEach(c => c.setAttribute('aria-checked', String(c.dataset.mode === t.mode)));
    const linked = t.taskId && state.tasks.find(x => x.id === t.taskId && x.status === 'pending');
    $('btn-complete-linked').hidden = !linked;

    syncCycleDay();
    const every = state.settings.longBreakEvery;
    $('cycle-info').textContent = `今天已完成 ${state.cycle.count} 段專注・每 ${every} 段長休息一次`;

    if (t.phase === 'running' || t.phase === 'paused') {
      document.title = `${left} ${t.phase === 'paused' ? '已暫停' : t.mode === 'focus' ? '專注中' : '休息中'}・時。刻`;
    } else if (document.title !== '時。刻 專注時鐘') document.title = '時。刻 專注時鐘';
  }

  function renderFocusTaskSelect() {
    const sel = $('focus-task-select');
    const pending = C.tasksForDate(state.tasks, today()).filter(t => t.status === 'pending');
    sel.textContent = '';
    sel.append(el('option', { value: '', text: '（不指定任務）' }));
    for (const t of pending) sel.append(el('option', { value: t.id, text: `${catOf(t.category).name}｜${t.title}` }));
    const cur = state.timer.taskId;
    sel.value = cur && pending.some(t => t.id === cur) ? cur : '';
  }

  /** 中途停止的專注：滿 1 分鐘就記下來 */
  function recordPartial(now) {
    const t = state.timer;
    if (t.mode !== 'focus' || (t.phase !== 'running' && t.phase !== 'paused')) return 0;
    const secs = Math.round(C.elapsedMs(t, now) / 1000);
    if (secs < 60) return 0;
    state.focusLog = C.logFocus(state.focusLog, C.dateKey(now), secs, false);
    state.tasks = C.addFocusSeconds(state.tasks, t.taskId, secs);
    return secs;
  }

  function setTimer(next) {
    const wasRunning = state.timer.phase === 'running';
    state.timer = next;
    save();
    renderTimer();
    renderClockText(new Date());
    if (wasRunning !== (next.phase === 'running')) refreshWake();
  }

  function handleDone(done) {
    const now = Date.now();
    const live = now - (done.finishedAt || now) < 60000; // 一分鐘內發現的才響鈴（重新整理後補記不響）
    const s = state.settings;
    let next;
    if (done.mode === 'focus') {
      const secs = Math.round(done.durationMs / 1000);
      state.focusLog = C.logFocus(state.focusLog, C.dateKey(done.finishedAt || now), secs);
      state.tasks = C.addFocusSeconds(state.tasks, done.taskId, secs);
      syncCycleDay();
      state.cycle = { date: state.cycle.date, count: state.cycle.count + 1 };
      next = C.nextMode('focus', state.cycle.count, s.longBreakEvery);
      const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
      toast(live ? `完成 ${Math.round(secs / 60)} 分鐘專注！${quote}` : `上次的專注已完成，記下 ${Math.round(secs / 60)} 分鐘。`, 5000);
    } else {
      next = 'focus';
      toast(live ? '休息結束，準備好再出發。' : '上次的休息已結束。', 4000);
    }
    const taskStill = done.taskId && state.tasks.some(x => x.id === done.taskId && x.status === 'pending');
    let nt = C.createTimer(next, minutesMs(s, next), taskStill ? done.taskId : null);
    if (s.autoStartNext && live) nt = C.startTimer(nt, now);
    if (live) alertDone();
    setTimer(nt);
    if (state.view === 'stats') renderStats();
    if (state.view === 'tasks') renderTasks();
  }

  $('btn-start').addEventListener('click', () => {
    const now = Date.now(), t = state.timer;
    unlockAudio(); // 使用者按過按鈕，之後才能出聲
    if (t.phase === 'running') setTimer(C.pauseTimer(t, now));
    else setTimer(C.startTimer(t, now));
  });

  $('btn-reset').addEventListener('click', () => {
    const now = Date.now();
    const secs = recordPartial(now);
    setTimer(C.createTimer(state.timer.mode, minutesMs(state.settings, state.timer.mode), state.timer.taskId));
    if (secs) toast(`已記錄 ${Math.floor(secs / 60)} 分鐘專注。`);
  });

  $('btn-skip').addEventListener('click', () => {
    const now = Date.now();
    const secs = recordPartial(now);
    const target = state.timer.mode === 'focus' ? 'short' : 'focus';
    setTimer(C.createTimer(target, minutesMs(state.settings, target), state.timer.taskId));
    toast(secs ? `已記錄 ${Math.floor(secs / 60)} 分鐘，切換到${MODE_NAMES[target]}。` : `切換到${MODE_NAMES[target]}。`);
  });

  document.querySelectorAll('.mode-chips .chip').forEach(chip => chip.addEventListener('click', async () => {
    const mode = chip.dataset.mode, t = state.timer;
    if (mode === t.mode && t.phase === 'idle') return;
    if (t.phase === 'running' || t.phase === 'paused') {
      const ok = await confirmDialog('切換模式？', '目前的計時會停止（專注滿 1 分鐘的部分會記錄下來）。');
      if (!ok) return;
      recordPartial(Date.now());
    }
    setTimer(C.createTimer(mode, minutesMs(state.settings, mode), state.timer.taskId));
  }));

  $('focus-task-select').addEventListener('change', e => {
    state.timer = Object.assign({}, state.timer, { taskId: e.target.value || null });
    save();
    renderTimer();
  });

  $('btn-complete-linked').addEventListener('click', () => {
    const id = state.timer.taskId;
    if (!id) return;
    const secs = recordPartial(Date.now());
    state.tasks = C.setCompleted(state.tasks, id, true, today());
    setTimer(C.createTimer('focus', minutesMs(state.settings, 'focus'), null));
    renderFocusTaskSelect();
    toast(secs ? `完成了！這段專注 ${Math.floor(secs / 60)} 分鐘也記下來了。` : '完成了！不要緊，你正在前進。');
    if (allDoneToday()) setTimeout(() => toast('今天的三件事都完成了，太棒了！'), 2600);
  });

  // ---------- 今日三件事 ----------
  function allDoneToday() {
    const list = C.tasksForDate(state.tasks, today());
    return list.length >= MAX && list.every(t => t.status === 'completed');
  }

  function renderCatChips() {
    const box = $('cat-chips');
    box.textContent = '';
    for (const c of CATS) {
      box.append(el('button', {
        type: 'button', class: 'cat-chip', role: 'radio', 'aria-checked': String(c.id === selectedCat),
        onclick: () => { selectedCat = c.id; renderCatChips(); },
      }, [el('span', { class: 'dot', style: `background:${c.color}` }), c.name]));
    }
  }

  function taskCard(t) {
    const done = t.status === 'completed';
    const cat = catOf(t.category);
    if (editingId === t.id) {
      const input = el('input', { type: 'text', value: t.title, maxlength: String(C.TITLE_MAX), 'aria-label': '任務名稱' });
      const sel = el('select', { 'aria-label': '分類' }, CATS.map(c => el('option', { value: c.id, text: c.name })));
      sel.value = cat.id;
      const saveEdit = () => {
        state.tasks = C.editTask(state.tasks, t.id, { title: input.value, category: sel.value });
        editingId = null;
        save(); renderTasks();
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
        if (e.key === 'Escape') { editingId = null; renderTasks(); }
      });
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return el('li', { class: 'task' }, el('div', { class: 'task-edit' }, [
        input,
        el('div', { class: 'task-edit-row' }, [
          sel,
          el('button', { type: 'button', class: 'btn btn-primary', onclick: saveEdit, text: '儲存' }),
          el('button', { type: 'button', class: 'btn', onclick: () => { editingId = null; renderTasks(); }, text: '取消' }),
        ]),
      ]));
    }
    const meta = [el('span', { class: 'dot', style: `background:${cat.color}` }), el('span', { text: cat.name })];
    if (t.duration >= 60) meta.push(el('span', { text: `・已專注 ${C.formatMinutes(t.duration)}` }));
    if (t.carriedFrom) meta.push(el('span', { text: `・從 ${C.formatKeyShort(t.carriedFrom)} 延續` }));
    const actions = [];
    if (!done) actions.push(el('button', { type: 'button', class: 'play', 'aria-label': `開始專注：${t.title}`, title: '開始專注', onclick: () => startTaskFocus(t.id) }, icon('play')));
    actions.push(el('button', { type: 'button', 'aria-label': `編輯：${t.title}`, title: '編輯', onclick: () => { editingId = t.id; renderTasks(); } }, icon('edit')));
    actions.push(el('button', { type: 'button', 'aria-label': `刪除：${t.title}`, title: '刪除', onclick: () => deleteTask(t) }, icon('trash')));
    return el('li', { class: 'task' + (done ? ' done' : '') }, [
      el('button', {
        type: 'button', class: 'task-check', 'aria-pressed': String(done),
        'aria-label': (done ? '取消完成：' : '標記完成：') + t.title,
        onclick: () => toggleTask(t.id),
      }, icon('check')),
      el('div', { class: 'task-body' }, [el('div', { class: 'task-meta' }, meta), el('div', { class: 'task-title', text: t.title })]),
      el('div', { class: 'task-actions' }, actions),
    ]);
  }

  function renderTasks() {
    const d = today();
    const list = C.tasksForDate(state.tasks, d);
    const doneN = list.filter(t => t.status === 'completed').length;
    $('task-counter').textContent = `${doneN}/${Math.max(MAX, list.length)}`;
    $('task-counter').setAttribute('aria-label', `今日完成 ${doneN} 件，共 ${list.length} 件`);
    const ul = $('task-list');
    ul.textContent = '';
    for (const t of list) ul.append(taskCard(t));
    $('tasks-empty').hidden = list.length > 0;
    const full = list.length >= MAX;
    $('add-form').hidden = full;
    $('full-note').hidden = !full || allDoneToday();
    if (full && allDoneToday()) { $('full-note').hidden = false; $('full-note').textContent = '今天的三件事都完成了，太棒了！好好休息。'; }
    else $('full-note').textContent = '今天的三件事已經排滿，先專心完成它們吧。';
    const carry = C.findCarryOver(state.tasks, d);
    const btn = $('btn-open-carry');
    btn.hidden = carry.length === 0 || full;
    btn.textContent = `前幾天還有 ${carry.length} 件未完成，看看要不要加入今天`;
  }

  function toggleTask(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    const done = t.status !== 'completed';
    state.tasks = C.setCompleted(state.tasks, id, done, today());
    if (done && state.timer.taskId === id && state.timer.phase === 'idle') state.timer = Object.assign({}, state.timer, { taskId: null });
    save();
    renderTasks();
    if (done) toast(allDoneToday() ? '今天的三件事都完成了，太棒了！' : '完成一件！不要緊，你正在前進。');
  }

  async function deleteTask(t) {
    const ok = await confirmDialog('刪除任務？', `「${t.title}」刪除後就找不回來了。`, '刪除');
    if (!ok) return;
    state.tasks = C.removeTask(state.tasks, t.id);
    if (state.timer.taskId === t.id) state.timer = Object.assign({}, state.timer, { taskId: null });
    save();
    renderTasks();
  }

  function startTaskFocus(id) {
    const t = state.timer, now = Date.now();
    const task = state.tasks.find(x => x.id === id);
    unlockAudio();
    if (t.phase === 'running' || t.phase === 'paused') {
      state.timer = Object.assign({}, t, { taskId: id });
      save();
      toast(`目前的計時改為專注在「${task ? task.title : ''}」。`);
      showView('focus');
      return;
    }
    let nt = C.createTimer('focus', minutesMs(state.settings, 'focus'), id);
    nt = C.startTimer(nt, now);
    setTimer(nt);
    showView('focus');
  }

  $('add-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('new-task-input');
    const r = C.addTask(state.tasks, { title: input.value, category: selectedCat, date: today() }, { max: MAX });
    if (r.error === 'empty') { input.focus(); toast('先輸入任務名稱。', 1800); return; }
    if (r.error === 'full') { toast(`今天最多 ${MAX} 件，先完成或刪掉一件吧。`); return; }
    if (r.error) return;
    state.tasks = r.tasks;
    input.value = '';
    save();
    renderTasks();
    if (!$('add-form').hidden) input.focus();
  });

  // ---------- 跨日延續（暖心提醒） ----------
  function roomToday() { return Math.max(0, MAX - C.tasksForDate(state.tasks, today()).length); }

  function openCarry(preselect) {
    const d = today();
    const all = C.findCarryOver(state.tasks, d);
    if (!all.length) { toast('沒有需要延續的任務。'); return; }
    const shown = all.slice(-20).reverse(); // 最近的在前，最多顯示 20 件
    const room = roomToday();
    const ul = $('carry-list');
    ul.textContent = '';
    shown.forEach((t, i) => {
      const checked = preselect ? preselect.includes(t.id) : i < room;
      ul.append(el('li', null, el('label', null, [
        el('input', { type: 'checkbox', value: t.id, checked: checked || null }),
        el('span', { class: 'dot', style: `background:${catOf(t.category).color}` }),
        el('span', { class: 't', text: t.title }),
        el('span', { class: 'd', text: C.formatKeyShort(t.date) }),
      ])));
    });
    $('carry-desc').textContent = all.length === 1
      ? '這項任務尚未完成，要幫您安排進今天的待辦清單中嗎？'
      : `前幾天還有 ${all.length} 件事沒完成，要幫您安排進今天的待辦清單中嗎？`;
    $('carry-room').textContent = room > 0 ? `今天還有 ${room} 個空位（一天最多 ${MAX} 件）。` : `今天已經排滿 ${MAX} 件，先完成或刪掉一件再加入。`;
    $('btn-carry-confirm').disabled = room === 0;
    state.carryPromptDate = d;
    save();
    openModal($('modal-carry'));
  }

  $('btn-carry-confirm').addEventListener('click', () => {
    const ids = Array.from($('carry-list').querySelectorAll('input:checked')).map(i => i.value);
    if (!ids.length) { closeModal($('modal-carry')); return; }
    const r = C.carryOver(state.tasks, ids, today(), MAX);
    state.tasks = r.tasks;
    save();
    closeModal($('modal-carry'));
    toast(r.skipped.length ? `已加入今天 ${r.moved.length} 件；今天滿了，另外 ${r.skipped.length} 件留在原本的日期。` : `已加入今天 ${r.moved.length} 件。`);
    showView('tasks');
  });
  $('btn-open-carry').addEventListener('click', () => openCarry());

  function maybePromptCarry() {
    const d = today();
    if (state.carryPromptDate === d) return;
    if (!C.findCarryOver(state.tasks, d).length || roomToday() === 0) return;
    if (document.querySelector('.modal:not([hidden])') || immersive) return;
    openCarry();
  }

  // ---------- 回顧 ----------
  function renderStats() {
    const d = today();
    const s = C.dayStats(state.tasks, state.focusLog, d);
    $('st-completed').textContent = String(s.completed);
    $('st-minutes').textContent = String(s.focusMinutes);
    $('st-streak').textContent = String(C.streak(state.tasks, state.focusLog, d));

    const days = C.lastNDays(state.tasks, state.focusLog, d, 7);
    const maxMin = Math.max(25, ...days.map(x => x.focusMinutes));
    const bars = $('week-bars');
    bars.textContent = '';
    for (const x of days) {
      const md = x.date.slice(5).split('-').map(Number).join('/');
      bars.append(el('div', { class: 'bar' + (x.date === d ? ' today' : '') }, [
        el('span', { class: 'bar-val', text: String(x.focusMinutes) }),
        el('div', { class: 'bar-fill', style: `height:${Math.round((x.focusMinutes / maxMin) * 100)}%` }),
        el('span', { class: 'bar-day', text: x.date === d ? '今天' : md }),
      ]));
    }
    bars.setAttribute('aria-label', '近 7 天專注分鐘：' + days.map(x => `${C.formatKeyShort(x.date)} ${x.focusMinutes} 分鐘`).join('，'));

    const totals = C.categoryTotals(state.tasks, d.slice(0, 7));
    const sum = Object.values(totals).reduce((a, b) => a + b, 0);
    const box = $('cat-stats');
    box.textContent = '';
    if (!sum) box.append(el('p', { class: 'muted small', text: '本月尚無紀錄。從「今日」的任務按 ▶ 開始專注，時間就會記在這裡。' }));
    else {
      const ids = new Set(CATS.map(c => c.id).concat(Object.keys(totals)));
      const rows = Array.from(ids).map(id => ({ cat: catOf(id), sec: totals[id] || 0 })).sort((a, b) => b.sec - a.sec);
      for (const r of rows) {
        box.append(el('div', { class: 'cat-row' }, [
          el('div', { class: 'cat-row-head' }, [el('span', { text: r.cat.name }), el('span', { text: C.formatMinutes(r.sec) })]),
          el('div', { class: 'track' }, el('div', { style: `width:${Math.round((r.sec / sum) * 100)}%;background:${r.cat.color}` })),
        ]));
      }
    }

    const pend = C.findCarryOver(state.tasks, d).slice(-8).reverse();
    const total = C.findCarryOver(state.tasks, d).length;
    const pl = $('pending-list');
    pl.textContent = '';
    if (!total) pl.append(el('p', { class: 'muted small', text: '沒有未完成的承諾，太棒了！' }));
    for (const t of pend) {
      pl.append(el('button', { type: 'button', class: 'pending-item', onclick: () => openCarry([t.id]) }, [
        el('span', { class: 'dot', style: `background:${catOf(t.category).color}` }),
        el('span', { class: 't', text: t.title }),
        el('span', { class: 'd', text: C.formatKeyShort(t.date) }),
      ]));
    }
    if (total > pend.length) pl.append(el('p', { class: 'muted small', text: `...還有 ${total - pend.length} 項` }));
  }

  $('btn-export').addEventListener('click', () => {
    const data = C.makeBackup({ tasks: state.tasks, focusLog: state.focusLog, settings: state.settings });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `tw-focus-clock-backup-${today()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已匯出備份檔。');
  });

  $('import-file').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast('檔案太大，不像是備份檔。'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const r = C.validateBackup(String(reader.result || ''), CFG);
      if (!r.ok) { toast('無法匯入：' + r.error, 5000); return; }
      const ok = await confirmDialog('匯入備份？', `備份裡有 ${r.data.tasks.length} 件任務。匯入會取代這台裝置上目前的資料。`, '匯入');
      if (!ok) return;
      state.tasks = r.data.tasks;
      state.focusLog = r.data.focusLog;
      state.settings = r.data.settings;
      state.timer = C.createTimer('focus', minutesMs(state.settings, 'focus'));
      state.carryPromptDate = '';
      save();
      applyTheme(); applyClockStyle(); refreshWake();
      renderAll();
      toast('匯入完成。');
    };
    reader.onerror = () => toast('讀取檔案失敗。');
    reader.readAsText(file);
  });

  $('btn-clear').addEventListener('click', async () => {
    const ok = await confirmDialog('清除全部資料？', '任務、專注紀錄、設定都會刪除，無法復原。建議先匯出備份。', '清除');
    if (!ok) return;
    state.tasks = [];
    state.focusLog = {};
    state.settings = C.normalizeSettings({}, CFG);
    state.timer = C.createTimer('focus', minutesMs(state.settings, 'focus'));
    state.cycle = { date: today(), count: 0 };
    state.carryPromptDate = '';
    save(); // 存一份空資料（不刪鍵值），避免舊版資料又被自動帶入
    applyTheme(); applyClockStyle(); refreshWake();
    renderAll();
    toast('已清除。');
  });

  // ---------- 設定 ----------
  const form = $('settings-form');
  $('btn-settings').addEventListener('click', () => {
    const s = state.settings;
    for (const k of ['focusMinutes', 'shortBreakMinutes', 'longBreakMinutes', 'longBreakEvery']) form.elements[k].value = s[k];
    for (const k of ['sound', 'keepAwake', 'autoStartNext', 'hour12']) form.elements[k].checked = s[k];
    form.elements.theme.value = s.theme;
    form.elements.clockStyle.value = s.clockStyle;
    openModal($('modal-settings'));
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const f = form.elements;
    state.settings = C.normalizeSettings({
      focusMinutes: f.focusMinutes.value, shortBreakMinutes: f.shortBreakMinutes.value,
      longBreakMinutes: f.longBreakMinutes.value, longBreakEvery: f.longBreakEvery.value,
      sound: f.sound.checked, keepAwake: f.keepAwake.checked, autoStartNext: f.autoStartNext.checked, hour12: f.hour12.checked,
      theme: f.theme.value, clockStyle: f.clockStyle.value,
    }, CFG);
    if (state.timer.phase === 'idle') {
      state.timer = C.createTimer(state.timer.mode, minutesMs(state.settings, state.timer.mode), state.timer.taskId);
    }
    save();
    closeModal($('modal-settings'));
    applyTheme(); applyClockStyle(); refreshWake();
    lastDigital = '';
    renderTimer();
    renderClockText(new Date());
    toast('設定已儲存。', 1600);
  });
  $('btn-test-sound').addEventListener('click', () => beep());

  // ---------- 鍵盤 ----------
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const open = Array.from(document.querySelectorAll('.modal:not([hidden])')).pop();
      if (open) { closeModal(open); return; }
      if (immersive) { exitImmersive(); return; }
    }
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.modal:not([hidden])')) return;
    if (e.key === ' ' && state.view === 'focus') { e.preventDefault(); $('btn-start').click(); }
    if ((e.key === 'f' || e.key === 'F') && state.view === 'clock') enterImmersive();
  });

  // ---------- 主迴圈：每 250ms 檢查一次（以時間戳記計算，不怕被節流） ----------
  function tick() {
    const now = Date.now();
    const d = today();
    if (d !== currentDay) {
      currentDay = d;
      syncCycleDay();
      save();
      renderAll();
      maybePromptCarry();
    }
    const t2 = C.tickTimer(state.timer, now);
    if (t2 !== state.timer) handleDone(t2);
    if (!rafId) renderClockText(new Date(now));
    if (state.view === 'focus' || state.timer.phase === 'running') renderTimer();
  }

  function renderAll() {
    lastDigital = ''; lastDate = '';
    renderClockText(new Date());
    renderAnalog(new Date());
    $('focus-quote').textContent = `「${C.quoteOfDay(QUOTES, today())}」`;
    renderTimer();
    renderFocusTaskSelect();
    renderTasks();
    if (state.view === 'stats') renderStats();
  }

  document.addEventListener('visibilitychange', () => {
    syncAnalogLoop();
    if (document.visibilityState === 'visible') { tick(); refreshWake(); }
  });

  // ---------- 啟動 ----------
  if (!storage.ok) $('storage-warning').hidden = false;
  applyTheme();
  applyClockStyle();
  renderCatChips();
  const fromHash = (location.hash || '').slice(1);
  showView(VIEWS.includes(fromHash) ? fromHash : state.view, { noSave: true });
  renderAll();
  tick();
  if (state.timer.phase === 'running') refreshWake();
  if (state.migrated) { save(); toast(`已帶入舊版「時。刻」的 ${state.migrated} 件任務。`, 4000); }

  const splash = $('splash');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hideSplash = () => {
    if (!splash.isConnected || splash.classList.contains('out')) return;
    splash.classList.add('out');
    setTimeout(() => { splash.remove(); maybePromptCarry(); }, 500);
  };
  splash.addEventListener('click', hideSplash);
  setTimeout(hideSplash, reduce ? 200 : 1600);

  setInterval(tick, 250);

  // 離線安裝（只在 http/https 啟用；直接雙擊 file:// 開啟時不載入，避免瀏覽器報錯）
  if (/^https?:$/.test(location.protocol)) {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = 'manifest.webmanifest';
    document.head.appendChild(link);
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
    }
  }
})();
