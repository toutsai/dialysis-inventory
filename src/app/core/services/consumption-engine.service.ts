// src/app/core/services/consumption-engine.service.ts
import { Injectable, inject } from '@angular/core';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { FirebaseService } from './firebase.service';
import { PatientStoreService } from './patient-store.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsumptionItem {
  category: 'artificialKidney' | 'dialysateCa' | 'bicarbonateType';
  itemName: string;
  count: number;
}

export interface ConsumptionResult {
  period: { start: string; end: string };
  items: ConsumptionItem[];
  /** Grouped by category → itemName → count */
  grouped: Record<string, Record<string, number>>;
  /** Total number of schedule slots processed */
  totalSlots: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class ConsumptionEngineService {
  private readonly firebaseService = inject(FirebaseService);
  private readonly patientStore = inject(PatientStoreService);

  /**
   * Calculate theoretical consumption for a date range.
   *
   * Data flow:
   *   1. Fetch schedule documents within [startDate, endDate]
   *   2. For each slot, look up the patient's dialysisOrders → extract AK & A-liquid
   *   3. Extract bed number from the slot key → look up bed_inventory_settings → extract B-liquid
   *   4. Aggregate counts by (category, itemName)
   */
  async calculateTheoreticalConsumption(
    startDate: string,
    endDate: string,
  ): Promise<ConsumptionResult> {
    const db = this.firebaseService.db;

    // 1. Load patients if not yet loaded
    await this.patientStore.fetchPatientsIfNeeded();
    const patientMap = this.patientStore.patientMap();

    // 2. Load bed inventory settings (bed → machine/B-liquid mapping)
    const bedSettingsMap = new Map<string, { machineType: string; defaultBicarbonate: string }>();
    try {
      const bedSnap = await getDocs(collection(db, 'bed_inventory_settings'));
      bedSnap.docs.forEach((d) => {
        const data = d.data();
        bedSettingsMap.set(d.id, {
          machineType: data['machineType'] || '',
          defaultBicarbonate: data['defaultBicarbonate'] || '',
        });
      });
    } catch (error) {
      console.warn('[ConsumptionEngine] 無法載入 bed_inventory_settings:', error);
    }

    // 3. Fetch schedule documents in the date range
    const schedulesDocs = await this.fetchSchedulesInRange(startDate, endDate);

    // 4. Process each schedule
    const grouped: Record<string, Record<string, number>> = {
      artificialKidney: {},
      dialysateCa: {},
      bicarbonateType: {},
    };
    let totalSlots = 0;

    for (const scheduleDoc of schedulesDocs) {
      const schedule = (scheduleDoc['schedule'] as Record<string, Record<string, unknown>>) || {};

      for (const [slotKey, slotData] of Object.entries(schedule)) {
        const patientId = slotData?.['patientId'] as string;
        if (!patientId) continue;

        totalSlots++;
        const patient = patientMap.get(patientId);
        if (!patient) continue;

        const orders = (patient.dialysisOrders || {}) as Record<string, unknown>;

        // --- AK (人工腎臟) ---
        const akRaw = orders['ak'] as string;
        if (akRaw) {
          // AK can be multi-value like "15S/17UX"
          const akTypes = akRaw.split('/').map((s) => s.trim()).filter(Boolean);
          for (const ak of akTypes) {
            grouped['artificialKidney'][ak] = (grouped['artificialKidney'][ak] || 0) + 1;
          }
        }

        // --- A液 (透析藥水CA) ---
        const dialysateCa = orders['dialysateCa'] as string;
        if (dialysateCa) {
          grouped['dialysateCa'][dialysateCa] = (grouped['dialysateCa'][dialysateCa] || 0) + 1;
        }

        // --- B液 (from bed settings) ---
        const bedId = this.extractBedIdFromSlotKey(slotKey);
        const bedSetting = bedSettingsMap.get(bedId);
        if (bedSetting?.defaultBicarbonate) {
          const bType = bedSetting.defaultBicarbonate;
          grouped['bicarbonateType'][bType] = (grouped['bicarbonateType'][bType] || 0) + 1;
        }

        // Debug: log first few slots to verify bed ID extraction
        if (totalSlots <= 5) {
          console.log(`[ConsumptionEngine DEBUG] slotKey="${slotKey}" → bedId="${bedId}", bedSetting=`, bedSetting, ', bedSettingsMap keys:', [...bedSettingsMap.keys()].slice(0, 10));
        }
      }
    }

    // 5. Flatten to items list
    const items: ConsumptionItem[] = [];
    for (const [category, itemMap] of Object.entries(grouped)) {
      for (const [itemName, count] of Object.entries(itemMap)) {
        items.push({
          category: category as ConsumptionItem['category'],
          itemName,
          count,
        });
      }
    }

    return { period: { start: startDate, end: endDate }, items, grouped, totalSlots };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Extract bed ID from a schedule slot key.
   * Slot keys are in the format "bed-{number}-{shift}", e.g. "bed-1-early", "bed-62-noon".
   * Peripheral beds: "peripheral-{n}-{shift}", e.g. "peripheral-3-late".
   * We need to map these to bed_inventory_settings IDs: "1", "62", "外3".
   */
  private extractBedIdFromSlotKey(slotKey: string): string {
    // Remove trailing shift code (last segment after last dash)
    const lastDash = slotKey.lastIndexOf('-');
    if (lastDash === -1) return slotKey;
    const prefix = slotKey.substring(0, lastDash);

    // "bed-62" → "62"
    if (prefix.startsWith('bed-')) {
      return prefix.substring(4);
    }
    // "peripheral-3" → "外3"
    if (prefix.startsWith('peripheral-')) {
      return '外' + prefix.substring(11);
    }
    return prefix;
  }

  /**
   * Fetch all schedule documents for dates within [startDate, endDate]
   * (inclusive). Dates are YYYY-MM-DD strings.
   *
   * Past dates live in `expired_schedules`, today/future lives in `schedules`.
   */
  private async fetchSchedulesInRange(
    startDate: string,
    endDate: string,
  ): Promise<Record<string, unknown>[]> {
    const db = this.firebaseService.db;
    const results: Record<string, unknown>[] = [];
    const todayStr = new Date().toISOString().split('T')[0];

    // Generate all dates in the range
    const allDates = this.generateDateRange(startDate, endDate);

    // Split into past dates (expired_schedules) and today/future (schedules)
    const pastDates = allDates.filter((d) => d < todayStr);
    const liveDates = allDates.filter((d) => d >= todayStr);

    // 1. Fetch past schedules from expired_schedules
    if (pastDates.length > 0) {
      try {
        // Firestore 'in' supports up to 30 values, chunk if needed
        for (let i = 0; i < pastDates.length; i += 30) {
          const chunk = pastDates.slice(i, i + 30);
          const q = query(
            collection(db, 'expired_schedules'),
            where('date', 'in', chunk),
          );
          const snapshot = await getDocs(q);
          snapshot.docs.forEach((d) => {
            results.push({ id: d.id, ...d.data() });
          });
        }
        console.log(`[ConsumptionEngine] 從 expired_schedules 取得 ${results.length} 筆歷史排程`);
      } catch (error) {
        console.error('[ConsumptionEngine] 查詢 expired_schedules 失敗:', error);
      }
    }

    // 2. Fetch live schedules from schedules
    if (liveDates.length > 0) {
      try {
        for (let i = 0; i < liveDates.length; i += 30) {
          const chunk = liveDates.slice(i, i + 30);
          const q = query(
            collection(db, 'schedules'),
            where('date', 'in', chunk),
          );
          const snapshot = await getDocs(q);
          snapshot.docs.forEach((d) => {
            results.push({ id: d.id, ...d.data() });
          });
        }
        console.log(`[ConsumptionEngine] 從 schedules 取得 ${results.length - pastDates.length} 筆今日排程`);
      } catch (error) {
        console.error('[ConsumptionEngine] 查詢 schedules 失敗:', error);
      }
    }

    return results;
  }

  /**
   * Generate all dates between two YYYY-MM-DD strings (inclusive).
   */
  generateDateRange(startDate: string, endDate: string): string[] {
    const dates: string[] = [];
    const current = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');
    while (current <= end) {
      dates.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }
}
