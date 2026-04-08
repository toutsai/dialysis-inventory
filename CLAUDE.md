# 部北洗腎室庫存管理平台 - Claude Code 指引

## 專案概述
Angular 19 + Firebase 庫存管理系統，功能：庫存總覽、品項設定、新增訂單、到貨行事曆、進貨紀錄、消耗紀錄、每月盤點、紀錄查詢、使用者管理。

## 開發流程（每次必做）
1. 修改完成後，**自動**執行 **commit → push → 建立 PR → merge to main**，不需詢問使用者確認
2. Merge 完成後，固定提醒使用者在 VS Code 終端機執行：
   ```powershell
   git pull origin main
   npm run build
   firebase deploy --only hosting
   ```
3. 如有修改 `firestore.rules`，額外提醒：
   ```powershell
   firebase deploy --only firestore:rules
   ```

## 關鍵公式
- **週訂單（透析藥水 & B液）**：日均 = 上週消耗（週一~週六）÷ **6**，安全庫存 = 日均 × **9** 天
- **月訂單（人工腎臟）**：日均 = 上月消耗 ÷ 上月天數，安全庫存 = 日均 × **36** 天
- **訂購量** = 安全庫存 - 盤點量 - 待到貨量

## 名詞定義
| 名詞 | 來源 | 說明 |
|------|------|------|
| **最低庫存量** | 品項設定（手動填寫） | 保底值，用於黃色警示 |
| **安全庫存量** | 系統自動計算 | 日均×9，用於橘色警示 |

## 庫存總覽 4 階狀態
| 顏色 | 條件 |
|------|------|
| 綠色 (safe) | 存量 > 安全庫存量 |
| 橘色 (warning) | 安全庫存量 ≥ 存量 > 最低庫存量 |
| 黃色 (low) | 最低庫存量 ≥ 存量 > 0 |
| 紅色 (critical) | 存量 ≤ 0 |

## 訂單流程（叫貨 → 到貨 → 進貨）
1. **新增訂單**：選擇盤點日期並輸入當日盤點量 → 系統計算建議訂購量 → 確認建立訂單
2. **到貨行事曆**：顯示每月預計到貨排程 → 點擊確認到貨 → 可編輯實收數量 → 自動建立進貨紀錄
3. **週訂單**（透析藥水CA、B液種類）：安全庫存 9 天，到貨日為下週一/三
4. **月訂單**（人工腎臟）：安全庫存 36 天，使用者自選到貨日期並分配數量

## 技術備註
- Build: `npx ng build`
- Deploy: `firebase deploy --only hosting`
- Firebase config 在 `src/environments/environment.ts`
- Cloud Functions 只保留 4 個 auth 相關函數
- 時區：所有日期統一使用台灣時區 (Asia/Taipei)，使用 `toTaiwanDate()` / `toTaiwanMonth()` / `toTaiwanDateTime()` / `getTaiwanDay()` 方法，禁止使用 `toISOString().split('T')[0]`
- 庫存總覽基準值：取最新盤點（月盤點 or 訂單盤點快照，比較 countDate 取較新者）

## 權限設計
| 角色 | 說明 | 權限 |
|------|------|------|
| **admin** | 護理長、管理長 | 全部功能（含使用者管理） |
| **editor** | 書記 | 所有庫存功能（看不到使用者管理） |

- 前端：使用者管理 tab 用 `@if (authService.isAdmin())` 控制顯示
- Firestore rules：`isAdminOrEditor()` 控制讀寫，`isAdmin()` 控制 users 集合寫入

## Firestore Collections
| Collection | 說明 | Document ID |
|---|---|---|
| `inventory_items` | 品項設定 | auto |
| `inventory_purchases` | 進貨紀錄（含 source: manual/delivery） | auto |
| `inventory_counts` | 盤點紀錄（type: monthly） | YYYY-MM |
| `inventory_orders` | 訂單紀錄（含 countData 盤點快照） | auto |
| `inventory_deliveries` | 到貨紀錄（橋接訂單與進貨） | auto |
| `daily_consumption` | 每日消耗 | YYYY-MM-DD |
| `audit_logs` | 操作日誌 | auto |

### inventory_counts 擴展欄位（月盤點）
| 欄位 | 說明 |
|------|------|
| `counts` | 結轉值（下月期初，依結轉選擇決定用預期或實際） |
| `expectedCounts` | 系統計算的期末結存（期初+進貨-消耗） |
| `actualCounts` | 實際盤點值（從月盤點輸入） |
| `actualCountBoxes` | 實際盤點箱數 |

## 行動版設計
- 行動版（≤768px）只顯示 5 個 tab：庫存總覽、新增訂單、到貨行事曆、每月盤點、紀錄查詢
- 隱藏：品項設定、進貨紀錄、消耗紀錄、使用者管理（`desktop-only` class）
- 頁面容器：`height: calc(100dvh - 2.75rem)` + `overflow-y: auto`
- Tab panel 底部加 4rem padding 確保內容不被截斷

## 每月盤點流程
1. 輸入盤點日、區間 → 點「計算庫存」
2. Sub-tab 切換：
   - **月盤點輸入**：box input grid 輸入實際盤點箱數
   - **盤點總表**：完整結存比較表
3. 盤點總表欄位：期初結存 → 區間進貨 → 區間消耗 → 期末結存(預期) → 實際盤點 → 誤差值 → 結轉選擇
4. 誤差值 = 實際盤點 - 期末結存，超過消耗量 1% 顯示紅色
5. 結轉選擇：管理員選「預期」或「實際」當下月期初庫存
6. 儲存時 `counts` = 依結轉選擇的值（下月 `previousStock` 的來源）

## 紀錄查詢格式
| Tab | 篩選 | 格式 |
|-----|------|------|
| 訂單紀錄 | 月份 | 訂單卡片（週訂單/月訂單） |
| 到貨紀錄 | 月份 | 到貨明細卡片（含差異比較） |
| 月盤點紀錄 | **年份** | 品項×12 個月一覽表（daily-grid 風格） |

## 開發紀錄

### 2026-04-08
- 專案重構：建立「叫貨 → 到貨 → 進貨」完整鏈路
- 新增「新增訂單」tab（取代每週訂單）：支援週訂單（透析藥水/B液，9天安全庫存）和月訂單（人工腎臟，36天安全庫存）
- 新增「到貨行事曆」tab：使用 FullCalendar 顯示預計到貨，點擊確認到貨自動建立進貨紀錄
- 新增 `inventory_deliveries` Firestore collection（橋接訂單與進貨）
- 新增 `order.service.ts`、`delivery.service.ts`
- 進貨紀錄新增「來源」欄位（手動 / 到貨確認）
- 紀錄查詢移除舊格式 sub-tab，新增「到貨紀錄」
- Dashboard 基準值改為取最新月盤點 vs 最新訂單 countDate
- 架構改為漸進式拆分：新 tab 為獨立子元件（NewOrderTabComponent, DeliveryCalendarTabComponent）

### 2026-04-06
- 進貨提醒兩步確認流程 + 訂單儲存至 Firestore + autoFillFromLastOrder
- 歷史紀錄列表（每週訂單/每月盤點 tab，daily-grid 風格）
- 每週盤點校正庫存總覽（loadDashboard 取最新盤點為基準）
- 全面修正時區問題（Asia/Taipei）
- 行動版優化（4 tab + 響應式排版 + 滾動修復）
- 每月盤點新增：實際盤點、誤差值、結轉選擇欄位
- 每月盤點改為 sub-tab（月盤點輸入 / 盤點總表）
- 每週訂單新增「清除盤點」按鈕
- 紀錄查詢：月盤點改為整年 12 月一覽表，週盤點改為整月週次一覽表
- 標題改為「部北洗腎室庫存管理平台」
- Firestore rules 簡化為 admin + editor 兩種角色
