// functions/utils/dateUtils.js

const TIME_ZONE = 'Asia/Taipei'

/**
 * 取得當前台北時區的 Date 物件。
 * @returns {Date} 代表當前台北時間的 Date 物件
 */
function getTaipeiNow() {
  // 建立一個符合 ISO 格式的台北時間字串，再轉回 Date 物件，以避免本地環境影響
  const now = new Date()
  const tzString = now.toLocaleString('en-US', { timeZone: TIME_ZONE })
  return new Date(tzString)
}

/**
 * 將指定的 Date 物件格式化為 'YYYY-MM-DD' 字串。
 * 這是 Firestore 查詢最理想的日期格式。
 * @param {Date} date - (可選) 要格式化的日期物件，預設為當前台北時間。
 * @returns {string} 'YYYY-MM-DD' 格式的日期字串。
 */
function formatDateToYYYYMMDD(date = new Date()) {
  // 使用 'sv-SE' (Swedish) locale 可以直接得到 'YYYY-MM-DD' 格式，無需替換。
  // 這是處理日期格式化的一個穩健技巧。
  return new Date(date).toLocaleDateString('sv-SE', { timeZone: TIME_ZONE })
}

/**
 * 取得台北時區「今天」的 'YYYY-MM-DD' 字串。
 * @returns {string}
 */
function getTaipeiTodayString() {
  return formatDateToYYYYMMDD(new Date())
}

/**
 * 取得台北時區「昨天」的 'YYYY-MM-DD' 字串。
 * @returns {string}
 */
function getTaipeiYesterdayString() {
  const todayStr = getTaipeiTodayString()
  const yesterday = new Date(todayStr + 'T00:00:00Z')
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  return formatDateToYYYYMMDD(yesterday)
}

/**
 * ✨【全新函式】✨
 * 取得指定 Date 物件在「台北時區」下的星期索引。
 * 輸出：0=週一, 1=週二, ..., 6=週日
 * @param {Date} date - 要計算的日期物件
 * @returns {number}
 */
function getTaipeiDayIndex(date) {
  // 使用 toLocaleString 搭配 'en-US' 和 weekday:'short' 可以穩定地取得星期的英文縮寫 (e.g., "Mon", "Sun")
  const dayString = date.toLocaleString('en-US', { timeZone: TIME_ZONE, weekday: 'short' })

  const dayMap = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  }

  return dayMap[dayString]
}

// 導出所有函式，讓其他檔案可以引用
module.exports = {
  getTaipeiNow,
  formatDateToYYYYMMDD,
  getTaipeiTodayString,
  getTaipeiYesterdayString,
  getTaipeiDayIndex, // <--- ✨ 確保導出新函式
  TIME_ZONE,
}
