// 檔案路徑: src/services/nursingGroupConfigService.js

import { doc, getDoc, setDoc, getDocs, collection, query, orderBy, limit, serverTimestamp } from 'firebase/firestore'
import { db } from '@/firebase'

const CONFIG_COLLECTION = 'nursing_group_config'

// 早班組別字母（B-K，A組保留給74/L）
const DAY_SHIFT_LETTERS = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']

// 晚班組別字母（A-J）
const NIGHT_SHIFT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']

/**
 * 根據組數產生早班可用組別（從B開始）
 * @param {number} count - 組數
 * @returns {string[]}
 */
export const generateDayShiftGroups = (count) => {
  const validCount = Math.min(Math.max(count || 0, 0), DAY_SHIFT_LETTERS.length)
  return DAY_SHIFT_LETTERS.slice(0, validCount)
}

/**
 * 根據組數產生晚班可用組別（從A開始）
 * @param {number} count - 組數
 * @returns {string[]}
 */
export const generateNightShiftGroups = (count) => {
  const validCount = Math.min(Math.max(count || 0, 0), NIGHT_SHIFT_LETTERS.length)
  return NIGHT_SHIFT_LETTERS.slice(0, validCount)
}

/**
 * 計算74班可用組別
 * 74班 = 早班可用組別 - 75班組別
 * @param {string[]} dayShiftGroups - 早班可用組別
 * @param {string[]} shift75Groups - 75班使用的組別
 * @returns {string[]}
 */
export const calculate74Groups = (dayShiftGroups, shift75Groups) => {
  const shift75Set = new Set(shift75Groups || [])
  return (dayShiftGroups || []).filter((g) => !shift75Set.has(g))
}

// 早班最大組數
export const MAX_DAY_SHIFT_GROUPS = DAY_SHIFT_LETTERS.length // 9

// 晚班最大組數
export const MAX_NIGHT_SHIFT_GROUPS = NIGHT_SHIFT_LETTERS.length // 9

/**
 * 預設的組別配置
 * @returns {object}
 */
export const getDefaultConfig = () => ({
  // 固定分配規則（無法修改）
  fixedAssignments: {
    '74/L': 'A',
    '816': '外圍',
    '311C': 'C', // 311C 固定為夜班 C 組
  },

  // 住院組定義
  hospitalGroups: {
    dayShift: ['H', 'I'],     // 白班住院組
    nightShift: ['G', 'H'],   // 夜班住院組
  },

  // 星期別組數設定
  groupCounts: {
    '135': {
      dayShiftCount: 8,   // 一三五早班共8組 → B-I
      nightShiftCount: 9, // 一三五晚班共9組 → A-I
    },
    '246': {
      dayShiftCount: 9,   // 二四六早班共9組 → B-J
      nightShiftCount: 8, // 二四六晚班共8組 → A-H
    },
  },

  // 早班 75班組別設定（從早班可用組別中選）
  dayShiftRules: {
    '135': {
      shift75Groups: ['F'], // 75班用F，74班自動用剩餘的
    },
    '246': {
      shift75Groups: ['F', 'J'], // 75班用F,J，74班自動用剩餘的
    },
  },

  // 不可擔任晚班組長的護理師 (存放 nurseId)
  cannotBeNightLeader: [],

  // 夜班組別限制 - 特定護理師不能排特定夜班組別
  // 格式: { nurseId: ['C', 'G', 'H'], ... }
  nightShiftRestrictions: {},

  // 新進護理師暫不分組（存放 nurseId 陣列）
  excludedNurses: [],

  // 最後修改資訊
  lastModified: {
    date: null,
    userId: null,
    userName: null,
  },
})

/**
 * 計算上一個月份
 * @param {string} yearMonth - YYYY-MM 格式
 * @returns {string} - 上一個月份 YYYY-MM 格式
 */
function getPreviousMonth(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number)
  if (month === 1) {
    return `${year - 1}-12`
  }
  return `${year}-${String(month - 1).padStart(2, '0')}`
}

/**
 * 從 Firestore 獲取指定月份的護理組別配置
 * 如果該月份不存在，會嘗試載入最近的配置
 * @param {string} yearMonth - 月份 (YYYY-MM 格式)
 * @returns {Promise<{config: object, sourceMonth: string|null}>}
 */
export async function fetchNursingGroupConfig(yearMonth) {
  try {
    // 1. 先嘗試載入指定月份的配置
    if (yearMonth) {
      const docRef = doc(db, CONFIG_COLLECTION, yearMonth)
      const docSnap = await getDoc(docRef)

      if (docSnap.exists()) {
        console.log(`✅ 從 Firestore 成功獲取 ${yearMonth} 的護理組別配置`)
        return {
          config: docSnap.data(),
          sourceMonth: yearMonth,
        }
      }
    }

    // 2. 如果指定月份不存在，嘗試載入上個月的配置（最多往前找12個月）
    if (yearMonth) {
      let searchMonth = getPreviousMonth(yearMonth)
      for (let i = 0; i < 12; i++) {
        const docRef = doc(db, CONFIG_COLLECTION, searchMonth)
        const docSnap = await getDoc(docRef)

        if (docSnap.exists()) {
          console.log(`⚠️ ${yearMonth} 無配置，使用 ${searchMonth} 的配置`)
          return {
            config: docSnap.data(),
            sourceMonth: searchMonth,
          }
        }
        searchMonth = getPreviousMonth(searchMonth)
      }
    }

    // 3. 嘗試載入舊的 'default' 文件（向後相容）
    const defaultDocRef = doc(db, CONFIG_COLLECTION, 'default')
    const defaultDocSnap = await getDoc(defaultDocRef)

    if (defaultDocSnap.exists()) {
      console.log('⚠️ 使用舊的 default 配置')
      return {
        config: defaultDocSnap.data(),
        sourceMonth: 'default',
      }
    }

    // 4. 都找不到，回傳預設值
    console.log('⚠️ 在 Firestore 中找不到任何護理組別配置，回傳預設值。')
    return {
      config: getDefaultConfig(),
      sourceMonth: null,
    }
  } catch (error) {
    console.error('❌ 獲取護理組別配置失敗:', error)
    throw new Error('無法從資料庫獲取護理組別配置。')
  }
}

/**
 * 將護理組別配置儲存到 Firestore（按月份儲存）
 * @param {object} config - 要儲存的配置物件
 * @param {string} yearMonth - 月份 (YYYY-MM 格式)
 * @param {object} currentUser - 當前使用者資訊
 * @returns {Promise<void>}
 */
export async function saveNursingGroupConfig(config, yearMonth, currentUser) {
  if (!yearMonth) {
    throw new Error('儲存配置時必須指定月份')
  }

  try {
    const docRef = doc(db, CONFIG_COLLECTION, yearMonth)

    const dataToSave = {
      ...config,
      yearMonth, // 記錄這份配置對應的月份
      lastModified: {
        date: serverTimestamp(),
        userId: currentUser?.uid || null,
        userName: currentUser?.displayName || currentUser?.name || '未知',
      },
    }

    // 不使用 merge: true，直接覆寫整份文件，確保刪除的欄位會被移除
    await setDoc(docRef, dataToSave)
    console.log(`✅ 護理組別配置已成功儲存到 Firestore (${yearMonth})`)
  } catch (error) {
    console.error('❌ 儲存護理組別配置失敗:', error)
    throw new Error('儲存護理組別配置到資料庫時發生錯誤。')
  }
}

/**
 * 驗證配置是否合法
 * @param {object} config - 配置物件
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateConfig(config) {
  const errors = []
  const groupCounts = config.groupCounts || {}
  const dayRules = config.dayShiftRules || {}

  // 驗證一三五
  const counts135 = groupCounts['135'] || {}
  const dayCount135 = counts135.dayShiftCount || 0
  const nightCount135 = counts135.nightShiftCount || 0
  const dayGroups135 = generateDayShiftGroups(dayCount135)
  const shift75Groups135 = dayRules['135']?.shift75Groups || []

  if (dayCount135 < 1) {
    errors.push('一三五早班至少需要1組')
  }
  if (nightCount135 < 1) {
    errors.push('一三五晚班至少需要1組')
  }
  if (shift75Groups135.length === 0) {
    errors.push('一三五 75班至少需要選擇一個組別')
  }
  // 檢查75班組別是否在早班可用組別內
  const invalid75_135 = shift75Groups135.filter((g) => !dayGroups135.includes(g))
  if (invalid75_135.length > 0) {
    errors.push(`一三五 75班組別 ${invalid75_135.join(', ')} 超出早班可用範圍 (${dayGroups135.join(', ')})`)
  }

  // 驗證二四六
  const counts246 = groupCounts['246'] || {}
  const dayCount246 = counts246.dayShiftCount || 0
  const nightCount246 = counts246.nightShiftCount || 0
  const dayGroups246 = generateDayShiftGroups(dayCount246)
  const shift75Groups246 = dayRules['246']?.shift75Groups || []

  if (dayCount246 < 1) {
    errors.push('二四六早班至少需要1組')
  }
  if (nightCount246 < 1) {
    errors.push('二四六晚班至少需要1組')
  }
  if (shift75Groups246.length === 0) {
    errors.push('二四六 75班至少需要選擇一個組別')
  }
  // 檢查75班組別是否在早班可用組別內
  const invalid75_246 = shift75Groups246.filter((g) => !dayGroups246.includes(g))
  if (invalid75_246.length > 0) {
    errors.push(`二四六 75班組別 ${invalid75_246.join(', ')} 超出早班可用範圍 (${dayGroups246.join(', ')})`)
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
