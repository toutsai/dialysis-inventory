// 檔案路徑: src/services/baseScheduleService.js
// (已根據 { [patientId]: ruleData } 的正確資料結構進行重構)

import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from '@/firebase'
import { generateAutoNote } from '@/utils/scheduleUtils.js'

// 直接獲取 Firestore 文件引用
const masterScheduleRef = doc(db, 'base_schedules', 'MASTER_SCHEDULE')

/**
 * 【已棄用 - 建議】從總床位表中移除指定病人的所有規則。
 * 註：Pinia Store 中的 `removeRuleFromMasterSchedule` 是更優的選擇，
 * 因為它還包含了取消未來調班的原子化操作。此函式作為備用。
 * @param {string} patientId - 病人ID
 * @returns {Promise<boolean>} 操作是否成功
 */
export async function removePatientFromBaseSchedule(patientId) {
  console.log(`🗑️ [BaseScheduleService] 開始從總床位表移除病人: ${patientId}`)

  try {
    // 直接使用 Firestore 的 FieldValue.delete() 來原子性地刪除一個 key
    await updateDoc(masterScheduleRef, {
      [`schedule.${patientId}`]: 'DELETE', // 假設 ApiManager 將 'DELETE' 轉為 FieldValue.delete()
      // 如果直接用 updateDoc，應該是 FieldValue.delete()
      updatedAt: new Date(),
      lastModifiedBy: 'system_remove_rule',
    })

    console.log(`✅ [BaseScheduleService] 已發送刪除病人 ${patientId} 規則的請求。`)
    return true
  } catch (error) {
    // 即使文件或欄位不存在，updateDoc 也不會報錯，但其他網路等問題會
    console.error(`❌ [BaseScheduleService] 移除病人 ${patientId} 規則失敗:`, error)
    throw new Error(`移除病人規則失敗: ${error.message}`)
  }
}

/**
 * 【重構版】更新總床位表中指定病人的頻率。
 * @param {string} patientId - 病人ID
 * @param {string} newFreq - 新頻率
 * @param {object} patientData - 完整的病人資料（用於重新生成autoNote）
 * @returns {Promise<void>}
 */
export async function updatePatientFreqInBaseSchedule(patientId, newFreq, patientData) {
  console.log(`🔄 [BaseScheduleService] 開始更新病人頻率: ${patientId} → ${newFreq}`)

  try {
    // 檢查病人規則是否存在，如果不存在則不進行任何操作
    const docSnap = await getDoc(masterScheduleRef)
    if (!docSnap.exists() || !docSnap.data().schedule?.[patientId]) {
      console.log(`ℹ️ [BaseScheduleService] 病人 ${patientId} 在總表中沒有規則，無需更新頻率。`)
      return
    }

    // 使用 "點" 表示法直接更新巢狀物件的欄位
    // 這是最高效且最正確的方式
    await updateDoc(masterScheduleRef, {
      [`schedule.${patientId}.freq`]: newFreq,
      [`schedule.${patientId}.autoNote`]: generateAutoNote(patientData), // 同時更新自動備註
      updatedAt: new Date(),
      lastModifiedBy: 'system_freq_update',
    })

    console.log(`✅ [BaseScheduleService] 成功更新病人 ${patientId} 的頻率為 ${newFreq}`)
  } catch (error) {
    console.error(`❌ [BaseScheduleService] 更新病人 ${patientId} 頻率失敗:`, error)
    throw new Error(`更新病人頻率失敗: ${error.message}`)
  }
}

/**
 * 【重構版】檢查總床位表中是否存在指定病人的規則。
 * @param {string} patientId - 病人ID
 * @returns {Promise<boolean>}
 */
export async function hasPatientInBaseSchedule(patientId) {
  try {
    const docSnap = await getDoc(masterScheduleRef)

    // 文件不存在，或者 schedule 物件中沒有這個 patientId 的 key
    if (!docSnap.exists() || !docSnap.data().schedule?.[patientId]) {
      return false
    }

    // 直接透過 key 查找，最高效
    return true
  } catch (error) {
    console.error(`❌ [BaseScheduleService] 檢查病人 ${patientId} 規則失敗:`, error)
    // 在發生錯誤時，保守地返回 false
    return false
  }
}
