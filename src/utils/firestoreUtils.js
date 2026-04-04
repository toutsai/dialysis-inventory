// 檔案路徑: src/utils/firestoreUtils.js

import { collection, query, where, getDocs } from 'firebase/firestore'
import { db } from '@/firebase'

/**
 * 【增強版】解決 Firestore 'IN' 查詢最多只能有 30 個值的限制，並支援額外的 where 條件。
 *
 * 這個函式非常有用，當你需要根據一個長長的 ID 列表來查詢文件，同時還需要滿足其他條件時
 * (例如：查詢這 50 位病人在特定月份的報告)。
 * 它會自動將長的 ID 列表分塊，並行發送多個查詢，最後安全地合併所有結果。
 *
 * @param {string} collectionName - 要查詢的集合名稱 (e.g., 'patients', 'lab_reports')。
 * @param {string} fieldToQuery - 要用 'in' 進行比對的欄位名稱 (e.g., documentId() 或 'patientId')。
 * @param {Array<any>} values - 要查詢的所有值的完整陣列 (e.g., ['id1', 'id2', 'id3', ...])。
 * @param {Array<any>} [additionalWheres=[]] - (可選) 一個包含額外 Firestore where() 條件的陣列。
 *   範例: [
 *     where('reportDate', '>=', startDate),
 *     where('status', '==', 'active')
 *   ]
 * @returns {Promise<Array<object>>} - 合併後的所有查詢結果，每個物件都包含 id 和文件資料。
 */
export async function queryWithInChunks(
  collectionName,
  fieldToQuery,
  values,
  additionalWheres = [],
) {
  // 如果傳入的值陣列為空，直接返回空陣列，避免不必要的查詢。
  if (!values || values.length === 0) {
    return []
  }

  // Firestore 'in' 查詢的當前上限是 30 個值。
  const CHUNK_SIZE = 30
  const chunks = []

  // 將長陣列切割成多個小於等於 30 個元素的小區塊 (chunks)。
  for (let i = 0; i < values.length; i += CHUNK_SIZE) {
    chunks.push(values.slice(i, i + CHUNK_SIZE))
  }

  const collectionRef = collection(db, collectionName)

  // 為每一個小區塊 (chunk) 建立一個獨立的查詢 Promise。
  const promises = chunks.map(async (chunk) => {
    // ✨ 核心邏輯：動態組合查詢條件。
    //    將固定的 'in' 查詢和傳入的額外條件合併成一個條件陣列。
    const queryConstraints = [
      where(fieldToQuery, 'in', chunk),
      ...additionalWheres, // 使用展開運算符(...)將額外的條件陣列加入。
    ]

    // 建立完整的查詢。
    const q = query(collectionRef, ...queryConstraints)
    const querySnapshot = await getDocs(q)

    // 將這個區塊的查詢結果收集起來。
    const chunkResults = []
    querySnapshot.forEach((doc) => {
      chunkResults.push({ id: doc.id, ...doc.data() })
    })
    return chunkResults
  })

  // 使用 Promise.all() 並行執行所有的查詢，以獲得最佳效能。
  // `chunkedResults` 會是一個二維陣列，例如: [[結果1, 結果2], [結果3, 結果4], ...]
  const chunkedResults = await Promise.all(promises)

  // 使用 Array.prototype.flat() 將二維陣列攤平成一個單一的一維陣列。
  // 例如: [[1, 2], [3, 4]] -> [1, 2, 3, 4]
  return chunkedResults.flat()
}
