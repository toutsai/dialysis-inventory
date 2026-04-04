import { db } from '@/firebase'
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  runTransaction,
} from 'firebase/firestore'

export const kiditService = {
  // 1. 取得指定月份的 Logbook (保持不變)
  async fetchMonthLogs(year, month) {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const nextDate = new Date(year, month, 1)
    const endDate = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-01`

    const q = query(
      collection(db, 'kidit_logbook'),
      where('date', '>=', startDate),
      where('date', '<', endDate),
    )
    const snapshot = await getDocs(q)
    return snapshot.docs.map((doc) => doc.data())
  },

  // 2. 更新整包 Logbook 事件 (保持不變，用於 MovementDetailModal 的列表儲存)
  async updateLogEvents(dateStr, events) {
    const docRef = doc(db, 'kidit_logbook', dateStr)
    await updateDoc(docRef, { events })
  },

  // 3. 取得病人詳細資料 (用於 "預填" 資料)
  async fetchPatientMasterRecord(patientId) {
    try {
      const docRef = doc(db, 'patients', patientId)
      const snap = await getDoc(docRef)
      return snap.exists() ? { id: snap.id, ...snap.data() } : null
    } catch (error) {
      console.error('Fetch master patient record failed:', error)
      return null
    }
  },

  /**
   * ✨ 核心新功能：更新特定日期的特定事件內的 KiDit 資料
   * @param {string} dateStr - 日期 (YYYY-MM-DD)
   * @param {string} eventId - 事件 ID
   * @param {string} fieldKey - 要更新的欄位 ('kidit_vascular' | 'kidit_profile' | 'kidit_history')
   * @param {object} data - 要儲存的資料物件
   */
  async updateEventKiDitData(dateStr, eventId, fieldKey, data) {
    const docRef = doc(db, 'kidit_logbook', dateStr)

    try {
      await runTransaction(db, async (transaction) => {
        const sfDoc = await transaction.get(docRef)
        if (!sfDoc.exists()) {
          throw new Error('Document does not exist!')
        }

        const logData = sfDoc.data()
        const events = logData.events || []

        // 找到對應的 event
        const eventIndex = events.findIndex((e) => e.id === eventId)
        if (eventIndex === -1) {
          throw new Error('Event not found!')
        }

        // 更新該 event 下的特定欄位 (例如 events[0].kidit_profile = data)
        events[eventIndex][fieldKey] = data

        // 寫回整份文件
        transaction.update(docRef, { events })
      })
      return true
    } catch (e) {
      console.error('Transaction failed: ', e)
      throw e
    }
  },
}
