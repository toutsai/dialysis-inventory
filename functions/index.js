// functions/index.js — 庫存管理系統 (獨立版)

// --- Firebase Functions V2 全局設定 ---
const { setGlobalOptions } = require('firebase-functions/v2')
setGlobalOptions({ region: 'asia-east1', timeoutSeconds: 60, memory: '256MiB', maxInstances: 100 })

// --- Firebase Functions V2 模組引入 ---
const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { logger } = require('firebase-functions')

// --- Firebase Admin SDK 初始化 ---
const admin = require('firebase-admin')
admin.initializeApp()

const db = admin.firestore()

// --- 第三方函式庫 ---
const bcrypt = require('bcryptjs')

// --- CORS 跨來源請求設定 ---
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:4200',
]

// ===================================================================
// 輔助函式
// ===================================================================

function getTaipeiNow() {
  const now = new Date()
  const tzString = now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' })
  return new Date(tzString)
}

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
    logger.error('[AuditLog] Failed to write audit log:', error)
  }
}

// ===================================================================
// 可呼叫函式 (Callable Functions)
// ===================================================================

exports.customLogin = onCall({ cors: allowedOrigins }, async (request) => {
  const { username, password } = request.data
  const ipAddress = request.rawRequest?.ip || request.rawRequest?.headers?.['x-forwarded-for'] || null

  if (!username || !password) {
    throw new HttpsError('invalid-argument', '請提供使用者名稱和密碼。')
  }
  try {
    const usersRef = db.collection('users')
    const snapshot = await usersRef.where('username', '==', username).limit(1).get()
    if (snapshot.empty) {
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

    const isHashed = storedPassword && storedPassword.startsWith('$2')

    let isPasswordValid = false
    if (isHashed) {
      isPasswordValid = await bcrypt.compare(password, storedPassword)
    } else {
      isPasswordValid = storedPassword === password
      if (isPasswordValid) {
        const hashedPassword = await bcrypt.hash(password, 10)
        await userDoc.ref.update({ password: hashedPassword })
        logger.info(`[customLogin] 用戶 ${userDoc.id} 的密碼已自動遷移為加密格式。`)
      }
    }

    if (!isPasswordValid) {
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
    if (error instanceof HttpsError) throw error
    throw new HttpsError('internal', '更新密碼時發生未知的伺服器錯誤。')
  }
})

exports.createUser = onCall({ cors: allowedOrigins }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '使用者未經驗證。')
  }
  if (request.auth.token.role !== 'admin') {
    throw new HttpsError('permission-denied', '只有管理員可以建立新用戶。')
  }

  const { username, password, name, title, role, email } = request.data

  if (!username || !password || !name || !title || !role) {
    throw new HttpsError('invalid-argument', '缺少必要欄位：username, password, name, title, role')
  }

  try {
    const existingUser = await db.collection('users').where('username', '==', username).limit(1).get()
    if (!existingUser.empty) {
      throw new HttpsError('already-exists', '此使用者名稱已被使用。')
    }

    const hashedPassword = await bcrypt.hash(password, 10)

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

    const newUserRef = await db.collection('users').add(userData)
    logger.info(`[createUser] 管理員 ${request.auth.uid} 成功建立新用戶 ${newUserRef.id}`)

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

    const hashedPassword = await bcrypt.hash(newPassword, 10)
    await userDocRef.update({
      password: hashedPassword,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

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
