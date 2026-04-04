// 檔案路徑: src/services/optimizedApiService.js (✨ 最終功能增強版 ✨)
import ApiManager from '@/services/api_manager'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '@/firebase'
import { getNowISO, formatDateToYYYYMMDD } from '@/utils/dateUtils'

// 快取系統... (保持不變)
const cache = new Map()
const CACHE_TTL = 30000
function getCacheKey(operation, collection, id = null) {
  return `${operation}:${collection}${id ? `:${id}` : ''}`
}
function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() })
}
function getCache(key) {
  const cached = cache.get(key)
  if (!cached) return null
  const isExpired = Date.now() - cached.timestamp > CACHE_TTL
  if (isExpired) {
    cache.delete(key)
    return null
  }
  return cached.data
}
function clearCacheByPattern(pattern) {
  const keysToDelete = []
  for (const key of cache.keys()) {
    if (key.includes(pattern)) {
      keysToDelete.push(key)
    }
  }
  keysToDelete.forEach((key) => cache.delete(key))
}

// 批次處理系統... (保持不變)
const batchQueue = new Map()
const BATCH_DELAY = 50
function addToBatch(operation, collection, id, data) {
  const batchKey = `${operation}:${collection}`
  if (!batchQueue.has(batchKey)) {
    batchQueue.set(batchKey, { items: [], timeout: null })
  }
  const batch = batchQueue.get(batchKey)
  batch.items.push({ id, data })
  if (batch.timeout) {
    clearTimeout(batch.timeout)
  }
  batch.timeout = setTimeout(() => {
    processBatch(operation, collection, batch.items)
    batchQueue.delete(batchKey)
  }, BATCH_DELAY)
}
async function processBatch(operation, collection, items) {
  const api = ApiManager(collection)
  const startTime = performance.now()
  try {
    console.log(`🚀 [Batch] 開始處理 ${operation} 批次操作 (${items.length} 項目)`)
    if (operation === 'update') {
      await Promise.all(items.map((item) => api.update(item.id, item.data)))
    } else if (operation === 'save') {
      await Promise.all(items.map((item) => api.save(item.data)))
    } else if (operation === 'delete') {
      await Promise.all(items.map((item) => api.delete(item.id)))
    }
    const endTime = performance.now()
    console.log(`✅ [Batch] ${operation} 批次操作完成，耗時 ${(endTime - startTime).toFixed(2)}ms`)
    clearCacheByPattern(collection)
  } catch (error) {
    console.error(`❌ [Batch] ${operation} 批次操作失敗:`, error)
    throw error
  }
}

// 資料驗證... (保持不變)
function sanitizePatientData(patientData) {
  const cleaned = { ...patientData }
  if (cleaned.medicalRecordNumber) {
    cleaned.medicalRecordNumber = cleaned.medicalRecordNumber.toString().trim()
  }
  if (cleaned.name) {
    cleaned.name = cleaned.name.toString().trim()
  }
  return cleaned
}
function validatePatientData(patientData) {
  const errors = []
  if (!patientData.medicalRecordNumber || !patientData.medicalRecordNumber.trim()) {
    errors.push('病歷號不能為空')
  }
  if (!patientData.name || !patientData.name.trim()) {
    errors.push('病人姓名不能為空')
  }
  if (errors.length > 0) {
    throw new Error(errors.join(', '))
  }
}

// 排程相關函式... (保持不變)
export async function fetchAllSchedules(queries = []) {
  const api = ApiManager('schedules')
  return api.fetchAll(queries)
}
export async function saveSchedule(scheduleData) {
  const api = ApiManager('schedules')
  const result = await api.save(scheduleData)
  clearCacheByPattern('schedules')
  return result
}
export async function updateSchedule(scheduleId, updateData) {
  const api = ApiManager('schedules')
  await api.update(scheduleId, updateData)
  clearCacheByPattern('schedules')
}

// 患者相關函式... (保持不變)
export async function fetchAllPatients() {
  const cacheKey = getCacheKey('fetchAll', 'patients_with_rules')
  const cached = getCache(cacheKey)
  if (cached) return cached

  const patientsApi = ApiManager('patients')
  const schedulesApi = ApiManager('base_schedules')
  const [patients, masterScheduleDoc] = await Promise.all([
    patientsApi.fetchAll(),
    schedulesApi.fetchById('MASTER_SCHEDULE'),
  ])
  const masterRules = masterScheduleDoc?.schedule || {}
  const rulesMap = new Map(Object.entries(masterRules))
  const patientsWithRules = patients.map((patient) => ({
    ...patient,
    scheduleRule: rulesMap.get(patient.id) || null,
  }))
  setCache(cacheKey, patientsWithRules)
  return patientsWithRules
}
export async function savePatient(patientData) {
  const cleanedData = sanitizePatientData(patientData)
  validatePatientData(cleanedData)
  const api = ApiManager('patients')
  const result = await api.save(cleanedData)
  clearCacheByPattern('patients')
  return result
}
export async function updatePatient(patientId, updateData) {
  const cleanedData = { ...updateData }
  if (cleanedData.medicalRecordNumber) {
    cleanedData.medicalRecordNumber = cleanedData.medicalRecordNumber.toString().trim()
  }
  const api = ApiManager('patients')
  await api.update(patientId, cleanedData)
  clearCacheByPattern('patients')
}

// === 護理職責 (Nursing Duties) 相關函式
const DUTY_DOC_ID = 'main' // 使用一個固定的文件 ID

/**
 * 從 Firestore 獲取護理工作職責
 * @returns {Promise<object>}
 */
export async function fetchDuties() {
  const cacheKey = getCacheKey('fetch', 'nursing_duties', DUTY_DOC_ID)
  const cached = getCache(cacheKey)
  if (cached) {
    console.log('✅ [API] 從快取獲取護理職責資料')
    return cached
  }

  try {
    const docRef = doc(db, 'nursing_duties', DUTY_DOC_ID)
    const docSnap = await getDoc(docRef)

    if (docSnap.exists()) {
      const data = docSnap.data()
      console.log('✅ [API] 從 Firestore 成功獲取護理職責資料')
      setCache(cacheKey, data) // 存入快取
      return data
    } else {
      console.log('⚠️ [API] 在 Firestore 中找不到護理職責文件，回傳空值。')
      return null // 回傳 null，讓前端處理預設值
    }
  } catch (error) {
    console.error('❌ [API] 獲取護理職責失敗:', error)
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
    await setDoc(docRef, data, { merge: true })
    console.log('✅ [API] 護理職責資料已成功儲存到 Firestore')
    // 清除相關快取
    clearCacheByPattern('nursing_duties')
  } catch (error) {
    console.error('❌ [API] 儲存護理職責失敗:', error)
    throw new Error('儲存護理職責到資料庫時發生錯誤。')
  }
}

// 備忘錄相關函式... (保持不變)
export async function fetchAllMemos(queryConstraints = null) {
  const api = ApiManager('memos')
  return queryConstraints ? api.fetchAll(queryConstraints) : api.fetchAll()
}
// (saveMemo, updateMemo, deleteMemo 保持不變)
export async function saveMemo(memoData) {
  const api = ApiManager('memos')
  const result = await api.save(memoData)
  clearCacheByPattern('memos')
  return result
}
export async function updateMemo(memoId, updateData) {
  const api = ApiManager('memos')
  await api.update(memoId, updateData)
  clearCacheByPattern('memos')
}
export async function deleteMemo(memoId) {
  const api = ApiManager('memos')
  await api.delete(memoId)
  clearCacheByPattern('memos')
}

// 透析醫囑歷史相關函式
export async function fetchDialysisOrderHistory(queryConstraints = null) {
  const api = ApiManager('dialysis_orders_history')
  return queryConstraints ? api.fetchAll(queryConstraints) : api.fetchAll()
}
export async function saveDialysisOrderHistory(historyData) {
  const api = ApiManager('dialysis_orders_history')
  const completeData = {
    ...historyData,
    createdAt: historyData.createdAt || getNowISO(),
    updatedAt: historyData.updatedAt || getNowISO(),
    operationType: historyData.operationType || 'CREATE',
  }
  return api.save(completeData)
}

// ✨ [這是最重要的修改！] ✨
export async function createDialysisOrderAndUpdatePatient(patientId, patientName, orderData) {
  console.log(`📝 [API] 開始為 ${patientName} 創建/更新醫囑...`, orderData)
  const parseNumeric = (v) => (v === '' || v == null ? null : Number(v))
  const now = getNowISO()

  const historyRecord = {
    patientId,
    patientName,
    operationType: 'UPDATE',
    createdAt: now,
    updatedAt: now,
    orders: {
      ak: orderData.ak || '',
      dialysateCa: orderData.dialysateCa || '',
      heparinInitial: parseNumeric(orderData.heparinInitial),
      heparinMaintenance: parseNumeric(orderData.heparinMaintenance),
      heparinLM: `${orderData.heparinInitial || '0'}/${orderData.heparinMaintenance || '0'}`,
      bloodFlow: parseNumeric(orderData.bloodFlow),
      dryWeight: parseNumeric(orderData.dryWeight),
      effectiveDate: orderData.effectiveDate || formatDateToYYYYMMDD(),
      vascAccess: orderData.vascAccess || '',
      arterialNeedle: orderData.arterialNeedle || '',
      venousNeedle: orderData.venousNeedle || '',
      physician: orderData.physician || '',
      mode: orderData.mode || '',
      freq: orderData.freq || '',
      dialysisHours: parseNumeric(orderData.dialysisHours),
      dialysateFlow: parseNumeric(orderData.dialysateFlow),
      replacementFlow: parseNumeric(orderData.replacementFlow),
      dehydration: orderData.dehydration || '',
      mannitol: orderData.mannitol || '',
      heparinRinse: orderData.heparinRinse || '',
      // ✅ [核心修正 1] 將 icuNote 加入到儲存的物件中
      icuNote: orderData.icuNote || '',
      // 相容性欄位
      artificialKidney: orderData.ak || '',
      dialysate: orderData.dialysateCa || '',
    },
  }

  // 從 PP/DFPP 醫囑複製額外欄位
  if (orderData.mode === 'PP' || orderData.mode === 'DFPP') {
    historyRecord.orders.bw = orderData.bw
    historyRecord.orders.hct = orderData.hct
    historyRecord.orders.exchangeMultiplier = orderData.exchangeMultiplier
    historyRecord.orders.plasmaVolume = orderData.plasmaVolume
    historyRecord.orders.exchangeVolume = orderData.exchangeVolume
    historyRecord.orders.heparin = orderData.heparin
  }

  const latestOrdersForPatient = { ...historyRecord.orders }

  try {
    await Promise.all([
      // ✅ [核心修正 2] 呼叫 saveDialysisOrderHistory 時傳入正確的參數
      saveDialysisOrderHistory(historyRecord),
      updatePatient(patientId, { dialysisOrders: latestOrdersForPatient, updatedAt: now }),
    ])
    console.log(`✅ [API] 成功為 ${patientName} 創建並同步醫囑。`)
    clearCacheByPattern('patients')
  } catch (error) {
    console.error(`❌ [API] 為 ${patientName} 創建醫囑時發生嚴重錯誤:`, error)
    throw new Error(`儲存醫囑失敗: ${error.message}`)
  }
}

export async function deleteDialysisOrderHistory(historyId) {
  try {
    const api = ApiManager('dialysis_orders_history')
    await api.delete(historyId)
  } catch (error) {
    if (error.code === 'permission-denied') {
      throw new Error('權限不足：無法刪除此透析醫囑歷史記錄')
    } else if (error.code === 'not-found') {
      throw new Error('記錄不存在：此透析醫囑歷史記錄可能已被刪除')
    } else {
      throw new Error(`刪除失敗：${error.message}`)
    }
  }
}

// 患者歷史相關函式... (保持不變)
export async function fetchPatientHistory(queryConstraints = null) {
  const api = ApiManager('patient_history')
  return queryConstraints ? await api.fetchAll(queryConstraints) : await api.fetchAll()
}
export async function savePatientHistory(historyData) {
  const api = ApiManager('patient_history')
  return api.save(historyData)
}

// 快取與批次處理函式... (保持不變)
export function clearAllCache() {
  cache.clear()
}
export function clearCacheByCollection(collection) {
  clearCacheByPattern(collection)
}
export function getCacheStats() {
  const stats = { totalItems: cache.size, collections: {} }
  for (const key of cache.keys()) {
    const collection = key.split(':')[1]
    if (!stats.collections[collection]) stats.collections[collection] = 0
    stats.collections[collection]++
  }
  return stats
}
export function batchUpdatePatients(updates) {
  updates.forEach(({ id, data }) => addToBatch('update', 'patients', id, data))
}
export function batchUpdateSchedules(updates) {
  updates.forEach(({ id, data }) => addToBatch('update', 'schedules', id, data))
}
export function batchSaveMemos(memos) {
  memos.forEach((data) => addToBatch('save', 'memos', null, data))
}

export default {
  fetchAllSchedules,
  saveSchedule,
  updateSchedule,
  fetchAllPatients,
  savePatient,
  updatePatient,
  fetchAllMemos,
  saveMemo,
  updateMemo,
  deleteMemo,
  fetchDialysisOrderHistory,
  saveDialysisOrderHistory,
  deleteDialysisOrderHistory,
  createDialysisOrderAndUpdatePatient,
  fetchPatientHistory,
  savePatientHistory,
  clearAllCache,
  clearCacheByCollection,
  getCacheStats,
  batchUpdatePatients,
  batchUpdateSchedules,
  batchSaveMemos,
  fetchDuties,
  saveDuties,
}
