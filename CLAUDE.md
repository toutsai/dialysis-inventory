# 部北洗腎室庫存管理平台 (dialysis-inventory)

台北醫院洗腎室庫存管理系統。支援行動版操作，方便護理人員在現場盤點。

## 技術棧

- **Frontend**: Angular 19 (standalone components, signals)
- **Backend**: Firebase (Firestore + Cloud Functions v2 + Auth)
- **UI**: 純 CSS（無 UI framework），FullCalendar（到貨行事曆）、Quill（富文本）、Chart.js
- **部署**: Firebase Hosting (`dist/browser/`)
- **Cloud Functions**: Node.js 20, region `asia-east1`
- **離線支援**: Firestore persistent local cache (IndexedDB + multi-tab)

## 常用指令

```bash
npm run dev              # 本機開發 (port 5173, emulator config)
npm start                # ng serve (development config)
npm run build            # production build
npm run deploy           # build + firebase deploy hosting
npm run deploy:functions # 部署 Cloud Functions
npm run deploy:rules     # 部署 Firestore rules
npm run emu              # 啟動 Firebase emulators (auth + firestore + functions)
npm run seed             # 填充測試資料到 emulator
```

## 專案結構

```
src/
  app/
    app.config.ts                  # Angular providers (router, animations)
    app.routes.ts                  # 路由：/login, /inventory (authGuard)
    components/dialogs/            # 共用對話框 (AlertDialog)
    core/
      guards/auth.guard.ts         # 路由守衛，等待 auth 初始化
      services/
        auth.service.ts            # 登入/登出/角色權限 (signals)
        firebase.service.ts        # Firebase 單例初始化 (app/auth/db/functions)
        daily-consumption.service.ts  # 每日消耗 Excel 解析 + Firestore CRUD
    features/
      login/                       # 登入頁
      inventory/                   # 主功能頁（單一元件 + tab 切換）
        inventory.component.ts     # 主元件，含所有 tab 邏輯
        tabs/
          new-order/               # 新增訂單 tab (獨立子元件)
          delivery-calendar/       # 到貨行事曆 tab (獨立子元件)
        services/
          order.service.ts         # 訂單計算與 CRUD
          delivery.service.ts      # 到貨管理與進貨紀錄建立
    layouts/main-layout.component.ts  # 頂部導航列 + router-outlet
  environments/
    environment.ts                 # 開發環境 Firebase config
    environment.production.ts      # 生產環境 Firebase config
  utils/
    dateUtils.js                   # 台灣時區日期工具
    firestoreUtils.js              # Firestore IN 查詢分塊工具
  data/changelog.json              # 版本更新紀錄
functions/
  index.js                        # Cloud Functions (customLogin, createUser, changeUserPassword, adminResetPassword)
firestore.rules                   # Firestore 安全規則
firestore.indexes.json             # Firestore 複合索引
```

## Firestore Collections

| Collection | Document ID | 說明 |
|---|---|---|
| `inventory_items` | auto | 品項設定（名稱、類別、每箱數量、院內代碼） |
| `inventory_orders` | auto | 訂單（含 countData 盤點快照、消耗資料） |
| `inventory_deliveries` | auto | 到貨排程（橋接訂單與進貨） |
| `inventory_purchases` | auto | 進貨紀錄（source: manual / delivery） |
| `inventory_counts` | YYYY-MM | 月盤點紀錄（期初、進貨、消耗、預期、實際、結轉） |
| `daily_consumption` | YYYY-MM-DD | 每日消耗（從醫院 Excel 匯入） |
| `users` | auto | 使用者帳號（密碼 bcrypt hash） |
| `audit_logs` | auto | 操作稽核日誌（僅 admin 可讀，不可改刪） |

## 品項分類

| Firestore key | 中文名 | 訂單類型 | 安全庫存天數 |
|---|---|---|---|
| `artificialKidney` | 人工腎臟 | 月訂單 | 36 天 |
| `dialysateCa` | 透析藥水CA | 週訂單 | 9 天 |
| `bicarbonateType` | B液種類 | 週訂單 | 9 天 |

## 關鍵業務公式

- **週訂單**：日均 = 上週消耗（週一~週六） / 6，安全庫存 = 日均 x 9
- **月訂單**：日均 = 上月消耗 / 上月天數，安全庫存 = 日均 x 36
- **訂購量** = 安全庫存 - 盤點量 - 待到貨量

## 庫存狀態（4 階）

| 狀態 | 條件 |
|------|------|
| 綠色 safe | 存量 > 安全庫存量 |
| 橘色 warning | 安全庫存量 >= 存量 > 最低庫存量 |
| 黃色 low | 最低庫存量 >= 存量 > 0 |
| 紅色 critical | 存量 <= 0 |

- **最低庫存量**：品項設定中手動填寫
- **安全庫存量**：系統自動計算（日均 x 天數）

## 訂單流程

1. **新增訂單**：輸入盤點量 -> 系統計算建議訂購量 -> 確認建立
2. **到貨行事曆**：FullCalendar 顯示預計到貨 -> 確認到貨 -> 自動建立進貨紀錄
3. 週訂單到貨日：下週一/三；月訂單到貨日：使用者自選

## 每月盤點流程

1. 輸入盤點日期、區間 -> 點「計算庫存」
2. **月盤點輸入**：box input grid 輸入實際盤點箱數
3. **盤點總表**：期初 -> 進貨 -> 消耗 -> 期末預期 -> 實際盤點 -> 誤差值 -> 結轉選擇
4. 誤差超過消耗 1% 顯示紅色
5. 結轉選擇「預期」或「實際」作為下月期初庫存

## 權限

| 角色 | 說明 | 權限 |
|------|------|------|
| `admin` | 護理長、管理長 | 全部功能（含使用者管理） |
| `editor` | 書記 | 所有庫存功能（無使用者管理） |

- 前端：`@if (authService.isAdmin())` 控制使用者管理 tab
- Firestore rules：`isAdminOrEditor()` 控制讀寫，`isAdmin()` 控制 users 集合
- Cloud Functions：auth 相關函式檢查 `request.auth.token.role`

## 行動版設計

- 斷點 <= 768px
- 僅顯示 5 個 tab：庫存總覽、新增訂單、到貨行事曆、每月盤點、紀錄查詢
- 隱藏 tab 使用 `desktop-only` CSS class
- 容器高度：`calc(100dvh - 2.75rem)` + `overflow-y: auto`

## 開發注意事項

- **時區**：所有日期統一台灣時區 (`Asia/Taipei`)，使用 `dateUtils.js` 或 service 內的 `toTaiwanDate()` 等方法，禁止 `toISOString().split('T')[0]`
- **Angular 風格**：standalone components + signals，不使用 NgModules
- **Firestore IN 限制**：超過 30 個值需使用 `firestoreUtils.js` 的 `queryWithInChunks()`
- **Cloud Functions region**：`asia-east1`，CORS 白名單在 `functions/index.js` 中設定
- **密碼自動遷移**：`customLogin` 會自動將明文密碼升級為 bcrypt hash
- **庫存基準值**：取最新月盤點 vs 最新訂單 countDate，比較日期取較新者
