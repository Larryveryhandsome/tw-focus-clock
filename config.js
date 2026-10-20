/*
 * tw-focus-clock 設定檔
 * 用記事本打開就能改，改完存檔、重新整理網頁即可。
 * 這裡是「預設值」；使用者在網頁「設定」裡改過的會優先（存在自己的瀏覽器）。
 */
window.FOCUS_CONFIG = {
  title: '時。刻 專注時鐘',
  locale: 'zh-TW',

  // 番茄鐘預設長度（分鐘）
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4,        // 每專注幾次換一次長休息

  maxTasksPerDay: 3,        // 「今日三件事」：一天最多幾件

  sound: true,              // 時間到嗶三聲（瀏覽器內建合成音，不用下載音檔）
  keepAwake: true,          // 專注計時中盡量讓螢幕不要自動關閉
  autoStartNext: false,     // 專注結束後自動開始休息（休息完自動開始專注）
  theme: 'system',          // system 跟隨系統、light 淺色、dark 深色
  clockStyle: 'both',       // both 指針＋數字、digital 只顯示大數字
  hour12: false,            // true 顯示「下午 1:05」

  // 任務分類：id 不要改（舊資料靠它對應），name、color 可以改
  categories: [
    { id: 'work', name: '工作', color: '#f59e0b' },
    { id: 'life', name: '生活', color: '#a1a1aa' },
    { id: 'learn', name: '學習', color: '#f472b6' },
    { id: 'health', name: '健康', color: '#34d399' },
  ],

  // 專注畫面與完成時隨機出現的一句話
  quotes: [
    '不要緊，你正在前進。',
    '專注當下，時間便有了形狀。',
    '把時間當作朋友。',
    '專注當下，感受流動。',
    '一次只做一件事，就是最快的方法。',
    '休息不是偷懶，是為了走更遠。',
    '慢慢來，比較快。',
  ],
};
