import admin from 'firebase-admin'

// 對於 .json 檔案的引入，需要加上一個 import assertion
import serviceAccount from './serviceAccountKey.json' with { type: 'json' }

// 初始化 Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

// 獲取 Firestore 資料庫實例
const db = admin.firestore()

// ==========================================================
// ==             遷移邏輯函式 (從這裡開始)                ==
// ==========================================================

const shiftCharToCode = { 早: 'early', 午: 'noon', 晚: 'late' }

async function migrateSchedules() {
  console.log('正在掃描 "schedules" 集合...')
  const collectionRef = db.collection('schedules')
  const snapshot = await collectionRef.get()

  if (snapshot.empty) {
    console.log('找不到任何 "schedules" 文件，無需遷移。')
    return 0
  }

  const batch = db.batch()
  let updatedDocs = 0

  snapshot.forEach((doc) => {
    const data = doc.data()
    const oldSchedule = data.schedule
    const newSchedule = {}
    let needsUpdate = false

    if (!oldSchedule) return

    for (const oldShiftId in oldSchedule) {
      const slotData = { ...oldSchedule[oldShiftId] }
      let newShiftId = oldShiftId

      // 1. 遷移 shiftId (e.g., bed-1-早 -> bed-1-early)
      const parts = oldShiftId.split('-')
      if (parts.length === 3 && shiftCharToCode[parts[2]]) {
        newShiftId = `${parts[0]}-${parts[1]}-${shiftCharToCode[parts[2]]}`
        slotData.shiftId = newShiftId // 同時更新 slot 內部的 shiftId
        needsUpdate = true
      }

      // 2. 遷移 note
      if (slotData.note) {
        slotData.manualNote = slotData.note
        delete slotData.note
        needsUpdate = true
      }

      newSchedule[newShiftId] = slotData
    }

    if (needsUpdate) {
      updatedDocs++
      const docRef = collectionRef.doc(doc.id)
      batch.update(docRef, { schedule: newSchedule })
    }
  })

  if (updatedDocs > 0) {
    await batch.commit()
    console.log(`成功遷移了 ${updatedDocs} 個 "schedules" 文件！`)
  } else {
    console.log('"schedules" 集合中的資料已是最新格式，無需遷移。')
  }
  return updatedDocs
}

async function migrateBaseSchedule() {
  console.log('正在掃描 "base_schedules" 集合...')
  const docRef = db.collection('base_schedules').doc('MASTER_SCHEDULE')
  const docSnap = await docRef.get()

  if (!docSnap.exists) {
    console.log('找不到 MASTER_SCHEDULE，無需遷移。')
    return false
  }

  const oldSchedule = docSnap.data().schedule
  const newSchedule = {}
  let needsUpdate = false

  if (!oldSchedule) return false

  for (const slotId in oldSchedule) {
    const slotData = { ...oldSchedule[slotId] }
    // BaseSchedule 只需遷移 note 欄位
    if (slotData.note) {
      slotData.manualNote = slotData.note
      delete slotData.note
      needsUpdate = true
    }
    newSchedule[slotId] = slotData
  }

  if (needsUpdate) {
    await docRef.update({ schedule: newSchedule })
    console.log('成功遷移了 MASTER_SCHEDULE 的 note 欄位！')
    return true
  } else {
    console.log('MASTER_SCHEDULE 的資料已是最新格式，無需遷移。')
    return false
  }
}

// 主執行函式
async function runMigration() {
  console.log('==== 開始資料庫遷移腳本 ====')
  try {
    await migrateSchedules()
    await migrateBaseSchedule()
    console.log('==== 資料庫遷移腳本執行完畢 ====')
  } catch (error) {
    console.error('遷移過程中發生嚴重錯誤:', error)
  }
}

// 執行！
runMigration()
