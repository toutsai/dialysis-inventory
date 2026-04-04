# 庫存管理系統獨立化 — 完整修改指南

## 前置作業
將 `dialysis-app-angular` 全部內容複製到 `dialysis-inventory`，然後依照以下步驟修改。

---

## Step 1: 刪除不需要的資料夾

### Features（只保留 inventory + login）
```bash
rm -rf src/app/features/account-settings
rm -rf src/app/features/base-schedule
rm -rf src/app/features/collaboration
rm -rf src/app/features/consumables
rm -rf src/app/features/daily-log
rm -rf src/app/features/draft-orders
rm -rf src/app/features/exception-manager
rm -rf src/app/features/kidit-report
rm -rf src/app/features/lab-reports
rm -rf src/app/features/my-patients
rm -rf src/app/features/nursing-schedule
rm -rf src/app/features/orders
rm -rf src/app/features/patients
rm -rf src/app/features/physician-schedule
rm -rf src/app/features/reporting
rm -rf src/app/features/schedule
rm -rf src/app/features/stats
rm -rf src/app/features/update-scheduler
rm -rf src/app/features/usage-guide
rm -rf src/app/features/user-management
rm -rf src/app/features/weekly
```

### Services（只保留 auth.service.ts + firebase.service.ts）
```bash
rm src/app/core/services/consumption-engine.service.ts
rm src/app/core/services/patient-store.service.ts
rm src/app/core/services/patient.service.ts
rm src/app/core/services/medication-store.service.ts
rm src/app/core/services/archive-store.service.ts
rm src/app/core/services/task-store.service.ts
rm src/app/core/services/notification.service.ts
rm src/app/core/services/auto-assign-config.service.ts
rm src/app/core/services/date-state.service.ts
rm src/app/core/services/user-directory.service.ts
rm src/app/core/services/api-manager.service.ts
```

### Guards（只保留 auth.guard.ts）
```bash
rm src/app/core/guards/admin.guard.ts
```

### 共用元件（只保留 alert-dialog）
```bash
rm -rf src/app/components/condition-record-panel
rm -rf src/app/components/daily-staff-display
rm -rf src/app/components/holiday-manager
rm -rf src/app/components/icons
rm -rf src/app/components/inpatient-sidebar
rm -rf src/app/components/kidit
rm -rf src/app/components/lab-med-correlation-view
rm -rf src/app/components/marquee-banner
rm -rf src/app/components/memo-panel
rm -rf src/app/components/patient-image-uploader
rm -rf src/app/components/patient-lab-summary-panel
rm -rf src/app/components/patient-messages-icon
rm -rf src/app/components/preparation-popover
rm -rf src/app/components/schedule-table
rm -rf src/app/components/stats-toolbar
rm -rf src/app/components/system-diagnostic
rm -rf src/app/components/ward-number-badge
```

### Dialogs（只保留 alert-dialog）
```bash
# 刪除 src/app/components/dialogs/ 底下除了 alert-dialog 以外的所有資料夾
```

### Utils（只保留 dateUtils.js + firestoreUtils.js）
```bash
rm src/utils/kiditHelpers.js
rm src/utils/medicationUtils.js
rm src/utils/sanitize.js
rm src/utils/scheduleUtils.js
rm src/utils/taskHandlers.js
```

### 其他
```bash
rm -rf scripts/
rm migrate.js
rm src/app/core/constants/medication-constants.ts
```

### Cloud Functions utils/services
```bash
rm -rf functions/services
rm -rf functions/utils
```

---

## Step 2: 建立新檔案 — DailyConsumptionService

建立 `src/app/core/services/daily-consumption.service.ts`
（完整內容見本資料夾中的同名檔案，已建好）

---

## Step 3: 修改 inventory.component.ts

### 3a. Import 區塊（檔案最上方）

**刪除：**
```typescript
import { PatientStoreService } from '@services/patient-store.service';
import { ConsumptionEngineService, type ConsumptionResult } from '@services/consumption-engine.service';
import { httpsCallable } from 'firebase/functions';
import { queryWithInChunks } from '@/utils/firestoreUtils';
```
從 firebase/firestore import 中移除 `documentId`。
從 @angular/core import 中移除 `computed`（如果沒有其他地方用到）。

**新增：**
```typescript
import { DailyConsumptionService } from '@services/daily-consumption.service';
```

### 3b. Inject 區塊

**刪除：**
```typescript
private readonly patientStore = inject(PatientStoreService);
private readonly consumptionEngine = inject(ConsumptionEngineService);
```

**新增：**
```typescript
private readonly dailyConsumption = inject(DailyConsumptionService);
```

### 3c. 刪除常數
刪除 `SHIFT_MAP` 和 `SHIFT_INDEX_MAP`。

### 3d. 刪除 Signal/屬性

刪除所有床位/機器相關：
- `bedsSettings`, `bedsLoading`
- `machineConfigs`, `machineConfigLoading`, `showMachineConfigModal`, `machineConfigForm`, `editingMachineConfig`
- `isMachineConfigFormValid` getter, `machineTypeNames` getter

刪除排程推算相關：
- `theoreticalLoading`, `theoreticalResult`, `theoreticalFilter`

刪除消耗查詢相關：
- `consumptionSubTab`, `consumptionLoading`, `consumptionSearchPerformed`
- `rawConsumptionData`, `processedConsumptionData`, `groupSearchParams`, `dynamicHeaders`
- `flattenedHeaders` getter

修改預估信號：
- 刪除 `todayForecast`, `tomorrowForecast`, `forecastLoading`
- 新增 `yesterdayConsumption = signal<Record<string, Record<string, number>>>({});`

### 3e. 修改 ngOnInit

```typescript
async ngOnInit(): Promise<void> {
  await this.initializeDefaultItems();
  await this.fetchInventoryItems();
  await this.fetchPurchases();
  await this.loadKnownItems();
  this.loadDashboard();
}
```

### 3f. 刪除整個 Tab 0.5 Methods 區塊
包含：`fetchMachineConfigs`, `openMachineConfigModal`, `closeMachineConfigModal`, `saveMachineConfig`, `deleteMachineConfig`, `onBedMachineChange`, `fetchBedsSettings`, `saveBedSetting`

### 3g. 刪除消耗查詢方法
- `formatShift()`
- `handleConsumptionSearch()`（大約 110 行）
- `exportConsumablesToExcel()`

### 3h. 刪除 `toBase64()` 方法

### 3i. 修改 `handleUpload()`

```typescript
async handleUpload(): Promise<void> {
  const file = this.selectedFile();
  if (!file) {
    this.showAlert('提示', '請先選擇一個檔案！');
    return;
  }
  this.isUploading.set(true);
  this.uploadResult.set(null);
  try {
    const currentUser = this.authService.currentUser();
    const result = await this.dailyConsumption.parseExcelAndSave(
      file,
      currentUser?.name || '未知',
    );
    this.uploadResult.set(result);
  } catch (error: any) {
    console.error('上傳處理失敗:', error);
    this.uploadResult.set({ message: `上傳失敗: ${error.message}`, errorCount: 1 });
  } finally {
    this.isUploading.set(false);
  }
}
```

### 3j. 刪除 `runTheoreticalConsumption()` 方法

### 3k. 修改 `loadDashboard()`

4 處 `consumptionEngine.calculateTheoreticalConsumption()` 呼叫替換為：

1. **盤點後消耗**（原: `this.consumptionEngine.calculateTheoreticalConsumption(countDate, todayStr)`）
   → `this.dailyConsumption.getConsumptionByRange(countDate, todayStr)` 然後取 `result.grouped`

2. **上週消耗**（原: `this.consumptionEngine.calculateTheoreticalConsumption(lastMondayStr, lastSaturdayStr)`）
   → `this.dailyConsumption.getConsumptionByRange(lastMondayStr, lastSaturdayStr)` 然後取 `result.grouped`

3. **今日/明日預估** → 全部移除，改為載入昨日實際消耗：
```typescript
let yesterdayData: Record<string, Record<string, number>> = {};
try {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const yesterdayResult = await this.dailyConsumption.getDailyConsumption(yesterdayStr);
  if (yesterdayResult) {
    yesterdayData = yesterdayResult;
    this.yesterdayConsumption.set(yesterdayResult);
  }
} catch (e) {
  console.warn('昨日消耗載入失敗:', e);
}
```

4. 狀態計算中，`todayForecastData[category]?.[itemName]` 改為 `yesterdayData[category]?.[itemName]`

### 3l. 刪除 `loadDailyForecast()` 方法

### 3m. 重命名 `isForecastEmpty` → `isConsumptionEmpty`

### 3n. 簡化 `getMonthlyConsumption()`

```typescript
private async getMonthlyConsumption(month: string): Promise<Record<string, Record<string, number>>> {
  return this.dailyConsumption.getMonthlyConsumption(month);
}
```

### 3o. 簡化 `getConsumptionByDateRange()`

```typescript
private async getConsumptionByDateRange(
  startDate: Date,
  endDate: Date,
): Promise<Record<string, Record<string, number>>> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const result = await this.dailyConsumption.getConsumptionByRange(fmt(startDate), fmt(endDate));
  return result.grouped;
}
```

### 3p. 修改 `loadWeeklyData()`

把 `this.consumptionEngine.calculateTheoreticalConsumption(lastWeekStart, lastWeekEnd)` 
改為 `this.dailyConsumption.getConsumptionByRange(lastWeekStart, lastWeekEnd)`

### 3q. 簡化 `loadKnownItems()`

```typescript
private async loadKnownItems(): Promise<void> {
  for (const category of Object.keys(this.knownItems)) {
    this.knownItems[category].sort();
  }
}
```

### 3r. 修改 `onModalOverlayClick`
類型改為 `modal: 'purchase' | 'item'`，移除 `machineConfig` 分支。

---

## Step 4: 修改 inventory.component.html

1. **Tab 導航列**：刪除「床位預設用物」按鈕
2. **Dashboard 預估區塊**：「今日/明日預估消耗」→「昨日實際消耗」
   - `todayForecast()` → `yesterdayConsumption()`
   - `isForecastEmpty()` → `isConsumptionEmpty()`
   - 移除明日預估卡片
3. **刪除整個床位設定 Tab panel**（`activeTab() === 'beds'` 區塊）
4. **消耗紀錄 Tab**：
   - 移除所有 sub-tab 按鈕（耗材查詢/排程推算/當月總量/資料上傳）
   - 移除「耗材查詢」sub-panel（按病人分組查詢）
   - 移除「排程推算」sub-panel
   - 保留「資料上傳」區塊（標題改為「上傳每日耗材消耗 Excel」）
   - 保留「當月消耗總量」區塊
   - 兩個區塊直接顯示（不再用 sub-tab 切換）
5. **刪除洗腎機設定 Modal**（`showMachineConfigModal()` 區塊）

---

## Step 5: 簡化其他檔案

### app.component.ts
```typescript
import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {}
```

### app.component.html
```html
<router-outlet />
```

### app.routes.ts
只保留 login + inventory 路由，預設導向 `/inventory`。

### main-layout.component.ts
簡化為 inline template：header（標題 + 使用者名稱 + 登出）+ `<router-outlet>`。
刪除 main-layout.component.html 和 main-layout.component.css。

### admin.guard.ts
刪除（路由中不再使用）。

---

## Step 6: Cloud Functions

`functions/index.js` 只保留 4 個函式：
- `customLogin`
- `changeUserPassword`
- `createUser`
- `adminResetPassword`

刪除 `functions/services/` 和 `functions/utils/` 資料夾。

`functions/package.json` 依賴只需要：
- `bcryptjs`
- `firebase-admin`
- `firebase-functions`

---

## Step 7: Firebase 設定

### environment.ts / environment.production.ts
Firebase config 改為 placeholder（`YOUR_PROJECT_ID` 等），等建好新 Firebase 專案後填入。

### .firebaserc
```json
{ "projects": { "default": "YOUR_PROJECT_ID" } }
```

### firestore.rules
只保留：`users`, `inventory_items`, `inventory_purchases`, `inventory_counts`, `daily_consumption`, `audit_logs` 集合的規則。

---

## Firestore 集合（新專案需要的）

| 集合 | 用途 |
|------|------|
| `inventory_items` | 品項主檔 |
| `inventory_purchases` | 進貨紀錄 |
| `inventory_counts` | 盤點結果(月/週) |
| `daily_consumption` | **新增** 每日消耗彙總 |
| `users` | 使用者帳號 |
| `audit_logs` | 稽核日誌 |
