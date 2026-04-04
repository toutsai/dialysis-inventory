// 檔案路徑: src/services/nursingDutyService.js

import ApiManager from './api_manager' // 確保您有這個共用的 ApiManager
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '@/firebase'

const dutiesApi = ApiManager('nursing_duties')
const DUTY_DOC_ID = 'main' // 我們使用一個固定的文件 ID

// 預設的空資料結構
const getDefaultData = () => ({
  announcement: '請在此輸入班別規則說明...',
  dayShift: { codes: '', tasks: '' },
  nightShift: [],
  checklist: [],
  teamwork: [],
  lastModified: { date: '', user: '系統' },
})

/**
 * 從 Firestore 獲取護理工作職責
 * @returns {Promise<object>}
 */
export async function fetchDuties() {
  try {
    const docRef = doc(db, 'nursing_duties', DUTY_DOC_ID)
    const docSnap = await getDoc(docRef)

    if (docSnap.exists()) {
      console.log('✅ 從 Firestore 成功獲取護理職責資料')
      return docSnap.data()
    } else {
      console.log('⚠️ 在 Firestore 中找不到護理職責文件，回傳預設值。')
      return getDefaultData()
    }
  } catch (error) {
    console.error('❌ 獲取護理職責失敗:', error)
    throw new Error('無法從資料庫獲取護理職責資料。')
  }
}

/**
 * 將護理工作職責儲存到 Firestore
 * @param {object} data - 要儲存的完整資料物件
 * @returns {Promise<void>}
 */
export async function saveDuties(data) {
  try {
    const docRef = doc(db, 'nursing_duties', DUTY_DOC_ID)
    // 使用 setDoc 搭配 { merge: true }，如果文件不存在會建立，如果存在則會更新
    await setDoc(docRef, data, { merge: true })
    console.log('✅ 護理職責資料已成功儲存到 Firestore')
  } catch (error) {
    console.error('❌ 儲存護理職責失敗:', error)
    throw new Error('儲存護理職責到資料庫時發生錯誤。')
  }
}
