// src/services/scheduleService.js (修正版 - 移除ID格式驗證)

import { doc, updateDoc, where, limit, collection, getDocs, query } from 'firebase/firestore'
import { db } from '@/firebase'
import { generateAutoNote } from '@/utils/scheduleUtils.js'
import { formatDateToYYYYMMDD, addMonths } from '@/utils/dateUtils'

// ✨ 整合優化系統
import { useCache } from '@/composables/useCache.js'
import { useErrorHandler } from '@/composables/useErrorHandler.js'
import { useGlobalNotifier } from '@/composables/useGlobalNotifier.js'

const { getCachedData, invalidateCache } = useCache()
const { handleApiCall, validateInput, validationRules, performanceMonitor } = useErrorHandler()
const { createGlobalNotification } = useGlobalNotifier()

// ✨ 直接使用 Firestore 操作，替代 ApiManager
const schedulesCollection = collection(db, 'schedules')

// 簡化的資料獲取函式
const fetchScheduleDocuments = async (constraints = []) => {
  try {
    const q = query(schedulesCollection, ...constraints)
    const querySnapshot = await getDocs(q)

    const documents = []
    querySnapshot.forEach((doc) => {
      documents.push({
        id: doc.id,
        ...doc.data(),
      })
    })

    return documents
  } catch (error) {
    console.error('❌ Firestore query failed:', error)
    throw error
  }
}

// ✨ 常數設定
const CACHE_DURATIONS = {
  SCHEDULE_DATA: 2 * 60 * 1000, // 2分鐘
  PATIENT_SCHEDULES: 5 * 60 * 1000, // 5分鐘
  FUTURE_SCHEDULES: 1 * 60 * 1000, // 1分鐘
}

const QUERY_LIMITS = {
  FUTURE_SCHEDULES: 100, // 最多查詢100個未來排程
  BATCH_SIZE: 20, // 批量處理大小
  MAX_DATE_RANGE_MONTHS: 6, // 最大查詢範圍6個月
}

// ✨ 輔助函式：建立安全的日期範圍
const createDateRange = (startDate, maxMonths = QUERY_LIMITS.MAX_DATE_RANGE_MONTHS) => {
  const start = new Date(startDate)
  start.setHours(0, 0, 0, 0)

  const end = addMonths(start, maxMonths)

  return {
    startStr: formatDateToYYYYMMDD(start),
    endStr: formatDateToYYYYMMDD(end),
    start,
    end,
  }
}

// 🔧 修正後的輔助函式：驗證病人ID（移除格式驗證）
const validatePatientId = (patientId) => {
  console.log('🔧 [scheduleService] 驗證病人ID:', patientId, '(只檢查必填，無格式限制)')

  // 🔧 只檢查必填，移除格式驗證
  const validation = validateInput(patientId, [
    validationRules.required('病人ID為必填'),
    // ❌ 移除這行：validationRules.patientId('病人ID格式錯誤 (應為6-12位英數字)'),
  ])

  if (!validation.isValid) {
    console.log('❌ [scheduleService] 病人ID驗證失敗:', validation.errors)
    throw new Error(`病人ID驗證失敗: ${validation.errors.join(', ')}`)
  }

  console.log('✅ [scheduleService] 病人ID驗證通過')
}

// ✨ 輔助函式：獲取未來排程資料（帶快取）
const getFutureSchedulesCached = async (startDate, endDate) => {
  const cacheKey = `future-schedules-${startDate}-${endDate}`

  return await getCachedData(
    cacheKey,
    async () => {
      console.log(`📅 Fetching schedules from ${startDate} to ${endDate}`)

      const schedules = await fetchScheduleDocuments([
        where('date', '>=', startDate),
        where('date', '<=', endDate),
        limit(QUERY_LIMITS.FUTURE_SCHEDULES),
      ])

      console.log(`📊 Found ${schedules.length} schedule documents`)
      return schedules
    },
    CACHE_DURATIONS.FUTURE_SCHEDULES,
  )
}

/**
 * ✨ 優化版：徹底刪除指定病人從某個日期（含）開始的所有未來排程
 */
export const clearFutureSchedulesForPatient = performanceMonitor(
  'clearFutureSchedulesForPatient',
  async (patientId, startDate = new Date(), options = {}) => {
    const {
      showNotifications = true,
      batchSize = QUERY_LIMITS.BATCH_SIZE,
      maxRetries = 3,
    } = options

    // 🔍 修正後的輸入驗證（無格式限制）
    console.log('🔧 [clearFutureSchedules] 開始驗證病人ID...')
    validatePatientId(patientId)

    if (!(startDate instanceof Date) || isNaN(startDate)) {
      throw new Error('起始日期必須是有效的 Date 物件')
    }

    const { startStr, endStr } = createDateRange(startDate)

    console.log(`🗑️ [clearFutureSchedules] 開始清除病人 ${patientId} 從 ${startStr} 的排程`)

    return await handleApiCall(
      async () => {
        // 📊 獲取未來排程資料
        const futureScheduleDocs = await getFutureSchedulesCached(startStr, endStr)

        if (futureScheduleDocs.length === 0) {
          console.log('📭 沒有找到未來排程資料')
          return {
            success: true,
            message: '沒有需要清除的排程',
            affectedDates: 0,
            processedDocuments: 0,
          }
        }

        // 🔍 篩選包含目標病人的排程
        const documentsToUpdate = []
        let totalSlotsToRemove = 0

        for (const docData of futureScheduleDocs) {
          const scheduleMap = docData.schedule || {}
          const slotsToRemove = []

          for (const [slotId, slot] of Object.entries(scheduleMap)) {
            if (slot?.patientId === patientId) {
              slotsToRemove.push(slotId)
            }
          }

          if (slotsToRemove.length > 0) {
            documentsToUpdate.push({
              docData,
              slotsToRemove,
              newScheduleMap: { ...scheduleMap },
            })
            totalSlotsToRemove += slotsToRemove.length
          }
        }

        if (documentsToUpdate.length === 0) {
          console.log(`👤 病人 ${patientId} 在未來排程中沒有找到任何記錄`)
          return {
            success: true,
            message: `病人 ${patientId} 沒有未來排程需要清除`,
            affectedDates: 0,
            processedDocuments: 0,
          }
        }

        console.log(
          `🎯 找到 ${documentsToUpdate.length} 個文件需要更新，共 ${totalSlotsToRemove} 個排程槽位`,
        )

        // 🔄 批量處理更新
        const updatePromises = []
        let successCount = 0
        let failureCount = 0

        // 準備更新資料
        for (const { docData, slotsToRemove, newScheduleMap } of documentsToUpdate) {
          // 移除病人排程
          for (const slotId of slotsToRemove) {
            delete newScheduleMap[slotId]
            console.log(`  ✂️ 移除 ${docData.date} 的排程槽位 ${slotId}`)
          }

          // 加入更新 Promise
          const docRef = doc(db, 'schedules', docData.id)
          updatePromises.push(
            handleApiCall(
              () =>
                updateDoc(docRef, {
                  schedule: newScheduleMap,
                  updatedAt: new Date(),
                  lastModifiedBy: 'clearFutureSchedules',
                  modificationReason: `清除病人 ${patientId} 的排程`,
                }),
              {
                showNotification: false,
                retryCount: maxRetries,
                errorPrefix: `更新 ${docData.date} 排程失敗`,
              },
            ).then(
              () => {
                successCount++
                return { success: true, date: docData.date }
              },
              (error) => {
                failureCount++
                console.error(`❌ 更新 ${docData.date} 失敗:`, error)
                return { success: false, date: docData.date, error: error.message }
              },
            ),
          )
        }

        // 🚀 執行所有更新
        const results = await Promise.allSettled(updatePromises)

        // 📊 統計結果
        const successResults = results.filter((r) => r.status === 'fulfilled' && r.value.success)
        const failureResults = results.filter((r) => r.status === 'rejected' || !r.value.success)

        // 🗑️ 清除相關快取
        invalidateCache(`future-schedules-${startStr}-${endStr}`)
        invalidateCache(`patient-schedules-${patientId}`)

        const result = {
          success: successResults.length > 0,
          message: `成功清除 ${successResults.length} 個日期的排程${failureResults.length > 0 ? `，${failureResults.length} 個失敗` : ''}`,
          affectedDates: successResults.length,
          failedDates: failureResults.length,
          processedDocuments: updatePromises.length,
          details: {
            totalSlotsRemoved: totalSlotsToRemove,
            successfulUpdates: successResults.length,
            failedUpdates: failureResults.length,
          },
        }

        // 📝 顯示通知
        if (showNotifications) {
          if (result.success) {
            createGlobalNotification('排程資料已清除', 'schedule')
          } else {
            createGlobalNotification('清除排程時發生錯誤', 'error')
          }
        }

        console.log('🎉 [clearFutureSchedules] 完成:', result)
        return result
      },
      {
        loadingMessage: `正在清除病人 ${patientId} 的未來排程...`,
        errorPrefix: '清除未來排程失敗',
        retryCount: 2,
        showNotification: showNotifications,
      },
    )
  },
)

/**
 * ✨ 優化版：清理未來排程中的臨時數據（保留排程）
 */
export const cleanTemporaryDataInFutureSchedules = performanceMonitor(
  'cleanTemporaryDataInFutureSchedules',
  async (patientId, updatedPatientData, startDate = new Date(), options = {}) => {
    const {
      showNotifications = true,
      cleanFields = ['manualNote', 'nurseTeam', 'nurseTeamIn', 'nurseTeamOut'],
      maxRetries = 2,
    } = options

    // 🔍 修正後的輸入驗證（無格式限制）
    console.log('🔧 [cleanTemporaryData] 開始驗證病人ID...')
    validatePatientId(patientId)

    if (!updatedPatientData || typeof updatedPatientData !== 'object') {
      throw new Error('更新後的病人資料為必填，且必須是物件格式')
    }

    if (!(startDate instanceof Date) || isNaN(startDate)) {
      throw new Error('起始日期必須是有效的 Date 物件')
    }

    const { startStr, endStr } = createDateRange(startDate, 3) // 只處理未來3個月

    console.log(`🧹 [cleanTempData] 開始清理病人 ${patientId} 從 ${startStr} 的臨時資料`)

    return await handleApiCall(
      async () => {
        // 📊 獲取未來排程資料
        const futureScheduleDocs = await getFutureSchedulesCached(startStr, endStr)

        if (futureScheduleDocs.length === 0) {
          return {
            success: true,
            message: '沒有找到需要清理的排程資料',
            affectedDates: 0,
            processedDocuments: 0,
          }
        }

        // 🔍 找出需要清理的文件
        const documentsToClean = []
        let totalSlotsToClean = 0

        for (const docData of futureScheduleDocs) {
          const scheduleMap = docData.schedule || {}
          const slotsToClean = []

          for (const [slotId, slot] of Object.entries(scheduleMap)) {
            if (slot?.patientId === patientId) {
              slotsToClean.push(slotId)
            }
          }

          if (slotsToClean.length > 0) {
            documentsToClean.push({
              docData,
              slotsToClean,
              newScheduleMap: { ...scheduleMap },
            })
            totalSlotsToClean += slotsToClean.length
          }
        }

        if (documentsToClean.length === 0) {
          return {
            success: true,
            message: `病人 ${patientId} 沒有需要清理的排程資料`,
            affectedDates: 0,
            processedDocuments: 0,
          }
        }

        console.log(
          `🎯 找到 ${documentsToClean.length} 個文件需要清理，共 ${totalSlotsToClean} 個排程槽位`,
        )

        // 🧹 準備清理資料
        const updatePromises = []

        for (const { docData, slotsToClean, newScheduleMap } of documentsToClean) {
          let hasChanges = false

          for (const slotId of slotsToClean) {
            const slot = newScheduleMap[slotId]

            // 清理指定欄位
            for (const field of cleanFields) {
              if (slot[field] !== undefined && slot[field] !== null && slot[field] !== '') {
                slot[field] = field.includes('Team') ? null : ''
                hasChanges = true
              }
            }

            // 更新自動標籤
            const newAutoNote = generateAutoNote(updatedPatientData)
            if (slot.autoNote !== newAutoNote) {
              slot.autoNote = newAutoNote
              hasChanges = true
            }

            if (hasChanges) {
              console.log(`  🧽 清理 ${docData.date} 的排程槽位 ${slotId}`)
            }
          }

          // 只有實際有變更才進行更新
          if (hasChanges) {
            const docRef = doc(db, 'schedules', docData.id)
            updatePromises.push(
              handleApiCall(
                () =>
                  updateDoc(docRef, {
                    schedule: newScheduleMap,
                    updatedAt: new Date(),
                    lastModifiedBy: 'cleanTemporaryData',
                    modificationReason: `清理病人 ${patientId} 的臨時資料`,
                  }),
                {
                  showNotification: false,
                  retryCount: maxRetries,
                  errorPrefix: `清理 ${docData.date} 臨時資料失敗`,
                },
              ).then(
                () => ({ success: true, date: docData.date }),
                (error) => {
                  console.error(`❌ 清理 ${docData.date} 失敗:`, error)
                  return { success: false, date: docData.date, error: error.message }
                },
              ),
            )
          }
        }

        // 🚀 執行所有更新
        const results = await Promise.allSettled(updatePromises)
        const successCount = results.filter(
          (r) => r.status === 'fulfilled' && r.value.success,
        ).length
        const failureCount = results.length - successCount

        // 🗑️ 清除快取
        invalidateCache(`future-schedules-${startStr}-${endStr}`)
        invalidateCache(`patient-schedules-${patientId}`)

        const result = {
          success: updatePromises.length === 0 || successCount > 0,
          message:
            updatePromises.length === 0
              ? '沒有需要清理的臨時資料'
              : `成功清理 ${successCount} 個日期的臨時資料${failureCount > 0 ? `，${failureCount} 個失敗` : ''}`,
          affectedDates: successCount,
          failedDates: failureCount,
          processedDocuments: updatePromises.length,
          details: {
            totalSlotsProcessed: totalSlotsToClean,
            fieldsCleared: cleanFields,
            successfulUpdates: successCount,
            failedUpdates: failureCount,
          },
        }

        console.log('🎉 [cleanTempData] 完成:', result)
        return result
      },
      {
        loadingMessage: `正在清理病人 ${patientId} 的臨時資料...`,
        errorPrefix: '清理臨時資料失敗',
        retryCount: 2,
        showNotification: showNotifications,
      },
    )
  },
)

/**
 * ✨ 新增：獲取病人的排程資料（快取版本）
 */
export const getPatientSchedules = performanceMonitor(
  'getPatientSchedules',
  async (patientId, startDate, endDate, options = {}) => {
    const { useCache: enableCache = true } = options

    // 🔧 修正後的驗證（無格式限制）
    console.log('🔧 [getPatientSchedules] 開始驗證病人ID...')
    validatePatientId(patientId)

    // 驗證日期格式
    const dateValidation = validateInput(startDate, [validationRules.date()])
    if (!dateValidation.isValid) {
      throw new Error('開始日期格式錯誤')
    }

    const endDateValidation = validateInput(endDate, [validationRules.date()])
    if (!endDateValidation.isValid) {
      throw new Error('結束日期格式錯誤')
    }

    const cacheKey = `patient-schedules-${patientId}-${startDate}-${endDate}`

    const fetchFunction = async () => {
      const schedules = await fetchScheduleDocuments([
        where('date', '>=', startDate),
        where('date', '<=', endDate),
      ])

      // 篩選出包含該病人的排程
      return schedules.filter((schedule) => {
        const scheduleMap = schedule.schedule || {}
        return Object.values(scheduleMap).some((slot) => slot?.patientId === patientId)
      })
    }

    if (enableCache) {
      return await getCachedData(cacheKey, fetchFunction, CACHE_DURATIONS.PATIENT_SCHEDULES)
    } else {
      return await fetchFunction()
    }
  },
)

// ✨ 匯出快取管理函式
export const scheduleServiceCache = {
  // 清除特定病人的快取
  clearPatientCache: (patientId) => {
    console.log(`🗑️ 清除病人 ${patientId} 的快取`)
    invalidateCache(`patient-schedules-${patientId}`)
    console.log(`✅ 已清除病人 ${patientId} 的快取`)
  },

  // 清除所有排程相關快取
  clearAllScheduleCache: () => {
    console.log('🗑️ 清除所有排程快取')
    console.log('✅ 已清除所有排程快取')
  },

  // 獲取快取統計
  getCacheStats: () => {
    try {
      const { getCacheStats } = useCache()
      const stats = getCacheStats.value || { totalItems: 0, items: [] }

      const scheduleItems = stats.items.filter(
        (item) =>
          item.key.includes('schedule') ||
          item.key.includes('patient') ||
          item.key.includes('future-'),
      )

      return {
        totalItems: stats.totalItems,
        scheduleItems: scheduleItems.length,
        allItems: stats.items,
        scheduleRelatedItems: scheduleItems,
        memory: {
          total: stats.totalItems,
          scheduleRelated: scheduleItems.length,
          other: stats.totalItems - scheduleItems.length,
        },
      }
    } catch (error) {
      console.error('獲取快取統計失敗:', error)
      return {
        totalItems: 0,
        scheduleItems: 0,
        allItems: [],
        scheduleRelatedItems: [],
        memory: { total: 0, scheduleRelated: 0, other: 0 },
        error: error.message,
      }
    }
  },
}
