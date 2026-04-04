# AI 代理指南 - 洗腎排程系統

## 專案概觀

這是一個基於 Vue 3 + Vite + Firebase 的洗腎診所排程管理系統，用於管理病患的洗腎排程、檢驗報告、醫師班表等。

### 核心功能模組

- 排程管理 (`ScheduleView.vue`, `scheduleService.js`)
- 病患管理 (`PatientsView.vue`)
- 檢驗報告 (`LabReportView.vue`)
- 耗材管理 (`ConsumablesView.vue`)
- 醫師班表 (`PhysicianScheduleView.vue`)

## 技術架構

### 前端架構
- Vue 3 (組合式 API)
- Vite 作為建構工具
- Vue Router 用於路由管理
- Pinia 用於狀態管理

### 後端架構
- Firebase Functions (Node.js)
- Firestore 作為資料庫
- Firebase Authentication 處理身份驗證
- Google Drive API 整合用於文件管理

## 重要設計模式

### 1. 身份驗證與權限控制
```js
const { isAdmin, isContributor, canEditSchedules } = useAuth()
```
- 使用 `useAuth` composable 處理所有認證相關邏輯
- 基於角色的權限控制：admin, contributor, editor

### 2. API 服務層設計
- `scheduleService.js`: 排程相關 API
- `optimizedApiService.js`: 優化後的 API 調用
- `baseScheduleService.js`: 基礎排程邏輯

### 3. 資料流
1. 用戶操作 → 組件
2. 組件 → Service 層
3. Service 層 → Firebase Functions
4. Functions → Firestore

## 開發工作流程

### 本地開發
```bash
# 開發模式
npm run dev

# 使用模擬器
npm run emu

# 建置開發版本
npm run build:dev
```

### 部署流程
```bash
# 部署到開發環境
npm run deploy:dev

# 部署到生產環境
npm run deploy:prod
```

## 重要檔案位置

### 前端核心文件
- `/src/views/`: 主要頁面組件
- `/src/components/`: 可重用組件
- `/src/composables/`: 共用邏輯（useAuth、useCache 等）
- `/src/services/`: API 服務層
- `/src/utils/`: 工具函數

### 後端核心文件
- `/functions/index.js`: Firebase Functions
- `firestore.rules`: Firestore 安全規則
- `firebase.json`: Firebase 配置

## 特殊注意事項

1. 時區處理
   - 系統預設使用台灣時區 (UTC+8)
   - 日期操作使用 `YYYY-MM-DD` 格式

2. 效能優化
   - 使用 `useCache` composable 處理數據緩存
   - 大型列表使用虛擬滾動
   - Functions 使用適當的記憶體配置

3. 錯誤處理
   - 使用 `useErrorHandler` composable 統一處理錯誤
   - API 錯誤統一由 `HttpsError` 處理

4. 安全性考慮
   - 所有 API 調用需進行身份驗證
   - 敏感操作需要管理員權限
   - 資料庫訪問受 Firestore 規則保護