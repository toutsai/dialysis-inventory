// scripts/seed-firestore.cjs (✨ 大幅簡化版 ✨)

const path = require('path')
// 確保讀取的是模擬器環境變數檔
require('dotenv').config({ path: path.resolve(__dirname, '../.env.emulator') })

const admin = require('firebase-admin')
const { getFirestore, Timestamp } = require('firebase-admin/firestore')
const { faker } = require('@faker-js/faker/locale/zh_TW')

// --- 配置 ---
const projectId = process.env.VITE_FIREBASE_PROJECT_ID
const PATIENT_COUNTS = {
  opd: 200,
  ipd: 10,
  er: 2,
}
const USERS_TO_CREATE = [
  {
    uid: 'admin',
    username: 'admin',
    password: 'admin',
    name: '管理員',
    role: 'admin',
    title: '管理員',
  },
  {
    uid: 'editor',
    username: 'editor',
    password: 'editor',
    name: '護理師組長',
    role: 'editor',
    title: '護理師組長',
  },
  {
    uid: 'viewer',
    username: 'nurse',
    password: 'viewer',
    name: '王護理師',
    role: 'viewer',
    title: '護理師',
  },
  {
    uid: 'contributor',
    username: 'doctor',
    password: 'contributor',
    name: '陳醫師',
    role: 'contributor',
    title: '主治醫師',
  },
  {
    uid: 'clerk',
    username: 'clerk',
    password: 'clerk',
    name: '林書記',
    role: 'viewer',
    title: '書記',
  },
  {
    uid: 'np',
    username: 'np',
    password: 'np',
    name: '張專師',
    role: 'contributor',
    title: '專科護理師',
  },
]
const PHYSICIANS = ['陳醫師', '林醫師', '黃醫師', '張醫師']
const FREQUENCIES = ['一三五', '二四六']

// --- 環境設定 ---
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'

if (!projectId) {
  console.error('❌ 錯誤：無法從 .env.emulator 檔案中讀取 VITE_FIREBASE_PROJECT_ID。')
  process.exit(1)
}

admin.initializeApp({ projectId })
const db = getFirestore()

/**
 * 創建一個簡化的隨機病人物件
 * @param {'opd' | 'ipd' | 'er'} type - 病人狀態
 */
function createSimplifiedPatient(type) {
  // 1. 產生一個今天之前的隨機日期 (最近一年內)
  const admissionDate = faker.date.past({ years: 1 })
  const createdAt = Timestamp.fromDate(admissionDate)

  // 2. 決定頻率：90% 機率為 135 或 246，剩下 10% 隨機
  let freq
  if (Math.random() < 0.9) {
    freq = faker.helpers.arrayElement(FREQUENCIES)
  } else {
    freq = faker.helpers.arrayElement(['一四', '二五', '三六', '每日', '臨時'])
  }

  // 3. 決定疾病：約 10% 機率有 HBV 或 HCV
  const diseases = []
  if (Math.random() < 0.1) {
    diseases.push(faker.helpers.arrayElement(['HBV', 'HCV']))
  }

  // 4. 組合病人資料
  const patient = {
    name: `${faker.person.lastName()}${faker.person.firstName()}`,
    medicalRecordNumber: faker.string.numeric(7),
    physician: faker.helpers.arrayElement(PHYSICIANS), // 會診/收案醫師
    mode: 'HD', // 透析模式固定為 HD
    freq: freq,
    diseases: diseases,

    // 狀態與日期
    status: type,
    isDeleted: false,

    // 統一使用 createdAt 作為收案/住院日期
    createdAt: createdAt,
    // updatedAt 稍微晚一點，以符合邏輯
    updatedAt: Timestamp.fromMillis(createdAt.toMillis() + 10000),
  }

  return patient
}

async function seedUsers() {
  console.log(`⏳ 正在建立 ${USERS_TO_CREATE.length} 位預設使用者...`)
  const authPromises = USERS_TO_CREATE.map(async (user) => {
    try {
      await admin.auth().createUser({ uid: user.uid, displayName: user.name })
      console.log(`   -> ✅ Auth 使用者 '${user.username}' 已建立。`)
    } catch (error) {
      if (error.code === 'auth/uid-already-exists') {
        console.log(`   -> 🟡 Auth 使用者 '${user.username}' 已存在，跳過建立。`)
      } else {
        throw error
      }
    }
  })

  const firestoreBatch = db.batch()
  USERS_TO_CREATE.forEach((user) => {
    const userRef = db.collection('users').doc(user.uid)
    // 移除密碼，不存入 firestore
    const { password, ...userData } = user
    firestoreBatch.set(userRef, userData)
  })

  await Promise.all([...authPromises, firestoreBatch.commit()])
  console.log('✅ 所有使用者資料已寫入 Firestore。')
}

async function seedPatients() {
  console.log(
    `\n⏳ 準備產生總共 ${Object.values(PATIENT_COUNTS).reduce((a, b) => a + b, 0)} 筆病人資料...`,
  )

  const allPatients = []
  // 根據指定的數量創建各類病人
  for (const [type, count] of Object.entries(PATIENT_COUNTS)) {
    console.log(`   -> 正在產生 ${count} 位 ${type} 病人...`)
    for (let i = 0; i < count; i++) {
      allPatients.push(createSimplifiedPatient(type))
    }
  }

  // 將所有病人資料一次性寫入 Firestore
  const batch = db.batch()
  const patientsCollection = db.collection('patients')
  allPatients.forEach((patient) => {
    const newPatientRef = patientsCollection.doc() // 自動生成 ID
    batch.set(newPatientRef, patient)
  })

  await batch.commit()
  console.log(`✅ 成功！已將 ${allPatients.length} 筆病人資料寫入 Firestore 模擬器。`)
}

async function seedAllData() {
  try {
    await seedUsers()
    await seedPatients()
    console.log('\n🎉🎉🎉 資料填充完成！🎉🎉🎉')
  } catch (error) {
    console.error('❌ 資料填充過程中發生嚴重錯誤:', error)
  }
}

seedAllData()
