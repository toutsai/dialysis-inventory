// 檔案路徑: src/services/nurseAssignmentsService.js
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/firebase' // ← 修正這裡！

const COLLECTION_NAME = 'nurse_assignments'

/**
 * 根據日期獲取護理分組
 * ✅ 優化：使用 doc ID 直取，比 query 快（省 index 查詢開銷）
 * @param {string} dateStr - 日期字串 (YYYY-MM-DD)
 * @returns {Promise<Object|null>} 護理分組記錄
 */
export async function fetchTeamsByDate(dateStr) {
  try {
    const docRef = doc(db, COLLECTION_NAME, dateStr)
    const docSnap = await getDoc(docRef)

    if (!docSnap.exists()) {
      return null
    }

    return {
      id: docSnap.id,
      ...docSnap.data(),
    }
  } catch (error) {
    console.error('獲取護理分組失敗:', error)
    throw error
  }
}

/**
 * 儲存新的護理分組
 * @param {Object} data - 包含 date 和 teams 的資料
 * @returns {Promise<Object>} 儲存後的記錄（含 ID）
 */
export async function saveTeams(data) {
  try {
    const docRef = doc(db, 'nurse_assignments', data.date)

    // 新建時確保結構完整
    const saveData = {
      date: data.date,
      teams: data.teams || {},
      names: data.names || {},
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }

    await setDoc(docRef, saveData)
    return { id: data.date, ...saveData }
  } catch (error) {
    console.error('儲存護理師分組失敗:', error)
    throw error
  }
}

/**
 * 更新現有的護理分組
 * @param {string} docId - 文件 ID
 * @param {Object} data - 更新的資料
 * @returns {Promise<void>}
 */
export async function updateTeams(docId, data) {
  try {
    const docRef = doc(db, 'nurse_assignments', docId)

    // 確保更新時包含所有必要欄位
    const updateData = {
      ...data,
      updatedAt: serverTimestamp(),
    }

    await updateDoc(docRef, updateData)
    return { success: true }
  } catch (error) {
    console.error('更新護理師分組失敗:', error)
    throw error
  }
}

/**
 * 批量獲取日期範圍內的護理分組
 * @param {string} startDate - 開始日期 (YYYY-MM-DD)
 * @param {string} endDate - 結束日期 (YYYY-MM-DD)
 * @returns {Promise<Array>} 護理分組記錄陣列
 */
export async function fetchTeamsInRange(startDate, endDate) {
  try {
    const q = query(
      collection(db, COLLECTION_NAME),
      where('date', '>=', startDate),
      where('date', '<=', endDate),
    )
    const querySnapshot = await getDocs(q)

    return querySnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
  } catch (error) {
    console.error('批量獲取護理分組失敗:', error)
    throw error
  }
}

/**
 * 複製某一天的護理分組到另一天
 * @param {string} sourceDate - 來源日期
 * @param {string} targetDate - 目標日期
 * @returns {Promise<Object>} 新建立的記錄
 */
export async function copyTeamsToDate(sourceDate, targetDate) {
  try {
    const sourceData = await fetchTeamsByDate(sourceDate)
    if (!sourceData) {
      throw new Error(`找不到 ${sourceDate} 的護理分組資料`)
    }

    // 檢查目標日期是否已有資料
    const existingData = await fetchTeamsByDate(targetDate)
    if (existingData) {
      // 更新現有資料
      return await updateTeams(existingData.id, {
        teams: sourceData.teams,
        date: targetDate,
      })
    } else {
      // 建立新資料
      return await saveTeams({
        date: targetDate,
        teams: sourceData.teams,
      })
    }
  } catch (error) {
    console.error('複製護理分組失敗:', error)
    throw error
  }
}

/**
 * 刪除特定日期的護理分組
 * @param {string} dateStr - 日期字串
 * @returns {Promise<boolean>} 是否刪除成功
 */
export async function deleteTeamsByDate(dateStr) {
  try {
    const data = await fetchTeamsByDate(dateStr)
    if (data && data.id) {
      const docRef = doc(db, COLLECTION_NAME, data.id)
      await deleteDoc(docRef)
      return true
    }
    return false
  } catch (error) {
    console.error('刪除護理分組失敗:', error)
    throw error
  }
}

/**
 * 清空特定日期的所有護理分組（但保留記錄）
 * @param {string} dateStr - 日期字串
 * @returns {Promise<void>}
 */
export async function clearTeamsByDate(dateStr) {
  try {
    const data = await fetchTeamsByDate(dateStr)
    if (data && data.id) {
      await updateTeams(data.id, {
        teams: {},
        date: dateStr,
      })
    }
  } catch (error) {
    console.error('清空護理分組失敗:', error)
    throw error
  }
}
