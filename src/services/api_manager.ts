// src/services/api_manager.ts

// 1. 從 Firebase SDK 中，引入所有我們需要用到的函式
import {
  collection,
  getDocs,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  getDoc,
  type QueryConstraint,
  type FirestoreDataConverter,
} from 'firebase/firestore'

// 2. 導入您的 Firebase db 實例
import { db } from '@/firebase'

type FirestoreRecord = { id?: string; [key: string]: unknown }

type ApiManagerReturn<T extends FirestoreRecord> = {
  fetchAll: (queryConstraints?: QueryConstraint[]) => Promise<T[]>
  save: (idOrData: string | T, data?: T) => Promise<T>
  update: (id: string, data: Partial<T>) => Promise<T>
  delete: (id: string) => Promise<{ id: string }>
  fetchById: (id: string) => Promise<T | null>
  create: (data: T) => Promise<T>
}

/**
 * 創建一個通用的 Firestore API 管理器。
 * @param {string} resourceType - Firestore 集合的名稱 (例如 'users', 'products')。
 * @returns {object} - 包含對該集合進行 CRUD 操作的函式物件。
 */
const ApiManager = <T extends FirestoreRecord>(resourceType: string): ApiManagerReturn<T> => {
  // 檢查 db 是否成功引入，這是非常好的習慣
  if (!db) {
    throw new Error("Firestore 'db' instance is not available! Check your firebase configuration.")
  }

  const collectionRef = collection(db, resourceType).withConverter({
    toFirestore(data: T) {
      const { id, ...rest } = data
      return rest as T
    },
    fromFirestore(snapshot) {
      return { id: snapshot.id, ...(snapshot.data() as T) }
    },
  } satisfies FirestoreDataConverter<T>)

  /**
   * 獲取集合中的所有文件。
   * @param {Array} [queryConstraints=[]] - (可選) Firestore 查詢約束陣列 (e.g., [where(...), orderBy(...)])。
   * @returns {Promise<Array<object>>} - 包含所有文件資料的陣列。
   */
  const fetchAll = async (queryConstraints: QueryConstraint[] = []) => {
    try {
      const q = queryConstraints.length > 0 ? query(collectionRef, ...queryConstraints) : collectionRef
      const querySnapshot = await getDocs(q)
      const allData: T[] = []
      querySnapshot.forEach((docSnapshot) => {
        allData.push({ id: docSnapshot.id, ...(docSnapshot.data() as T) })
      })
      return allData
    } catch (error) {
      console.error(`[ApiManager] Error fetching ${resourceType}:`, error)
      throw error
    }
  }

  /**
   * 保存文件。
   * - save(data): 新增文件，由 Firebase 自動生成 ID。
   * - save(id, data): 創建或完全覆蓋指定 ID 的文件。
   * @param {string|object} idOrData - 文件的 ID 或要保存的資料物件。
   * @param {object} [data] - (可選) 如果第一個參數是 ID，則這是要保存的資料。
   * @returns {Promise<object>} - 返回包含 id 和已保存資料的物件，方便前端更新。
   */
  const save = async (idOrData: string | T, data?: T) => {
    try {
      // 情況一：新增文件 (addDoc)
      if (typeof idOrData === 'object' && data === undefined) {
        const dataToSave = idOrData
        const docRef = await addDoc(collectionRef, dataToSave)
        console.log(`[ApiManager] Added new document to ${resourceType} with ID: ${docRef.id}`)
        return { id: docRef.id, ...dataToSave }
      }
      // 情況二：指定 ID 創建/覆蓋 (setDoc)
      else if (typeof idOrData === 'string' && typeof data === 'object') {
        const id = idOrData
        const dataToSave = data
        const docRef = doc(db, resourceType, id)
        await setDoc(docRef, dataToSave, { merge: true }) // ✨ 建議：加上 merge: true，避免意外覆蓋整個文件
        console.log(`[ApiManager] Set document with ID ${id} in ${resourceType}`)
        return { id, ...dataToSave }
      }
      // 情況三：參數錯誤
      else {
        throw new Error('Invalid arguments for save function. Use save(data) or save(id, data).')
      }
    } catch (error) {
      console.error(`[ApiManager] Error saving to ${resourceType}:`, error)
      throw error
    }
  }

  /**
   * 更新指定 ID 的文件。
   * @param {string} id - 要更新的文件的 ID。
   * @param {object} data - 要更新的欄位物件。
   * @returns {Promise<object>} - 返回包含 id 和已更新資料的物件。
   */
  const update = async (id: string, data: Partial<T>) => {
    if (!id || typeof id !== 'string') {
      const errorMessage = `[ApiManager] Invalid or missing ID for update in ${resourceType}. ID must be a non-empty string.`
      console.error(errorMessage)
      throw new Error(errorMessage)
    }

    try {
      const docRef = doc(db, resourceType, id)
      await updateDoc(docRef, data as any)
      console.log(`[ApiManager] Successfully updated document with ID: ${id} in ${resourceType}`)
      return { id, ...(data as T) }
    } catch (error) {
      console.error(`[ApiManager] Error updating document with ID ${id}:`, error)
      throw error
    }
  }

  /**
   * 根據 ID 獲取單一文件。
   * @param {string} id - 要獲取的文件 ID。
   * @returns {Promise<object|null>} - 返回文件物件，如果不存在則返回 null。
   */
  const fetchById = async (id: string) => {
    if (!id || typeof id !== 'string') {
      // 修正：當ID為空時，不應該拋出錯誤，而是直接返回 null，讓呼叫端處理
      console.warn(
        `[ApiManager] fetchById called with invalid ID in ${resourceType}. Returning null.`,
      )
      return null
    }

    try {
      const docRef = doc(db, resourceType, id)
      const docSnap = await getDoc(docRef)

      if (docSnap.exists()) {
        console.log(`[ApiManager] Fetched document with ID ${id} from ${resourceType}`)
        return { id: docSnap.id, ...(docSnap.data() as T) }
      } else {
        console.warn(`[ApiManager] No document found with ID ${id} in ${resourceType}`)
        return null
      }
    } catch (error) {
      console.error(`[ApiManager] Error fetching document with ID ${id}:`, error)
      throw error
    }
  }

  /**
   * 刪除指定 ID 的文件。
   * @param {string} id - 要刪除的文件的 ID。
   * @returns {Promise<{id: string}>} - 返回被刪除文件的 ID。
   */
  const deleteDocument = async (id: string) => {
    if (!id || typeof id !== 'string') {
      const errorMessage = `[ApiManager] Invalid or missing ID for deletion in ${resourceType}. ID must be a non-empty string.`
      console.error(errorMessage)
      throw new Error(errorMessage)
    }

    try {
      const docRef = doc(db, resourceType, id)
      await deleteDoc(docRef)
      console.log(`[ApiManager] Successfully deleted document with ID: ${id} from ${resourceType}`)
      return { id }
    } catch (error) {
      console.error(`[ApiManager] Error deleting document with ID ${id}:`, error)
      throw error
    }
  }

  // ✨✨✨ 核心修正點 ✨✨✨
  /**
   * 新增一個文件，並讓 Firebase 自動生成 ID。
   * @param {object} data - 要新增的資料。
   * @returns {Promise<object>} - 返回包含新 ID 和已儲存資料的物件。
   */
  const create = async (data: T) => {
    // 直接呼叫您已經寫好的 save 函式的第一種情況
    return save(data)
  }

  // 返回所有可用的 API 函式
  return {
    fetchAll,
    save,
    update,
    delete: deleteDocument, // 'delete' 是關鍵字，這樣賦值是標準做法
    fetchById,
    create, // ✨ 將新的 create 函式匯出
  }
}

export default ApiManager
