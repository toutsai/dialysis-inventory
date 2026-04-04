import * as XLSX from 'xlsx'
import { toRocDate } from '@/utils/kiditHelpers'

/**
 * 匯出 KiDit 報表
 * @param {Array} logbookEvents - 當月 kidit_logbook 裡所有的 events 陣列
 * @param {string} filename - 檔名
 */
export function exportKiDitExcel(logbookEvents, filename = 'KiDit_Export.xlsx') {
  const sheetData = {
    patients: [],
    history: [],
    access: [],
  }

  const processedPatientIds = new Set()

  logbookEvents.forEach((event) => {
    const p = event.kidit_profile || {}
    const h = event.kidit_history || {}
    const v = event.kidit_vascular || {}
    const pid = event.patientId

    // 確保只處理有填寫 KiDit 資料的紀錄，或是該月該病人的第一筆
    // (這裡邏輯維持：每個病人只出一筆基本資料，但 HD 造管可能需要多筆，這裡先假設一月一筆)
    if (!processedPatientIds.has(pid)) {
      processedPatientIds.add(pid)

      // --- Sheet 1: 病患資料 (維持不變) ---
      sheetData.patients.push({
        '01 姓名': p.name || '',
        '02 病患類別': p.patientCategory || '',
        '03 生日': toRocDate(p.birthDate),
        '04 身分證號': p.idNumber || '',
        '05 性別': p.gender || '',
        '06 婚姻': p.maritalStatus || '',
        '07 電話': p.phone || '',
        '08 病歷號': p.medicalRecordNumber || '',
        '09 透析代號': p.dialysisCode || '',
        '10 地址': p.address || '',
        '11 教育程度': p.education || '',
        '12 職業': p.occupation || '',
        '13 連絡人': p.contactPerson || '',
        '14 關係': p.relationship || '',
        '15 血型': p.bloodType || '',
        '16 重大傷病卡號': p.catastrophicCardNo || '',
        '17 是否為原住民': p.isIndigenous || '',
        '18 是否具福保身分': p.isWelfare || '',
        '19 狀態': p.status || '',
        '20 首次治療日期': toRocDate(p.firstDialysisDate),
        '21 本院開始治療日期': toRocDate(p.hospitalStartDate),
        '22 原發病大類': p.diagnosisCategory || '',
        '23 原發病細類': p.diagnosisSubcategory || '',
      })

      // --- Sheet 2: 病史原發病 (維持不變) ---
      const mapCheckboxes = (selectedIndices, totalBits) => {
        let result = Array(totalBits).fill('0')
        if (Array.isArray(selectedIndices)) {
          selectedIndices.forEach((idx) => {
            if (idx < totalBits) result[idx] = '1'
          })
        }
        return result.join('')
      }

      sheetData.history.push({
        '01 身分證號': p.idNumber || '',
        '02 病歷號': p.medicalRecordNumber || '',
        '03 轉入院所名稱': h.transferFromName || '',
        '04 轉入院所醫事代號': h.transferFromCode || '',
        '05 開始血液透析日期': toRocDate(h.startHDDate),
        '06 是否本院開始血液透析': h.isStartHDHere || '',
        '07 開始血液透析院所': h.startHDHospital || '',
        '08 腹膜透析開始日期': toRocDate(h.startPDDate),
        '09 是否本院開始腹膜透析': h.isStartPDHere || '',
        '10 腹膜透析開始院所': h.startPDHospital || '',
        '11 腎移植日期': toRocDate(h.transplantDate),
        '12 是否本院腎移植': h.isTransplantHere || '',
        '13 腎移植院所': h.transplantHospital || '',
        '14 是否知為慢性腎衰竭': h.isKnownCKD || '',
        '15 BUN或Creatinine異常': h.isBUNCreatAbnormal || '',
        '16 BUN/Creatinine 檢驗日期': toRocDate(h.abnormalLabDate),
        '17 BUN (mg/dl)': h.initialBUN || '',
        '18 Creatinine (mg/dl)': h.initialCr || '',
        '19 腎臟超音波檢查異常': '',
        '20 腎臟超音波檢查異常說明': '',
        '21 腎臟超音波檢驗日期': '',
        '22 其他系統性疾病': mapCheckboxes(h.selectedSystemicDiseases, 10),
        '23 其他': h.otherSystemicDescription || '',
        '24 DM型式': h.dmType || '',
        '25 檢驗日期': toRocDate(h.initialLabDate),
        '26 Hct (%)': h.initialHct || '',
        '27 Hb(g/dl)': h.initialHb || '',
        '28 BUN(mg/dl)': h.initialBUN || '',
        '29 Creatinine(mg/dl)': h.initialCr || '',
        '30 K(meq/l)': h.initialK || '',
        '31 CCr(ml/min)': '',
        '32 Albumin(gm/dl)': h.initialAlb || '',
        '體重(kg)': h.initialWeight || '',
        '身高(cm)': h.initialHeight || '',
        'eGFR(ml/min)': h.initialEGFR || '',
        '33 HBsAg': h.hbsag || '',
        '34 Anti-HCV': h.antihcv || '',
        '35 適應症種類': h.indicationType || '',
        '36 其他症狀': mapCheckboxes(h.selectedSymptoms, 10),
        '37 其他症狀(其他)': '',
        '38 緊急透析原因': mapCheckboxes(h.selectedEmergencyReasons, 15),
        '39 緊急透析原因(其他)': '',
        '40 檢驗日期': toRocDate(h.emergencyLabDate),
        '50 是否初次申請重大傷病': h.isFirstCatastrophic || '',
      })

      // --- Sheet 3: HD造管 (完整 76 欄位映射) ---
      const c = v.current || {} // 目前使用
      const u = v.unused || {} // 其他未使用

      // 判斷是否有並存通路 (只要 unused 裡有勾選任一項)
      const hasSecondary = u.isAutoCap || u.isManuCap || u.isPermCath || u.isDoubleLumen ? 'Y' : 'N'

      sheetData.access.push({
        '01 身份證號': p.idNumber || '',
        '02 病歷號': p.medicalRecordNumber || '',
        '03 日期': toRocDate(event.timestamp),

        // --- 目前使用 ---
        '04 自體動靜脈瘻管': c.isAutoCap ? 'Y' : 'N',
        '05 左右': c.isAutoCap ? c.autoCapSide || '' : '',
        '06 自體動靜脈瘻管位置': c.isAutoCap ? c.autoCapSite || '' : '',

        '07 人工動靜脈瘻管': c.isManuCap ? 'Y' : 'N',
        '08 左右': c.isManuCap ? c.manuCapSide || '' : '',
        '09 人工動靜脈瘻管位置': c.isManuCap ? c.manuCapSite || '' : '',

        '10 PermCath或其他長期導管': c.isPermCath ? 'Y' : 'N',
        '11 左右': c.isPermCath ? c.permCathSide || '' : '',
        '12 PermCath或其他長期導管位置': c.isPermCath ? c.permCathSite || '' : '',

        '13 其他短期導管': c.isDoubleLumen ? 'Y' : 'N',
        '14 左右': c.isDoubleLumen ? c.dlSide || '' : '',
        '15 其他短期導管位置': c.isDoubleLumen ? c.dlSite || '' : '',

        // 16-23 是透析參數 (如果 UI 沒做，留空)
        '16 本季透析時最佳pump blood flow': '',
        '17 vascular access flow ml/min': '',
        '18 是否使用遠紅外線治療': '',
        '19 每周幾次': '',
        '20 平均每周總治療時間(分)': '',
        '21 是否使用其他熱治療法': '',
        '22 治療方法': '',
        '23 平均每周總治療時間(分)': '',

        // --- 並存/其他通路 (對應 v.unused) ---
        '24 是否並存其他血管通路方式': hasSecondary,

        '25 自體動靜脈瘻管': u.isAutoCap ? 'Y' : 'N',
        '26 左右': u.isAutoCap ? u.autoCapSide || '' : '',
        '27 自體動靜脈瘻管位置': u.isAutoCap ? u.autoCapSite || '' : '',

        '28 人工動靜脈瘻管': u.isManuCap ? 'Y' : 'N',
        '29 左右': u.isManuCap ? u.manuCapSide || '' : '',
        '30 人工動靜脈瘻管位置': u.isManuCap ? u.manuCapSite || '' : '',

        '31 PermCath或其他長期導管': u.isPermCath ? 'Y' : 'N',
        '32 左右': u.isPermCath ? u.permCathSide || '' : '',
        '33 PermCath或其他長期導管位置': u.isPermCath ? u.permCathSite || '' : '',

        '34 其他短期導管': u.isDoubleLumen ? 'Y' : 'N',
        '35 左右': u.isDoubleLumen ? u.dlSide || '' : '',
        '36 其他短期導管位置': u.isDoubleLumen ? u.dlSite || '' : '',

        // 37-76 為併發症、失效原因、重建等 (目前 UI 未實作，全部留空以符合格式)
        '37 是否有血管通路問題': '',
        '38 介入治療日期 1': '',
        '39 血管通路失敗原因 1': '',
        '40 原有血管重建方式 1': '',
        '41 原有血管重建其他方式 1': '',
        '42 介入治療日期 2': '',
        '43 血管通路失敗原因 2': '',
        '44 原有血管重建方式 2': '',
        '45 原有血管重建其他方式 2': '',
        '46 介入治療日期 3': '',
        '47 血管通路失敗原因 3': '',
        '48 原有血管重建方式 3': '',
        '49 原有血管重建其他方式 3': '',
        '50 血管重建日期 1': '',
        '51 前次血管通路失敗原因 1': '',
        '52 是否是自體動靜脈瘻管': '',
        '53 左右1': '',
        '54 自體動靜脈瘻管位置1': '',
        '55 是否是人工動靜脈瘻管1': '',
        '56 左右1': '',
        '57 人工動靜脈瘻管位置1': '',
        '58 是否是PermCath或其他長期導管1': '',
        '59 左右1': '',
        '60 PermCath或其他長期導管位置1': '',
        '61 血管重建日期 2': '',
        '62 前次血管通路失敗原因 2': '',
        '63 是否是自體動靜脈瘻管2': '',
        '64 左右2': '',
        '65 自體動靜脈瘻管位置2': '',
        '66 是否是人工動靜脈瘻管2': '',
        '67 左右2': '',
        '68 人工動靜脈瘻管位置2': '',
        '69 是否是PermCath或其他長期導管2': '',
        '70 左右2': '',
        '71 PermCath或其他長期導管位置2': '',
        '72 血管重建日期 3': '',
        '73 前次血管通路失敗原因 3': '',
        '74 是否是自體動靜脈瘻管3': '',
        '75 左右3': '',
        '76 自體動靜脈瘻管位置3': '',
      })
    }
  })

  const wb = XLSX.utils.book_new()

  const ws1 = XLSX.utils.json_to_sheet(sheetData.patients)
  XLSX.utils.book_append_sheet(wb, ws1, '病患資料')

  const ws2 = XLSX.utils.json_to_sheet(sheetData.history)
  XLSX.utils.book_append_sheet(wb, ws2, '病史原發病')

  const ws3 = XLSX.utils.json_to_sheet(sheetData.access)
  XLSX.utils.book_append_sheet(wb, ws3, 'HD造管')

  XLSX.writeFile(wb, filename)
}
