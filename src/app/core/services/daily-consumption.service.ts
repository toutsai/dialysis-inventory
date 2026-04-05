import { Injectable, inject } from '@angular/core';
import {
  collection, query, where, getDocs, setDoc, doc, Timestamp, orderBy,
} from 'firebase/firestore';
import { FirebaseService } from './firebase.service';
import * as XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DailyConsumptionTotals {
  [key: string]: Record<string, number>;
  artificialKidney: Record<string, number>;
  dialysateCa: Record<string, number>;
  bicarbonateType: Record<string, number>;
}

export interface DailyConsumptionDoc {
  date: string;
  month: string;
  totals: DailyConsumptionTotals;
  sourceFile: string;
  uploadedBy: string;
  uploadedAt: Timestamp;
}

export interface UploadResult {
  success: boolean;
  message: string;
  date?: string;
  category?: string;
  itemCount?: number;
  errorCount?: number;
}

// Category header mapping: Excel header → Firestore field
const CATEGORY_MAP: Record<string, keyof DailyConsumptionTotals> = {
  '人工腎臟': 'artificialKidney',
  '透析藥水CA': 'dialysateCa',
  'B液種類': 'bicarbonateType',
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class DailyConsumptionService {
  private readonly firebaseService = inject(FirebaseService);

  /**
   * Parse an Excel file (same format as hospital consumables report)
   * and save aggregated consumption to Firestore `daily_consumption/{date}`.
   *
   * Excel format:
   *   Row 0: Title (e.g. "A2.透析筆水Ca統計表--來源透析紀錄")
   *   Row 1: "&起日20250726&迄日20250825"
   *   Row N: 病歷號 | 姓名 | [耗材類別] | COUNT(*)
   */
  async parseExcelAndSave(file: File, userName: string): Promise<UploadResult> {
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const sheetData: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

      if (sheetData.length < 3) {
        return { success: false, message: 'Excel 檔案內容行數不足。', errorCount: 1 };
      }

      // 1. Extract date from row 1: "&起日YYYYMMDD&迄日YYYYMMDD"
      const dateString = String(sheetData[1]?.[0] || '');
      const dateMatch = dateString.match(/&迄日(\d{4})(\d{2})(\d{2})/);
      if (!dateMatch) {
        return {
          success: false,
          message: 'Excel 格式錯誤：在第二列找不到有效的迄日（需為 &迄日YYYYMMDD 格式）。',
          errorCount: 1,
        };
      }
      const date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
      const month = `${dateMatch[1]}-${dateMatch[2]}`;

      // 2. Find the header row (contains "病歷號")
      let headerRowIndex = -1;
      for (let i = 0; i < sheetData.length; i++) {
        if (sheetData[i]?.some((cell: any) => String(cell).trim() === '病歷號')) {
          headerRowIndex = i;
          break;
        }
      }
      if (headerRowIndex === -1) {
        return {
          success: false,
          message: "找不到有效的標題行（需包含 '病歷號'）。",
          errorCount: 1,
        };
      }

      // 3. Identify the consumable category from header
      const headers = sheetData[headerRowIndex];
      let consumableHeader = '';
      let firestoreField: keyof DailyConsumptionTotals | '' = '';

      for (const [headerName, fieldName] of Object.entries(CATEGORY_MAP)) {
        if (headers.some((h: any) => String(h).trim() === headerName)) {
          consumableHeader = headerName;
          firestoreField = fieldName;
          break;
        }
      }

      if (!firestoreField) {
        return {
          success: false,
          message: '在標題行中找不到關鍵的耗材欄位（人工腎臟/透析藥水CA/B液種類）。',
          errorCount: 1,
        };
      }

      // 4. Build column index map
      const headerIndex: Record<string, number> = {};
      headers.forEach((h: any, idx: number) => {
        if (h != null) headerIndex[String(h).trim()] = idx;
      });

      const consumableColIdx = headerIndex[consumableHeader];
      const countColIdx = headerIndex['COUNT(*)'];

      if (consumableColIdx === undefined || countColIdx === undefined) {
        return {
          success: false,
          message: `找不到必要的欄位：${consumableHeader} 或 COUNT(*)。`,
          errorCount: 1,
        };
      }

      // 5. Aggregate: sum COUNT(*) per consumable item name
      const dataRows = sheetData.slice(headerRowIndex + 1);
      const aggregated: Record<string, number> = {};
      let processedRows = 0;
      let errorRows = 0;

      for (const row of dataRows) {
        if (!row || row.every((cell: any) => cell == null || String(cell).trim() === '')) {
          continue; // skip empty rows
        }

        const itemName = row[consumableColIdx];
        const count = row[countColIdx];

        if (itemName == null || String(itemName).trim() === '') {
          errorRows++;
          continue;
        }

        const itemStr = String(itemName).trim();
        const countNum = typeof count === 'number' ? count : parseInt(String(count), 10) || 0;

        aggregated[itemStr] = (aggregated[itemStr] || 0) + countNum;
        processedRows++;
      }

      // 6. Read existing doc to merge with other categories
      const db = this.firebaseService.db;
      const docRef = doc(db, 'daily_consumption', date);
      const existingSnap = await getDocs(
        query(collection(db, 'daily_consumption'), where('date', '==', date))
      );

      let existingTotals: DailyConsumptionTotals = {
        artificialKidney: {},
        dialysateCa: {},
        bicarbonateType: {},
      };

      if (!existingSnap.empty) {
        const existingData = existingSnap.docs[0].data() as DailyConsumptionDoc;
        existingTotals = existingData.totals || existingTotals;
      }

      // Overwrite only the uploaded category
      existingTotals[firestoreField] = aggregated;

      // 7. Write to Firestore
      await setDoc(docRef, {
        date,
        month,
        totals: existingTotals,
        sourceFile: file.name,
        uploadedBy: userName,
        uploadedAt: Timestamp.now(),
      });

      const categoryName = Object.entries(CATEGORY_MAP).find(([, v]) => v === firestoreField)?.[0] || firestoreField;

      return {
        success: true,
        message: `上傳成功！日期：${date}，類別：${categoryName}，處理 ${processedRows} 筆資料，${Object.keys(aggregated).length} 個品項。${errorRows > 0 ? `（${errorRows} 筆略過）` : ''}`,
        date,
        category: firestoreField as string,
        itemCount: Object.keys(aggregated).length,
        errorCount: errorRows,
      };
    } catch (error: any) {
      console.error('[DailyConsumption] 解析 Excel 失敗:', error);
      return {
        success: false,
        message: `解析 Excel 失敗: ${error.message}`,
        errorCount: 1,
      };
    }
  }

  /**
   * Get aggregated consumption for a date range (inclusive).
   * Returns the same shape as ConsumptionResult.grouped.
   */
  async getConsumptionByRange(
    startDate: string,
    endDate: string,
  ): Promise<{ grouped: DailyConsumptionTotals; totalDays: number }> {
    const db = this.firebaseService.db;
    const grouped: DailyConsumptionTotals = {
      artificialKidney: {},
      dialysateCa: {},
      bicarbonateType: {},
    };
    let totalDays = 0;

    try {
      const q = query(
        collection(db, 'daily_consumption'),
        where('date', '>=', startDate),
        where('date', '<=', endDate),
        orderBy('date'),
      );
      const snapshot = await getDocs(q);

      snapshot.docs.forEach((d) => {
        const data = d.data() as DailyConsumptionDoc;
        totalDays++;
        for (const category of Object.keys(grouped) as (keyof DailyConsumptionTotals)[]) {
          const items = data.totals?.[category] || {};
          for (const [itemName, count] of Object.entries(items)) {
            grouped[category][itemName] = (grouped[category][itemName] || 0) + count;
          }
        }
      });
    } catch (error) {
      console.error('[DailyConsumption] 查詢消耗資料失敗:', error);
    }

    return { grouped, totalDays };
  }

  /**
   * Get aggregated consumption for a specific month (YYYY-MM).
   */
  async getMonthlyConsumption(month: string): Promise<DailyConsumptionTotals> {
    const db = this.firebaseService.db;
    const result: DailyConsumptionTotals = {
      artificialKidney: {},
      dialysateCa: {},
      bicarbonateType: {},
    };

    try {
      const q = query(
        collection(db, 'daily_consumption'),
        where('month', '==', month),
      );
      const snapshot = await getDocs(q);

      snapshot.docs.forEach((d) => {
        const data = d.data() as DailyConsumptionDoc;
        for (const category of Object.keys(result) as (keyof DailyConsumptionTotals)[]) {
          const items = data.totals?.[category] || {};
          for (const [itemName, count] of Object.entries(items)) {
            result[category][itemName] = (result[category][itemName] || 0) + count;
          }
        }
      });
    } catch (error) {
      console.error('[DailyConsumption] 查詢月消耗失敗:', error);
    }

    return result;
  }

  /**
   * Get consumption for a single date.
   */
  async getDailyConsumption(date: string): Promise<DailyConsumptionTotals | null> {
    const db = this.firebaseService.db;
    try {
      const q = query(
        collection(db, 'daily_consumption'),
        where('date', '==', date),
      );
      const snapshot = await getDocs(q);
      if (snapshot.empty) return null;
      const data = snapshot.docs[0].data() as DailyConsumptionDoc;
      return data.totals;
    } catch (error) {
      console.error('[DailyConsumption] 查詢單日消耗失敗:', error);
      return null;
    }
  }

  /**
   * Get list of all uploaded dates for a month (for display).
   */
  async getUploadedDates(month: string): Promise<string[]> {
    const db = this.firebaseService.db;
    try {
      const q = query(
        collection(db, 'daily_consumption'),
        where('month', '==', month),
        orderBy('date'),
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map((d) => (d.data() as DailyConsumptionDoc).date);
    } catch (error) {
      console.error('[DailyConsumption] 查詢上傳日期失敗:', error);
      return [];
    }
  }

  /**
   * Get per-day consumption breakdown for a month.
   * Returns a map: date → DailyConsumptionTotals
   */
  async getMonthlyDailyBreakdown(month: string): Promise<Map<string, DailyConsumptionTotals>> {
    const db = this.firebaseService.db;
    const result = new Map<string, DailyConsumptionTotals>();

    try {
      const q = query(
        collection(db, 'daily_consumption'),
        where('month', '==', month),
        orderBy('date'),
      );
      const snapshot = await getDocs(q);

      snapshot.docs.forEach((d) => {
        const data = d.data() as DailyConsumptionDoc;
        result.set(data.date, data.totals);
      });
    } catch (error) {
      console.error('[DailyConsumption] 查詢每日明細失敗:', error);
    }

    return result;
  }
}
