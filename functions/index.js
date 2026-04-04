// functions/index.js (✨ 最終整理版 ✨)

// --- Firebase Functions V2 全局設定 ---
const { setGlobalOptions } = require('firebase-functions/v2')
// 建議在此處設定您的全局選項
setGlobalOptions({ region: 'asia-east1', timeoutSeconds: 60, memory: '256MiB', maxInstances: 100 })

// --- Firebase Functions V2 模組引入 ---
const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { onSchedule } = require('firebase-functions/v2/scheduler')
const {
  onDocumentWritten,
  onDocumentCreated,
  onDocumentDeleted,
} = require('firebase-functions/v2/firestore')
const { logger } = require('firebase-functions')

// --- Firebase Admin SDK 初始化 (只需一次) ---
const admin = require('firebase-admin')
admin.initializeApp()

// --- 從 Admin SDK 中獲取服務實例 ---
const db = admin.firestore()
const auth = admin.auth()
const storage = admin.storage()
const { getFirestore, FieldValue, FieldPath } = require('firebase-admin/firestore')

// --- 第三方函式庫 ---
const { google } = require('googleapis')
const stream = require('stream')
const path = require('path')
const bcrypt = require('bcryptjs') // ✨ 密碼加密

// --- ✨ 引入統一的日期處理工具 ✨ ---
const {
  formatDateToYYYYMMDD,
  getTaipeiTodayString,
  getTaipeiNow,
  getTaipeiDayIndex, // <--- ✨ 引入新函式
  TIME_ZONE,
} = require('./utils/dateUtils')

// --- ✨ 引入排程邏輯引擎 ✨ ---
const {
  recalculateDailySchedule,
  generateDailyScheduleFromRules,
  getScheduleKey,
  FREQ_MAP_TO_DAY_INDEX,
  SHIFTS, // ✨ 一併加入，以防萬一
} = require('./services/scheduleEngineService')

// ===================================================================
// 全域設定 (Global Configurations)
// ===================================================================

const PROJECT_ID = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT

// --- Google Drive 動態設定 ---
let SHARED_DRIVE_FOLDER_ID
if (PROJECT_ID === 'dialysis-schedule-cd36c') {
  SHARED_DRIVE_FOLDER_ID = '1uGKoMfJicJoNR2CYOznEj_62Wh_FSrg8'
  logger.info(`Running in PRODUCTION environment. Using Production Google Drive Folder.`)
} else {
  SHARED_DRIVE_FOLDER_ID = '1FPdK5sHy90zXzUAv0dHuF6fzpdilwjVe'
  logger.info(
    `Running in DEVELOPMENT or EMULATOR environment. Using Development Google Drive Folder.`,
  )
}

// --- CORS 跨來源請求設定 ---
const allowedOrigins = [
  'https://my-dialysis-app-develop.web.app', // 開發版前端網址
  'https://dialysis-schedule-cd36c.web.app', // 正式版前端網址
  'http://localhost:5173', // 本地 Vite 開發伺服器
  'http://localhost:4200', // 本地 Angular 開發伺服器
]

// ===================================================================
// 輔助函式 (Helper Functions)
// ===================================================================

/**
 * ✨ 稽核日誌記錄函式 - B 級合規要求
 * 記錄系統中的重要操作，確保可追溯性
 * @param {Object} params - 日誌參數
 * @param {string} params.action - 操作類型 (LOGIN, LOGOUT, CREATE, UPDATE, DELETE, etc.)
 * @param {string} params.userId - 執行操作的用戶 ID
 * @param {string} params.userName - 執行操作的用戶名稱
 * @param {string} params.collection - 被操作的集合名稱
 * @param {string} params.documentId - 被操作的文件 ID
 * @param {Object} params.details - 操作詳情
 * @param {string} params.ipAddress - 來源 IP (如果可用)
 * @param {boolean} params.success - 操作是否成功
 */
async function logAuditEvent({
  action,
  userId = 'system',
  userName = 'System',
  collection = null,
  documentId = null,
  details = {},
  ipAddress = null,
  success = true,
}) {
  try {
    const auditLog = {
      action,
      userId,
      userName,
      collection,
      documentId,
      details,
      ipAddress,
      success,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: getTaipeiNow().toISOString(),
    }
    await db.collection('audit_logs').add(auditLog)
    logger.info(`[AuditLog] ${action} by ${userName} (${userId}) - Success: ${success}`)
  } catch (error) {
    // 稽核日誌失敗不應該阻擋主要操作，只記錄錯誤
    logger.error('[AuditLog] Failed to write audit log:', error)
  }
}

async function cleanupFuturePatientMetadata(patientId, options = {}) {
  const { clearTeams = false, clearManualNote = false } = options
  if (!clearTeams && !clearManualNote) {
    logger.info(
      `[Metadata Cleanup] No cleanup options provided for patient ${patientId}. Skipping.`,
    )
    return
  }
  logger.info(`[Metadata Cleanup] Starting for patient ${patientId}...`, options)

  const todayStr = getTaipeiTodayString() // ✨ 使用統一函式
  const batch = db.batch()
  let updatesCount = 0

  try {
    if (clearTeams) {
      const assignmentsSnapshot = await db
        .collection('nurse_assignments')
        .where('date', '>', todayStr) // 保護今天的資料
        .get()
      assignmentsSnapshot.forEach((doc) => {
        const teamsData = doc.data().teams || {}
        const updates = {}
        let needsUpdate = false
        for (const teamKey in teamsData) {
          if (teamKey.startsWith(patientId + '-')) {
            updates[`teams.${teamKey}`] = FieldValue.delete()
            needsUpdate = true
          }
        }
        if (needsUpdate) {
          batch.update(doc.ref, updates)
          updatesCount++
        }
      })
    }

    if (clearManualNote) {
      const schedulesSnapshot = await db
        .collection('schedules')
        .where('date', '>', todayStr) // 保護今天的資料
        .get()
      schedulesSnapshot.forEach((doc) => {
        const scheduleData = doc.data().schedule || {}
        const updates = {}
        let needsUpdate = false
        for (const shiftId in scheduleData) {
          if (scheduleData[shiftId]?.patientId === patientId) {
            updates[`schedule.${shiftId}.manualNote`] = ''
            needsUpdate = true
          }
        }
        if (needsUpdate) {
          batch.update(doc.ref, updates)
          updatesCount++
        }
      })
    }

    if (updatesCount > 0) {
      await batch.commit()
      logger.info(`[Metadata Cleanup] Successfully committed cleanup for patient ${patientId}.`)
    } else {
      logger.info(`[Metadata Cleanup] No future metadata found to clean for patient ${patientId}.`)
    }
  } catch (error) {
    logger.error(`[Metadata Cleanup] Error cleaning metadata for patient ${patientId}:`, error)
  }
}

// 輔助函式：取消病人所有未來的調班申請
async function cancelFutureExceptionsForPatient(patientId) {
  if (!patientId) return

  logger.info(`[Exception Cleanup] Cancelling exceptions for deleted patient ${patientId}`)

  const todayStr = getTaipeiTodayString() // ✨ 使用統一函式
  const batch = db.batch()
  let cancelledCount = 0

  try {
    // 1. 該病人的調班
    const mainQuery = await db
      .collection('schedule_exceptions')
      .where('patientId', '==', patientId)
      .where('status', 'in', ['pending', 'applied', 'processing', 'conflict_requires_resolution'])
      .get()

    mainQuery.forEach((doc) => {
      const ex = doc.data()
      const latestDate = ex.endDate || ex.to?.goalDate || ex.date || ex.startDate
      if (!latestDate || latestDate > todayStr) {
        batch.update(doc.ref, {
          status: 'cancelled',
          cancelReason: '病人已刪除',
          cancelledAt: FieldValue.serverTimestamp(),
        })
        cancelledCount++
      }
    })

    // 2. SWAP 中涉及該病人的調班
    const swapQuery = await db
      .collection('schedule_exceptions')
      .where('type', '==', 'SWAP')
      .where('status', 'in', ['pending', 'applied', 'processing', 'conflict_requires_resolution'])
      .get()

    swapQuery.forEach((doc) => {
      const swap = doc.data()
      if (
        (swap.patient1?.patientId === patientId || swap.patient2?.patientId === patientId) &&
        (!swap.date || swap.date >= todayStr)
      ) {
        batch.update(doc.ref, {
          status: 'cancelled',
          cancelReason: '病人已刪除',
          cancelledAt: FieldValue.serverTimestamp(),
        })
        cancelledCount++
      }
    })

    if (cancelledCount > 0) {
      await batch.commit()
      logger.info(`✅ Cancelled ${cancelledCount} exceptions for deleted patient ${patientId}`)
    } else {
      logger.info(`[Exception Cleanup] No active exceptions found for patient ${patientId}`)
    }
  } catch (error) {
    logger.error(`❌ Error cancelling exceptions for patient ${patientId}:`, error)
  }
}

// ✨ 輔助函式：取消病人所有未來的預約變更
async function cancelFutureScheduledChangesForPatient(patientId) {
  if (!patientId) return

  logger.info(`[ScheduledChanges Cleanup] Cancelling scheduled changes for deleted patient ${patientId}`)

  const todayStr = getTaipeiTodayString()
  const batch = db.batch()
  let cancelledCount = 0

  try {
    const query = await db
      .collection('scheduled_changes')
      .where('patientId', '==', patientId)
      .where('status', '==', 'pending')
      .get()

    query.forEach((doc) => {
      const change = doc.data()
      // 只取消未來的（effectiveDate > today 或無日期的）
      if (!change.effectiveDate || change.effectiveDate >= todayStr) {
        batch.update(doc.ref, {
          status: 'cancelled',
          cancelReason: '病人已刪除',
          cancelledAt: FieldValue.serverTimestamp(),
        })
        cancelledCount++
      }
    })

    if (cancelledCount > 0) {
      await batch.commit()
      logger.info(`✅ Cancelled ${cancelledCount} scheduled changes for deleted patient ${patientId}`)
    } else {
      logger.info(`[ScheduledChanges Cleanup] No pending changes found for patient ${patientId}`)
    }
  } catch (error) {
    logger.error(`❌ Error cancelling scheduled changes for patient ${patientId}:`, error)
  }
}

/**
 * ✨【全新輔助函式 v7.0】✨
 * 根據調班申請的內容，分析出在指定日期會影響到的來源與目標 keys
 * @param {object} exceptionData - 調班申請的完整資料
 * @param {string} dateStr - 正在處理的目標日期 'YYYY-MM-DD'
 * @returns {{sourceKeys: string[], targetKeys: string[]}} - 回傳包含來源和目標 key 陣列的物件
 */
function getAffectedKeys(exceptionData, dateStr) {
  const sourceKeys = new Set()
  const targetKeys = new Set()

  switch (exceptionData.type) {
    case 'MOVE':
      // 來源位置只在 sourceDate 當天受影響
      if (exceptionData.from?.sourceDate === dateStr) {
        sourceKeys.add(getScheduleKey(exceptionData.from.bedNum, exceptionData.from.shiftCode))
      }
      // 目標位置只在 goalDate 當天受影響
      if (exceptionData.to?.goalDate === dateStr) {
        targetKeys.add(getScheduleKey(exceptionData.to.bedNum, exceptionData.to.shiftCode))
      }
      break

    case 'ADD_SESSION':
      // 只有目標位置受影響
      if (exceptionData.to?.goalDate === dateStr) {
        targetKeys.add(getScheduleKey(exceptionData.to.bedNum, exceptionData.to.shiftCode))
      }
      break

    case 'SWAP':
      // 兩個位置既是來源也是目標
      if (exceptionData.date === dateStr) {
        const key1 = getScheduleKey(
          exceptionData.patient1.fromBedNum,
          exceptionData.patient1.fromShiftCode,
        )
        const key2 = getScheduleKey(
          exceptionData.patient2.fromBedNum,
          exceptionData.patient2.fromShiftCode,
        )
        sourceKeys.add(key1)
        sourceKeys.add(key2)
        targetKeys.add(key1)
        targetKeys.add(key2)
      }
      break

    case 'SUSPEND':
      // SUSPEND 沒有固定的 source/target key，它的影響是基於病人的。
      // 它的衝突檢測比較特殊，會在 applySingleException 中隱含處理（即移除病人）。
      // 所以這裡我們回傳空陣列。
      break
  }

  return {
    sourceKeys: Array.from(sourceKeys),
    targetKeys: Array.from(targetKeys),
  }
}

/**
 * ✨【全新輔助函式 v7.0】✨
 * 將單一一個已通過衝突檢測的調班申請，應用到一個 schedule 物件上。
 * 注意：此函式會直接修改傳入的 schedule 物件。
 * @param {object} schedule - 正在建構中的 schedule 物件 (會被直接修改)
 * @param {object} ex - 要套用的單一調班申請資料
 * @param {string} dateStr - 正在處理的目標日期 'YYYY-MM-DD'
 */
function applySingleException(schedule, ex, dateStr) {
  try {
    switch (ex.type) {
      case 'MOVE':
        // 移除來源 (如果來源是今天)
        if (ex.from?.sourceDate === dateStr) {
          const sourceKey = getScheduleKey(ex.from.bedNum, ex.from.shiftCode)
          // 雙重保險：再次確認要刪除的位置上確實是目標病人
          if (schedule[sourceKey]?.patientId === ex.patientId) {
            delete schedule[sourceKey]
          }
        }
        // 加入目標 (如果目標是今天)
        if (ex.to?.goalDate === dateStr) {
          const targetKey = getScheduleKey(ex.to.bedNum, ex.to.shiftCode)
          schedule[targetKey] = {
            patientId: ex.patientId,
            patientName: ex.patientName,
            exceptionId: ex.id,
            manualNote: '(換班)',
          }
        }
        break

      case 'ADD_SESSION':
        if (ex.to?.goalDate === dateStr) {
          const targetKey = getScheduleKey(ex.to.bedNum, ex.to.shiftCode)
          schedule[targetKey] = {
            patientId: ex.patientId,
            patientName: ex.patientName,
            exceptionId: ex.id,
            manualNote: '(臨時加洗)',
          }
        }
        break

      case 'SWAP':
        if (ex.date === dateStr) {
          const key1 = getScheduleKey(ex.patient1.fromBedNum, ex.patient1.fromShiftCode)
          const key2 = getScheduleKey(ex.patient2.fromBedNum, ex.patient2.fromShiftCode)

          // 為了安全，從當前 schedule 中獲取最新的 slot data
          const slot1Data = schedule[key1]
            ? { ...schedule[key1] }
            : { patientId: ex.patient1.patientId, patientName: ex.patient1.patientName }
          const slot2Data = schedule[key2]
            ? { ...schedule[key2] }
            : { patientId: ex.patient2.patientId, patientName: ex.patient2.patientName }

          // 執行交換
          schedule[key1] = {
            ...slot2Data,
            exceptionId: ex.id,
            manualNote: `(與${ex.patient1.patientName}互調)`,
          }
          schedule[key2] = {
            ...slot1Data,
            exceptionId: ex.id,
            manualNote: `(與${ex.patient2.patientName}互調)`,
          }
        }
        break

      case 'SUSPEND':
        const start = new Date(ex.startDate + 'T00:00:00Z')
        const end = new Date(ex.endDate + 'T00:00:00Z')
        const targetDate = new Date(dateStr + 'T00:00:00Z')
        if (targetDate >= start && targetDate <= end) {
          // 從排程中移除這位病人的所有班次
          Object.keys(schedule).forEach((key) => {
            if (schedule[key].patientId === ex.patientId) {
              delete schedule[key]
            }
          })
        }
        break
    }
  } catch (error) {
    // 記錄錯誤，但不在這裡拋出，以避免中斷整個重建過程
    logger.error(`[applySingleException] 在模擬套用調班 ${ex.id} 時發生錯誤:`, error)
  }
}

/**
 * 🔥🔥🔥【最終正確版 v11.0】 - rebuildSingleDaySchedule 🔥🔥🔥
 * 職責：作為「協調器」或「專案經理」。
 *       為「某一天」收集所有必要的資料（總表規則、當天調班），
 *       將資料交給核心引擎 (`recalculateDailySchedule`) 去計算，
 *       然後處理計算結果（包括將衝突標記回資料庫）。
 * @param {string} dateStr - 要計算的日期 'YYYY-MM-DD'
 * @param {object} masterRules - 最新的總表規則
 * @returns {Promise<object>} - 返回計算完成的、不包含衝突效果的最終 schedule 物件
 */
async function rebuildSingleDaySchedule(dateStr, masterRules) {
  try {
    // --- 步驟 1: 收集「原料」- 當天所有相關的調班申請 ---
    const allExceptionsSnapshot = await db
      .collection('schedule_exceptions')
      .where('status', 'in', ['applied', 'conflict_requires_resolution'])
      .get()

    const todaysExceptions = []
    allExceptionsSnapshot.forEach((doc) => {
      const ex = { id: doc.id, ...doc.data() }
      // 判斷此調班是否影響今天
      if (ex.type === 'SUSPEND' && ex.startDate && ex.endDate) {
        const start = new Date(ex.startDate + 'T00:00:00Z')
        const end = new Date(ex.endDate + 'T00:00:00Z')
        const current = new Date(dateStr + 'T00:00:00Z')
        if (current >= start && current <= end) todaysExceptions.push(ex)
      } else {
        const exDates = [ex.date, ex.startDate, ex.from?.sourceDate, ex.to?.goalDate].filter(
          Boolean,
        )
        if (exDates.includes(dateStr)) todaysExceptions.push(ex)
      }
    })
    // 按創建時間排序
    todaysExceptions.sort((a, b) => (a.createdAt?.toMillis() || 0) - (b.createdAt?.toMillis() || 0))

    // --- 步驟 2: 將所有「原料」交給核心引擎進行純計算 ---
    // 引擎會回傳一個包含最終排程和衝突列表的物件
    const { finalSchedule, conflictingExceptions } = recalculateDailySchedule(
      dateStr,
      masterRules,
      todaysExceptions,
    )

    // --- 步驟 3: 處理引擎回報的「衝突」---
    if (conflictingExceptions.length > 0) {
      const conflictBatch = db.batch()
      conflictingExceptions.forEach((ex) => {
        logger.warn(`[RebuildCoordinator] 將調班 ${ex.id} 標記為衝突，因為其目標床位已被佔據。`)
        const docRef = db.collection('schedule_exceptions').doc(ex.id)
        conflictBatch.update(docRef, {
          status: 'conflict_requires_resolution',
          errorMessage: '系統重建排程時發現目標床位已被佔用，請重新安排。',
        })
      })
      // 將衝突狀態寫回資料庫
      await conflictBatch.commit()
    }

    // --- 步驟 4: 回傳計算出的、不包含衝突調班效果的「最終排程」 ---
    return finalSchedule
  } catch (error) {
    logger.error(`❌ [RebuildCoordinator] 在為 ${dateStr} 準備和處理資料時失敗:`, error)
    throw error
  }
}

/**
 * 🔥🔥🔥【第二階段引擎 v11.0】 - mergeExceptionsIntoSchedules 🔥🔥🔥
 * 職責：作為同步的第二步。接收一個「需要重新合併調班的日期列表」，
 *       然後為列表中的每一天，讀取其（已被重置的）基礎排程，
 *       並將所有有效的調班申請合併上去，最後寫回資料庫。
 * @param {Set<string>} datesToMerge - 包含日期字串 'YYYY-MM-DD' 的 Set
 * @param {object} masterRules - 最新的總表規則 (用於傳遞給引擎)
 */
async function mergeExceptionsIntoSchedules(datesToMerge, masterRules) {
  if (datesToMerge.size === 0) {
    logger.info('  ✅ [Sync Step 2/2] 沒有需要合併調班的日期，程序結束。')
    return
  }
  logger.info(`  ➡️ [Sync Step 2/2] 啟動調班合併程序，共需處理 ${datesToMerge.size} 個日期...`)

  try {
    const mergeBatch = db.batch()

    // 對每一個需要合併的日期，呼叫核心引擎來計算最終結果
    for (const dateStr of datesToMerge) {
      // 🔥 核心邏輯：呼叫 rebuildSingleDaySchedule 來完成「讀取基礎排程+合併調班」的計算
      // 注意：雖然 rebuildSingleDaySchedule 內部會自己生成基礎排程，但我們依然傳入 masterRules，
      // 確保它使用的是與第一階段完全相同的規則，避免任何不一致。
      // 這個函式現在的實際作用就是「合併」。
      const finalSchedule = await rebuildSingleDaySchedule(dateStr, masterRules)

      const scheduleRef = db.collection('schedules').doc(dateStr)
      // 🔥 使用 update 而不是 set，因為我們是在第一階段的基礎上「更新」
      mergeBatch.update(scheduleRef, {
        schedule: finalSchedule,
        updatedAt: FieldValue.serverTimestamp(),
        syncMethod: 'engine_driven_sync_v11.0_merge',
      })
    }

    await mergeBatch.commit()
    logger.info(`  ✅ [Sync Step 2/2] 成功！已重新合併 ${datesToMerge.size} 天的調班申請。`)
  } catch (error) {
    logger.error('  ❌ [Sync Step 2/2] 在合併調班階段發生嚴重錯誤:', error)
    // 即使這裡失敗，第一階段的基礎排程也已成功，系統仍可用
  }
}

// ===================================================================
// Firestore 文件觸發器 - 病人資料變更處理（完整修正版）
// ===================================================================
/**
 * 處理病人資料變更
 */
// ✅ [最終完整版] Cloud Function 主體
exports.onPatientDataChange = onDocumentWritten('patients/{patientId}', async (event) => {
  const patientId = event.params.patientId
  const beforeData = event.data?.before.data()
  const afterData = event.data?.after.data()
  const tasks = []

  // ✨ 稽核日誌輔助函式（從文件中嘗試取得修改者資訊）
  const logPatientAudit = async (action, details) => {
    const data = afterData || beforeData
    await logAuditEvent({
      action,
      userId: data?.lastModifiedBy?.uid || 'system',
      userName: data?.lastModifiedBy?.name || 'System/Trigger',
      collection: 'patients',
      documentId: patientId,
      details: {
        patientName: data?.name || '未知',
        medicalRecordNumber: data?.medicalRecordNumber || null,
        ...details,
      },
      success: true,
    })
  }

  // ✅ [新增] 狀態碼的中文對照表
  const STATUS_MAP = {
    opd: '門診',
    ipd: '住院',
    er: '急診',
  }

  const getStatusInChinese = (status) => STATUS_MAP[status] || status

  // 用於 patient_history 的快照函式 (保持不變)
  const createSnapshot = (data) => ({
    medicalRecordNumber: data.medicalRecordNumber || null,
    firstDialysisDate: data.firstDialysisDate || null,
    vascAccess: data.vascAccess || null,
    accessCreationDate: data.accessCreationDate || null,
    hospitalInfo: data.hospitalInfo || { source: '', transferOut: '' },
    inpatientReason: data.inpatientReason || null,
    dialysisReason: data.dialysisReason || null,
  })

  // 輔助函式，用於將病人動態加入當日工作日誌 (保持不變)
  const addMovementToDailyLog = async (movementData) => {
    const todayStr = getTaipeiTodayString()
    const dailyLogRef = db.collection('daily_logs').doc(todayStr)

    try {
      const doc = await dailyLogRef.get()
      if (doc.exists) {
        const logData = doc.data()
        const movements = logData.patientMovements || []
        // 檢查是否已存在一個源自此自動事件的紀錄 (檢查 originalAutoId)
        const hasBeenEdited = movements.some((m) => m.originalAutoId === movementData.id)

        if (hasBeenEdited) {
          logger.info(
            `[DailyLog] Movement ${movementData.id} for patient ${movementData.patientId} has been manually edited. Skipping auto-update.`,
          )
          return // 如果已經被手動編輯過，則直接跳過，不做任何事
        }
      }
      // 如果文件不存在，或紀錄未被編輯過，則正常添加
      return dailyLogRef.set(
        {
          patientMovements: FieldValue.arrayUnion(movementData),
        },
        { merge: true },
      )
    } catch (error) {
      logger.error(`[DailyLog] Error checking for edited movement:`, error)
      // 即使檢查失敗，也嘗試寫入，確保功能基本可用
      return dailyLogRef.set(
        {
          patientMovements: FieldValue.arrayUnion(movementData),
        },
        { merge: true },
      )
    }
  }

  let historyWritten = false

  // === 處理新增病人 ===
  if (!beforeData && afterData) {
    logger.info(`[History] 新增病人 ${afterData.name} (ID: ${patientId})`)
    tasks.push(
      db.collection('patient_history').add({
        patientId,
        patientName: afterData.name,
        timestamp: FieldValue.serverTimestamp(),
        eventType: 'CREATE',
        eventDetails: { status: afterData.status },
        snapshot: createSnapshot(afterData),
      }),
    )
    historyWritten = true

    // ✨ 稽核日誌：新增病人
    tasks.push(logPatientAudit('PATIENT_CREATE', { status: afterData.status }))

    tasks.push(
      addMovementToDailyLog({
        id: `auto_create_${patientId}`, // 使用固定ID
        type: '新增',
        name: afterData.name,
        patientId: patientId,
        medicalRecordNumber: afterData.medicalRecordNumber,
        physician: afterData.physician || '',
        reason: afterData.inpatientReason || afterData.dialysisReason || '',
        wardNumber: afterData.wardNumber || '',
        remarks: `新增至「${getStatusInChinese(afterData.status)}」`,
      }),
    )
  }
  // === 處理病人刪除 ===
  else if (
    beforeData &&
    afterData &&
    beforeData.isDeleted !== true &&
    afterData.isDeleted === true
  ) {
    logger.info(`[History] 刪除病人 ${afterData.name} (ID: ${patientId})`)
    tasks.push(
      db.collection('patient_history').add({
        patientId,
        patientName: afterData.name,
        timestamp: FieldValue.serverTimestamp(),
        eventType: 'DELETE',
        eventDetails: { reason: afterData.deleteReason || '未知', fromStatus: beforeData.status },
        snapshot: createSnapshot(afterData),
      }),
    )
    historyWritten = true

    // ✨ 稽核日誌：刪除病人
    tasks.push(
      logPatientAudit('PATIENT_DELETE', {
        reason: afterData.deleteReason || '未知',
        fromStatus: beforeData.status,
      }),
    )

    tasks.push(
      addMovementToDailyLog({
        id: `auto_delete_${patientId}`, // 使用固定ID
        type: '刪除',
        name: afterData.name,
        patientId: patientId,
        medicalRecordNumber: afterData.medicalRecordNumber,
        reason: afterData.deleteReason || '未知',
        wardNumber: beforeData.wardNumber || '',
        remarks: `從「${getStatusInChinese(beforeData.status)}」移除`,
      }),
    )

    // --- 全面清理邏輯 (修正版：先取消調班/預約，再清理排程，防止競態條件) ---
    logger.info(
      `[Cleanup Trigger] Patient ${patientId} was deleted. Starting comprehensive cleanup...`,
    )
    if (afterData.wardNumber) {
      tasks.push(event.data.after.ref.update({ wardNumber: null }))
    }
    tasks.push(
      db
        .collection('base_schedules')
        .doc('MASTER_SCHEDULE')
        .update({
          [`schedule.${patientId}`]: FieldValue.delete(),
        }),
    )

    // ✨ 第一步：先取消調班申請和預約變更（await 確保完成後再清理排程）
    // 這樣即使夜間排程重建 cron 在清理排程之後運行，也不會因為未取消的調班而重新加入已刪除的病人
    await cancelFutureExceptionsForPatient(patientId)
    await cancelFutureScheduledChangesForPatient(patientId)

    // ✨ 第二步：清理未來 60 天的每日排程
    const todayStr = getTaipeiTodayString()
    let cleanupBatch = db.batch()
    let cleanupCount = 0
    const BATCH_SIZE = 450
    for (let i = 0; i <= 60; i++) {
      const targetDate = new Date(todayStr + 'T00:00:00Z')
      targetDate.setUTCDate(targetDate.getUTCDate() + i)
      const dateStr = formatDateToYYYYMMDD(targetDate)
      if (dateStr >= todayStr) {
        const scheduleRef = db.collection('schedules').doc(dateStr)
        const scheduleDoc = await scheduleRef.get()
        if (scheduleDoc.exists) {
          const schedule = scheduleDoc.data().schedule || {}
          const updates = {}
          for (const key in schedule) {
            if (schedule[key].patientId === patientId) {
              updates[`schedule.${key}`] = FieldValue.delete()
              cleanupCount++
            }
          }
          if (Object.keys(updates).length > 0) {
            cleanupBatch.update(scheduleRef, updates)
            if (cleanupCount >= BATCH_SIZE) {
              await cleanupBatch.commit()
              cleanupCount = 0
              cleanupBatch = db.batch()
            }
          }
        }
      }
    }
    if (cleanupCount > 0) {
      tasks.push(cleanupBatch.commit())
    }
  }
  // === 處理病人復原 ===
  else if (
    beforeData &&
    afterData &&
    beforeData.isDeleted === true &&
    afterData.isDeleted === false
  ) {
    logger.info(`[History] 復原病人 ${afterData.name} (ID: ${patientId}) 至 ${afterData.status}`)
    tasks.push(
      db.collection('patient_history').add({
        patientId,
        patientName: afterData.name,
        timestamp: FieldValue.serverTimestamp(),
        eventType: 'RESTORE_AND_TRANSFER',
        eventDetails: {
          restoredTo: afterData.status,
          fromReason: beforeData.deleteReason || '未知',
        },
        snapshot: createSnapshot(afterData),
      }),
    )
    historyWritten = true

    // ✨ 稽核日誌：復原病人
    tasks.push(
      logPatientAudit('PATIENT_RESTORE', {
        restoredTo: afterData.status,
        fromReason: beforeData.deleteReason || '未知',
      }),
    )

    tasks.push(
      addMovementToDailyLog({
        id: `auto_restore_${patientId}`, // 使用固定ID
        type: '復原',
        name: afterData.name,
        patientId: patientId,
        medicalRecordNumber: afterData.medicalRecordNumber,
        physician: afterData.physician || '',
        wardNumber: afterData.wardNumber || '',
        remarks: `從刪除狀態復原至「${getStatusInChinese(afterData.status)}」`,
      }),
    )
  }
  // === 處理狀態轉換 (轉移) ===
  else if (
    beforeData &&
    afterData &&
    !beforeData.isDeleted &&
    !afterData.isDeleted &&
    beforeData.status !== afterData.status
  ) {
    logger.info(
      `[History] 轉移病人 ${afterData.name} 從 ${beforeData.status} 到 ${afterData.status}`,
    )
    tasks.push(
      db.collection('patient_history').add({
        patientId,
        patientName: afterData.name,
        timestamp: FieldValue.serverTimestamp(),
        eventType: 'TRANSFER',
        eventDetails: { from: beforeData.status, to: afterData.status },
        snapshot: createSnapshot(afterData),
      }),
    )
    historyWritten = true

    // ✨ 稽核日誌：病人狀態轉換
    tasks.push(
      logPatientAudit('PATIENT_TRANSFER', {
        fromStatus: beforeData.status,
        toStatus: afterData.status,
      }),
    )

    tasks.push(
      addMovementToDailyLog({
        id: `auto_transfer_${patientId}`, // 使用固定ID
        type: '轉移',
        name: afterData.name,
        patientId: patientId,
        medicalRecordNumber: afterData.medicalRecordNumber,
        physician: afterData.physician || '',
        wardNumber: afterData.wardNumber || beforeData.wardNumber || '',
        remarks: `從「${getStatusInChinese(beforeData.status)}」轉至「${getStatusInChinese(afterData.status)}」`,
      }),
    )

    if ((beforeData.status === 'ipd' || beforeData.status === 'er') && afterData.status === 'opd') {
      if (afterData.wardNumber) {
        tasks.push(event.data.after.ref.update({ wardNumber: null }))
      }
    }
  }

  // === 一般資料更新 (不記錄歷史) ===
  if (!historyWritten) {
    if (beforeData && afterData) {
      // 頻率 (freq) 的更新邏輯保持移除
    }
  }

  // === 執行所有任務 ===
  if (tasks.length > 0) {
    try {
      await Promise.all(tasks)
      logger.info(`✅ Successfully executed ${tasks.length} tasks for patient ${patientId}.`)
    } catch (error) {
      logger.error(`❌ Error executing tasks for patient ${patientId}:`, error)
      await db.collection('error_logs').add({
        function: 'onPatientDataChange',
        patientId: patientId,
        error: error.message,
        stack: error.stack,
        timestamp: FieldValue.serverTimestamp(),
      })
    }
  }
  return null
})

// ===================================================================
// ✨ 排程變更稽核日誌 - B 級合規要求
// ===================================================================

/**
 * 記錄每日排程變更
 * 追蹤洗腎排班的任何修改
 */
exports.auditScheduleChange = onDocumentWritten('schedules/{scheduleId}', async (event) => {
  const scheduleId = event.params.scheduleId
  const beforeData = event.data?.before.data()
  const afterData = event.data?.after.data()

  // 計算變更的床位數量
  const beforeSlots = beforeData?.schedule ? Object.keys(beforeData.schedule).length : 0
  const afterSlots = afterData?.schedule ? Object.keys(afterData.schedule).length : 0

  let action = 'SCHEDULE_UPDATE'
  if (!beforeData && afterData) {
    action = 'SCHEDULE_CREATE'
  } else if (beforeData && !afterData) {
    action = 'SCHEDULE_DELETE'
  }

  // 嘗試從文件中取得修改者資訊
  const data = afterData || beforeData
  const modifiedBy = data?.lastModifiedBy || {}

  await logAuditEvent({
    action,
    userId: modifiedBy.uid || 'system',
    userName: modifiedBy.name || 'System/Trigger',
    collection: 'schedules',
    documentId: scheduleId,
    details: {
      date: scheduleId,
      beforeSlotCount: beforeSlots,
      afterSlotCount: afterSlots,
      slotDifference: afterSlots - beforeSlots,
    },
    success: true,
  })

  return null
})

/**
 * 記錄基礎排程（Master Schedule）變更
 * 追蹤病人固定班表的設定變更
 */
exports.auditBaseScheduleChange = onDocumentWritten('base_schedules/{scheduleId}', async (event) => {
  const scheduleId = event.params.scheduleId
  const beforeData = event.data?.before.data()
  const afterData = event.data?.after.data()

  // 計算變更的病人數量
  const beforePatients = beforeData?.schedule ? Object.keys(beforeData.schedule).length : 0
  const afterPatients = afterData?.schedule ? Object.keys(afterData.schedule).length : 0

  let action = 'BASE_SCHEDULE_UPDATE'
  if (!beforeData && afterData) {
    action = 'BASE_SCHEDULE_CREATE'
  } else if (beforeData && !afterData) {
    action = 'BASE_SCHEDULE_DELETE'
  }

  // 嘗試從文件中取得修改者資訊
  const data = afterData || beforeData
  const modifiedBy = data?.lastModifiedBy || {}

  // 找出具體變更的病人 ID（限制記錄前 10 個避免日誌過大）
  const changedPatientIds = []
  if (beforeData?.schedule && afterData?.schedule) {
    const allPatientIds = new Set([
      ...Object.keys(beforeData.schedule || {}),
      ...Object.keys(afterData.schedule || {}),
    ])
    for (const patientId of allPatientIds) {
      const before = JSON.stringify(beforeData.schedule[patientId] || null)
      const after = JSON.stringify(afterData.schedule[patientId] || null)
      if (before !== after) {
        changedPatientIds.push(patientId)
        if (changedPatientIds.length >= 10) break
      }
    }
  }

  await logAuditEvent({
    action,
    userId: modifiedBy.uid || 'system',
    userName: modifiedBy.name || 'System/Trigger',
    collection: 'base_schedules',
    documentId: scheduleId,
    details: {
      scheduleType: scheduleId === 'MASTER_SCHEDULE' ? 'Master Schedule' : scheduleId,
      beforePatientCount: beforePatients,
      afterPatientCount: afterPatients,
      changedPatientIds: changedPatientIds.length > 0 ? changedPatientIds : undefined,
    },
    success: true,
  })

  return null
})

// ===================================================================
// ✨ KIDit Logbook 統一同步函式 (v4.1 - 修正病歷號遺失)
// ===================================================================

exports.syncEventsToKiditLogbook = onDocumentWritten('daily_logs/{dateStr}', async (event) => {
  const dateStr = event.params.dateStr
  const afterData = event.data?.after.data()

  // 1. 處理刪除事件
  if (!afterData) {
    logger.info(
      `[KIDIT Sync] Daily log for ${dateStr} was deleted. Clearing events in kidit_logbook...`,
    )
    const kiditLogRef = db.collection('kidit_logbook').doc(dateStr)
    await kiditLogRef.set({ date: dateStr, events: [] })
    return null
  }

  logger.info(`🚀 [KIDIT Sync] Triggered for date ${dateStr}. Processing Daily Log entries...`)

  try {
    // --- 階段 1: 從 Daily Log 本身提取事件 ---
    const dailyLogEvents = []
    const fallbackTimestamp = afterData.createdAt ? afterData.createdAt.toDate() : new Date()

    // 1-1. 處理病人動態 (Patient Movements)
    ;(afterData.patientMovements || []).forEach((item) => {
      if (item.patientId && item.name) {
        let eventTime = fallbackTimestamp
        if (item.timestamp) {
          eventTime = item.timestamp.toDate ? item.timestamp.toDate() : new Date(item.timestamp)
        }

        dailyLogEvents.push({
          id: `move_${dateStr}_${item.id}`,
          type: item.type || 'MOVEMENT',
          timestamp: eventTime,
          patientName: item.name,
          patientId: item.patientId,
          // ✨✨✨ [修正點 1] 補上病歷號欄位 ✨✨✨
          medicalRecordNumber: item.medicalRecordNumber || '',
          details: item.remarks || item.reason || '手動記錄於工作日誌',
        })
      }
    })

    // 1-2. 處理血管通路事件 (Vascular Access)
    ;(afterData.vascularAccessLog || []).forEach((item) => {
      if (item.patientId && item.name) {
        let eventTime = fallbackTimestamp
        if (item.timestamp) {
          eventTime = item.timestamp.toDate ? item.timestamp.toDate() : new Date(item.timestamp)
        }

        dailyLogEvents.push({
          id: `access_${dateStr}_${item.id}`,
          type: 'ACCESS',
          timestamp: eventTime,
          patientName: item.name,
          patientId: item.patientId,
          // ✨✨✨ [修正點 2] 補上病歷號欄位 ✨✨✨
          medicalRecordNumber: item.medicalRecordNumber || '',
          details: `通路處置: ${(item.interventions || []).join(', ')} (${item.location || '未知院所'})`,
        })
      }
    })

    logger.info(`[KIDIT Sync] Extracted ${dailyLogEvents.length} events from daily_log.`)

    // --- 階段 3: 合併、去重、排序並寫入 ---
    const allEventsForDay = dailyLogEvents
    const kiditLogRef = db.collection('kidit_logbook').doc(dateStr)

    if (allEventsForDay.length === 0) {
      await kiditLogRef.set({ date: dateStr, events: [] }, { merge: true })
      return null
    }

    await db.runTransaction(async (transaction) => {
      const kiditDoc = await transaction.get(kiditLogRef)
      const existingEvents = kiditDoc.exists ? kiditDoc.data().events || [] : []

      const verifiedEventsMap = new Map()
      allEventsForDay.forEach((e) => verifiedEventsMap.set(e.id, e))

      existingEvents.forEach((existing) => {
        if (verifiedEventsMap.has(existing.id)) {
          const current = verifiedEventsMap.get(existing.id)
          // 保留使用者的手動勾選狀態
          current.isRegistered = existing.isRegistered || false
          current.transferOutHospital = existing.transferOutHospital || ''
        }
      })

      const finalEvents = Array.from(verifiedEventsMap.values())

      finalEvents.sort((a, b) => {
        return a.timestamp.getTime() - b.timestamp.getTime()
      })

      transaction.set(kiditLogRef, {
        date: dateStr,
        events: finalEvents.map((e) => ({
          ...e,
          timestamp: e.timestamp,
          isRegistered: e.isRegistered || false,
          transferOutHospital: e.transferOutHospital || '',
          // 這裡會自動包含 medicalRecordNumber，因為 ...e 已經包含了它
        })),
      })
    })

    logger.info(
      `[KIDIT Sync] ✅ Successfully synced ${allEventsForDay.length} events to kidit_logbook.`,
    )
  } catch (error) {
    logger.error(`[KIDIT Sync] ❌ Failed to sync events for ${dateStr}:`, error)
  }
  return null
})

// ===================================================================
// 排程函式 (Scheduled Functions)
// ===================================================================
exports.checkExpiredTasks = onSchedule(
  { schedule: 'every day 02:00', timeZone: 'Asia/Taipei', timeoutSeconds: 300 },
  async (event) => {
    logger.info('[Scheduler] Running daily check for expired tasks (messages)...')
    const todayStr = getTaipeiTodayString() // 使用統一函式

    try {
      const query = db
        .collection('tasks')
        .where('status', '==', 'pending')
        .where('category', '==', 'message')
        .where('targetDate', '<', todayStr)

      const snapshot = await query.get()
      if (snapshot.empty) {
        logger.info('[Scheduler] No expired tasks (messages) with valid targetDate found.')
        return null
      }

      const batch = db.batch()
      let expiredCount = 0 // 新增一個計數器，用於記錄實際過期的數量

      snapshot.forEach((doc) => {
        const taskData = doc.data()

        // 🔥🔥🔥【核心修正】🔥🔥🔥
        // 在這裡加入判斷，如果任務類型是 '衛教'，就跳過，不處理
        if (taskData.type === '衛教') {
          logger.info(`[Scheduler] Skipping task ${doc.id} because it is a '衛教' task.`)
          return // 'return' 在 forEach 中相當於 'continue'
        }

        // 如果不是 '衛教'，則正常加入批次更新
        logger.info(`[Scheduler] Task (message) ${doc.id} has expired. Updating status.`)
        batch.update(doc.ref, { status: 'expired' })
        expiredCount++ // 計數器加一
      })

      // 只有在真正有需要過期的任務時，才執行 commit
      if (expiredCount > 0) {
        await batch.commit()
        logger.info(`[Scheduler] Successfully updated ${expiredCount} tasks to 'expired'.`)
      } else {
        logger.info('[Scheduler] No non-衛教 tasks to expire.')
      }
    } catch (error) {
      logger.error('[Scheduler] Failed to check for expired tasks:', error)
    }
    return null
  },
)

exports.initializeFutureSchedules = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'Asia/Taipei', timeoutSeconds: 540, memory: '1GiB' },
  async (event) => {
    logger.info('[Scheduler] Initializing future 60-day schedules...')
    const schedulesRef = db.collection('schedules')

    // 🔥 修正：使用字串為基礎的日期計算
    const todayStr = getTaipeiTodayString()
    const datesToCheck = Array.from({ length: 60 }, (_, i) => {
      const targetDate = new Date(todayStr + 'T00:00:00Z')
      targetDate.setUTCDate(targetDate.getUTCDate() + i) // 使用 UTC 方法
      return formatDateToYYYYMMDD(targetDate)
    })

    try {
      const masterScheduleDoc = await db.collection('base_schedules').doc('MASTER_SCHEDULE').get()
      const masterRules = masterScheduleDoc.exists ? masterScheduleDoc.data().schedule || {} : {}
      const part1 = schedulesRef.where('date', 'in', datesToCheck.slice(0, 30))
      const part2 = schedulesRef.where('date', 'in', datesToCheck.slice(30, 60))
      const [snapshot1, snapshot2] = await Promise.all([part1.get(), part2.get()])
      const existingDates = new Set([
        ...snapshot1.docs.map((doc) => doc.id),
        ...snapshot2.docs.map((doc) => doc.id),
      ])
      const datesToCreate = datesToCheck.filter((dateStr) => !existingDates.has(dateStr))
      if (datesToCreate.length === 0) {
        logger.info('[Scheduler] All future schedules already exist.')
        return null
      }
      logger.info(`[Scheduler] Found ${datesToCreate.length} missing daily schedules. Creating...`)

      // 🔥 v2.0: 查詢所有病人資料，用於動態生成 autoNote
      const patientsSnapshot = await db.collection('patients').where('isDeleted', '!=', true).get()
      const patientsMap = new Map()
      patientsSnapshot.forEach((doc) => {
        patientsMap.set(doc.id, doc.data())
      })
      logger.info(`[Scheduler] Loaded ${patientsMap.size} patients for dynamic autoNote generation.`)

      const batch = db.batch()
      datesToCreate.forEach((dateStr) => {
        // 🔥 v2.0: 傳遞 patientsMap 以動態生成 autoNote
        const dailySchedule = generateDailyScheduleFromRules(masterRules, dateStr, patientsMap)
        const newDocRef = schedulesRef.doc(dateStr)
        batch.set(newDocRef, {
          date: dateStr,
          schedule: dailySchedule,
          createdAt: FieldValue.serverTimestamp(),
        })
      })
      await batch.commit()
      logger.info(`[Scheduler] Successfully created ${datesToCreate.length} daily schedules.`)
    } catch (error) {
      logger.error('❌ 排程初始化失敗:', error)
    }
    return null
  },
)

// ===================================================================
// 可呼叫函式 (Callable Functions) - ✨ 全面加入 CORS 設定 ✨
// ===================================================================
exports.customLogin = onCall({ cors: allowedOrigins }, async (request) => {
  const { username, password } = request.data
  // 嘗試取得來源 IP（Cloud Functions v2）
  const ipAddress = request.rawRequest?.ip || request.rawRequest?.headers?.['x-forwarded-for'] || null

  if (!username || !password) {
    throw new HttpsError('invalid-argument', '請提供使用者名稱和密碼。')
  }
  try {
    const usersRef = db.collection('users')
    const snapshot = await usersRef.where('username', '==', username).limit(1).get()
    if (snapshot.empty) {
      // ✨ 記錄登入失敗（用戶不存在）
      await logAuditEvent({
        action: 'LOGIN_FAILED',
        details: { username, reason: '使用者名稱不存在' },
        ipAddress,
        success: false,
      })
      throw new HttpsError('not-found', '使用者名稱不存在。')
    }
    const userDoc = snapshot.docs[0]
    const userData = userDoc.data()
    const storedPassword = userData.password

    // ✨ 檢查密碼是否已經是 bcrypt hash 格式
    const isHashed = storedPassword && storedPassword.startsWith('$2')

    let isPasswordValid = false
    if (isHashed) {
      // 已加密的密碼：使用 bcrypt 比對
      isPasswordValid = await bcrypt.compare(password, storedPassword)
    } else {
      // 舊有明文密碼：直接比對，並在成功後自動遷移
      isPasswordValid = storedPassword === password
      if (isPasswordValid) {
        // ✨ 自動遷移：將明文密碼升級為 bcrypt hash
        const hashedPassword = await bcrypt.hash(password, 10)
        await userDoc.ref.update({ password: hashedPassword })
        logger.info(`[customLogin] 用戶 ${userDoc.id} 的密碼已自動遷移為加密格式。`)
      }
    }

    if (!isPasswordValid) {
      // ✨ 記錄登入失敗（密碼錯誤）
      await logAuditEvent({
        action: 'LOGIN_FAILED',
        userId: userDoc.id,
        userName: userData.name,
        details: { username, reason: '密碼不正確' },
        ipAddress,
        success: false,
      })
      throw new HttpsError('unauthenticated', '密碼不正確。')
    }

    const uid = userDoc.id
    const customToken = await admin.auth().createCustomToken(uid, {
      role: userData.role,
      name: userData.name,
      title: userData.title,
    })

    // ✨ 記錄登入成功
    await logAuditEvent({
      action: 'LOGIN_SUCCESS',
      userId: uid,
      userName: userData.name,
      details: { username, role: userData.role, title: userData.title },
      ipAddress,
      success: true,
    })

    return { token: customToken }
  } catch (error) {
    logger.error('[customLogin] Login function error:', error)
    if (error instanceof HttpsError) throw error
    throw new HttpsError('internal', '發生未知的伺服器錯誤。')
  }
})

exports.changeUserPassword = onCall({ cors: allowedOrigins }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '使用者未經驗證，無法更改密碼。')
  }
  const { oldPassword, newPassword } = request.data

  // ✨ 強化密碼驗證：至少 8 字元，包含大小寫和數字
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z\d@$!%*?&]{8,}$/
  if (!oldPassword || !newPassword) {
    throw new HttpsError('invalid-argument', '請提供舊密碼和新密碼。')
  }
  if (!passwordRegex.test(newPassword)) {
    throw new HttpsError(
      'invalid-argument',
      '新密碼需至少 8 個字元，並包含大寫字母、小寫字母和數字。',
    )
  }

  const uid = request.auth.uid
  try {
    const userDocRef = db.collection('users').doc(uid)
    const userDoc = await userDocRef.get()
    if (!userDoc.exists) {
      throw new HttpsError('not-found', '在資料庫中找不到對應的使用者紀錄。')
    }
    const userData = userDoc.data()
    const storedPassword = userData.password

    // ✨ 檢查舊密碼（支援 bcrypt hash 和舊有明文格式）
    const isHashed = storedPassword && storedPassword.startsWith('$2')
    let isOldPasswordValid = false
    if (isHashed) {
      isOldPasswordValid = await bcrypt.compare(oldPassword, storedPassword)
    } else {
      isOldPasswordValid = storedPassword === oldPassword
    }

    if (!isOldPasswordValid) {
      throw new HttpsError('unauthenticated', '舊密碼不正確。')
    }

    // ✨ 將新密碼加密後儲存
    const hashedNewPassword = await bcrypt.hash(newPassword, 10)
    await userDocRef.update({ password: hashedNewPassword })

    try {
      await admin.auth().updateUser(uid, { password: newPassword })
    } catch (authError) {
      logger.warn(
        `[changeUserPassword] Updated password in Firestore for user ${uid}, but failed to update in Firebase Auth. Reason:`,
        authError.message,
      )
    }

    // ✨ 記錄密碼變更操作
    await logAuditEvent({
      action: 'PASSWORD_CHANGE',
      userId: uid,
      userName: userData.name,
      collection: 'users',
      documentId: uid,
      details: { changedByUser: true },
      success: true,
    })

    logger.info(`User ${uid} successfully changed their password.`)
    return { success: true, message: '密碼已成功更新！' }
  } catch (error) {
    logger.error(`[changeUserPassword] Error changing password for user ${uid}:`, error)
    if (error instanceof HttpsError) {
      throw error
    }
    throw new HttpsError('internal', '更新密碼時發生未知的伺服器錯誤。')
  }
})

/**
 * ✨ 安全建立用戶（密碼加密儲存）
 * 只有 admin 角色可以呼叫此函式
 */
exports.createUser = onCall({ cors: allowedOrigins }, async (request) => {
  // 驗證呼叫者是否為 admin
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '使用者未經驗證。')
  }
  if (request.auth.token.role !== 'admin') {
    throw new HttpsError('permission-denied', '只有管理員可以建立新用戶。')
  }

  const { username, password, name, title, role, email, staffId, phone, clinicHours, defaultSchedules, defaultConsultationSchedules } = request.data

  // 驗證必要欄位
  if (!username || !password || !name || !title || !role) {
    throw new HttpsError('invalid-argument', '缺少必要欄位：username, password, name, title, role')
  }

  try {
    // 檢查 username 是否已存在
    const existingUser = await db.collection('users').where('username', '==', username).limit(1).get()
    if (!existingUser.empty) {
      throw new HttpsError('already-exists', '此使用者名稱已被使用。')
    }

    // ✨ 加密密碼
    const hashedPassword = await bcrypt.hash(password, 10)

    // 建立用戶資料
    const userData = {
      username,
      password: hashedPassword,
      name,
      title,
      role,
      email: email || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }

    // 如果是主治醫師，添加額外欄位
    if (title === '主治醫師') {
      userData.staffId = staffId || ''
      userData.phone = phone || ''
      userData.clinicHours = clinicHours || []
      userData.defaultSchedules = defaultSchedules || []
      userData.defaultConsultationSchedules = defaultConsultationSchedules || []
    }

    const newUserRef = await db.collection('users').add(userData)
    logger.info(`[createUser] 管理員 ${request.auth.uid} 成功建立新用戶 ${newUserRef.id}`)

    // ✨ 記錄用戶建立操作
    await logAuditEvent({
      action: 'USER_CREATE',
      userId: request.auth.uid,
      userName: request.auth.token.name || 'Admin',
      collection: 'users',
      documentId: newUserRef.id,
      details: {
        newUsername: username,
        newUserName: name,
        newUserRole: role,
        newUserTitle: title,
      },
      success: true,
    })

    return {
      success: true,
      userId: newUserRef.id,
      message: '用戶已成功建立。',
    }
  } catch (error) {
    logger.error('[createUser] Error creating user:', error)
    if (error instanceof HttpsError) throw error
    throw new HttpsError('internal', '建立用戶時發生錯誤。')
  }
})

/**
 * ✨ 管理員重設用戶密碼
 * 只有 admin 角色可以呼叫此函式
 */
exports.adminResetPassword = onCall({ cors: allowedOrigins }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '使用者未經驗證。')
  }
  if (request.auth.token.role !== 'admin') {
    throw new HttpsError('permission-denied', '只有管理員可以重設密碼。')
  }

  const { userId, newPassword } = request.data
  if (!userId || !newPassword) {
    throw new HttpsError('invalid-argument', '缺少必要欄位：userId, newPassword')
  }

  // 檢查新密碼複雜度
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z\d@$!%*?&]{8,}$/
  if (!passwordRegex.test(newPassword)) {
    throw new HttpsError(
      'invalid-argument',
      '新密碼需至少 8 個字元，並包含大寫字母、小寫字母和數字。',
    )
  }

  try {
    const userDocRef = db.collection('users').doc(userId)
    const userDoc = await userDocRef.get()
    if (!userDoc.exists) {
      throw new HttpsError('not-found', '找不到該用戶。')
    }

    const targetUserData = userDoc.data()

    // ✨ 加密新密碼
    const hashedPassword = await bcrypt.hash(newPassword, 10)
    await userDocRef.update({
      password: hashedPassword,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    // ✨ 記錄密碼重設操作
    await logAuditEvent({
      action: 'PASSWORD_RESET_BY_ADMIN',
      userId: request.auth.uid,
      userName: request.auth.token.name || 'Admin',
      collection: 'users',
      documentId: userId,
      details: {
        targetUserName: targetUserData.name,
        targetUsername: targetUserData.username,
      },
      success: true,
    })

    logger.info(`[adminResetPassword] 管理員 ${request.auth.uid} 重設了用戶 ${userId} 的密碼`)
    return { success: true, message: '密碼已成功重設。' }
  } catch (error) {
    logger.error('[adminResetPassword] Error:', error)
    if (error instanceof HttpsError) throw error
    throw new HttpsError('internal', '重設密碼時發生錯誤。')
  }
})

/**
 * 管理員從前端點擊按鈕觸發(目前無用)
 * 🔧 v2.0: 修正傳遞日期字串而非 Date 物件，並支援動態 autoNote
 */
exports.ensureFutureSchedules = onCall(
  { cors: allowedOrigins, timeoutSeconds: 300, memory: '512MiB' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', '使用者未登入，無法執行此操作。')
    }

    logger.info(
      `🚀 [ensureFutureSchedules] 由使用者 ${request.auth.uid} 觸發，開始檢查未來60天排程...`,
    )

    const schedulesRef = db.collection('schedules')
    const today = getTaipeiNow() // ✨ 使用統一函式
    const datesToCheck = []

    for (let i = 0; i < 60; i++) {
      const targetDate = new Date(today) // ✨ 從正確的起點複製
      targetDate.setDate(today.getDate() + i)
      datesToCheck.push(formatDateToYYYYMMDD(targetDate)) // ✨ 使用統一函式
    }

    try {
      // 載入總表規則
      const masterScheduleDoc = await db.collection('base_schedules').doc('MASTER_SCHEDULE').get()
      const masterRules = masterScheduleDoc.exists ? masterScheduleDoc.data().schedule || {} : {}

      // 分批查詢現有排程（Firestore in 查詢限制30個）
      const existingDates = new Set()
      for (let i = 0; i < datesToCheck.length; i += 30) {
        const chunk = datesToCheck.slice(i, i + 30)
        const snapshot = await schedulesRef.where('date', 'in', chunk).get()
        snapshot.forEach((doc) => existingDates.add(doc.data().date))
      }

      const datesToCreate = datesToCheck.filter((dateStr) => !existingDates.has(dateStr))

      if (datesToCreate.length === 0) {
        logger.info('✅ [ensureFutureSchedules] 所有未來60天排程均已存在。')
        return { success: true, message: '所有排程均已存在。', createdCount: 0 }
      }

      logger.info(`⏳ [ensureFutureSchedules] 發現 ${datesToCreate.length} 個缺失排程，正在創建...`)

      // 🔥 v2.0: 查詢所有病人資料，用於動態生成 autoNote
      const patientsSnapshot = await db.collection('patients').where('isDeleted', '!=', true).get()
      const patientsMap = new Map()
      patientsSnapshot.forEach((doc) => {
        patientsMap.set(doc.id, doc.data())
      })
      logger.info(`[ensureFutureSchedules] Loaded ${patientsMap.size} patients for dynamic autoNote.`)

      const batch = db.batch()
      datesToCreate.forEach((dateStr) => {
        // 🔥 v2.0: 直接傳遞日期字串和 patientsMap
        const dailySchedule = generateDailyScheduleFromRules(masterRules, dateStr, patientsMap)

        const newDocRef = schedulesRef.doc(dateStr)
        batch.set(newDocRef, {
          date: dateStr,
          schedule: dailySchedule,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          syncMethod: 'initial_create',
        })
      })

      await batch.commit()

      const successMsg = `成功創建了 ${datesToCreate.length} 個排程文件。`
      logger.info(`✅ [ensureFutureSchedules] ${successMsg}`)
      return { success: true, message: successMsg, createdCount: datesToCreate.length }
    } catch (error) {
      logger.error('❌ [ensureFutureSchedules] 執行失敗:', error)
      throw new HttpsError('internal', '伺服器展程時發生錯誤。', { details: error.message })
    }
  },
)

// ===================================================================
// ✨【最終健壯版 v2.3】 - 掃描多個儲存格來尋找標題
// ===================================================================
exports.saveNursingSchedule = onCall({ cors: allowedOrigins }, async (request) => {
  // 1. 安全性檢查
  if (!request.auth || request.auth.token.role !== 'admin') {
    throw new HttpsError('permission-denied', '此操作需要管理員權限。')
  }

  // 2. 驗證傳入的檔案內容
  if (!request.data.fileContentBase64 || !request.data.fileName) {
    throw new HttpsError('invalid-argument', '缺少檔案內容或檔名。')
  }

  logger.log(`由使用者 ${request.auth.uid} 開始處理班表檔案: ${request.data.fileName}`)

  try {
    const db = admin.firestore()

    // 3. 解析 Excel
    const fileBuffer = Buffer.from(request.data.fileContentBase64, 'base64')
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' })
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

    logger.log(`Excel 解析完成，共 ${jsonData.length} 行資料`)

    if (!jsonData || jsonData.length < 1) {
      throw new Error('Excel 檔案內容不足，請確認檔案格式正確')
    }

    // ✨✨✨【核心修正：使用巢狀迴圈掃描多個儲存格】✨✨✨
    let title = ''
    let year, month, yearMonth
    let titleFound = false // 新增一個旗標來跳出外層迴圈

    // 外層迴圈：掃描前 10 行
    for (let rowIndex = 0; rowIndex < Math.min(jsonData.length, 10); rowIndex++) {
      const row = jsonData[rowIndex]
      if (!row) continue // 如果是空行，跳過

      // 內層迴圈：掃描該行的前 10 個儲存格 (A欄 到 J欄)
      for (let cellIndex = 0; cellIndex < Math.min(row.length, 10); cellIndex++) {
        const cell = row[cellIndex]

        if (cell && typeof cell === 'string') {
          const match = cell.match(/(\d{3,4})\s*年\s*(\d{1,2})\s*月(份)?/)
          if (match) {
            title = cell.trim()
            let rawYear = parseInt(match[1], 10)
            year = rawYear < 1911 ? rawYear + 1911 : rawYear
            month = String(match[2]).padStart(2, '0')
            yearMonth = `${year}-${month}`

            logger.log(
              `在儲存格 [${rowIndex + 1}, ${cellIndex + 1}] 的 "${title}" 中找到匹配項, 解析年月為: ${yearMonth}`,
            )

            titleFound = true // 設置旗標
            break // 跳出內層迴圈
          }
        }
      }
      if (titleFound) {
        break // 如果已找到，也跳出外層迴圈
      }
    }

    if (!yearMonth) {
      const firstTenRowsPreview = jsonData
        .slice(0, 10)
        .map((row, index) => `  行 ${index + 1}: ${(row || []).slice(0, 5).join(', ')}`)
        .join('\n')
      logger.error('無法解析年月標題。Excel 前 10 行內容預覽:\n' + firstTenRowsPreview)
      throw new Error(
        '無法在 Excel 檔案的前 10 行中找到有效的年月標題 (格式應包含 "XXX年YY月" 或 "XXX年YY月份")。請檢查檔案。',
      )
    }
    // ✨✨✨ (修正結束) ✨✨✨

    const maxDaysInMonth = new Date(year, parseInt(month, 10), 0).getDate()
    logger.log(`${yearMonth} 共有 ${maxDaysInMonth} 天`)

    // ... 後續的程式碼完全不變 ...
    const usersSnapshot = await db.collection('users').where('title', '==', '護理師').get()
    const nurseMap = new Map()
    const nurseDataMap = new Map()

    usersSnapshot.forEach((doc) => {
      const userData = doc.data()
      nurseMap.set(userData.name, doc.id)
      nurseDataMap.set(doc.id, {
        name: userData.name,
        username: userData.username || '',
      })
    })
    logger.log(`資料庫中有 ${nurseMap.size} 位護理師`)

    let nurseStartRow = -1
    for (let i = 2; i < Math.min(jsonData.length, 20); i++) {
      const firstCell = String(jsonData[i]?.[0] || '').trim()
      if (!firstCell) continue
      for (const fullName of nurseMap.keys()) {
        if (fullName.endsWith(firstCell)) {
          nurseStartRow = i
          logger.log(`找到第一位護理師 "${firstCell}" 在第 ${i} 行`)
          break
        }
      }
      if (nurseStartRow !== -1) break
    }
    if (nurseStartRow === -1) {
      throw new Error('找不到護理師資料，請確認 Excel 格式')
    }

    const scheduleByNurse = {}
    const scheduleByWeek = {}
    const processedNurses = new Set()
    const processingOrder = []
    const EARLY_SHIFTS = ['74', '75', '84', '74/L', '816', '815', '7-3', '8-4', '7-5']
    const LATE_SHIFTS = ['3-11', '311']
    const REST_TYPES = ['休', '例', '例假', '國定', 'off', 'OFF', '例教']

    for (let rowIndex = nurseStartRow; rowIndex < jsonData.length; rowIndex++) {
      const row = jsonData[rowIndex]
      if (!row || !row[0]) continue

      const nurseFirstName = String(row[0]).trim()
      if (
        !nurseFirstName ||
        ['COUNT', '合計', '總計', '例假', '備註'].some((kw) => nurseFirstName.includes(kw))
      ) {
        logger.log(`跳過無關行: "${nurseFirstName}"`)
        continue
      }

      let matchedFullName = null,
        matchedId = null
      for (const [fullName, id] of nurseMap.entries()) {
        if (fullName && fullName.endsWith(nurseFirstName)) {
          matchedFullName = fullName
          matchedId = id
          break
        }
      }
      if (!matchedFullName) {
        logger.log(`第 ${rowIndex} 行: 未匹配的名字 "${nurseFirstName}"`)
        continue
      }
      if (processedNurses.has(matchedId)) {
        logger.warn(`第 ${rowIndex} 行: 護理師 "${matchedFullName}" 已經處理過，跳過重複資料`)
        continue
      }

      const shifts = new Array(maxDaysInMonth).fill('')
      for (let day = 1; day <= maxDaysInMonth; day++) {
        const columnIndex = day
        if (columnIndex < row.length) {
          const shift = String(row[columnIndex] || '').trim()
          if (shift) shifts[day - 1] = shift
        }
      }

      const nurseData = nurseDataMap.get(matchedId)
      scheduleByNurse[matchedId] = {
        nurseName: matchedFullName,
        nurseUsername: nurseData?.username || '',
        orderIndex: processingOrder.length,
        shifts: shifts,
      }
      processingOrder.push(matchedId)
      processedNurses.add(matchedId)

      shifts.forEach((shift, index) => {
        if (!shift) return
        const day = index + 1
        let type = null
        if (EARLY_SHIFTS.some((s) => shift.includes(s))) type = 'early'
        else if (LATE_SHIFTS.some((s) => shift.includes(s))) type = 'late'

        if (type) {
          const date = new Date(year, parseInt(month, 10) - 1, day)
          const dayOfWeek = (date.getDay() + 6) % 7
          const weekNumber = Math.ceil(day / 7)
          if (!scheduleByWeek[weekNumber]) scheduleByWeek[weekNumber] = {}
          if (!scheduleByWeek[weekNumber][dayOfWeek])
            scheduleByWeek[weekNumber][dayOfWeek] = { early: [], late: [] }
          scheduleByWeek[weekNumber][dayOfWeek][type].push({
            id: matchedId,
            name: matchedFullName,
            username: nurseData?.username || '',
            shift: shift,
          })
        }
      })
    }

    if (processedNurses.size === 0) {
      throw new Error('沒有找到任何可處理的護理師資料')
    }

    const dataToSave = {
      title,
      yearMonth,
      maxDaysInMonth,
      scheduleByNurse,
      scheduleByWeek,
      processingOrder,
      lastUpdatedAt: FieldValue.serverTimestamp(),
      updatedBy: { uid: request.auth.uid, name: request.auth.token.name || '未知管理員' },
    }
    await db.collection('nursing_schedules').doc(yearMonth).set(dataToSave)

    const nurseList = Object.values(scheduleByNurse)
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((n) => n.nurseName)
      .join(', ')
    logger.log(`✅ 班表 ${yearMonth} 已成功儲存`)

    return {
      success: true,
      message: `班表 ${yearMonth} 已成功儲存，包含 ${processedNurses.size} 位護理師的完整資料。`,
      stats: {
        month: yearMonth,
        nurseCount: processedNurses.size,
        daysInMonth: maxDaysInMonth,
        nurses: nurseList,
      },
    }
  } catch (error) {
    logger.error('儲存護理班表失敗:', error)
    throw new HttpsError('internal', error.message || '儲存班表時發生未預期的錯誤。')
  }
})

// ===================================================================
// 串接google drive
// ===================================================================
/**
 * 【超簡化最終版】取得 Google API 的授權客戶端。
 * 直接使用開發人員的 OAuth 2.0 憑證進行授權。
 * @returns {Promise<object>} Authorized Google Auth client.
 */
async function getGoogleAuthClient() {
  // 從環境變數讀取 OAuth 2.0 憑證
  const clientId = process.env.GDRIVE_CLIENT_ID
  const clientSecret = process.env.GDRIVE_CLIENT_SECRET
  const refreshToken = process.env.GDRIVE_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    logger.error('Missing Google Drive OAuth 2.0 credentials in environment variables.')
    throw new Error('Server configuration error for Google Drive access.')
  }

  // 建立 OAuth2 客戶端
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'https://developers.google.com/oauthplayground', // 重新導向 URI 必須與設定時一致
  )

  // 設定 Refresh Token，客戶端會自動用它來獲取 Access Token
  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  })

  logger.info(`Successfully created OAuth2 client for user.`)
  return oauth2Client
}

/**
 * (新輔助函式) 在指定的父資料夾中，尋找或建立一個子資料夾。
 * @param {object} drive - 已授權的 Google Drive API 實例。
 * @param {string} folderName - 要尋找或建立的子資料夾名稱。
 * @param {string} parentFolderId - 父資料夾的 ID。
 * @returns {Promise<string>} 子資料夾的 ID。
 */
async function findOrCreateFolder(drive, folderName, parentFolderId) {
  // 1. 建立搜尋查詢
  const query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentFolderId}' in parents and trashed=false`

  // 2. 執行搜尋
  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })

  // 3. 判斷結果
  if (response.data.files && response.data.files.length > 0) {
    // 如果找到了，直接回傳第一個匹配項的 ID
    const existingFolderId = response.data.files[0].id
    logger.info(`Found existing folder: "${folderName}" (ID: ${existingFolderId})`)
    return existingFolderId
  } else {
    // 如果沒找到，就建立一個新的
    logger.info(`Folder "${folderName}" not found. Creating new one...`)
    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    }
    const newFolder = await drive.files.create({
      resource: fileMetadata,
      fields: 'id',
      supportsAllDrives: true,
    })
    const newFolderId = newFolder.data.id
    logger.info(`Successfully created new folder: "${folderName}" (ID: ${newFolderId})`)
    return newFolderId
  }
}

//------------------------------------------------------------------
/**
 * 【可呼叫函式 - 最終統一版】上傳檔案到 Google Drive 中指定的路徑。
 * 此函式會自動遞迴地尋找或建立 targetPath 中定義的子資料夾結構。
 */
/**
 * 【可呼叫函式 - 最終簡化版】上傳檔案到 Google Drive 中指定的路徑。
 * 此函式會自動遞迴地尋找或建立 targetPath 中定義的子資料夾結構。
 */
exports.uploadFile = onCall({ cors: allowedOrigins }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '您必須登入才能上傳檔案。')
  }

  const { fileName, fileContentBase64, mimeType, targetPath } = request.data

  if (
    !fileName ||
    !fileContentBase64 ||
    !mimeType ||
    !Array.isArray(targetPath) ||
    targetPath.length === 0
  ) {
    throw new HttpsError('invalid-argument', '請求中缺少必要的檔案資訊或目標路徑 (targetPath)。')
  }

  try {
    // 取得代表目標 Google 帳號的授權
    const auth = await getGoogleAuthClient()
    const drive = google.drive({ version: 'v3', auth })

    // 1. 遞迴地尋找或建立資料夾結構
    let currentParentFolderId = SHARED_DRIVE_FOLDER_ID // 從對應環境的共享根目錄開始
    for (const folderName of targetPath) {
      // 依序尋找或建立路徑中的每一個資料夾
      currentParentFolderId = await findOrCreateFolder(drive, folderName, currentParentFolderId)
    }

    // 最終得到的 currentParentFolderId 就是我們要上傳檔案的目標位置
    const finalTargetFolderId = currentParentFolderId
    logger.info(`Final target folder ID for upload: ${finalTargetFolderId}`)

    // 2. 準備並上傳檔案
    const fileBuffer = Buffer.from(fileContentBase64, 'base64')
    const bufferStream = new stream.PassThrough()
    bufferStream.end(fileBuffer)

    const fileMetadata = {
      name: fileName,
      parents: [finalTargetFolderId],
    }

    const media = {
      mimeType: mimeType,
      body: bufferStream,
    }

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink, webContentLink',
      supportsAllDrives: true, // 保留此參數是好的實踐
    })

    const fileData = response.data
    logger.info(
      `File uploaded successfully to path "${targetPath.join('/')}": ${fileData.name} (ID: ${fileData.id})`,
    )

    // 所有權轉移的邏輯已移除，因為 Refresh Token 的所有者就是檔案的所有者，不再需要轉移。

    return {
      success: true,
      message: `檔案成功上傳至 [${targetPath.join(' / ')}]！`,
      file: {
        id: fileData.id,
        name: fileData.name,
        viewLink: fileData.webViewLink,
        downloadLink: fileData.webContentLink,
      },
    }
  } catch (error) {
    logger.error('Error uploading file to Google Drive:', error)
    throw new HttpsError('internal', '上傳檔案至 Google Drive 時發生錯誤。', error.message)
  }
})

//------------------------------------------------------------------
/**
 * 【新增的可呼叫函式 - 最終修正版 v2.2】根據指定的路徑，在 Google Drive 中搜尋檔案。
 */
exports.getDriveFiles = onCall({ cors: allowedOrigins }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '您必須登入才能查詢檔案。')
  }

  const { targetPath } = request.data
  if (!Array.isArray(targetPath) || targetPath.length === 0) {
    throw new HttpsError('invalid-argument', '請求中缺少目標路徑 (targetPath)。')
  }

  try {
    const auth = await getGoogleAuthClient()
    const drive = google.drive({ version: 'v3', auth })

    // 1. 遞迴找到最終的目標資料夾 ID
    let currentParentFolderId = SHARED_DRIVE_FOLDER_ID
    for (const folderName of targetPath) {
      const query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${currentParentFolderId}' in parents and trashed=false`
      const response = await drive.files.list({
        q: query,
        fields: 'files(id)',
        supportsAllDrives: true,
        // ✨ --- [核心修正 1] 必須加入此參數才能在共享雲端硬碟中搜尋 --- ✨
        includeItemsFromAllDrives: true,
      })

      if (response.data.files && response.data.files.length > 0) {
        currentParentFolderId = response.data.files[0].id
      } else {
        logger.info(`查詢路徑 ${targetPath.join('/')} 時，找不到資料夾 ${folderName}。`)
        return { success: true, files: [] }
      }
    }
    const finalTargetFolderId = currentParentFolderId

    // 2. 在最終的資料夾中搜尋所有檔案
    const fileQuery = `'${finalTargetFolderId}' in parents and trashed = false`
    const response = await drive.files.list({
      q: fileQuery,
      fields: 'files(id, name, thumbnailLink, webViewLink, createdTime, iconLink)',
      orderBy: 'createdTime desc',
      pageSize: 50,
      supportsAllDrives: true,
      // ✨ --- [核心修正 2] 這裡同樣需要加入此參數 --- ✨
      includeItemsFromAllDrives: true,
    })

    // ✨ --- [健壯性改進] 確保即使 API 回應沒有 files 屬性也不會出錯 --- ✨
    const files = response.data.files || []
    logger.info(`Found ${files.length} files in path: ${targetPath.join('/')}`)

    return {
      success: true,
      files: files,
    }
  } catch (error) {
    logger.error(`Error searching files in Google Drive for path ${targetPath.join('/')}:`, error)
    throw new HttpsError('internal', '在 Google Drive 中搜尋檔案時發生錯誤。', error.message)
  }
})

/**
 * 【可呼叫函式】重新命名 Google Drive 上的檔案。
 * 需要傳入 fileId 和新的檔案名稱 newName。
 */
exports.renameDriveFile = onCall({ cors: allowedOrigins }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '您必須登入才能重新命名檔案。')
  }

  const { fileId, newName } = request.data

  if (!fileId || !newName) {
    throw new HttpsError('invalid-argument', '請求中缺少檔案 ID 或新檔名。')
  }

  try {
    const auth = await getGoogleAuthClient()
    const drive = google.drive({ version: 'v3', auth })

    const response = await drive.files.update({
      fileId: fileId,
      requestBody: {
        name: newName,
      },
      fields: 'id, name',
      supportsAllDrives: true,
    })

    logger.info(`File renamed successfully: ${fileId} -> ${newName}`)

    return {
      success: true,
      file: response.data,
    }
  } catch (error) {
    logger.error(`Error renaming file ${fileId}:`, error)
    throw new HttpsError('internal', '重新命名檔案時發生錯誤。', error.message)
  }
})

// ===================================================================
// 自動備份輔助函式 v2.2 (使用 dateUtils)
// ===================================================================
const XLSX = require('xlsx') // 確保在檔案頂部引入

/**
 * 在指定的 Google Drive 資料夾中尋找特定名稱的檔案並刪除。
 * @param {object} drive - 已授權的 Google Drive API 實例。
 * @param {string} fileName - 要尋找並刪除的檔案名稱。
 * @param {string} parentFolderId - 檔案所在的父資料夾 ID。
 * @returns {Promise<boolean>} 是否成功刪除。
 */
async function findAndDeleteFile(drive, fileName, parentFolderId) {
  try {
    const query = `'${parentFolderId}' in parents and name = '${fileName}' and trashed = false`
    const res = await drive.files.list({
      q: query,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })

    if (res.data.files && res.data.files.length > 0) {
      const fileId = res.data.files[0].id
      logger.info(`[Backup] Found old pre-backup file "${fileName}" (ID: ${fileId}). Deleting...`)
      await drive.files.delete({
        fileId: fileId,
        supportsAllDrives: true,
      })
      logger.info(`[Backup] Successfully deleted old pre-backup file.`)
      return true
    } else {
      logger.info(`[Backup] No old pre-backup file named "${fileName}" found to delete.`)
      return false
    }
  } catch (error) {
    logger.error(`[Backup] Error during findAndDeleteFile for "${fileName}":`, error)
    return false
  }
}

/**
 * 將 Buffer 內容上傳到 Google Drive 的指定路徑。
 * @param {object} drive - 已授權的 Google Drive API 實例。
 * @param {Buffer} fileBuffer - 檔案的 Buffer 內容。
 * @param {string} fileName - 檔案名稱。
 * @param {string} mimeType - 檔案的 MIME 類型。
 * @param {Array<string>} targetPath - 目標路徑陣列，例如 ['資料備份', '2025 年']。
 */
async function uploadBufferToDrive(drive, fileBuffer, fileName, mimeType, targetPath) {
  let currentParentFolderId = SHARED_DRIVE_FOLDER_ID
  for (const folderName of targetPath) {
    currentParentFolderId = await findOrCreateFolder(drive, folderName, currentParentFolderId)
  }

  const bufferStream = new stream.PassThrough()
  bufferStream.end(fileBuffer)

  const fileMetadata = { name: fileName, parents: [currentParentFolderId] }
  const media = { mimeType: mimeType, body: bufferStream }

  await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id',
    supportsAllDrives: true,
  })
  logger.info(`[Backup] Successfully uploaded "${fileName}" to Google Drive.`)
}

/**
 * [後端版 effectiveStatsData]
 * 根據排班、分組、病人資料，產生用於統計和匯出的結構化護理分組資料。
 * @param {object} schedule - 當日的排班資料 (來自 schedules 集合)
 * @param {object} teams - 當日的護理師分組資料 (來自 nurse_assignments 集合的 teams 欄位)
 * @param {object} names - 當日的護理師姓名指派 (來自 nurse_assignments 集合的 names 欄位)
 * @param {Map<string, object>} patientMap - 病人資料的 Map
 * @returns {object} - 包含 early, late, lateTakeOff 分組的完整資料物件
 */
function generateAssignmentsData(schedule, teams, names, patientMap) {
  // --- 在函式內部定義常數，使其自給自足 ---
  const SHIFT_CODES = { EARLY: 'early', NOON: 'noon', LATE: 'late' }
  const baseTeams = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', '外圍', '未分組']
  const earlyTeams = baseTeams.map((t) => `早${t}`)
  const lateTeams = baseTeams.map((t) => `晚${t}`)
  const lateTakeOffTeams = baseTeams.map((t) => `夜間收針${t}`)

  const createTeamStats = (teamList, shiftType) => {
    const stats = {}
    teamList.forEach((team) => {
      stats[team] = {
        nurseName: names?.[team] || '',
        totalOpdCount: 0,
        totalIpdCount: 0,
        totalErCount: 0,
      }
      if (shiftType === 'early') {
        stats[team].earlyShift = { patients: [], opdCount: 0, ipdCount: 0, erCount: 0 }
        stats[team].noonShiftOn = { patients: [], opdCount: 0, ipdCount: 0, erCount: 0 }
        stats[team].noonShiftOff = { patients: [], opdCount: 0, ipdCount: 0, erCount: 0 }
      } else if (shiftType === 'late') {
        stats[team].noonShiftOff = { patients: [], opdCount: 0, ipdCount: 0, erCount: 0 }
        stats[team].lateShift = { patients: [], opdCount: 0, ipdCount: 0, erCount: 0 }
      } else if (shiftType === 'lateTakeOff') {
        stats[team].lateShiftTakeOff = { patients: [], opdCount: 0, ipdCount: 0, erCount: 0 }
      }
    })
    return stats
  }

  const stats = {
    early: createTeamStats(earlyTeams, 'early'),
    late: createTeamStats(lateTeams, 'late'),
    lateTakeOff: createTeamStats(lateTakeOffTeams, 'lateTakeOff'),
  }

  for (const shiftId in schedule) {
    const slot = schedule[shiftId]
    if (!slot || !slot.patientId) continue

    const patientDetails = patientMap.get(slot.patientId)
    if (!patientDetails) continue

    const detail = {
      id: slot.patientId,
      shiftId,
      name: patientDetails.name,
      status: patientDetails.status,
      dialysisBed: shiftId.startsWith('peripheral') ? '外圍' : shiftId.split('-')[1] || '',
      finalTags: `${slot.autoNote || ''} ${slot.manualNote || ''}`.trim(),
    }

    const assignAndCount = (group, pDetail) => {
      if (!group) return
      group.patients.push(pDetail)
      if (pDetail.status === 'ipd') group.ipdCount++
      else if (pDetail.status === 'er') group.erCount++
      else group.opdCount++
    }

    const shiftCode = shiftId.split('-')[2]
    const teamKey = `${slot.patientId}-${shiftCode}`
    const teamInfo = teams[teamKey] || {}

    if (shiftCode === SHIFT_CODES.EARLY) {
      const targetTeam = teamInfo.nurseTeam || '早未分組'
      if (stats.early[targetTeam]) assignAndCount(stats.early[targetTeam].earlyShift, detail)
    } else if (shiftCode === SHIFT_CODES.LATE) {
      const targetTeam = teamInfo.nurseTeam || '晚未分組'
      if (stats.late[targetTeam]) assignAndCount(stats.late[targetTeam].lateShift, detail)

      const targetTakeOffTeam = teamInfo.nurseTeamTakeOff || '夜間收針未分組'
      if (stats.lateTakeOff[targetTakeOffTeam])
        assignAndCount(stats.lateTakeOff[targetTakeOffTeam].lateShiftTakeOff, detail)
    } else if (shiftCode === SHIFT_CODES.NOON) {
      const targetInTeam = teamInfo.nurseTeamIn || '早未分組'
      if (stats.early[targetInTeam]) assignAndCount(stats.early[targetInTeam].noonShiftOn, detail)

      const targetOutTeam = teamInfo.nurseTeamOut || '晚未分組'
      if (stats.late[targetOutTeam]) assignAndCount(stats.late[targetOutTeam].noonShiftOff, detail)
    }
  }

  // 計算總人數
  Object.values(stats).forEach((shiftGroup) => {
    for (const team in shiftGroup) {
      const teamData = shiftGroup[team]
      if (!teamData) continue
      teamData.totalOpdCount = Object.values(teamData).reduce(
        (sum, part) => sum + (part.opdCount || 0),
        0,
      )
      teamData.totalIpdCount = Object.values(teamData).reduce(
        (sum, part) => sum + (part.ipdCount || 0),
        0,
      )
      teamData.totalErCount = Object.values(teamData).reduce(
        (sum, part) => sum + (part.erCount || 0),
        0,
      )
    }
  })

  return stats
}

/**
 * 根據處理好的護理分組資料，產生 Excel 檔案的 Buffer。
 * @param {object} statsData - 從 generateAssignmentsData 函式得到的資料
 * @param {object} names - 護理師姓名指派
 * @returns {Buffer|null} Excel 檔案的 Buffer，或在無資料時返回 null
 */
function generateAssignmentsExcelBuffer(statsData, names) {
  if (!statsData) return null

  const aoa = []
  const formatPatientCell = (patients) => {
    if (!patients || patients.length === 0) return ''
    return patients
      .map((p) => `${p.dialysisBed} - ${p.name} ${p.finalTags ? '(' + p.finalTags + ')' : ''}`)
      .join('\n')
  }
  const formatCountCell = (teamData) =>
    `門${teamData?.totalOpdCount || 0} 住${teamData?.totalIpdCount || 0} 急${teamData?.totalErCount || 0}`

  // --- 早班 ---
  const sortedEarlyTeams = Object.keys(statsData.early).sort((a, b) => a.localeCompare(b))
  aoa.push(['早班', ...sortedEarlyTeams.map((name) => name.replace('早', '') + '組')])
  aoa.push(['姓名', ...sortedEarlyTeams.map((name) => names[name] || '-- 未指派 --')])
  aoa.push([
    '早班',
    ...sortedEarlyTeams.map((name) =>
      formatPatientCell(statsData.early[name]?.earlyShift.patients),
    ),
  ])
  aoa.push([
    '午班(上針)',
    ...sortedEarlyTeams.map((name) =>
      formatPatientCell(statsData.early[name]?.noonShiftOn.patients),
    ),
  ])
  aoa.push([
    '午班(收針)',
    ...sortedEarlyTeams.map((name) =>
      formatPatientCell(statsData.early[name]?.noonShiftOff.patients),
    ),
  ])
  aoa.push(['照護人數', ...sortedEarlyTeams.map((name) => formatCountCell(statsData.early[name]))])

  aoa.push([]) // 分隔

  // --- 晚班 ---
  const sortedLateTeams = Object.keys(statsData.late).sort((a, b) => a.localeCompare(b))
  aoa.push(['晚班', ...sortedLateTeams.map((name) => name.replace('晚', '') + '組')])
  aoa.push(['姓名', ...sortedLateTeams.map((name) => names[name] || '-- 未指派 --')])
  aoa.push([
    '午班(收針)',
    ...sortedLateTeams.map((name) =>
      formatPatientCell(statsData.late[name]?.noonShiftOff.patients),
    ),
  ])
  aoa.push([
    '晚班',
    ...sortedLateTeams.map((name) => formatPatientCell(statsData.late[name]?.lateShift.patients)),
  ])
  aoa.push(['照護人數', ...sortedLateTeams.map((name) => formatCountCell(statsData.late[name]))])

  // --- 夜班收針 (如果存在) ---
  const lateTakeOffTeams = Object.keys(statsData.lateTakeOff).filter(
    (t) =>
      statsData.lateTakeOff[t].totalOpdCount +
        statsData.lateTakeOff[t].totalIpdCount +
        statsData.lateTakeOff[t].totalErCount >
      0,
  )
  if (lateTakeOffTeams.length > 0) {
    aoa.push([]) // 分隔
    const sortedTakeoffTeams = lateTakeOffTeams.sort((a, b) => a.localeCompare(b))
    aoa.push(['夜班收針', ...sortedTakeoffTeams.map((name) => name.replace('夜間收針', '') + '組')])
    aoa.push(['姓名', ...sortedTakeoffTeams.map((name) => names[name] || '-- 未指派 --')])
    aoa.push([
      '夜班收針',
      ...sortedTakeoffTeams.map((name) =>
        formatPatientCell(statsData.lateTakeOff[name]?.lateShiftTakeOff.patients),
      ),
    ])
    aoa.push([
      '照護人數',
      ...sortedTakeoffTeams.map((name) => formatCountCell(statsData.lateTakeOff[name])),
    ])
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const colWidths = [
    { wch: 12 },
    ...Array(Math.max(sortedEarlyTeams.length, sortedLateTeams.length)).fill({ wch: 25 }),
  ]
  ws['!cols'] = colWidths
  // ... (可以添加更多樣式設定) ...

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '護理分組表')
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })
}

// ===================================================================
// ✨ 每日自動資料備份 (Excel) v2.3 - 最終整合版
// ===================================================================
/**
 * 輔助函式：產生網格化「每日排程」的 Excel Buffer。
 * (邏輯移植自 ScheduleView.vue)
 * @param {FirebaseFirestore.DocumentSnapshot} scheduleDoc - Firestore 的 schedules 文件
 * @param {Map<string, object>} patientMap - 病人資料 Map
 * @param {string} dateStr - 日期字串 YYYY-MM-DD
 * @returns {Buffer | null} Excel 檔案的 Buffer 或 null
 */
function generateGridScheduleExcel(scheduleDoc, patientMap, dateStr) {
  if (!scheduleDoc.exists) return null
  const scheduleData = scheduleDoc.data().schedule || {}

  // 常數定義
  const ORDERED_SHIFT_CODES = ['early', 'noon', 'late']
  const SHIFT_DISPLAY_MAP = { early: '早班', noon: '午班', late: '晚班' }
  const STATUS_MAP = { opd: '門診', ipd: '住院', er: '急診' }
  const allBedNumbers = [
    32, 31, 33, 35, 36, 39, 38, 37, 51, 52, 53, 57, 56, 55, 58, 59, 61, 65, 63, 62, 29, 28, 27, 23,
    25, 26, 22, 21, 19, 16, 17, 18, 15, 13, 12, 8, 9, 11, 7, 6, 5, 1, 2, 3,
  ].sort((a, b) => a - b)
  const peripheralBedCount = 6

  const getCombinedNote = (slotData) => {
    if (!slotData) return ''
    const autoTags = (slotData.autoNote || '').split(' ').filter(Boolean)
    const manualTags = (slotData.manualNote || '').split(' ').filter(Boolean)
    return [...new Set([...autoTags, ...manualTags])]
      .filter((tag) => !['住', '急'].includes(tag))
      .join(' ')
  }

  const data = [['部立台北醫院 每日排程表'], ['日期:', dateStr], []]
  const headers = ['床號', SHIFT_DISPLAY_MAP.early, SHIFT_DISPLAY_MAP.noon, SHIFT_DISPLAY_MAP.late]
  data.push(headers)

  const allBedsToExport = [
    ...allBedNumbers,
    ...Array.from({ length: peripheralBedCount }, (_, i) => `外圍 ${i + 1}`),
  ]

  allBedsToExport.forEach((bedKey) => {
    const row = [bedKey]
    ORDERED_SHIFT_CODES.forEach((shiftCode) => {
      const bedNum = String(bedKey).replace('外圍 ', '')
      const shiftId = String(bedKey).startsWith('外圍')
        ? `peripheral-${bedNum}-${shiftCode}`
        : `bed-${bedNum}-${shiftCode}`
      const slot = scheduleData[shiftId]
      if (slot?.patientId && patientMap.has(slot.patientId)) {
        const patient = patientMap.get(slot.patientId)
        const cellText = `${patient?.name || '未知'} (${patient?.medicalRecordNumber || 'N/A'})\n[${STATUS_MAP[patient?.status] || '未知'}]\n${getCombinedNote(slot)}`
        row.push(cellText)
      } else {
        row.push('')
      }
    })
    data.push(row)
  })

  const worksheet = XLSX.utils.aoa_to_sheet(data)
  // 設定樣式 (與前台一致)
  worksheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
    { s: { r: 1, c: 1 }, e: { r: 1, c: 3 } },
  ]
  worksheet['!cols'] = [{ wch: 10 }, { wch: 30 }, { wch: 30 }, { wch: 30 }]
  if (!worksheet['!rows']) worksheet['!rows'] = []
  worksheet['!rows'][0] = { hpt: 25 }
  worksheet['!rows'][1] = { hpt: 20 }
  worksheet['!rows'][2] = { hpt: 10 }
  worksheet['!rows'][3] = { hpt: 20 }

  for (let i = 4; i < data.length; i++) {
    worksheet['!rows'][i] = { hpt: 55 }
    for (let j = 0; j < 4; j++) {
      const cellAddress = XLSX.utils.encode_cell({ r: i, c: j })
      if (worksheet[cellAddress]) {
        if (!worksheet[cellAddress].s) worksheet[cellAddress].s = {}
        worksheet[cellAddress].s.alignment = {
          vertical: 'center',
          horizontal: 'center',
          wrapText: true,
        }
      }
    }
  }

  const wb = XLSX.utils.book_new()
  // ✨✨✨【核心修正】將 ws 改為 worksheet ✨✨✨
  XLSX.utils.book_append_sheet(wb, worksheet, `排程 ${dateStr}`)
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })
}

/**
 * ✨✨✨【核心修正 v2.5】重寫床位總表備份函式，模擬 ScheduleTable.vue 佈局 ✨✨✨
 * @param {FirebaseFirestore.DocumentSnapshot} masterScheduleDoc - base_schedules 文件
 * @param {Map<string, object>} patientMap - 病人資料 Map
 * @param {string} dateStr - 匯出日期字串
 * @returns {Buffer | null}
 */
function generateGridMasterScheduleExcel(masterScheduleDoc, patientMap, dateStr) {
  if (!masterScheduleDoc.exists) return null
  const masterScheduleData = masterScheduleDoc.data().schedule || {}

  // 1. 從前台移植必要的常數
  const SHIFTS = ['early', 'noon', 'late'] // 班別代碼
  const SHIFT_DISPLAY_MAP = { early: '早班', noon: '午班', late: '晚班' }
  const WEEKDAYS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  const FREQ_MAP_TO_DAY_INDEX = {
    一三五: [0, 2, 4],
    二四六: [1, 3, 5],
    一四: [0, 3],
    二五: [1, 4],
    三六: [2, 5],
    一五: [0, 4],
    二六: [1, 5],
    每日: [0, 1, 2, 3, 4, 5],
    每周一: [0],
    每周二: [1],
    每周三: [2],
    每周四: [3],
    每周五: [4],
    每周六: [5],
  }
  const baseBedLayout = [
    1,
    2,
    3,
    5,
    6,
    7,
    8,
    9,
    11,
    12,
    13,
    15,
    16,
    17,
    18,
    19,
    21,
    22,
    23,
    25,
    26,
    27,
    28,
    29,
    31,
    32,
    33,
    35,
    36,
    37,
    38,
    39,
    51,
    52,
    53,
    55,
    56,
    57,
    58,
    59,
    61,
    62,
    63,
    65,
    ...Array.from({ length: 6 }, (_, i) => `peripheral-${i + 1}`),
  ].sort((a, b) => {
    const numA = typeof a === 'number' ? a : Infinity
    const numB = typeof b === 'number' ? b : Infinity
    if (numA !== Infinity || numB !== Infinity) return numA - numB
    return String(a).localeCompare(String(b))
  })

  // 2. 建立一個 `slotId -> patient` 的地圖，類似前台的 `weekScheduleMap`
  const weeklyScheduleMap = {}
  for (const patientId in masterScheduleData) {
    if (patientMap.has(patientId)) {
      const rule = masterScheduleData[patientId]
      if (rule?.freq) {
        const dayIndices = FREQ_MAP_TO_DAY_INDEX[rule.freq] || []
        dayIndices.forEach((dayIndex) => {
          const slotId = `${rule.bedNum}-${rule.shiftIndex}-${dayIndex}`
          weeklyScheduleMap[slotId] = { patientId, ...rule }
        })
      }
    }
  }

  // 3. 建立 Excel 資料陣列 (aoa)
  const data = [['部立台北醫院 透析排程總表 (固定規則)'], [`匯出日期: ${dateStr}`], []]
  const headers = ['床位', '班次', ...WEEKDAYS]
  data.push(headers)

  const merges = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: headers.length - 1 } },
  ]
  let currentRowIndex = 4 // 資料從第5行開始 (index 4)

  baseBedLayout.forEach((bedNum) => {
    const bedDisplayName = String(bedNum).startsWith('p')
      ? `外圍 ${String(bedNum).slice(-1)}`
      : `${bedNum}号床`

    // 設定床位儲存格的合併範圍
    merges.push({
      s: { r: currentRowIndex, c: 0 },
      e: { r: currentRowIndex + SHIFTS.length - 1, c: 0 },
    })

    SHIFTS.forEach((shiftCode, shiftIndex) => {
      const row = []
      if (shiftIndex === 0) {
        row.push(bedDisplayName) // 第一個班次才加入床位號
      } else {
        row.push('') // 其他班次留空，因為已經合併
      }
      row.push(SHIFT_DISPLAY_MAP[shiftCode]) // 加入班次名稱

      WEEKDAYS.forEach((_, dayIndex) => {
        const slotId = `${bedNum}-${shiftIndex}-${dayIndex}`
        const slotData = weeklyScheduleMap[slotId]
        if (slotData && patientMap.has(slotData.patientId)) {
          const patient = patientMap.get(slotData.patientId)
          const cellText = `${patient.name}\n(${patient.medicalRecordNumber})`
          row.push(cellText)
        } else {
          row.push('')
        }
      })
      data.push(row)
    })
    currentRowIndex += SHIFTS.length
  })

  const worksheet = XLSX.utils.aoa_to_sheet(data)
  worksheet['!merges'] = merges
  worksheet['!cols'] = [{ wch: 10 }, { wch: 8 }, ...Array(WEEKDAYS.length).fill({ wch: 20 })]

  // 設定樣式
  if (!worksheet['!rows']) worksheet['!rows'] = []
  worksheet['!rows'][0] = { hpt: 25 }
  worksheet['!rows'][1] = { hpt: 20 }
  worksheet['!rows'][3] = { hpt: 20 }
  for (let i = 4; i < data.length; i++) {
    worksheet['!rows'][i] = { hpt: 40 }
    for (let j = 0; j < headers.length; j++) {
      const cellAddress = XLSX.utils.encode_cell({ r: i, c: j })
      if (worksheet[cellAddress]) {
        if (!worksheet[cellAddress].s) worksheet[cellAddress].s = {}
        worksheet[cellAddress].s.alignment = {
          vertical: 'center',
          horizontal: 'center',
          wrapText: true,
        }
      }
    }
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, worksheet, '總床位表')
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })
}

exports.scheduledDataBackup = onSchedule(
  {
    schedule: '30 23 * * *',
    timeZone: 'Asia/Taipei',
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async (event) => {
    logger.info('[Backup-v2.4] Starting scheduled GRID Excel data backup to Google Drive...')

    try {
      const auth = await getGoogleAuthClient()
      const drive = google.drive({ version: 'v3', auth })

      const todayStr = getTaipeiTodayString()
      const tomorrowDate = new Date(todayStr + 'T00:00:00Z')
      tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1)
      const tomorrowStr = formatDateToYYYYMMDD(tomorrowDate)
      const [yearStr, monthStr] = todayStr.split('-')
      const targetPath = ['資料備份', `${yearStr} 年`, `${monthStr} 月`]

      const oldPreBackupScheduleName = `${todayStr}_Schedule_PREBACKUP.xlsx`
      const oldPreBackupAssignmentsName = `${todayStr}_Assignments_PREBACKUP.xlsx`

      let parentFolderId = SHARED_DRIVE_FOLDER_ID
      for (const folderName of targetPath) {
        parentFolderId = await findOrCreateFolder(drive, folderName, parentFolderId)
      }
      await findAndDeleteFile(drive, oldPreBackupScheduleName, parentFolderId)
      await findAndDeleteFile(drive, oldPreBackupAssignmentsName, parentFolderId)

      const [
        patientsSnapshot,
        todayScheduleDoc,
        tomorrowScheduleDoc,
        todayAssignmentsDoc,
        tomorrowAssignmentsDoc,
        masterScheduleDoc,
      ] = await Promise.all([
        db.collection('patients').get(),
        db.collection('schedules').doc(todayStr).get(),
        db.collection('schedules').doc(tomorrowStr).get(),
        db.collection('nurse_assignments').doc(todayStr).get(),
        db.collection('nurse_assignments').doc(tomorrowStr).get(),
        db.collection('base_schedules').doc('MASTER_SCHEDULE').get(),
      ])

      const patientMap = new Map(patientsSnapshot.docs.map((doc) => [doc.id, doc.data()]))
      const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

      // --- 備份「每日排程」 (使用新函式) ---
      const todayScheduleBuffer = generateGridScheduleExcel(todayScheduleDoc, patientMap, todayStr)
      if (todayScheduleBuffer) {
        await uploadBufferToDrive(
          drive,
          todayScheduleBuffer,
          `${todayStr}_Schedule.xlsx`,
          mimeType,
          targetPath,
        )
      }
      const tomorrowScheduleBuffer = generateGridScheduleExcel(
        tomorrowScheduleDoc,
        patientMap,
        tomorrowStr,
      )
      if (tomorrowScheduleBuffer) {
        await uploadBufferToDrive(
          drive,
          tomorrowScheduleBuffer,
          `${tomorrowStr}_Schedule_PREBACKUP.xlsx`,
          mimeType,
          targetPath,
        )
      }

      // --- 備份「護理分組」(邏輯不變) ---
      const processAndUploadAssignments = async (
        assignmentsDoc,
        scheduleDoc,
        dateStr,
        isPreBackup = false,
      ) => {
        if (!assignmentsDoc.exists || !scheduleDoc.exists) return
        const assignmentsData = assignmentsDoc.data()
        const scheduleData = scheduleDoc.data().schedule || {}
        const processedData = generateAssignmentsData(
          scheduleData,
          assignmentsData.teams || {},
          assignmentsData.names || {},
          patientMap,
        )
        const excelBuffer = generateAssignmentsExcelBuffer(
          processedData,
          assignmentsData.names || {},
        )
        if (excelBuffer) {
          const fileName = isPreBackup
            ? `${dateStr}_Assignments_PREBACKUP.xlsx`
            : `${dateStr}_Assignments.xlsx`
          await uploadBufferToDrive(drive, excelBuffer, fileName, mimeType, targetPath)
        }
      }
      await processAndUploadAssignments(todayAssignmentsDoc, todayScheduleDoc, todayStr, false)
      await processAndUploadAssignments(
        tomorrowAssignmentsDoc,
        tomorrowScheduleDoc,
        tomorrowStr,
        true,
      )

      // --- 備份「床位總表」 (使用全新重寫的函式) ---
      if (masterScheduleDoc.exists) {
        const masterScheduleBuffer = generateGridMasterScheduleExcel(
          masterScheduleDoc,
          patientMap,
          todayStr,
        )
        if (masterScheduleBuffer) {
          await uploadBufferToDrive(
            drive,
            masterScheduleBuffer,
            `${todayStr}_MasterSchedule.xlsx`,
            mimeType,
            targetPath,
          )
        }
      }

      logger.info('[Backup-v2.5] Scheduled GRID Excel data backup completed successfully.')
    } catch (error) {
      logger.error('[Backup-v2.5] Scheduled GRID Excel data backup failed:', error)
    }
  },
)

// ===================================================================
// 🔥🔥🔥【最終健壯版 v13.5】 - syncMasterScheduleToFuture 🔥🔥🔥
// 🔧 v13.5: 支援動態 autoNote 生成
// ===================================================================
exports.syncMasterScheduleToFuture = onDocumentWritten(
  {
    document: 'base_schedules/MASTER_SCHEDULE',
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async (event) => {
    logger.info('🚀 [AtomicSync-v13.5] 原子化同步流程啟動...')

    if (!event.data.after.exists) {
      logger.info('✅ [AtomicSync-v13.5] 總表文件被刪除，無需同步。')
      return null
    }

    const beforeRules = event.data.before?.data()?.schedule || {}
    const afterRules = event.data.after.data().schedule || {}
    if (JSON.stringify(beforeRules) === JSON.stringify(afterRules)) {
      logger.info('✅ [AtomicSync-v13.5] 總表資料無實質變更，跳過同步。')
      return null
    }

    try {
      const masterRules = afterRules

      // 🔥 v13.5: 查詢所有病人資料，用於動態生成 autoNote
      const patientsSnapshot = await db.collection('patients').where('isDeleted', '!=', true).get()
      const patientsMap = new Map()
      patientsSnapshot.forEach((doc) => {
        patientsMap.set(doc.id, doc.data())
      })
      logger.info(`  [AtomicSync-v13.5] Loaded ${patientsMap.size} patients for dynamic autoNote.`)

      // --- 階段一: 精準計算差異，並原子性更新/創建基礎排程 ---
      logger.info('  ➡️ [Sync Step 1/2] 開始計算差異並同步從明天起的 60 天基礎排程...')

      const allPatientIds = new Set([...Object.keys(beforeRules), ...Object.keys(afterRules)])

      // 🔥 修正：使用字串為基礎的日期計算，避免時區問題
      const todayStr = getTaipeiTodayString()
      const futureDates = Array.from({ length: 60 }, (_, i) => {
        const futureDate = new Date(todayStr + 'T00:00:00Z')
        futureDate.setUTCDate(futureDate.getUTCDate() + i + 1) // i+1 確保從明天開始
        return formatDateToYYYYMMDD(futureDate)
      })

      // 加入除錯 log
      logger.info(
        `  [Sync Step 1/2] Today: ${todayStr}, First future date: ${futureDates[0]}, Last: ${futureDates[59]}`,
      )

      const existingSchedules = new Map()
      for (let i = 0; i < futureDates.length; i += 30) {
        const chunk = futureDates.slice(i, i + 30)
        if (chunk.length > 0) {
          const snapshot = await db
            .collection('schedules')
            .where(FieldPath.documentId(), 'in', chunk)
            .get()
          snapshot.forEach((doc) => existingSchedules.set(doc.id, doc.data().schedule || {}))
        }
      }
      logger.info(
        `  [Sync Step 1/2] 已檢查未來 60 天排程，找到 ${existingSchedules.size} 份現有文件。`,
      )

      const syncBatch = db.batch()

      for (const dateStr of futureDates) {
        const targetDate = new Date(dateStr + 'T00:00:00Z')
        const dayIndex = getTaipeiDayIndex(targetDate)

        if (!existingSchedules.has(dateStr)) {
          logger.warn(`  [Sync Step 1/2] 警告：未來排程 ${dateStr} 不存在，將即時創建。`)
          // 🔥 v13.5: 傳遞 patientsMap 以動態生成 autoNote
          const newDailySchedule = generateDailyScheduleFromRules(masterRules, dateStr, patientsMap)

          const scheduleRef = db.collection('schedules').doc(dateStr)
          syncBatch.set(scheduleRef, {
            date: dateStr,
            schedule: newDailySchedule,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            syncMethod: 'engine_driven_sync_v13.5_recreate',
          })
          continue
        }

        const updates = {}
        allPatientIds.forEach((patientId) => {
          const ruleBefore = beforeRules[patientId]
          const ruleAfter = afterRules[patientId]
          const wasScheduled =
            ruleBefore && (FREQ_MAP_TO_DAY_INDEX[ruleBefore.freq] || []).includes(dayIndex)
          const isScheduled =
            ruleAfter && (FREQ_MAP_TO_DAY_INDEX[ruleAfter.freq] || []).includes(dayIndex)

          // 🔥 v13.5: 使用動態 autoNote 而非總表中的靜態值
          const { generateAutoNote } = require('./services/scheduleEngineService')
          const createSlotObject = (rule) => {
            if (!rule) return null
            const shiftCode = SHIFTS[rule.shiftIndex]
            if (!shiftCode) return null
            // 🔥 v13.5: 從 patientsMap 獲取病人資料，動態生成 autoNote
            const patient = patientsMap.get(patientId)
            const dynamicAutoNote = patient ? generateAutoNote(patient) : (rule.autoNote || '')
            return {
              patientId: patientId,
              patientName: rule.patientName || '',
              shiftId: shiftCode,
              autoNote: dynamicAutoNote,
              manualNote: rule.manualNote || '',
              baseRuleId: patientId,
            }
          }

          if (wasScheduled && !isScheduled) {
            const oldShiftCode = SHIFTS[ruleBefore.shiftIndex]
            if (ruleBefore.bedNum !== undefined && oldShiftCode) {
              const oldKey = getScheduleKey(ruleBefore.bedNum, oldShiftCode)
              updates[`schedule.${oldKey}`] = FieldValue.delete()
            }
          } else if (!wasScheduled && isScheduled) {
            const newSlot = createSlotObject(ruleAfter)
            if (newSlot && ruleAfter.bedNum !== undefined) {
              const newKey = getScheduleKey(ruleAfter.bedNum, newSlot.shiftId)
              updates[`schedule.${newKey}`] = newSlot
            }
          } else if (wasScheduled && isScheduled) {
            const oldShiftCode = SHIFTS[ruleBefore.shiftIndex]
            const newSlot = createSlotObject(ruleAfter)

            if (
              newSlot &&
              ruleBefore.bedNum !== undefined &&
              oldShiftCode &&
              ruleAfter.bedNum !== undefined
            ) {
              const oldKey = getScheduleKey(ruleBefore.bedNum, oldShiftCode)
              const newKey = getScheduleKey(ruleAfter.bedNum, newSlot.shiftId)
              if (oldKey !== newKey) {
                updates[`schedule.${oldKey}`] = FieldValue.delete()
              }
              updates[`schedule.${newKey}`] = newSlot
            }
          }
        })

        if (Object.keys(updates).length > 0) {
          updates.updatedAt = FieldValue.serverTimestamp()
          updates.syncMethod = 'engine_driven_sync_v13.5_atomic'
          const scheduleRef = db.collection('schedules').doc(dateStr)
          syncBatch.update(scheduleRef, updates)
        }
      }

      await syncBatch.commit()
      logger.info('  ✅ [Sync Step 1/2] 成功同步 60 天的基礎排程。')

      // --- 階段二: 找出受影響的日期並呼叫合併引擎 ---
      logger.info('  ➡️ [Sync Step 2/2] 開始計算需要合併調班的日期...')
      const exceptionsSnapshot = await db
        .collection('schedule_exceptions')
        .where('status', 'in', ['applied', 'conflict_requires_resolution'])
        .get()

      const datesToMerge = new Set()

      // 🔥 修正：使用一致的方式計算 tomorrow
      const tomorrowDate = new Date(todayStr + 'T00:00:00Z')
      tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1)
      const tomorrowStr = formatDateToYYYYMMDD(tomorrowDate)

      exceptionsSnapshot.forEach((doc) => {
        const ex = doc.data()
        const allDates = [ex.date, ex.startDate, ex.from?.sourceDate, ex.to?.goalDate].filter(
          Boolean,
        )
        if (ex.type === 'SUSPEND' && ex.startDate && ex.endDate) {
          const start = new Date(ex.startDate + 'T00:00:00Z')
          const end = new Date(ex.endDate + 'T00:00:00Z')
          for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
            allDates.push(formatDateToYYYYMMDD(new Date(d)))
          }
        }
        allDates.forEach((d) => {
          if (d && d >= tomorrowStr) {
            datesToMerge.add(d)
          }
        })
      })

      await mergeExceptionsIntoSchedules(datesToMerge, masterRules)

      logger.info('🎉 [AtomicSync-v13.4] 所有同步階段均已成功完成！')
    } catch (error) {
      logger.error('❌ [AtomicSync-v13.4] 原子化同步過程中發生嚴重錯誤:', error)
      throw error
    }
    return null
  },
)

// ===================================================================
// 🔥 即時調班處理 - 立即修改排程 (✨ 最終、最嚴謹的日期驗證版 ✨)
// ===================================================================
exports.handleNewExceptionRequest = onDocumentCreated(
  'schedule_exceptions/{exceptionId}',
  async (event) => {
    const exceptionDoc = event.data
    const exceptionData = exceptionDoc.data()
    const exceptionId = exceptionDoc.id

    const logPatientName =
      exceptionData.type === 'SWAP'
        ? `${exceptionData.patient1?.patientName} <=> ${exceptionData.patient2?.patientName}`
        : exceptionData.patientName

    logger.info(
      `🚀 [NewException] 新調班申請: ${exceptionId} (${exceptionData.type} - ${
        logPatientName || 'N/A'
      })`,
      { data: JSON.stringify(exceptionData) },
    )

    try {
      if (exceptionData.status !== 'pending') {
        logger.info(`[NewException] 調班 ${exceptionId} 狀態為 ${exceptionData.status}，跳過處理`)
        return null
      }

      // ✨✨✨ 核心修正 1: 開始 [時區感知日期守門員] ✨✨✨
      // 1. 獲取「台北時區」的今天日期字串
      const taipeiDateString = new Date()
        .toLocaleDateString('zh-TW', {
          timeZone: 'Asia/Taipei',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        })
        .replace(/\//g, '-')
      // 2. 根據此字串建立一個標準化的 Date 物件，代表台北今天的凌晨
      const todayInTaipei = new Date(taipeiDateString + 'T00:00:00Z')

      const parseDateString = (dateStr) => {
        if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
        return new Date(dateStr + 'T00:00:00Z') // 使用 UTC 避免時區問題
      }

      // 根據不同類型，找出這次申請「最早會影響的日期」
      let relevantStartDateStr
      switch (exceptionData.type) {
        case 'MOVE':
          const fromDate = parseDateString(exceptionData.from?.sourceDate)
          const toDate = parseDateString(exceptionData.to?.goalDate)
          if (fromDate < todayInTaipei || toDate < todayInTaipei) {
            throw new Error('無法為過去的日期建立「調班」申請。')
          }
          relevantStartDateStr = exceptionData.from?.sourceDate
          break
        case 'ADD_SESSION':
          relevantStartDateStr = exceptionData.to?.goalDate
          break
        case 'SWAP':
          relevantStartDateStr = exceptionData.date
          break
        case 'SUSPEND':
        case 'RANGE_MOVE':
        default:
          relevantStartDateStr = exceptionData.startDate
          break
      }

      if (!relevantStartDateStr) {
        throw new Error('調班資料缺少必要的起始日期欄位 (startDate/sourceDate/goalDate/date)。')
      }

      const relevantStartDate = parseDateString(relevantStartDateStr)
      if (!relevantStartDate || isNaN(relevantStartDate.getTime())) {
        throw new Error(`調班起始日期格式無效: ${relevantStartDateStr}`)
      }

      // 最終的核心檢查：如果最早影響日期在台北今天之前，則拒絕操作
      if (relevantStartDate < todayInTaipei) {
        throw new Error('無法為過去的日期建立或執行此調班申請。')
      }
      // ✨✨✨ 核心修正 1: 結束 ✨✨✨

      await exceptionDoc.ref.update({
        status: 'processing',
        processingStarted: FieldValue.serverTimestamp(),
      })

      let processedDates = []
      let conflicts = []

      // ===== 處理 MOVE 類型 =====
      if (exceptionData.type === 'MOVE') {
        const { from, to, patientId, patientName } = exceptionData
        if (
          !patientId ||
          !from?.sourceDate ||
          !from?.bedNum ||
          !from?.shiftCode ||
          !to?.goalDate ||
          !to?.bedNum ||
          !to?.shiftCode
        ) {
          throw new Error('MOVE 調班資料不完整：缺少來源或目標資訊')
        }

        await db.runTransaction(async (transaction) => {
          // 情況 1: 同日移動 (sourceDate 與 goalDate 相同)
          if (from.sourceDate === to.goalDate) {
            logger.info(`  └─ 執行同日移動: ${from.sourceDate}`)
            const scheduleRef = db.collection('schedules').doc(from.sourceDate)
            const scheduleDoc = await transaction.get(scheduleRef)

            if (!scheduleDoc.exists) {
              throw new Error(`MOVE 失敗：找不到來源日期 ${from.sourceDate} 的排班表`)
            }

            const schedule = scheduleDoc.data().schedule || {}
            const sourceKey = getScheduleKey(from.bedNum, from.shiftCode)
            const targetKey = getScheduleKey(to.bedNum, to.shiftCode)

            // 步驟 A: 驗證並刪除來源位置
            if (schedule[sourceKey]?.patientId === patientId) {
              delete schedule[sourceKey]
              logger.info(`  └─ 移除 ${patientName} 從 ${from.sourceDate} ${sourceKey}`)
            } else {
              logger.warn(`  └─ 警告：原位置 ${sourceKey} 的病人不是 ${patientName}，不執行移除。`)
            }

            // 步驟 B: 檢查衝突並新增到目標位置
            const newSlotData = {
              patientId: patientId,
              patientName: patientName,
              shiftId: to.shiftCode,
              manualNote: `(換班)`,
              exceptionId: exceptionId,
              appliedAt: FieldValue.serverTimestamp(),
            }

            // ✨ 修改：檢查目標位置是否有調班
            if (schedule[targetKey]) {
              const occupant = schedule[targetKey]

              // 如果是調班 vs 調班，標記為衝突
              if (occupant.exceptionId) {
                await exceptionDoc.ref.update({
                  status: 'conflict_requires_resolution',
                  errorMessage: `目標床位已被 ${occupant.patientName} 的調班佔用，請選擇其他床位`,
                  conflictDetectedAt: FieldValue.serverTimestamp(),
                })
                logger.error(`❌ 系統異常：調班衝突不應該發生 - ${targetKey} 已被調班佔用`)
                return // 提早結束，不套用調班
              }

              // 如果是一般排程，記錄衝突但仍覆蓋（理論上不應該發生）
              conflicts.push({
                date: to.goalDate,
                position: targetKey,
                occupiedBy: occupant.patientName || occupant.patientId,
              })
              logger.warn(`  └─ 異常衝突：${targetKey} 被 ${occupant.patientName} 佔用，將覆蓋`)
              newSlotData.manualNote = `(換班-覆蓋)`
            }

            schedule[targetKey] = newSlotData
            logger.info(`  └─ 新增 ${patientName} 到 ${to.goalDate} ${targetKey}`)

            // 步驟 C: 執行一次性的更新
            transaction.update(scheduleRef, {
              schedule: schedule,
              lastModified: FieldValue.serverTimestamp(),
              modifiedBy: 'exception_handler',
            })
            processedDates = [from.sourceDate]

            // 情況 2: 跨日移動 (sourceDate 與 goalDate 不同)
          } else {
            logger.info(`  └─ 執行跨日移動: 從 ${from.sourceDate} 到 ${to.goalDate}`)
            const sourceScheduleRef = db.collection('schedules').doc(from.sourceDate)
            const targetScheduleRef = db.collection('schedules').doc(to.goalDate)
            const [sourceDoc, targetDoc] = await Promise.all([
              transaction.get(sourceScheduleRef),
              transaction.get(targetScheduleRef),
            ])

            // 刪除來源
            if (sourceDoc.exists) {
              const sourceKey = getScheduleKey(from.bedNum, from.shiftCode)
              const sourceSchedule = sourceDoc.data().schedule || {}
              if (sourceSchedule[sourceKey]?.patientId === patientId) {
                delete sourceSchedule[sourceKey]
                transaction.update(sourceScheduleRef, {
                  schedule: sourceSchedule,
                  lastModified: FieldValue.serverTimestamp(),
                  modifiedBy: 'exception_handler',
                })
                logger.info(`  └─ 移除 ${patientName} 從 ${from.sourceDate} ${sourceKey}`)
              } else {
                logger.warn(
                  `  └─ 警告：原位置 ${sourceKey} 的病人不是 ${patientName}，不執行移除。`,
                )
              }
            }

            // 新增到目標
            const targetKey = getScheduleKey(to.bedNum, to.shiftCode)
            const newSlotData = {
              patientId: patientId,
              patientName: patientName,
              shiftId: to.shiftCode,
              manualNote: `(換班)`,
              exceptionId: exceptionId,
              appliedAt: FieldValue.serverTimestamp(),
            }
            const targetSchedule = targetDoc.exists ? targetDoc.data().schedule || {} : {}

            // ✨ 修改：檢查目標位置是否有調班
            if (targetSchedule[targetKey]) {
              const occupant = targetSchedule[targetKey]

              // 如果是調班 vs 調班，標記為衝突
              if (occupant.exceptionId) {
                await exceptionDoc.ref.update({
                  status: 'conflict_requires_resolution',
                  errorMessage: `目標床位已被 ${occupant.patientName} 的調班佔用，請選擇其他床位`,
                  conflictDetectedAt: FieldValue.serverTimestamp(),
                })
                logger.error(`❌ 系統異常：調班衝突不應該發生 - ${targetKey} 已被調班佔用`)
                return // 提早結束，不套用調班
              }

              // 如果是一般排程，記錄衝突但仍覆蓋（理論上不應該發生）
              conflicts.push({
                date: to.goalDate,
                position: targetKey,
                occupiedBy: occupant.patientName || occupant.patientId,
              })
              logger.warn(`  └─ 異常衝突：${targetKey} 被 ${occupant.patientName} 佔用，將覆蓋`)
              newSlotData.manualNote = `(換班-覆蓋)`
            }

            targetSchedule[targetKey] = newSlotData

            if (targetDoc.exists) {
              transaction.update(targetScheduleRef, {
                schedule: targetSchedule,
                lastModified: FieldValue.serverTimestamp(),
                modifiedBy: 'exception_handler',
              })
            } else {
              transaction.set(targetScheduleRef, {
                date: to.goalDate,
                schedule: targetSchedule,
                createdAt: FieldValue.serverTimestamp(),
                lastModified: FieldValue.serverTimestamp(),
                modifiedBy: 'exception_handler',
              })
            }
            logger.info(`  └─ 新增 ${patientName} 到 ${to.goalDate} ${targetKey}`)
            processedDates = [from.sourceDate, to.goalDate]
          }
        })
      }

      // ===== 處理 SUSPEND 類型 =====
      else if (exceptionData.type === 'SUSPEND') {
        const { patientId, patientName, startDate, endDate } = exceptionData
        if (!patientId || !startDate || !endDate) {
          throw new Error('SUSPEND 調班資料不完整：缺少 patientId 或日期區間')
        }
        const start = new Date(startDate + 'T00:00:00Z')
        const end = new Date(endDate + 'T00:00:00Z')
        const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1
        logger.info(`  └─ 暫停 ${patientName} 從 ${startDate} 到 ${endDate} (${days} 天)`)
        const BATCH_SIZE = 450
        let batch = db.batch()
        let operationCount = 0
        let removedCount = 0
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          // ✨✨✨【核心修正】✨✨✨
          // 使用 dateUtils 中正確的函式來格式化日期
          const dateStr = formatDateToYYYYMMDD(new Date(d))

          processedDates.push(dateStr)
          const scheduleRef = db.collection('schedules').doc(dateStr)
          const scheduleDoc = await scheduleRef.get()
          if (scheduleDoc.exists) {
            const scheduleData = scheduleDoc.data().schedule || {}
            let updateNeeded = false
            const updates = {
              lastModified: FieldValue.serverTimestamp(),
              modifiedBy: 'exception_handler',
            }
            for (const key in scheduleData) {
              if (scheduleData[key].patientId === patientId) {
                updates[`schedule.${key}`] = FieldValue.delete()
                updateNeeded = true
                removedCount++
                logger.info(`    └─ 移除 ${dateStr} 的 ${key}`)
                break
              }
            }
            if (updateNeeded) {
              batch.update(scheduleRef, updates)
              operationCount++
              if (operationCount >= BATCH_SIZE) {
                await batch.commit()
                logger.info(`  └─ 批次提交：已處理 ${operationCount} 個操作`)
                batch = db.batch()
                operationCount = 0
              }
            }
          }
        }
        if (operationCount > 0) {
          await batch.commit()
          logger.info(`  └─ 最終批次提交：處理了 ${operationCount} 個操作`)
        }
        logger.info(`  └─ 完成暫停：共移除 ${removedCount} 個排班`)
      }

      // ===== 處理 ADD_SESSION 類型 =====
      else if (exceptionData.type === 'ADD_SESSION') {
        const { to, patientId, patientName } = exceptionData
        if (!patientId || !to?.goalDate || !to?.bedNum || !to?.shiftCode) {
          throw new Error('ADD_SESSION 調班資料不完整：缺少 patientId 或目標資訊')
        }
        const targetDate = to.goalDate
        const scheduleRef = db.collection('schedules').doc(targetDate)
        const targetKey = getScheduleKey(to.bedNum, to.shiftCode)

        await db.runTransaction(async (transaction) => {
          const scheduleDoc = await transaction.get(scheduleRef)
          const newSlotData = {
            patientId: patientId,
            patientName: patientName,
            shiftId: to.shiftCode,
            manualNote: exceptionData.mode && exceptionData.mode !== 'HD'
              ? `(臨時加洗-${exceptionData.mode})`
              : `(臨時加洗)`,
            exceptionId: exceptionId,
            appliedAt: FieldValue.serverTimestamp(),
          }
          // 如果有指定不同透析模式，記錄到 slot
          if (exceptionData.mode) {
            newSlotData.modeOverride = exceptionData.mode
          }
          const scheduleData = scheduleDoc.exists ? scheduleDoc.data().schedule || {} : {}

          // ✨ 修改：檢查目標位置是否有調班
          if (scheduleData[targetKey]) {
            const occupant = scheduleData[targetKey]

            // 如果是調班 vs 調班，標記為衝突
            if (occupant.exceptionId) {
              await exceptionDoc.ref.update({
                status: 'conflict_requires_resolution',
                errorMessage: `目標床位已被 ${occupant.patientName} 的調班佔用，請選擇其他床位`,
                conflictDetectedAt: FieldValue.serverTimestamp(),
              })
              logger.error(`❌ 系統異常：臨時加洗衝突不應該發生 - ${targetKey} 已被調班佔用`)
              return // 提早結束，不套用調班
            }

            // 如果是一般排程，記錄衝突但仍覆蓋（理論上不應該發生）
            conflicts.push({
              date: targetDate,
              position: targetKey,
              occupiedBy: occupant.patientName || occupant.patientId,
              action: 'override',
            })
            logger.warn(`  └─ 異常衝突：${targetKey} 被 ${occupant.patientName} 佔用，將覆蓋`)
            newSlotData.manualNote = `(臨時加洗-覆蓋)`
          }

          scheduleData[targetKey] = newSlotData

          if (scheduleDoc.exists) {
            transaction.update(scheduleRef, {
              schedule: scheduleData,
              lastModified: FieldValue.serverTimestamp(),
              modifiedBy: 'exception_handler',
            })
          } else {
            transaction.set(scheduleRef, {
              date: targetDate,
              schedule: scheduleData,
              createdAt: FieldValue.serverTimestamp(),
              lastModified: FieldValue.serverTimestamp(),
              modifiedBy: 'exception_handler',
            })
          }
        })
        logger.info(`  └─ 新增 ${patientName} 到 ${targetDate} ${targetKey}`)
        processedDates = [targetDate]
      }

      // ===== 處理 SWAP 類型 =====
      else if (exceptionData.type === 'SWAP') {
        const { date, patient1, patient2 } = exceptionData
        if (
          !date ||
          !patient1 ||
          !patient2 ||
          !patient1.patientId ||
          !patient1.fromBedNum ||
          !patient1.fromShiftCode ||
          !patient2.patientId ||
          !patient2.fromBedNum ||
          !patient2.fromShiftCode
        ) {
          throw new Error(
            'SWAP 調班資料不完整：缺少日期或完整的 patient1/patient2 物件及其內部欄位',
          )
        }
        const scheduleRef = db.collection('schedules').doc(date)
        const key1 = getScheduleKey(patient1.fromBedNum, patient1.fromShiftCode)
        const key2 = getScheduleKey(patient2.fromBedNum, patient2.fromShiftCode)
        await db.runTransaction(async (transaction) => {
          const scheduleDoc = await transaction.get(scheduleRef)
          if (!scheduleDoc.exists) {
            throw new Error(`SWAP 失敗：找不到日期 ${date} 的排班表`)
          }
          const scheduleData = scheduleDoc.data().schedule || {}
          if (scheduleData[key1]?.patientId !== patient1.patientId) {
            throw new Error(`SWAP 驗證失敗：${patient1.patientName} 不在預期的位置 ${key1}`)
          }
          if (scheduleData[key2]?.patientId !== patient2.patientId) {
            throw new Error(`SWAP 驗證失敗：${patient2.patientName} 不在預期的位置 ${key2}`)
          }
          const slot1Data = { ...scheduleData[key1] }
          const slot2Data = { ...scheduleData[key2] }
          transaction.update(scheduleRef, {
            [`schedule.${key1}`]: {
              ...slot2Data,
              manualNote: `(與${patient1.patientName}互調)`,
              exceptionId: exceptionId,
            },
            [`schedule.${key2}`]: {
              ...slot1Data,
              manualNote: `(與${patient2.patientName}互調)`,
              exceptionId: exceptionId,
            },
            lastModified: FieldValue.serverTimestamp(),
            modifiedBy: 'exception_handler',
          })
        })
        logger.info(
          `  └─ 成功交換 ${patient1.patientName} (${key1}) 與 ${patient2.patientName} (${key2})`,
        )
        processedDates = [date]
      }

      // ===== 更新調班狀態為已套用 =====
      let relevantEndDateStr
      if (exceptionData.endDate) {
        relevantEndDateStr = exceptionData.endDate
      } else if (exceptionData.type === 'MOVE') {
        relevantEndDateStr =
          exceptionData.to?.goalDate > exceptionData.from?.sourceDate
            ? exceptionData.to.goalDate
            : exceptionData.from.sourceDate
      } else if (exceptionData.type === 'ADD_SESSION') {
        relevantEndDateStr = exceptionData.to?.goalDate
      } else if (exceptionData.type === 'SWAP') {
        relevantEndDateStr = exceptionData.date
      } else {
        relevantEndDateStr = exceptionData.startDate
      }

      let expireAt = null
      if (relevantEndDateStr) {
        const endDate = new Date(relevantEndDateStr)
        endDate.setMonth(endDate.getMonth() + 1)
        expireAt = endDate
        logger.info(
          `[NewException] Calculated expireAt for ${exceptionId}: ${expireAt.toISOString()}`,
        )
      } else {
        const now = new Date()
        now.setMonth(now.getMonth() + 1)
        expireAt = now
        logger.warn(
          `[NewException] Could not determine endDate for ${exceptionId}. Setting default expireAt.`,
        )
      }

      const updateData = {
        status: 'applied',
        appliedAt: FieldValue.serverTimestamp(),
        processedDates: processedDates,
        conflicts: conflicts.length > 0 ? conflicts : null,
        conflictCount: conflicts.length,
        applyMethod: 'realtime',
        expireAt: expireAt,
      }
      await exceptionDoc.ref.update(updateData)

      // ===== 記錄操作日誌 =====
      await db.collection('exception_logs').add({
        exceptionId: exceptionId,
        type: exceptionData.type,
        patientId: exceptionData.patientId,
        patientName: exceptionData.patientName,
        action: 'applied',
        timestamp: FieldValue.serverTimestamp(),
        details: exceptionData,
        success: true,
      })

      if (conflicts.length > 0) {
        logger.warn(
          `✅ [NewException] 調班 ${exceptionId} 已套用（有 ${conflicts.length} 個衝突被覆蓋）`,
        )
      } else {
        logger.info(`✅ [NewException] 調班 ${exceptionId} 已成功套用`)
      }
    } catch (error) {
      logger.error(`❌ [NewException] 處理調班 ${exceptionId} 失敗:`, error)
      await exceptionDoc.ref.update({
        status: 'error',
        errorMessage: error.message,
        errorAt: FieldValue.serverTimestamp(),
      })
      await db.collection('exception_logs').add({
        exceptionId: exceptionId,
        type: exceptionData.type,
        patientId: exceptionData.patientId,
        patientName: exceptionData.patientName,
        action: 'error',
        timestamp: FieldValue.serverTimestamp(),
        error: { message: error.message, stack: error.stack },
        success: false,
      })
      throw error
    }
    return null
  },
)

// ===================================================================
// 🔥🔥🔥【最終修正版 v6.3】 - onExceptionDeleted (使用統一日期函式) 🔥🔥🔥
// 職責：當調班被撤銷時，先獲取最新的總表規則，然後呼叫核心引擎來
//       為所有【未來或當天】受影響的日期進行徹底的、正確的重建。
// ===================================================================
exports.onExceptionDeleted = onDocumentDeleted(
  'schedule_exceptions/{exceptionId}',
  async (event) => {
    const deletedException = event.data.data()
    const exceptionId = event.params.exceptionId

    // --- 🔥 核心修正: 直接從 dateUtils 獲取台北時區今天的日期字串 ---
    const todayStr = getTaipeiTodayString()

    logger.info(
      `🚀 [RebuildOnDelete-v6.3] 偵測到調班撤銷: ${exceptionId}，觸發排程重建... (基準日: ${todayStr})`,
    )

    if (!deletedException || !deletedException.type) {
      logger.error(`❌ [RebuildOnDelete-v6.3] 失敗：被刪除的調班資料不完整`)
      return
    }

    try {
      // --- 步驟 2: 獲取總表規則 ---
      const masterDoc = await db.collection('base_schedules').doc('MASTER_SCHEDULE').get()
      const masterRules = masterDoc.exists ? masterDoc.data().schedule || {} : {}
      logger.info(`[RebuildOnDelete-v6.3] 已成功獲取最新的總表規則。`)

      // --- 步驟 3: 找出所有受影響的日期 ---
      const datesToRebuild = new Set()
      if (
        deletedException.type === 'SUSPEND' &&
        deletedException.startDate &&
        deletedException.endDate
      ) {
        const start = new Date(deletedException.startDate + 'T00:00:00Z')
        const end = new Date(deletedException.endDate + 'T00:00:00Z')
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          // <-- 確認這裡也使用統一的格式化函式
          datesToRebuild.add(formatDateToYYYYMMDD(new Date(d)))
        }
      } else {
        const exDates = [
          deletedException.date,
          deletedException.startDate,
          deletedException.from?.sourceDate,
          deletedException.to?.goalDate,
        ].filter(Boolean)
        exDates.forEach((d) => datesToRebuild.add(d))
      }

      const allDateStrings = Array.from(datesToRebuild)
      if (allDateStrings.length === 0) {
        logger.info('[RebuildOnDelete-v6.3] 該撤銷操作無需重建任何日期。')
        return
      }
      logger.info(`[RebuildOnDelete-v6.3] 原始受影響日期: [${allDateStrings.join(', ')}]`)

      // --- 步驟 4: 過濾掉過去的日期，只處理未來或當天的排程 ---
      const futureDateStrings = allDateStrings.filter((dateStr) => {
        return dateStr >= todayStr
      })

      if (futureDateStrings.length === 0) {
        logger.info('[RebuildOnDelete-v6.3] 所有受影響的日期皆為過去，無需執行重建。')
        return
      }

      logger.info(
        `[RebuildOnDelete-v6.3] 過濾後，將對 ${futureDateStrings.length} 個未來或當天日期 [${futureDateStrings.join(', ')}] 執行徹底重建...`,
      )

      // --- 步驟 5: 呼叫重建引擎 ---
      const rebuildPromises = futureDateStrings.map((dateStr) =>
        rebuildSingleDaySchedule(dateStr, masterRules),
      )
      const rebuiltSchedules = await Promise.all(rebuildPromises)

      // --- 步驟 6: 批次寫入資料庫 ---
      const batch = db.batch()
      rebuiltSchedules.forEach((schedule, index) => {
        const dateStr = futureDateStrings[index]
        if (schedule) {
          const scheduleRef = db.collection('schedules').doc(dateStr)
          batch.set(scheduleRef, {
            date: dateStr,
            schedule: schedule,
            updatedAt: FieldValue.serverTimestamp(),
            syncMethod: 'rebuild_on_delete_v6.3', // <-- 版本號更新
          })
        }
      })

      await batch.commit()

      logger.info(
        `✅ [RebuildOnDelete-v6.3] 成功完成 ${futureDateStrings.length} 個日期的重建任務。`,
      )
    } catch (error) {
      logger.error(`❌ [RebuildOnDelete-v6.3] 處理調班 ${exceptionId} 的撤銷時發生嚴重錯誤:`, error)
    }
  },
)

// ===================================================================
// 處理調班任務（舊系統備用 - 保留以防需要）
// ===================================================================
exports.processExceptionTask = onDocumentCreated('exception_tasks/{taskId}', async (event) => {
  const taskDoc = event.data
  if (!taskDoc) {
    logger.warn('Event data is missing, exiting function.')
    return
  }
  const taskData = taskDoc.data()
  const taskId = taskDoc.id
  const parentExceptionRef = db.collection('schedule_exceptions').doc(taskData.parentExceptionId)

  logger.info(
    `👷 [ExceptionWorker-Legacy] 開始處理任務: ${taskId} (來自申請 ${taskData.parentExceptionId})`,
  )

  if (taskData.status !== 'pending') {
    logger.info(`任務 ${taskId} 狀態為 "${taskData.status}"，非 "pending"，不予處理。`)
    return
  }

  await taskDoc.ref.update({ status: 'processing' })

  try {
    await db.runTransaction(async (transaction) => {
      if (taskData.type === 'MOVE') {
        const { from, to, patientId, patientName, targetDate } = taskData
        const sourceScheduleRef = db.collection('schedules').doc(from.sourceDate)
        const sourceScheduleKey = getScheduleKey(from.bedNum, from.shiftCode)
        transaction.update(sourceScheduleRef, {
          [`schedule.${sourceScheduleKey}`]: FieldValue.delete(),
        })

        const targetScheduleRef = db.collection('schedules').doc(targetDate)
        const targetScheduleKey = getScheduleKey(to.bedNum, to.shiftCode)
        const newSlotData = {
          patientId,
          patientName,
          shiftId: to.shiftCode,
          manualNote: `(換班)`,
        }

        transaction.set(
          targetScheduleRef,
          { schedule: { [targetScheduleKey]: newSlotData } },
          { merge: true },
        )
      } else if (taskData.type === 'SUSPEND') {
        const { targetDate, patientId } = taskData
        const scheduleRef = db.collection('schedules').doc(targetDate)
        const scheduleDoc = await transaction.get(scheduleRef)

        if (!scheduleDoc.exists) {
          logger.warn(`[SUSPEND] 日期 ${targetDate} 的排班表不存在，跳過此任務。`)
          return
        }

        const scheduleData = scheduleDoc.data().schedule || {}
        for (const key in scheduleData) {
          if (scheduleData[key].patientId === patientId) {
            transaction.update(scheduleRef, { [`schedule.${key}`]: FieldValue.delete() })
            break
          }
        }
      }
    })

    await taskDoc.ref.update({ status: 'completed', completedAt: FieldValue.serverTimestamp() })
    const siblingTasksQuery = db
      .collection('exception_tasks')
      .where('parentExceptionId', '==', taskData.parentExceptionId)
      .where('status', 'in', ['pending', 'processing'])

    const pendingSiblings = await siblingTasksQuery.get()
    if (pendingSiblings.empty) {
      await parentExceptionRef.update({
        status: 'applied',
        appliedAt: FieldValue.serverTimestamp(),
      })
    }

    logger.info(`✅ [ExceptionWorker-Legacy] 任務 ${taskId} 處理完成`)
  } catch (error) {
    logger.error(`❌ [ExceptionWorker-Legacy] 處理任務 ${taskId} 失敗:`, error)
    await taskDoc.ref.update({ status: 'error', errorMessage: error.message })
    await parentExceptionRef.update({
      status: 'error',
      errorMessage: `任務 ${taskId} 執行失敗: ${error.message}`,
    })
  }
})

// ===================================================================
// Lab Report Functions (檢驗報告相關函式)
// ===================================================================
exports.processLabReport = onCall(
  { cors: allowedOrigins, timeoutSeconds: 300, memory: '1GiB' },
  async (request) => {
    const allowedRoles = ['admin', 'editor', 'contributor', 'viewer']
    if (!request.auth || !allowedRoles.includes(request.auth.token.role)) {
      throw new HttpsError('permission-denied', '您沒有權限執行此操作。')
    }
    const { fileName, fileContent } = request.data
    if (!fileName || !fileContent) {
      throw new HttpsError('invalid-argument', '請求中缺少檔案名稱或內容。')
    }
    logger.info(`接收到檔案 ${fileName}，開始解析...`)
    try {
      const buffer = Buffer.from(fileContent, 'base64')
      const workbook = XLSX.read(buffer, { type: 'buffer' })
      const sheetName = workbook.SheetNames[0]
      const worksheet = workbook.Sheets[sheetName]
      const sheetAsArray = XLSX.utils.sheet_to_json(worksheet, { header: 1 })
      if (sheetAsArray.length < 2) {
        throw new HttpsError('invalid-argument', 'Excel 檔案內容行數不足。')
      }
      let headerRowIndex = -1
      let headers = []
      for (let i = 0; i < sheetAsArray.length; i++) {
        const row = sheetAsArray[i]
        if (row.includes('病歷號') && row.includes('細項名稱')) {
          headerRowIndex = i
          headers = row
          break
        }
      }
      if (headerRowIndex === -1) {
        throw new HttpsError(
          'invalid-argument',
          "找不到有效的標題行 (需包含 '病歷號' 和 '細項名稱')。",
        )
      }
      const dataRows = sheetAsArray.slice(headerRowIndex + 1)
      const headerToIndex = {}
      headers.forEach((header, index) => {
        if (header) headerToIndex[String(header).trim()] = index
      })
      const labItemMapping = {
        白血球: 'WBC',
        紅血球: 'RBC',
        血色素: 'Hb',
        血球容積比: 'Hct',
        平均紅血球容積: 'MCV',
        平均紅血球血紅素量: 'MCH',
        平均紅血球血紅素濃度: 'MCHC',
        血小板: 'Platelet',
        '總膽固醇(血)': 'Cholesterol',
        'BUN(Blood)': 'BUN',
        '三酸甘油酯(血)': 'Triglyceride',
        飯前血糖: 'GlucoseAC',
        'Calcium(Blood)': 'Ca',
        磷: 'P',
        'Uric Acid (B)': 'UricAcid',
        eGFR: 'eGFR',
        '肌酐、血(洗腎專用)': 'Creatinine',
        血中鈉: 'Na',
        血中鉀: 'K',
        總鐵結合能力TIBC: 'TIBC',
        Iron: 'Iron',
        '白蛋白(BCG法)': 'Albumin',
        '總蛋白(血)': 'TotalProtein',
        高密度脂蛋白: 'HDL',
        低密度脂蛋白: 'LDL',
        副甲狀腺素: 'iPTH',
        '血中尿素氮(洗後專用)': 'PostBUN',
        鐵蛋白: 'Ferritin',
        丙胺酸轉胺酶: 'ALT',
        // ✨ 您可以根據新的 Excel 內容，在這裡增加更多對應項目
      }
      const reports = new Map()
      let errors = []
      const patientCache = new Map()
      for (const rowArray of dataRows) {
        let medicalRecordNumber = String(rowArray[headerToIndex['病歷號']] || '').trim()
        if (medicalRecordNumber) {
          medicalRecordNumber = medicalRecordNumber.replace(/^0+/, '')
        }

        // ✨ ===================== 核心修正點在這裡 ===================== ✨
        // 1. 讀取原始的、可能包含時分秒的日期字串
        let originalReportDateStr = String(rowArray[headerToIndex['報告日']] || '').trim()

        // 2. 標準化日期：只取前 8 位 (YYYYMMDD)，忽略後面的時分秒
        const reportDateStr = originalReportDateStr.substring(0, 8)
        // ✨ ========================================================== ✨

        const labItemName = String(rowArray[headerToIndex['細項名稱']] || '').trim()
        const labResult = rowArray[headerToIndex['結果']]
        if (
          !medicalRecordNumber ||
          !reportDateStr || // 使用標準化後的日期字串做判斷
          !labItemName ||
          labResult === undefined ||
          labResult === null
        ) {
          if (
            rowArray.every(
              (cell) => cell === null || cell === undefined || String(cell).trim() === '',
            )
          )
            continue
          errors.push({
            rowData: JSON.stringify(rowArray),
            reason: '該行缺少 病歷號/報告日/細項名稱/結果',
          })
          continue
        }

        // 使用標準化後的 reportDateStr 來建立 key，確保同一天的資料能聚合
        const reportKey = `${medicalRecordNumber}_${reportDateStr}`

        if (!reports.has(reportKey)) {
          let patientDoc
          if (patientCache.has(medicalRecordNumber)) {
            patientDoc = patientCache.get(medicalRecordNumber)
          } else {
            const patientQuery = await db
              .collection('patients')
              .where('medicalRecordNumber', '==', medicalRecordNumber)
              .limit(1)
              .get()
            if (patientQuery.empty) {
              patientCache.set(medicalRecordNumber, null)
            } else {
              patientDoc = patientQuery.docs[0]
              patientCache.set(medicalRecordNumber, patientDoc)
            }
          }
          if (!patientDoc) {
            errors.push({ rowData: `病歷號: ${medicalRecordNumber}`, reason: `找不到對應的病人` })
            continue
          }

          // 解析日期時，同樣使用標準化後的 reportDateStr
          const year = reportDateStr.substring(0, 4)
          const month = reportDateStr.substring(4, 6)
          const day = reportDateStr.substring(6, 8)
          let parsedDate = new Date(`${year}-${month}-${day}`)
          if (isNaN(parsedDate.getTime())) {
            parsedDate = new Date()
          }
          reports.set(reportKey, {
            patientId: patientDoc.id,
            patientName: patientDoc.data().name,
            medicalRecordNumber: patientDoc.data().medicalRecordNumber,
            reportDate: parsedDate,
            sourceFile: fileName,
            createdAt: FieldValue.serverTimestamp(),
            data: {},
          })
        }
        const report = reports.get(reportKey)
        if (report) {
          const dbField = labItemMapping[labItemName]
          if (dbField) {
            const value = parseFloat(labResult)
            report.data[dbField] = isNaN(value) ? String(labResult) : value
          }
        }
      }
      if (reports.size > 0) {
        const batch = db.batch()
        for (const reportData of reports.values()) {
          const newReportRef = db.collection('lab_reports').doc()
          batch.set(newReportRef, reportData)
        }
        await batch.commit()
      }
      return {
        success: true,
        message: `處理完成！成功聚合並匯入 ${reports.size} 份報告，發現 ${errors.length} 個問題行。`,
        processedCount: reports.size,
        errorCount: errors.length,
        errors: errors.slice(0, 50),
      }
    } catch (error) {
      logger.error(`處理檔案 ${fileName} 時發生嚴重錯誤:`, error)
      throw new HttpsError('internal', `處理 Excel 檔案時發生錯誤: ${error.message}`)
    }
  },
)

// ===================================================================
// Consumables Report Functions (耗材報告相關函式) - v3.2 (使用迄日歸檔)
// ===================================================================

exports.processConsumables = onCall(
  { cors: allowedOrigins, timeoutSeconds: 300, memory: '1GiB' },
  async (request) => {
    const allowedRoles = ['admin', 'editor', 'contributor']
    if (!request.auth || !allowedRoles.includes(request.auth.token.role)) {
      throw new HttpsError('permission-denied', '您沒有權限執行此操作。')
    }

    const { fileName, fileContent } = request.data
    if (!fileName || !fileContent) {
      throw new HttpsError('invalid-argument', '請求中缺少檔案名稱或內容。')
    }

    logger.info(`[Consumables V3.2] 接收到檔案 ${fileName}，開始解析...`)

    try {
      const buffer = Buffer.from(fileContent, 'base64')
      const workbook = XLSX.read(buffer, { type: 'buffer' })
      const sheetName = workbook.SheetNames[0]
      const worksheet = workbook.Sheets[sheetName]
      const sheetAsArray = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

      if (sheetAsArray.length < 3) {
        throw new HttpsError('invalid-argument', 'Excel 檔案內容行數不足。')
      }

      // ✨ --- [核心修正] 修改正規表達式，抓取「迄日」 --- ✨
      const dateString = sheetAsArray[1][0] || ''
      // 原本的: const monthMatch = dateString.match(/&起日(\d{4})(\d{2})/)
      const monthMatch = dateString.match(/&迄日(\d{4})(\d{2})/) // 改為匹配 &迄日

      if (!monthMatch) {
        // 更新錯誤訊息，讓它更清晰
        throw new HttpsError(
          'invalid-argument',
          'Excel 格式錯誤，在第二列找不到有效的迄日(需為 &迄日YYYYMM 格式)。',
        )
      }
      const reportMonth = `${monthMatch[1]}-${monthMatch[2]}`
      logger.info(`[Consumables V3.2] 解析到報表月份為 (迄日): ${reportMonth}`)
      // ✨ --- (修正結束) --- ✨

      let headerRowIndex = -1
      for (let i = 0; i < sheetAsArray.length; i++) {
        if (sheetAsArray[i].includes('病歷號')) {
          headerRowIndex = i
          break
        }
      }
      if (headerRowIndex === -1) {
        throw new HttpsError('invalid-argument', "找不到有效的標題行 (需包含 '病歷號')。")
      }

      const headers = sheetAsArray[headerRowIndex]
      const dataRows = sheetAsArray.slice(headerRowIndex + 1)

      let consumableHeader = ''
      let firestoreField = ''
      if (headers.includes('人工腎臟')) {
        consumableHeader = '人工腎臟'
        firestoreField = 'artificialKidney'
      } else if (headers.includes('透析藥水CA')) {
        consumableHeader = '透析藥水CA'
        firestoreField = 'dialysateCa'
      } else if (headers.includes('B液種類')) {
        consumableHeader = 'B液種類'
        firestoreField = 'bicarbonateType'
      } else {
        throw new HttpsError('invalid-argument', '在標題行中找不到關鍵的耗材欄位。')
      }

      const headerToIndex = {}
      headers.forEach((header, index) => {
        if (header) headerToIndex[String(header).trim()] = index
      })

      const patientCache = new Map()
      const updatesMap = new Map()
      let errors = []
      let processedRowCount = 0

      for (const rowArray of dataRows) {
        let medicalRecordNumber = String(rowArray[headerToIndex['病歷號']] || '').trim()
        const consumableValue = rowArray[headerToIndex[consumableHeader]]
        const count = rowArray[headerToIndex['COUNT(*)']]

        if (!medicalRecordNumber || consumableValue === undefined || consumableValue === null) {
          if (
            rowArray.every(
              (cell) => cell === null || cell === undefined || String(cell).trim() === '',
            )
          )
            continue
          errors.push({ rowData: JSON.stringify(rowArray), reason: '該行缺少病歷號或耗材數值' })
          continue
        }

        medicalRecordNumber = medicalRecordNumber.replace(/^0+/, '')

        let patientData
        if (patientCache.has(medicalRecordNumber)) {
          patientData = patientCache.get(medicalRecordNumber)
        } else {
          const patientQuery = await db
            .collection('patients')
            .where('medicalRecordNumber', '==', medicalRecordNumber)
            .limit(1)
            .get()
          patientData = patientQuery.empty
            ? null
            : { id: patientQuery.docs[0].id, ...patientQuery.docs[0].data() }
          patientCache.set(medicalRecordNumber, patientData)
        }

        if (!patientData) {
          errors.push({ rowData: `病歷號: ${medicalRecordNumber}`, reason: `找不到對應的病人` })
          continue
        }

        const reportId = `${reportMonth}_${patientData.id}`
        if (!updatesMap.has(reportId)) {
          updatesMap.set(reportId, {
            patientId: patientData.id,
            patientName: patientData.name,
            medicalRecordNumber: patientData.medicalRecordNumber,
            data: {},
          })
        }

        const patientUpdate = updatesMap.get(reportId)

        if (!patientUpdate.data[firestoreField]) {
          patientUpdate.data[firestoreField] = []
        }
        patientUpdate.data[firestoreField].push({
          item: consumableValue,
          count: count || 0,
        })

        processedRowCount++
      }

      if (updatesMap.size > 0) {
        const batch = db.batch()
        for (const [reportId, updateData] of updatesMap.entries()) {
          const docRef = db.collection('consumables_reports').doc(reportId)
          batch.set(
            docRef,
            {
              patientId: updateData.patientId,
              patientName: updateData.patientName,
              medicalRecordNumber: updateData.medicalRecordNumber,
              reportDate: new Date(`${reportMonth}-01`),
              sourceFile: fileName,
              updatedAt: FieldValue.serverTimestamp(),
              data: updateData.data,
            },
            { merge: true },
          )
        }
        await batch.commit()
      }

      return {
        success: true,
        message: `處理完成！成功處理 ${processedRowCount} 筆耗材資料，聚合為 ${updatesMap.size} 份月報表，發現 ${errors.length} 個問題行。`,
        processedCount: updatesMap.size,
        errorCount: errors.length,
        errors: errors.slice(0, 50),
      }
    } catch (error) {
      logger.error(`[Consumables V3.2] 處理檔案 ${fileName} 時發生嚴重錯誤:`, error)
      if (error instanceof HttpsError) throw error
      throw new HttpsError('internal', `處理 Excel 檔案時發生錯誤: ${error.message}`)
    }
  },
)

// ===================================================================
// Medication Orders Processing Function (藥囑處理函式) - ✨ 最終修正版 v1.7 (uploadMonth 基於上傳時間) ✨
// ===================================================================

exports.processOrders = onCall(
  { cors: allowedOrigins, timeoutSeconds: 540, memory: '1GiB' },
  async (request) => {
    const allowedRoles = ['admin', 'editor', 'contributor']
    if (!request.auth || !allowedRoles.includes(request.auth.token.role)) {
      throw new HttpsError('permission-denied', '您沒有權限執行此操作。')
    }
    const { fileName, fileContent } = request.data
    if (!fileName || !fileContent) {
      throw new HttpsError('invalid-argument', '請求中缺少檔案名稱或內容。')
    }
    logger.info(`[ProcessOrders V1.8] 接收到檔案 ${fileName}，開始解析...`)

    try {
      // ✨ --- [核心修正] 使用正確的方式呼叫 serverTimestamp --- ✨
      const uploadTimestamp = FieldValue.serverTimestamp()

      const now = new Date()
      const year = now.getFullYear()
      const month = (now.getMonth() + 1).toString().padStart(2, '0')
      const uploadMonth = `${year}-${month}`
      logger.info(`[ProcessOrders V1.8] 本次上傳將歸檔至月份: ${uploadMonth}`)

      const buffer = Buffer.from(fileContent, 'base64')
      const workbook = XLSX.read(buffer, { type: 'buffer' })
      const sheetName = workbook.SheetNames[0]
      const worksheet = workbook.Sheets[sheetName]
      const dataRows = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: '',
        raw: false,
        dateNF: 'YYYY-MM-DD',
      })

      let headerRowIndex = -1
      let headers = []
      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i].map((h) => String(h).trim())
        if (row.includes('病歷號') && row.includes('醫令碼') && row.includes('名稱')) {
          headerRowIndex = i
          headers = row
          break
        }
      }
      if (headerRowIndex === -1) {
        throw new HttpsError(
          'invalid-argument',
          "找不到有效的標題行 (需包含 '病歷號', '醫令碼', '名稱')。",
        )
      }

      const headerToIndex = {}
      headers.forEach((header, index) => {
        if (header) headerToIndex[header.trim()] = index
      })
      const requiredHeaders = ['病歷號', '醫令碼', '名稱', '異動日期', '次劑量']
      const missingHeaders = requiredHeaders.filter((h) => headerToIndex[h] === undefined)
      if (missingHeaders.length > 0) {
        throw new HttpsError(
          'invalid-argument',
          `Excel 檔案缺少必要的欄位: ${missingHeaders.join(', ')}`,
        )
      }

      const oralMedCodes = ['OALK1', 'OCAA', 'OCAL1', 'OFOS4', 'OUCA1', 'OVAF', 'OORK']
      const injectionMedCodes = ['INES2', 'IPAR1', 'ICAC', 'IFER2', 'IREC1']

      let batch = db.batch()
      const patientCache = new Map()
      let errors = []
      let processedCount = 0
      let batchCounter = 0
      const BATCH_SIZE = 450

      for (let i = headerRowIndex + 1; i < dataRows.length; i++) {
        const row = dataRows[i]
        if (row.every((cell) => String(cell).trim() === '')) continue

        let medicalRecordNumber = String(row[headerToIndex['病歷號']] || '')
          .trim()
          .replace(/^0+/, '')
        const orderCode = String(row[headerToIndex['醫令碼']] || '').trim()
        const orderName = String(row[headerToIndex['名稱']] || '').trim()
        const rawChangeDate = row[headerToIndex['異動日期']]
        let changeDate = ''

        if (rawChangeDate) {
          const dateStr = String(rawChangeDate).trim()
          if (/^\d{8,}/.test(dateStr)) {
            const year = dateStr.substring(0, 4)
            const month = dateStr.substring(4, 6)
            const day = dateStr.substring(6, 8)
            if (
              parseInt(month) >= 1 &&
              parseInt(month) <= 12 &&
              parseInt(day) >= 1 &&
              parseInt(day) <= 31
            ) {
              changeDate = `${year}-${month}-${day}`
            }
          }
          if (!changeDate) {
            try {
              const dateObj = new Date(rawChangeDate)
              if (!isNaN(dateObj.getTime())) {
                const year = dateObj.getUTCFullYear()
                const month = (dateObj.getUTCMonth() + 1).toString().padStart(2, '0')
                const day = dateObj.getUTCDate().toString().padStart(2, '0')
                changeDate = `${year}-${month}-${day}`
              }
            } catch (e) {
              /* 忽略解析錯誤 */
            }
          }
        }

        if (
          !medicalRecordNumber ||
          !orderCode ||
          !orderName ||
          !changeDate ||
          !/^\d{4}-\d{2}-\d{2}$/.test(changeDate)
        ) {
          let reason = '缺少必要欄位或日期格式不正確'
          if (!changeDate || !/^\d{4}-\d{2}-\d{2}$/.test(changeDate)) {
            reason = `異動日期格式錯誤或為空 (應為 YYYY-MM-DD)，讀取到的值為: "${rawChangeDate}"`
          }
          errors.push({ rowNumber: i + 1, reason })
          continue
        }

        let patientData
        if (patientCache.has(medicalRecordNumber)) {
          patientData = patientCache.get(medicalRecordNumber)
        } else {
          const patientQuery = await db
            .collection('patients')
            .where('medicalRecordNumber', '==', medicalRecordNumber)
            .limit(1)
            .get()
          patientData = patientQuery.empty
            ? null
            : { id: patientQuery.docs[0].id, ...patientQuery.docs[0].data() }
          patientCache.set(medicalRecordNumber, patientData)
        }

        if (!patientData) {
          errors.push({
            rowNumber: i + 1,
            reason: `病歷號 ${medicalRecordNumber} 找不到對應的病人`,
          })
          continue
        }

        let orderType = null
        const orderPayload = {
          patientId: patientData.id,
          medicalRecordNumber: patientData.medicalRecordNumber,
          patientName: patientData.name,
          orderCode,
          orderName,
          changeDate,
          uploadMonth,
          dose: String(row[headerToIndex['次劑量']] || ''),
          action: 'MODIFY',
          sourceFile: fileName,
          uploadTimestamp: uploadTimestamp,
        }

        if (oralMedCodes.includes(orderCode)) {
          orderType = 'oral'
          orderPayload.frequency = String(row[headerToIndex['頻率服法']] || '')
        } else if (injectionMedCodes.includes(orderCode)) {
          orderType = 'injection'
          orderPayload.note = String(row[headerToIndex['備註']] || '')
        }

        if (orderType) {
          orderPayload.orderType = orderType
          const newOrderRef = db.collection('medication_orders').doc()
          batch.set(newOrderRef, orderPayload)
          processedCount++
          batchCounter++
          if (batchCounter >= BATCH_SIZE) {
            await batch.commit()
            logger.info(`[ProcessOrders V1.8] 已提交 ${batchCounter} 筆資料...`)
            batch = db.batch()
            batchCounter = 0
          }
        }
      }

      if (batchCounter > 0) {
        await batch.commit()
        logger.info(`[ProcessOrders V1.8] 已提交最後 ${batchCounter} 筆資料。`)
      }

      logger.info(
        `[ProcessOrders V1.8] 處理完成，成功處理 ${processedCount} 筆藥囑，發現 ${errors.length} 個問題。`,
      )

      return {
        success: true,
        message: `處理完成！成功匯入 ${processedCount} 筆藥囑紀錄，發現 ${errors.length} 個問題行。`,
        processedCount,
        errorCount: errors.length,
        errors: errors.slice(0, 50),
      }
    } catch (error) {
      logger.error(`[ProcessOrders V1.8] 處理檔案 ${fileName} 時發生嚴重錯誤:`, error)
      if (error instanceof HttpsError) throw error
      throw new HttpsError('internal', `處理 Excel 檔案時發生錯誤: ${error.message}`)
    }
  },
)

// ===================================================================
// Daily Injection Calculation Function - 完整修復版
// ===================================================================

const parseFlexibleDate = (dateStr, targetDate) => {
  if (!dateStr || typeof dateStr !== 'string') {
    return null
  }
  const str = dateStr.trim()
  const year = targetDate.getUTCFullYear()

  // 支援 YYYY-MM-DD 或 YYYY/MM/DD
  let match = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/)
  if (match) {
    const customYear = match[1]
    const month = match[2].padStart(2, '0')
    const day = match[3].padStart(2, '0')
    return `${customYear}-${month}-${day}`
  }

  // 支援 MM/DD
  match = str.match(/^(\d{1,2})\/(\d{1,2})$/)
  if (match) {
    const month = match[1].padStart(2, '0')
    const day = match[2].padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  // 支援 MMDD
  match = str.match(/^(\d{2})(\d{2})$/)
  if (match && str.length === 4) {
    const month = match[1]
    const day = match[2]
    if (
      parseInt(month, 10) > 0 &&
      parseInt(month, 10) <= 12 &&
      parseInt(day, 10) > 0 &&
      parseInt(day, 10) <= 31
    ) {
      return `${year}-${month}-${day}`
    }
  }

  return null
}

exports.getDailyInjections = onCall(
  { cors: allowedOrigins, timeoutSeconds: 300, memory: '1GiB' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', '使用者未登入，無法執行此操作。')
    }

    const { targetDate, patientIds } = request.data

    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      throw new HttpsError('invalid-argument', '請提供有效的目標日期 (格式 YYYY-MM-DD)。')
    }

    if (!patientIds || !Array.isArray(patientIds) || patientIds.length === 0) {
      return { success: true, targetDate, injections: [] }
    }

    if (patientIds.length > 100) {
      throw new HttpsError('invalid-argument', '單次查詢的病人數不能超過100人。')
    }

    logger.info(
      `[getDailyInjections] 開始為 ${patientIds.length} 位病人計算 ${targetDate} 的應打針劑...`,
    )

    try {
      // 步驟 1: 找出最新的上傳月份
      const latestMonthQuery = db
        .collection('medication_orders')
        .where('patientId', 'in', patientIds)
        .where('orderType', '==', 'injection')
        .orderBy('uploadMonth', 'desc')
        .limit(1)

      const latestMonthSnapshot = await latestMonthQuery.get()

      if (latestMonthSnapshot.empty) {
        logger.info(`[getDailyInjections] 在這些病人中找不到任何針劑藥囑紀錄。`)
        return { success: true, targetDate, injections: [] }
      }

      const latestUploadMonth = latestMonthSnapshot.docs[0].data().uploadMonth
      logger.info(`[getDailyInjections] 找到最新的上傳月份為: ${latestUploadMonth}`)

      // 步驟 2: 查詢最新月份的藥囑紀錄
      const effectiveOrdersQuery = db
        .collection('medication_orders')
        .where('patientId', 'in', patientIds)
        .where('orderType', '==', 'injection')
        .where('uploadMonth', '==', latestUploadMonth)

      const effectiveOrdersSnapshot = await effectiveOrdersQuery.get()

      // 步驟 3: 聚合每個病人每個藥物的最新紀錄
      const patientLatestOrders = new Map()

      effectiveOrdersSnapshot.forEach((doc) => {
        const order = doc.data()
        const key = `${order.patientId}-${order.orderCode}`
        const existingOrder = patientLatestOrders.get(key)

        if (!existingOrder || new Date(order.changeDate) > new Date(existingOrder.changeDate)) {
          patientLatestOrders.set(key, order)
        }
      })

      const patientHistory = Array.from(patientLatestOrders.values())
      logger.info(`[getDailyInjections] 已聚合出 ${patientHistory.length} 筆最新的有效藥囑。`)

      // 步驟 4: 撈取排班資料
      const scheduleDoc = await db.collection('schedules').doc(targetDate).get()
      const scheduleData = scheduleDoc.exists ? scheduleDoc.data().schedule : {}
      const patientSlotMap = new Map()

      for (const shiftId in scheduleData) {
        const slot = scheduleData[shiftId]
        if (slot.patientId) {
          patientSlotMap.set(slot.patientId, {
            bedNum: shiftId.startsWith('peripheral')
              ? `外${shiftId.split('-')[1]}`
              : shiftId.split('-')[1],
            shift: shiftId.split('-')[2],
          })
        }
      }

      // 步驟 5: 計算應打針劑
      const finalInjectionList = []
      const dateObj = new Date(targetDate + 'T00:00:00Z')
      const targetDayOfWeek = dateObj.getUTCDay()

      for (const order of patientHistory) {
        const slotInfo = patientSlotMap.get(order.patientId) || { bedNum: 'N/A', shift: 'N/A' }
        const note = (order.note || '').trim()
        let shouldAdminister = false
        let reason = ''

        // 使用更寬鬆的分割，保留 QW 規則的完整性
        // 只用空白字元分割，不用逗號（因為 qw3,6 的逗號是頻率的一部分）
        const noteParts = note.split(/\s+/).filter(Boolean)

        for (const part of noteParts) {
          if (part.toUpperCase().startsWith('QW')) {
            // 解析 QW 規則（如 QW135, QW3.6, QW3,6, QW3、6 等格式）
            const dayString = part.substring(2)
            if (dayString) {
              // 使用正則表達式提取所有數字（1-7），支援多種分隔符
              // 支援格式：qw36, qw3.6, qw3,6, qw3、6, qw3，6 等
              const days = []
              const matches = dayString.match(/[1-7]/g)
              if (matches) {
                matches.forEach((d) => days.push(parseInt(d, 10)))
              }

              // 醫院系統：1=週一, 2=週二, ..., 7=週日
              const hospitalSystemDayOfWeek = targetDayOfWeek === 0 ? 7 : targetDayOfWeek

              if (days.includes(hospitalSystemDayOfWeek)) {
                shouldAdminister = true
                reason = `規則匹配: ${part}`
                break
              }
            }
          } else {
            // 檢查是否為日期
            const parsedDate = parseFlexibleDate(part, dateObj)
            if (parsedDate && parsedDate === targetDate) {
              shouldAdminister = true
              reason = `日期匹配: ${part}`
              break
            }
          }
        }

        // ✨ 關鍵修復：補上完整的 push 內容
        if (shouldAdminister) {
          finalInjectionList.push({
            patientId: order.patientId,
            patientName: order.patientName,
            medicalRecordNumber: order.medicalRecordNumber,
            bedNum: slotInfo.bedNum,
            shift: slotInfo.shift,
            orderCode: order.orderCode,
            orderName: order.orderName,
            dose: order.dose,
            note: order.note,
            reason: reason,
            changeDate: order.changeDate,
          })
        }
      }

      // 步驟 6: 排序結果
      finalInjectionList.sort((a, b) => {
        const shiftOrder = { early: 1, noon: 2, late: 3, N: 98, A: 99 }
        const shiftA = a.shift || 'A'
        const shiftB = b.shift || 'A'

        if (shiftA !== shiftB) {
          return (shiftOrder[shiftA] || 99) - (shiftOrder[shiftB] || 99)
        }

        const bedA = String(a.bedNum).startsWith('外')
          ? 1000 + parseInt(String(a.bedNum).substring(1))
          : parseInt(a.bedNum)
        const bedB = String(b.bedNum).startsWith('外')
          ? 1000 + parseInt(String(b.bedNum).substring(1))
          : parseInt(b.bedNum)

        return bedA - bedB
      })

      logger.info(`[getDailyInjections] 計算完成，找到 ${finalInjectionList.length} 筆應打針劑。`)

      return {
        success: true,
        targetDate,
        injections: finalInjectionList,
      }
    } catch (error) {
      logger.error(`[getDailyInjections] 處理針劑計算時發生嚴重錯誤:`, error)
      throw new HttpsError('internal', `計算應打針劑時發生錯誤: ${error.message}`)
    }
  },
)

// ===================================================================
// ✨【最終修正版 V2.3】 - 每日自動歸檔 (使用 dateUtils)
// ===================================================================

exports.archiveDailySchedule = onSchedule(
  { schedule: 'every day 00:05', timeZone: TIME_ZONE, timeoutSeconds: 540, memory: '512MiB' },
  async (event) => {
    // 1. ✨ 使用統一函式獲取台北時區的昨天日期
    const { getTaipeiYesterdayString } = require('./utils/dateUtils') // 引入昨天的函式
    const dateStr = getTaipeiYesterdayString()

    logger.info(`[Archiver V3] 🚀 歸檔任務啟動，目標歸檔日期: ${dateStr}`)

    const sourceScheduleRef = db.collection('schedules').doc(dateStr)
    const targetArchiveRef = db.collection('expired_schedules').doc(dateStr)

    try {
      // 使用 transaction 確保原子操作
      await db.runTransaction(async (transaction) => {
        // 讀取原始排程
        const scheduleDoc = await transaction.get(sourceScheduleRef)

        if (!scheduleDoc.exists) {
          logger.warn(`[Archiver V3] ⚠️ 日期 ${dateStr} 的排班文件不存在，無需歸檔。`)
          return null
        }

        // 檢查是否已經有歸檔文件（避免重複歸檔）
        const existingArchive = await transaction.get(targetArchiveRef)
        if (existingArchive.exists) {
          logger.warn(`[Archiver V3] ⚠️ 日期 ${dateStr} 已經有歸檔文件，將刪除原始文件。`)
          transaction.delete(sourceScheduleRef)
          return null
        }

        const originalData = scheduleDoc.data()
        const originalSchedule = originalData.schedule || {}

        // 收集所有病人ID
        const patientIds = [
          ...new Set(
            Object.values(originalSchedule)
              .map((slot) => slot.patientId)
              .filter(Boolean),
          ),
        ]

        logger.info(`[Archiver V3] 🔍 找到 ${patientIds.length} 位病人，開始處理歸檔資料...`)

        // 如果沒有病人，直接歸檔
        if (patientIds.length === 0) {
          logger.info(`[Archiver V3] 📄 日期 ${dateStr} 的排班中沒有病人，直接歸檔空排班。`)

          transaction.set(targetArchiveRef, {
            ...originalData,
            archivedAt: FieldValue.serverTimestamp(),
            archiveMethod: 'empty_schedule',
          })
          transaction.delete(sourceScheduleRef)
          return null
        }

        // 建立歸檔資料
        const archivedSchedule = { ...originalSchedule }
        const patientDataMap = new Map()

        // 批次查詢病人資料（Transaction 外部查詢，因為 Transaction 內有限制）
        // 注意：這會在 transaction 外執行，但因為病人資料相對穩定，風險較低
        const CHUNK_SIZE = 30
        for (let i = 0; i < patientIds.length; i += CHUNK_SIZE) {
          const chunk = patientIds.slice(i, i + CHUNK_SIZE)
          const patientQuery = db.collection('patients').where(FieldPath.documentId(), 'in', chunk)
          const patientDocs = await patientQuery.get()

          patientDocs.forEach((doc) => {
            patientDataMap.set(doc.id, doc.data())
          })
        }

        // 為每個排程項目添加病人快照
        let missingPatientCount = 0
        for (const shiftId in archivedSchedule) {
          const slot = archivedSchedule[shiftId]
          if (slot?.patientId) {
            const patientData = patientDataMap.get(slot.patientId)
            if (patientData) {
              slot.archivedPatientInfo = {
                status: patientData.status || 'unknown',
                mode: slot.modeOverride || patientData.mode || null,
                wardNumber: patientData.wardNumber || null,
                medicalRecordNumber: patientData.medicalRecordNumber || null,
                freq: patientData.freq || null,
              }
            } else {
              missingPatientCount++
              slot.archivedPatientInfo = {
                status: 'deleted',
                mode: 'N/A',
                wardNumber: null,
                medicalRecordNumber: null,
                name: slot.patientName || '未知 (已刪除)',
                note: 'Patient data not found during archival',
              }
            }
          }
        }

        if (missingPatientCount > 0) {
          logger.warn(
            `[Archiver V3] ⚠️ 有 ${missingPatientCount} 位病人的資料在 patients 集合中找不到。`,
          )
        }

        // 準備歸檔資料
        const dataToArchive = {
          ...originalData,
          schedule: archivedSchedule,
          archivedAt: FieldValue.serverTimestamp(),
          archiveMethod: 'daily_scheduled',
          patientCount: patientIds.length,
          missingPatientCount: missingPatientCount,
        }

        // 在 transaction 中執行歸檔和刪除
        transaction.set(targetArchiveRef, dataToArchive)
        transaction.delete(sourceScheduleRef)

        logger.info(`[Archiver V3] ✅ Transaction 準備完成，即將提交歸檔 ${dateStr}`)
      })

      // Transaction 成功完成
      logger.info(`[Archiver V3] ✅ 成功歸檔並刪除原始排班 ${dateStr}`)

      // 驗證操作結果
      const verifySource = await sourceScheduleRef.get()
      const verifyTarget = await targetArchiveRef.get()

      if (verifySource.exists) {
        logger.error(`[Archiver V3] ❌ 驗證失敗：原始文件 ${dateStr} 仍然存在！`)
        // 嘗試強制刪除
        await sourceScheduleRef.delete()
        logger.info(`[Archiver V3] 🔧 已執行強制刪除`)
      }

      if (!verifyTarget.exists) {
        logger.error(`[Archiver V3] ❌ 驗證失敗：歸檔文件 ${dateStr} 不存在！`)
      }
    } catch (error) {
      logger.error(`[Archiver V3] ❌ 歸檔日期 ${dateStr} 的排班時發生嚴重錯誤:`, error)

      // 錯誤恢復：如果歸檔已建立但原始文件還在，嘗試刪除原始文件
      try {
        const [sourceExists, targetExists] = await Promise.all([
          sourceScheduleRef.get(),
          targetArchiveRef.get(),
        ])

        if (targetExists.exists && sourceExists.exists) {
          logger.info(`[Archiver V3] 🔧 檢測到部分完成的歸檔，嘗試清理原始文件...`)
          await sourceScheduleRef.delete()
          logger.info(`[Archiver V3] ✅ 清理完成`)
        }
      } catch (cleanupError) {
        logger.error(`[Archiver V3] ❌ 清理失敗:`, cleanupError)
      }

      throw error
    }

    return null
  },
)

// ✨ --- 【全新】手動遷移歷史排班的一次性 Cloud Function --- ✨
exports.migrateSchedulesToArchive = onCall(
  { cors: allowedOrigins, timeoutSeconds: 540, memory: '1GiB' },
  async (request) => {
    if (request.auth?.token?.role !== 'admin') {
      throw new HttpsError('permission-denied', '您沒有權限執行此操作。')
    }

    const { startDate, endDate } = request.data
    if (!startDate || !endDate) {
      throw new HttpsError('invalid-argument', '請提供 startDate 和 endDate (格式 YYYY-MM-DD)。')
    }

    logger.info(`[Migrator V2.1] 🚀 手動遷移啟動，範圍: ${startDate} 至 ${endDate}`)

    try {
      const schedulesSnapshot = await db
        .collection('schedules')
        .where('date', '>=', startDate)
        .where('date', '<=', endDate)
        .get()

      if (schedulesSnapshot.empty) {
        logger.info('[Migrator V2.1] 在此日期範圍內找不到需要遷移的排班文件。')
        return {
          success: true,
          message: '在此日期範圍內找不到需要遷移的排班文件。',
          migratedCount: 0,
        }
      }

      logger.info(`[Migrator V2.1] 🔍 找到 ${schedulesSnapshot.size} 份排班文件準備遷移...`)
      let migratedCount = 0

      for (const scheduleDoc of schedulesSnapshot.docs) {
        const dateStr = scheduleDoc.id
        const originalData = scheduleDoc.data()
        const originalSchedule = originalData.schedule || {}

        logger.info(`  └─ 正在處理 ${dateStr}...`)

        const patientIds = [
          ...new Set(
            Object.values(originalSchedule)
              .map((slot) => slot.patientId)
              .filter(Boolean),
          ),
        ]
        const archivedSchedule = { ...originalSchedule }

        if (patientIds.length > 0) {
          const patientDataMap = new Map()
          const CHUNK_SIZE = 30
          for (let i = 0; i < patientIds.length; i += CHUNK_SIZE) {
            const chunk = patientIds.slice(i, i + CHUNK_SIZE)
            const patientDocs = await db
              .collection('patients')
              .where(FieldPath.documentId(), 'in', chunk)
              .get()
            patientDocs.forEach((doc) => patientDataMap.set(doc.id, doc.data()))
          }

          for (const shiftId in archivedSchedule) {
            const slot = archivedSchedule[shiftId]
            if (slot?.patientId) {
              const patientData = patientDataMap.get(slot.patientId)
              if (patientData) {
                // ✨ --- 核心修正點 --- ✨
                slot.archivedPatientInfo = {
                  status: patientData.status || 'unknown',
                  mode: slot.modeOverride || patientData.mode || null,
                  wardNumber: patientData.wardNumber || null,
                }
              } else {
                slot.archivedPatientInfo = {
                  status: 'deleted',
                  mode: 'N/A',
                  wardNumber: null,
                  name: slot.patientName || '未知(已刪除)',
                }
              }
            }
          }
        }

        const dataToArchive = {
          ...originalData,
          schedule: archivedSchedule,
          archivedAt: FieldValue.serverTimestamp(),
          migrationNote: 'Manually migrated on ' + new Date().toISOString(),
        }

        const batch = db.batch()
        batch.set(db.collection('expired_schedules').doc(dateStr), dataToArchive)
        batch.delete(db.collection('schedules').doc(dateStr))
        await batch.commit()
        migratedCount++
        logger.info(`    └─ ✅ ${dateStr} 遷移成功！`)
      }

      const successMessage = `成功遷移 ${migratedCount} 份排班文件！`
      logger.info(`[Migrator V2.1] ✅ ${successMessage}`)
      return { success: true, message: successMessage, migratedCount }
    } catch (error) {
      logger.error(`[Migrator V2.1] ❌ 遷移過程中發生嚴重錯誤:`, error)
      throw new HttpsError('internal', `遷移失敗: ${error.message}`)
    }
  },
)

/**
 * ✨✨✨【全新函式】✨✨✨
 * 手動觸發，將所有已過期的 `message` 類型的 task 狀態更新為 `expired`。
 * 僅限管理員使用。
 */
exports.manuallyExpireTasks = onCall(
  { cors: allowedOrigins, timeoutSeconds: 300 },
  async (request) => {
    // 1. 權限檢查：確保只有 admin 角色的使用者可以呼叫
    if (request.auth?.token?.role !== 'admin') {
      throw new HttpsError('permission-denied', '您沒有權限執行此操作。')
    }

    logger.info(`[Manual Trigger] Manually expiring tasks, triggered by admin: ${request.auth.uid}`)

    const todayStr = getTaipeiTodayString()
    try {
      // 2. 執行與排程函式完全相同的查詢邏輯
      const query = db
        .collection('tasks')
        .where('status', '==', 'pending')
        .where('category', '==', 'message')
        .where('targetDate', '<', todayStr)

      const snapshot = await query.get()
      if (snapshot.empty) {
        logger.info('[Manual Trigger] No expired tasks (messages) found to update.')
        return { success: true, message: '找不到需要更新的過期留言。', updatedCount: 0 }
      }

      const batch = db.batch()
      snapshot.forEach((doc) => {
        logger.info(`[Manual Trigger] Expiring task (message) ${doc.id}.`)
        batch.update(doc.ref, { status: 'expired' })
      })
      await batch.commit()

      const successMessage = `成功將 ${snapshot.size} 則留言標記為已過期。`
      logger.info(`[Manual Trigger] ${successMessage}`)
      // 3. 回傳詳細的成功訊息給前端
      return { success: true, message: successMessage, updatedCount: snapshot.size }
    } catch (error) {
      logger.error('[Manual Trigger] Failed to manually expire tasks:', error)
      throw new HttpsError('internal', '手動更新過期留言時發生錯誤。', error)
    }
  },
)

// ===================================================================
// 當月當班藥物草稿整理函式 (藥物草稿處理函式) - v1.0
// ===================================================================

exports.getDailyMedicationDrafts = onCall(
  { cors: allowedOrigins, timeoutSeconds: 180, memory: '512MiB' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', '使用者未登入，無法執行此操作。')
    }

    const { targetDate, patientIds } = request.data
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      throw new HttpsError('invalid-argument', '請提供有效的目標日期 (格式 YYYY-MM-DD)。')
    }

    if (!patientIds || !Array.isArray(patientIds) || patientIds.length === 0) {
      return { success: true, targetDate, drafts: [] }
    }
    if (patientIds.length > 100) {
      throw new HttpsError('invalid-argument', '單次查詢的病人數不能超過100人。')
    }

    // 從 targetDate (e.g., "2025-08-15") 推算出 targetMonth (e.g., "2025-08")
    const targetMonth = targetDate.substring(0, 7)

    logger.info(
      `[getDailyMedicationDrafts] 開始為 ${patientIds.length} 位病人計算 ${targetMonth} 的藥囑草稿...`,
    )

    try {
      // --- 步驟 1: 查詢所有相關的藥囑草稿 ---
      const draftsQuery = db
        .collection('medication_drafts')
        .where('patientId', 'in', patientIds)
        .where('targetMonth', '==', targetMonth)
        .where('status', '==', 'pending') // 只撈取待處理的草稿

      const draftsSnapshot = await draftsQuery.get()
      const allDrafts = draftsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))

      // --- 步驟 2: 撈取當天的排班資料以取得床號和班別 ---
      const scheduleDoc = await db.collection('schedules').doc(targetDate).get()
      const scheduleData = scheduleDoc.exists ? scheduleDoc.data().schedule : {}
      const patientSlotMap = new Map()
      for (const shiftId in scheduleData) {
        const slot = scheduleData[shiftId]
        if (slot.patientId) {
          patientSlotMap.set(slot.patientId, {
            bedNum: shiftId.startsWith('peripheral')
              ? `外${shiftId.split('-')[1]}`
              : shiftId.split('-')[1],
            shift: shiftId.split('-')[2],
          })
        }
      }

      // --- 步驟 3: 組合資料 ---
      const finalDraftList = allDrafts.map((draft) => {
        const slotInfo = patientSlotMap.get(draft.patientId) || { bedNum: 'N/A', shift: 'N/A' }
        return {
          ...draft,
          bedNum: slotInfo.bedNum,
          shift: slotInfo.shift,
        }
      })

      // --- 步驟 4: 排序 ---
      finalDraftList.sort((a, b) => {
        const shiftOrder = { early: 1, noon: 2, late: 3, N: 98, A: 99 }
        const shiftA = a.shift || 'A'
        const shiftB = b.shift || 'A'
        if (shiftA !== shiftB) return (shiftOrder[shiftA] || 99) - (shiftOrder[shiftB] || 99)

        const bedA = String(a.bedNum).startsWith('外')
          ? 1000 + parseInt(String(a.bedNum).substring(1))
          : parseInt(a.bedNum)
        const bedB = String(b.bedNum).startsWith('外')
          ? 1000 + parseInt(String(b.bedNum).substring(1))
          : parseInt(b.bedNum)
        if (bedA !== bedB) return bedA - bedB

        // 如果床位班別都相同，按藥物名稱排序
        return (a.orderName || '').localeCompare(b.orderName || '')
      })

      logger.info(`[getDailyMedicationDrafts] 計算完成，找到 ${finalDraftList.length} 筆藥囑草稿。`)
      return { success: true, targetDate, drafts: finalDraftList }
    } catch (error) {
      logger.error(`[getDailyMedicationDrafts] 處理藥囑草稿計算時發生嚴重錯誤:`, error)
      throw new HttpsError('internal', `計算藥囑草稿時發生錯誤: ${error.message}`)
    }
  },
)

// ===================================================================
// ✨【最終修正版 v1.3】 - 補上遺漏的 today 變數宣告
// ===================================================================

/**
 * 每日定時執行的 Cloud Function，用於處理所有到期的「預約病人變更」任務。
 * 觸發時間：每日凌晨 01:00 (台北時間)。
 */
exports.applyScheduledPatientUpdates = onSchedule(
  { schedule: '0 1 * * *', timeZone: TIME_ZONE, timeoutSeconds: 540, memory: '1GiB' },
  async (event) => {
    // 使用統一的日期字串作為基準
    const todayStr = getTaipeiTodayString()

    logger.info(`🚀 [Updater] 執行 ${todayStr} 的預約變更任務...`)

    const updatesQuery = db
      .collection('scheduled_patient_updates')
      .where('effectiveDate', '==', todayStr)
      .where('status', '==', 'pending')

    const snapshot = await updatesQuery.get()

    if (snapshot.empty) {
      logger.info('✅ [Updater] 今天沒有待處理的預約變更。')
      return null
    }

    logger.info(`[Updater] 找到 ${snapshot.size} 個待處理的預約。`)

    const hasFrequencyConflict = (freq1, freq2) => {
      if (!freq1 || !freq2) return false
      const days1 = FREQ_MAP_TO_DAY_INDEX[freq1] || []
      const days2 = FREQ_MAP_TO_DAY_INDEX[freq2] || []
      return days1.some((day) => days2.includes(day))
    }

    for (const doc of snapshot.docs) {
      const updateTask = doc.data()
      const taskId = doc.id
      const { patientId, changeType, payload } = updateTask

      logger.info(`  - 正在處理任務 ${taskId} for patient ${patientId} (${changeType})...`)

      try {
        switch (changeType) {
          case 'UPDATE_STATUS':
          case 'UPDATE_MODE':
            await db.collection('patients').doc(patientId).update(payload)
            logger.info(`    - 成功更新 patients/${patientId} 的屬性。`)
            break

          case 'UPDATE_FREQ':
            if (!payload.freq) {
              throw new Error("Payload for UPDATE_FREQ is missing 'freq'.")
            }
            await db.collection('patients').doc(patientId).update({ freq: payload.freq })
            logger.info(`    - 成功更新 patients/${patientId} 的預設頻率為 ${payload.freq}。`)
            break

          case 'UPDATE_BASE_SCHEDULE_RULE':
            const { bedNum, shiftIndex, freq } = payload
            if (bedNum === undefined || shiftIndex === undefined || !freq) {
              throw new Error('Payload for UPDATE_BASE_SCHEDULE_RULE is incomplete.')
            }
            const masterScheduleRef = db.collection('base_schedules').doc('MASTER_SCHEDULE')

            await db.runTransaction(async (transaction) => {
              const masterDoc = await transaction.get(masterScheduleRef)
              if (!masterDoc.exists) throw new Error('MASTER_SCHEDULE document not found!')

              const schedule = masterDoc.data().schedule || {}

              for (const otherPatientId in schedule) {
                if (otherPatientId === patientId) continue
                const otherRule = schedule[otherPatientId]
                if (
                  otherRule.bedNum === bedNum &&
                  otherRule.shiftIndex === shiftIndex &&
                  hasFrequencyConflict(freq, otherRule.freq)
                ) {
                  const otherPatientName = otherRule.patientName || `ID:${otherPatientId}`
                  throw new Error(
                    `床位衝突：目標位置已被 ${otherPatientName} (${otherRule.freq}) 佔用。`,
                  )
                }
              }

              transaction.update(db.collection('patients').doc(patientId), { freq })

              const existingRule = schedule[patientId] || {}
              transaction.update(masterScheduleRef, {
                [`schedule.${patientId}`]: {
                  ...existingRule,
                  bedNum: bedNum,
                  shiftIndex: shiftIndex,
                  freq: freq,
                  patientName: updateTask.patientName || existingRule.patientName,
                },
              })
            })
            logger.info(`    - 成功更新 patient/${patientId} 和 base_schedules 的總表規則。`)
            break

          case 'DELETE_PATIENT':
            const patientRef = db.collection('patients').doc(patientId)
            const masterRef = db.collection('base_schedules').doc('MASTER_SCHEDULE')

            await db.runTransaction(async (transaction) => {
              const patientDoc = await transaction.get(patientRef)
              if (!patientDoc.exists) throw new Error(`Patient with ID ${patientId} not found.`)
              const patientData = patientDoc.data()

              transaction.set(
                patientRef,
                {
                  isDeleted: true,
                  status: 'deleted',
                  originalStatus: patientData.status,
                  deleteReason: payload.deleteReason || '預約刪除',
                  remarks: payload.remarks || '',
                  deletedAt: FieldValue.serverTimestamp(),
                },
                { merge: true },
              )

              transaction.update(masterRef, {
                [`schedule.${patientId}`]: FieldValue.delete(),
              })
            })

            logger.info(`    - 開始清理 ${patientId} 的排程...`)
            const cleanupBatch = db.batch()
            let cleanupCount = 0
            const BATCH_SIZE = 450

            // 🔥 修正：使用 UTC 日期計算，從今天開始的 60 天
            for (let i = 0; i <= 60; i++) {
              const targetDate = new Date(todayStr + 'T00:00:00Z')
              targetDate.setUTCDate(targetDate.getUTCDate() + i)
              const dateStr = formatDateToYYYYMMDD(targetDate)

              if (dateStr >= todayStr) {
                const scheduleRef = db.collection('schedules').doc(dateStr)
                const scheduleDoc = await scheduleRef.get()

                if (scheduleDoc.exists) {
                  const schedule = scheduleDoc.data().schedule || {}
                  const updates = {}
                  for (const key in schedule) {
                    if (schedule[key].patientId === patientId) {
                      updates[`schedule.${key}`] = FieldValue.delete()
                      cleanupCount++
                      logger.info(`      └─ 移除 ${dateStr} 的 ${key}`)
                    }
                  }
                  if (Object.keys(updates).length > 0) {
                    cleanupBatch.update(scheduleRef, {
                      ...updates,
                      lastModified: FieldValue.serverTimestamp(),
                      modifiedBy: 'scheduled_update',
                    })
                    if (cleanupCount >= BATCH_SIZE) {
                      await cleanupBatch.commit()
                      logger.info(`      └─ 批次提交：已清理 ${cleanupCount} 個項目`)
                      cleanupCount = 0
                      cleanupBatch = db.batch()
                    }
                  }
                }
              }
            }
            if (cleanupCount > 0) {
              await cleanupBatch.commit()
              logger.info(`    - 共清理了 ${cleanupCount} 個排程項目`)
            }

            logger.info(`    - 開始清理 ${patientId} 的護理師分組...`)
            const assignmentsBatch = db.batch()
            let assignmentCount = 0
            const assignmentsSnapshot = await db
              .collection('nurse_assignments')
              .where('date', '>', todayStr)
              .get()
            assignmentsSnapshot.forEach((doc) => {
              const teamsData = doc.data().teams || {}
              const updates = {}
              let needsUpdate = false
              for (const teamKey in teamsData) {
                if (teamKey.startsWith(patientId + '-')) {
                  updates[`teams.${teamKey}`] = FieldValue.delete()
                  needsUpdate = true
                  assignmentCount++
                }
              }
              if (needsUpdate) {
                assignmentsBatch.update(doc.ref, updates)
              }
            })
            if (assignmentCount > 0) {
              await assignmentsBatch.commit()
              logger.info(`    - 共清理了 ${assignmentCount} 個護理分組`)
            }

            await cancelFutureExceptionsForPatient(patientId)
            logger.info(`    - 成功將 patient/${patientId} 標記為刪除並完成所有清理工作`)
            break

          case 'RESTORE_PATIENT':
            const patientToRestoreRef = db.collection('patients').doc(patientId)
            if (!payload.status) {
              throw new Error("Payload for RESTORE_PATIENT is missing 'status'.")
            }
            const restoreData = {
              isDeleted: false,
              status: payload.status,
              wardNumber: payload.wardNumber || null,
              deleteReason: FieldValue.delete(),
              deletedAt: FieldValue.delete(),
              originalStatus: FieldValue.delete(),
            }
            await patientToRestoreRef.update(restoreData)
            logger.info(`    - 成功將 patient/${patientId} 從刪除名單中復原至 ${payload.status}。`)
            break

          default:
            throw new Error(`未知的變更類型: ${changeType}`)
        }

        await doc.ref.update({ status: 'completed' })
      } catch (error) {
        logger.error(`  - ❌ 處理任務 ${taskId} 失敗:`, error)
        await doc.ref.update({ status: 'error', errorMessage: error.message })
      }
    }

    logger.info('✅ [Updater] 所有預約變更任務處理完畢。')
    return null
  },
)

// ===================================================================
// ✨【全新函式 v5.3 - 含歷史保護版】
// 當護理總班表更新時，讀取手動設定的組別，並同步到每日分組文件。
// 只同步今天(含)以後的日期，保護歷史記錄
// ===================================================================
exports.syncAndCreateAssignments = onDocumentWritten(
  'nursing_schedules/{yearMonth}',
  async (event) => {
    const yearMonth = event.params.yearMonth
    const afterData = event.data?.after.data()

    if (!afterData || !afterData.scheduleByNurse) {
      logger.info(`[SyncManualGroups-v5.3] 總班表 ${yearMonth} 被刪除或無資料，跳過。`)
      return null
    }

    logger.info(`🚀 [SyncManualGroups-v5.3] 偵測到總班表 ${yearMonth} 更新，開始同步手動分組...`)

    try {
      // ✨ 新增：取得今天的日期（台北時區）
      const todayStr = getTaipeiTodayString()

      const [year, month] = yearMonth.split('-').map(Number)
      const daysInMonth = new Date(year, month, 0).getDate()
      const batch = db.batch()
      let updatedCount = 0
      let createdCount = 0
      let skippedCount = 0

      // 對每一天進行處理
      for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${yearMonth}-${String(day).padStart(2, '0')}`
        const dateIndex = day - 1

        // ✨ 新增：跳過過去的日期
        if (dateStr < todayStr) {
          skippedCount++
          logger.info(`  └─ [跳過] ${dateStr} 為歷史資料，不進行修改`)
          continue
        }

        // 產生新的 names
        const newNames = {}
        for (const nurseId in afterData.scheduleByNurse) {
          const nurseData = afterData.scheduleByNurse[nurseId]
          const shift = (nurseData.shifts?.[dateIndex] || '').trim()
          const group = (nurseData.groups?.[dateIndex] || '').trim()

          if (shift && !['休', '例', '國定', ''].includes(shift)) {
            let prefix = ''
            if (['74', '75', '816', '74/L', '84', '815', '7-3', '8-4', '7-5'].includes(shift)) {
              prefix = '早'
            } else if (['311', '3-11', '311C'].includes(shift)) {
              prefix = '晚'
            } else {
              prefix = '早'
            }

            if (group) {
              const teamName = `${prefix}${group}`
              newNames[teamName] = nurseData.nurseName
            }
          }
        }

        // 使用日期作為文件 ID
        const docRef = db.collection('nurse_assignments').doc(dateStr)
        const existingDoc = await docRef.get()

        if (existingDoc.exists) {
          // 文件存在：更新 names，保留 teams
          const existingData = existingDoc.data()
          const existingNames = existingData.names || {}
          const existingTeams = existingData.teams || {}

          // 只有當 names 有變化時才更新
          if (JSON.stringify(newNames) !== JSON.stringify(existingNames)) {
            batch.update(docRef, {
              names: newNames,
              // 保留原有的 teams
              updatedAt: FieldValue.serverTimestamp(),
              syncSource: 'nursing_schedule', // ✨ 標記更新來源
            })
            updatedCount++
            logger.info(`  └─ [更新] ${dateStr} 的護理師指派已更新（保留病人分組）`)
          }
        } else {
          // 文件不存在：創建新文件（只處理未來日期）
          if (Object.keys(newNames).length > 0) {
            batch.set(docRef, {
              date: dateStr,
              names: newNames,
              teams: {},
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
              syncSource: 'nursing_schedule', // ✨ 標記創建來源
            })
            createdCount++
            logger.info(`  └─ [創建] ${dateStr} 的新分組文件已創建`)
          }
        }
      }

      // ✨ 新增：清理重複文件（只處理今天以後的）
      const cleanupQuery = db
        .collection('nurse_assignments')
        .where('date', '>=', todayStr)
        .where('date', '<=', `${yearMonth}-31`)

      const allDocs = await cleanupQuery.get()
      const dateDocMap = new Map()

      // 找出所有重複的文件
      allDocs.docs.forEach((doc) => {
        const docData = doc.data()
        const date = docData.date
        if (date && date >= todayStr) {
          // ✨ 再次確認日期
          if (!dateDocMap.has(date)) {
            dateDocMap.set(date, [])
          }
          dateDocMap.set(date, [...dateDocMap.get(date), doc])
        }
      })

      // 合併並刪除重複文件
      let mergedCount = 0
      for (const [date, docs] of dateDocMap.entries()) {
        if (docs.length > 1) {
          logger.warn(`  └─ 發現 ${date} 有 ${docs.length} 個重複文件，進行合併...`)

          // 合併所有文件的資料
          let mergedTeams = {}
          let mergedNames = {}
          let keepDocId = date // 使用日期作為保留的文件 ID

          docs.forEach((doc) => {
            const data = doc.data()
            // 合併 teams
            if (data.teams) {
              mergedTeams = { ...mergedTeams, ...data.teams }
            }
            // 合併 names（後面的會覆蓋前面的）
            if (data.names) {
              mergedNames = { ...mergedNames, ...data.names }
            }
          })

          // 更新或創建標準文件
          batch.set(db.collection('nurse_assignments').doc(keepDocId), {
            date: date,
            teams: mergedTeams,
            names: mergedNames,
            updatedAt: FieldValue.serverTimestamp(),
            createdAt: FieldValue.serverTimestamp(),
            syncSource: 'nursing_schedule_cleanup', // ✨ 標記合併來源
          })

          // 刪除所有非標準 ID 的文件
          docs.forEach((doc) => {
            if (doc.id !== keepDocId) {
              batch.delete(doc.ref)
              logger.info(`    └─ 刪除重複文件: ${doc.id}`)
            }
          })
          mergedCount++
        }
      }

      if (updatedCount > 0 || createdCount > 0 || mergedCount > 0) {
        await batch.commit()
        logger.info(
          `✅ [SyncManualGroups-v5.3] 批次提交完成！\n` +
            `  - 更新: ${updatedCount} 份\n` +
            `  - 創建: ${createdCount} 份\n` +
            `  - 合併: ${mergedCount} 組重複\n` +
            `  - 跳過: ${skippedCount} 份歷史資料`,
        )
      } else {
        logger.info(
          `✅ [SyncManualGroups-v5.3] 檢查完畢，無需更新。` + `（跳過 ${skippedCount} 份歷史資料）`,
        )
      }
    } catch (error) {
      logger.error(`❌ [SyncManualGroups-v5.3] 同步/創建 ${yearMonth} 的分組文件時發生錯誤:`, error)
    }
    return null
  },
)

/**
 * ✨【手動觸發】強制重新同步未來60天的排程 ✨
 * - 步驟 1: 根據總表完全覆蓋未來60天的基礎排程。
 * - 步驟 2: 查找所有未來有效的調班申請。
 * - 步驟 3: 透過更新調班文件的狀態，來重新觸發調班處理邏輯，讓系統自動重新套用它們。
 * 僅限管理員使用。
 * 🔧 v2.0: 支援動態 autoNote 生成
 */
exports.forceResyncAllSchedules = onCall(
  { cors: allowedOrigins, timeoutSeconds: 540, memory: '1GiB' },
  async (request) => {
    // 權限檢查
    if (request.auth?.token?.role !== 'admin') {
      throw new HttpsError('permission-denied', '此操作需要管理員權限。')
    }

    const { dryRun = false } = request.data // 新增 dryRun 模式，用於測試
    const logPrefix = dryRun ? '[ForceResync-DryRun]' : '[ForceResync]'
    logger.info(`🚀 ${logPrefix} 手動強制重新同步所有未來排程...`)

    try {
      // --- 步驟 1: 根據總表，完全重建未來 60 天的基礎排程 ---
      logger.info(`${logPrefix} 步驟 1/3: 正在重建基礎排程...`)
      const masterDoc = await db.collection('base_schedules').doc('MASTER_SCHEDULE').get()
      if (!masterDoc.exists) {
        throw new HttpsError('not-found', '找不到 MASTER_SCHEDULE 文件。')
      }
      const masterRules = masterDoc.data().schedule || {}

      // 🔥 v2.0: 查詢所有病人資料，用於動態生成 autoNote
      const patientsSnapshot = await db.collection('patients').where('isDeleted', '!=', true).get()
      const patientsMap = new Map()
      patientsSnapshot.forEach((doc) => {
        patientsMap.set(doc.id, doc.data())
      })
      logger.info(`${logPrefix} Loaded ${patientsMap.size} patients for dynamic autoNote.`)

      // 🔥 修正：使用字串為基礎的日期計算
      const todayStr = getTaipeiTodayString()

      const scheduleRebuildBatch = db.batch()
      let rebuiltCount = 0

      for (let i = 0; i < 60; i++) {
        // 🔥 修正：使用 UTC 日期計算
        const targetDate = new Date(todayStr + 'T00:00:00Z')
        targetDate.setUTCDate(targetDate.getUTCDate() + i)
        const dateStr = formatDateToYYYYMMDD(targetDate)

        // 🔥 v2.0: 傳遞 patientsMap 以動態生成 autoNote
        const newDailySchedule = generateDailyScheduleFromRules(masterRules, dateStr, patientsMap)

        const scheduleRef = db.collection('schedules').doc(dateStr)
        scheduleRebuildBatch.set(scheduleRef, {
          date: dateStr,
          schedule: newDailySchedule,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          syncMethod: 'force_resync_base_v2', // 標記為強制重建 (v2.0)
        })
        rebuiltCount++
      }

      if (!dryRun) {
        await scheduleRebuildBatch.commit()
      }
      logger.info(`${logPrefix} ✅ 成功重建 ${rebuiltCount} 天的基礎排程。`)

      // --- 步驟 2: 查找所有未來需要重新套用的調班申請 ---
      logger.info(`${logPrefix} 步驟 2/3: 正在查找未來的有效調班...`)
      // todayStr 已經在上面宣告了，不需要重複宣告
      const exceptionsToReapply = []

      const exceptionsQuery = db
        .collection('schedule_exceptions')
        .where('status', 'in', ['applied', 'conflict_requires_resolution'])
        // 根據不同類型查詢日期，確保撈到所有未來的調班
        // Firestore 不支持 OR 查詢，所以我們需要分開查詢或簡化邏輯
        // 簡化：撈取所有 'applied' 的，然後在程式中過濾日期
        .where('status', '==', 'applied')

      const snapshot = await exceptionsQuery.get()

      snapshot.forEach((doc) => {
        const ex = doc.data()
        const latestDate = ex.endDate || ex.to?.goalDate || ex.date || ex.startDate
        if (latestDate && latestDate >= todayStr) {
          exceptionsToReapply.push({ id: doc.id, data: ex })
        }
      })

      if (exceptionsToReapply.length === 0) {
        logger.info(`${logPrefix} ✅ 找不到需要重新套用的未來調班。同步完成！`)
        return {
          success: true,
          message: `成功重建 ${rebuiltCount} 天的排程，沒有需要重新套用的調班。`,
        }
      }
      logger.info(`${logPrefix} 🔍 找到 ${exceptionsToReapply.length} 個需要重新套用的調班。`)

      // --- 步驟 3: 批次更新調班狀態以重新觸發處理 ---
      logger.info(`${logPrefix} 步驟 3/3: 正在觸發調班重新處理...`)
      const reapplyBatch = db.batch()

      exceptionsToReapply.forEach((ex) => {
        const docRef = db.collection('schedule_exceptions').doc(ex.id)
        reapplyBatch.update(docRef, {
          status: 'pending', // 將狀態重置為 pending
          reapplyTriggeredAt: FieldValue.serverTimestamp(), // 添加一個標記欄位
          // 清除舊的處理結果，以便重新執行
          appliedAt: FieldValue.delete(),
          processedDates: FieldValue.delete(),
          conflicts: FieldValue.delete(),
          conflictCount: FieldValue.delete(),
          errorMessage: FieldValue.delete(),
        })
      })

      if (!dryRun) {
        await reapplyBatch.commit()
      }

      const successMessage = `成功重建 ${rebuiltCount} 天的基礎排程，並已觸發 ${exceptionsToReapply.length} 個調班的重新套用程序。系統將在背景自動完成後續處理。`
      logger.info(`${logPrefix} ✅ ${successMessage}`)

      return {
        success: true,
        message: successMessage,
        rebuiltSchedules: rebuiltCount,
        retriggeredExceptions: exceptionsToReapply.length,
      }
    } catch (error) {
      logger.error(`❌ ${logPrefix} 強制同步失敗:`, error)
      throw new HttpsError('internal', `強制同步過程中發生錯誤: ${error.message}`)
    }
  },
)
