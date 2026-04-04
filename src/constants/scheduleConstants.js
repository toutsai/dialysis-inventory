// src/constants/scheduleConstants.js

/**
 * 系統核心班別代碼 (用於資料庫儲存和內部邏輯)
 * @enum {string}
 */
export const SHIFT_CODES = {
  EARLY: 'early',
  NOON: 'noon',
  LATE: 'late',
}

/**
 * 班別代碼對應的中文顯示名稱 (用於 UI)
 */
export const SHIFT_DISPLAY_NAMES = {
  [SHIFT_CODES.EARLY]: '早班',
  [SHIFT_CODES.NOON]: '午班',
  [SHIFT_CODES.LATE]: '晚班',
}

/**
 * 有序的班別代碼陣列，方便在模板中 v-for 迴圈
 */
export const ORDERED_SHIFT_CODES = [SHIFT_CODES.EARLY, SHIFT_CODES.NOON, SHIFT_CODES.LATE]

/**
 * 根據班別代碼獲取對應的中文顯示名稱
 * @param {string} code - 班別代碼 (e.g., 'early')
 * @returns {string} - 中文顯示名稱 (e.g., '早班')
 */
export function getShiftDisplayName(code) {
  return SHIFT_DISPLAY_NAMES[code] || '未知班別'
}

// =================================
// ==    護理組別 (Team) 相關常量    ==
// =================================

/**
 * 基礎護理組別名稱
 */
export const baseTeams = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', '外圍']

/**
 * 早班可用的護理組別 (早 + 組名)
 */
export const earlyTeams = baseTeams.map((t) => `早${t}`)

/**
 * 晚班可用的護理組別 (晚 + 組名)
 */
export const lateTeams = baseTeams.map((t) => `晚${t}`)

/**
 * 所有可能的護理組別 (用於午班收針等情況)
 */
export const allTeams = [...earlyTeams, ...lateTeams]
