// 檔案路徑: src/utils/taskHandlers.js

import { collection, addDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '@/firebase'

/**
 * 處理新增交辦/留言的通用函式
 * @param {object} data - 從 TaskCreateDialog 元件 submit 事件傳來的表單資料
 * @param {object} currentUser - 當前登入的使用者物件 (來自 useAuth)
 * @returns {Promise<void>}
 */
export async function handleTaskCreated(data, currentUser) {
  // 1. 安全檢查：確保有使用者資料
  if (!currentUser) {
    console.error('[handleTaskCreated] Error: currentUser is not available.')
    // 可以在這裡拋出錯誤或顯示通知
    throw new Error('使用者未登入，無法新增項目。')
  }

  // 2. 準備要寫入資料庫的 payload 物件
  const payload = {
    ...data, // 包含從 dialog 傳來的 patientId, content, type, targetDate 等
    creator: {
      uid: currentUser.uid,
      name: currentUser.name,
    },
    status: 'pending',
    createdAt: serverTimestamp(), // 使用 Firestore 伺服器時間，確保時間一致性
    resolvedAt: null,
    resolvedBy: null,
  }

  // 3. 根據 data.category 決定要寫入哪個集合 (collection)
  //    'task' -> 交辦事項
  //    'message' -> 留言
  const collectionName = data.category === 'task' ? 'tasks' : 'memos'

  try {
    // 4. 使用 addDoc 將資料寫入指定的集合
    const docRef = await addDoc(collection(db, collectionName), payload)
    console.log(
      `[handleTaskCreated] Document written with ID: ${docRef.id} to collection: ${collectionName}`,
    )
  } catch (error) {
    console.error(`[handleTaskCreated] Error adding document to ${collectionName}:`, error)
    // 拋出錯誤，讓呼叫它的元件可以捕捉並處理 (例如顯示錯誤訊息)
    throw error
  }
}
