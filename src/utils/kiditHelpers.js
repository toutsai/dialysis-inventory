// src/utils/kiditHelpers.js

// 民國年轉換工具 (YYYY-MM-DD -> 0YYMMDD)
export function toRocDate(isoDateString) {
  if (!isoDateString) return ''
  const date = new Date(isoDateString)
  if (isNaN(date.getTime())) return ''

  const year = date.getFullYear() - 1911
  const yStr = String(year).padStart(3, '0')
  const mStr = String(date.getMonth() + 1).padStart(2, '0')
  const dStr = String(date.getDate()).padStart(2, '0')

  return `${yStr}${mStr}${dStr}`
}

// 完整資料字典 (依照 Excel 截圖)
export const KIDIT_OPTIONS = {
  // 02 病患類別
  patientCategory: [
    { value: '00', label: '00 健保' },
    { value: '11', label: '11 自費' },
  ],
  // 05 性別
  gender: [
    { value: '1', label: '男' },
    { value: '2', label: '女' },
  ],
  // 06 婚姻
  maritalStatus: [
    { value: '1', label: '已婚' },
    { value: '2', label: '未婚' },
    { value: '3', label: '分居' },
    { value: '4', label: '配偶死亡' },
    { value: '9', label: '未明' },
  ],
  // 11 教育程度
  education: [
    { value: '1', label: '無' },
    { value: '2', label: '小學' },
    { value: '3', label: '國中' },
    { value: '4', label: '高中' },
    { value: '5', label: '大專(含)以上' },
  ],
  // 12 職業
  occupation: [
    { value: '01', label: '軍' },
    { value: '02', label: '公' },
    { value: '03', label: '教' },
    { value: '04', label: '農' },
    { value: '05', label: '林' },
    { value: '06', label: '漁' },
    { value: '07', label: '牧' },
    { value: '08', label: '商' },
    { value: '09', label: '工' },
    { value: '10', label: '礦' },
    { value: '11', label: '學生' },
    { value: '12', label: '自由業' },
    { value: '13', label: '家管' },
  ],
  // 14 關係
  relation: [
    { value: '0', label: '無' },
    { value: '1', label: '兒女' },
    { value: '2', label: '妻子' },
    { value: '3', label: '丈夫' },
    { value: '4', label: '父母' },
    { value: '9', label: '其他' },
  ],
  // 15 血型
  bloodType: [
    { value: 'A', label: 'A' },
    { value: 'B', label: 'B' },
    { value: 'O', label: 'O' },
    { value: 'AB', label: 'AB' },
  ],
  // 17, 18 是否為原住民/福保
  yesNo: [
    { value: 'Y', label: '是' },
    { value: 'N', label: '否' },
  ],
  // 19 狀態 (根據 Excel)
  status: [
    { value: '-', label: '- 未歸類-急性病患' },
    { value: '.', label: '. 未歸類-住院需緊急透析' },
    { value: '/', label: '/ 未歸類-外院長期透析暫管' },
    { value: '0', label: '0 未歸類-尚未進入長期透析' },
    { value: '1', label: '1 長期血液透析' },
    { value: '2', label: '2 長期腹膜透析' },
    { value: '3', label: '3 長期腎移植追蹤' },
    { value: '5', label: '5 轉院' },
    { value: '6', label: '6 痊癒' },
    { value: '7', label: '7 放棄' },
    { value: '8', label: '8 不明原因退出' },
    { value: '9', label: '9 死亡' },
  ],
  // 22 原發病大類
  diagnosisCategory: [
    { value: 'A', label: 'A 腎臟實質疾病' },
    { value: 'B', label: 'B 系統性疾病' },
    { value: 'C', label: 'C 阻塞性腎病變及泌尿系統疾病' },
    { value: 'D', label: 'D 腎血管病變' },
    { value: 'E', label: 'E 遺傳性疾病' },
    { value: 'F', label: 'F 其他已知原因腎衰竭' },
    { value: 'G', label: 'G 不明原因之腎衰竭' },
    { value: 'H', label: 'H 中毒' },
    { value: 'I', label: 'I 其他' },
  ],
  // 23 原發病細類 (部分範例，這張表很長，您可以根據需要補齊)
  diagnosisSubcategory: [
    { value: 'A-01A', label: '慢性腎絲球腎炎(臨床)' },
    { value: 'A-01B-a', label: 'A型免疫球蛋白腎炎' },
    { value: 'A-01B-b', label: '局部腎絲球硬化症' },
    { value: 'A-01B-c', label: '膜性腎病變' },
    { value: 'A-01B-d', label: '膜性增生性腎炎' },
    { value: 'B-01', label: '腎硬化症(缺血性)' },
    { value: 'B-02', label: '惡性高血壓' },
    { value: 'B-04', label: '糖尿病' },
    // ... 請依據 Excel 完整列表繼續擴充
  ],
}

// 新增病史相關的選項
export const KIDIT_HISTORY_OPTIONS = {
  // 06, 09, 12, 14, 15, 19 是/否選項
  yesNo: [
    { value: 'Y', label: '是' },
    { value: 'N', label: '否' },
  ],
  // 33, 34 肝炎標記
  hepatitis: [
    { value: 'Y', label: '陽性(+)' },
    { value: 'N', label: '陰性(-)' },
    { value: 'O', label: '未做' },
  ],
  // 24 DM 型式
  dmType: [
    { value: '1', label: 'IDDM (胰島素依賴)' },
    { value: '2', label: 'NDDM (非胰島素依賴)' },
    { value: '3', label: '未明' },
  ],
  // 35 適應症種類
  indicationType: [
    { value: '1', label: '1 血清肌酸酐>=8mg/dl 或肌酸酐廓清率=<5ml/min' },
    { value: '2', label: '2 重度慢性腎衰竭且...(詳見說明)' },
    { value: '3', label: '3 其他' },
  ],
  // 22 其他系統性疾病 (複選) - 對應 10 個位元
  systemicDiseases: [
    { index: 0, label: '糖尿病' },
    { index: 1, label: '高血壓' },
    { index: 2, label: '鬱血性心衰竭' },
    { index: 3, label: '缺血性心臟病' },
    { index: 4, label: '腦血管病變' },
    { index: 5, label: '慢性肝疾病/肝硬化' },
    { index: 6, label: '惡性腫瘤' },
    { index: 7, label: '結核' },
    { index: 8, label: 'Gout (痛風)' },
    { index: 9, label: '高血脂' },
  ],
  // 36 其他症狀 (複選) - 對應 10 個位元
  otherSymptoms: [
    { index: 0, label: '心臟衰竭或肺水腫' },
    { index: 1, label: '心包膜炎' },
    { index: 2, label: '出血傾向' },
    { index: 3, label: '神經症狀：意識障礙、抽搐或末梢神經病變' },
    { index: 4, label: '高血鉀 (藥物難以控制)' },
    { index: 5, label: '噁心、嘔吐 (藥物難以控制)' },
    { index: 6, label: '代謝性酸血症 (藥物難以控制)' },
    { index: 7, label: '惡病體質 (Cachexia)' },
    { index: 8, label: '重度氮血症 (BUN > 100 mg/dl)' },
    { index: 9, label: '其他' },
  ],
  // 38 緊急透析原因 (複選) - 對應 15 個位元
  emergencyReasons: [
    { index: 0, label: '心臟衰竭或肺水腫' },
    { index: 1, label: '心包膜炎' },
    { index: 2, label: '出血傾向' },
    { index: 3, label: '神經症狀' },
    { index: 4, label: '高血鉀' },
    { index: 5, label: '嚴重酸血症' },
    { index: 6, label: '噁心、嘔吐' },
    { index: 7, label: '惡病體質' },
    { index: 8, label: '重度氮血症' },
    { index: 9, label: '近日內準備接受重大手術者' },
    { index: 10, label: '全身水腫' },
    { index: 11, label: '開心手術後，無尿' },
    { index: 12, label: '高血鈣' },
    { index: 13, label: '藥物或其他物質中毒' },
    { index: 14, label: '其他' },
  ],
}
