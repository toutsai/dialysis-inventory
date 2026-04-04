// src/app/core/services/medication-store.service.ts
import { Injectable, inject, signal } from '@angular/core';
import {
  collection,
  query,
  where,
  getDocs,
  orderBy,
  limit,
} from 'firebase/firestore';
import { FirebaseService } from './firebase.service';
import { PatientStoreService } from './patient-store.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InjectionRecord {
  id: string;
  patientId: string;
  patientName?: string;
  orderCode?: string;
  orderName?: string;
  dose?: string;
  unit?: string;
  note?: string;
  frequency?: string;
  orderType?: string;
  changeDate?: string;
  uploadMonth?: string;
  [key: string]: unknown;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const FIRESTORE_IN_LIMIT = 30;

/** Known injection medication master data */
const INJECTION_MEDS: Record<string, { tradeName: string; unit: string }> = {
  INES2: { tradeName: 'NESP', unit: 'mcg' },
  IREC1: { tradeName: 'Recormon', unit: 'KIU' },
  IFER2: { tradeName: 'Fe-back', unit: 'mg' },
  ICAC: { tradeName: 'Cacare', unit: 'amp' },
  IPAR1: { tradeName: 'Parsabiv', unit: 'mg' },
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class MedicationStoreService {
  private readonly firebaseService = inject(FirebaseService);
  private readonly patientStore = inject(PatientStoreService);

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------
  readonly isLoading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  // -----------------------------------------------------------------------
  // Cache (keyed by "date|patientIdHash")
  // -----------------------------------------------------------------------
  private readonly cache = new Map<string, CacheEntry<InjectionRecord[]>>();

  // -----------------------------------------------------------------------
  // Public methods
  // -----------------------------------------------------------------------

  /**
   * Fetch daily injection records for a set of patients.
   * Queries medication_orders for injection-type orders and returns
   * the latest order per patient+orderCode.
   *
   * @param date        - YYYY-MM-DD target date (used for uploadMonth lookup)
   * @param patientIds  - array of patient document IDs to query
   * @returns Array of InjectionRecord
   */
  async fetchDailyInjections(
    date: string,
    patientIds: string[],
  ): Promise<InjectionRecord[]> {
    if (!date || !patientIds || patientIds.length === 0) {
      return [];
    }

    const cacheKey = this.buildCacheKey(date, patientIds);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      this.isLoading.set(true);
      this.error.set(null);

      const db = this.firebaseService.db;
      const colRef = collection(db, 'medication_orders');

      // Determine which uploadMonth to query.
      // Use the month of the target date, and if no results, try previous month.
      const targetDate = new Date(date + 'T00:00:00');
      const currentMonth = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;

      // Query all injection orders for these patients in the current month
      const chunks = this.chunkArray(patientIds, FIRESTORE_IN_LIMIT);
      let allOrders: InjectionRecord[] = [];

      // Try current month first
      allOrders = await this.queryInjectionOrders(colRef, chunks, currentMonth);

      // If no results, try the previous month
      if (allOrders.length === 0) {
        const prevDate = new Date(targetDate.getFullYear(), targetDate.getMonth() - 1, 1);
        const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
        allOrders = await this.queryInjectionOrders(colRef, chunks, prevMonth);
      }

      // Deduplicate: keep only the latest order per patient+orderCode
      const latestMap = new Map<string, InjectionRecord>();
      for (const order of allOrders) {
        const key = `${order.patientId}-${order.orderCode}`;
        const existing = latestMap.get(key);
        if (!existing || (order.changeDate && existing.changeDate && order.changeDate > existing.changeDate)) {
          latestMap.set(key, order);
        }
      }

      // Enrich with patient names and medication info
      const patientMap = this.patientStore.patientMap();
      const enrichedRecords = Array.from(latestMap.values())
        .filter(order => order.dose && order.dose !== '0' && order.dose !== '') // Only orders with actual dose
        .filter(order => this.shouldAdministerOnDate(order.note || '', date)) // Check frequency/date rules
        .map(order => {
          const patient = patientMap.get(order.patientId) as any;
          const medInfo = INJECTION_MEDS[order.orderCode || ''];
          return {
            ...order,
            patientName: patient?.name || order.patientName || '未知',
            orderName: medInfo?.tradeName || order.orderCode || '',
            unit: medInfo?.unit || '',
          };
        })
        .sort((a, b) => {
          // Sort by patient name, then by orderCode
          const nameCompare = (a.patientName || '').localeCompare(b.patientName || '');
          if (nameCompare !== 0) return nameCompare;
          return (a.orderCode || '').localeCompare(b.orderCode || '');
        });

      this.setCache(cacheKey, enrichedRecords);

      console.log(
        `[MedicationStoreService] Fetched ${enrichedRecords.length} injection records for ${date} (${patientIds.length} patients)`,
      );
      return enrichedRecords;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch injections';
      this.error.set(message);
      console.error('[MedicationStoreService] fetchDailyInjections error:', error);
      throw error;
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Get cached injection records for a given date.
   */
  getInjectionsForDate(date: string): InjectionRecord[] {
    const prefix = `${date}|`;
    const results: InjectionRecord[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (key.startsWith(prefix) && !this.isExpired(entry)) {
        results.push(...entry.data);
      }
    }

    return results;
  }

  /**
   * Clear all cached medication data.
   */
  clearCache(): void {
    this.cache.clear();
    console.log('[MedicationStoreService] Cache cleared');
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async queryInjectionOrders(
    colRef: any,
    chunks: string[][],
    uploadMonth: string,
  ): Promise<InjectionRecord[]> {
    const promises = chunks.map(async (chunk) => {
      const q = query(
        colRef,
        where('patientId', 'in', chunk),
        where('orderType', '==', 'injection'),
        where('uploadMonth', '==', uploadMonth),
      );
      const snapshot = await getDocs(q);
      const records: InjectionRecord[] = [];
      snapshot.forEach((doc: any) => {
        records.push({
          id: doc.id,
          ...doc.data(),
        } as InjectionRecord);
      });
      return records;
    });

    const results = await Promise.all(promises);
    return results.flat();
  }

  private buildCacheKey(date: string, patientIds: string[]): string {
    const sorted = [...patientIds].sort();
    const hash = sorted.join(',');
    return `${date}|${hash}`;
  }

  private getFromCache(key: string): InjectionRecord[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  private setCache(key: string, data: InjectionRecord[]): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  private isExpired(entry: CacheEntry<unknown>): boolean {
    return Date.now() - entry.timestamp > CACHE_TTL;
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  // -----------------------------------------------------------------------
  // Injection date/frequency filtering (ported from Vue standalone backend)
  // -----------------------------------------------------------------------

  /**
   * Determine if an injection should be administered on `targetDate`
   * based on rules encoded in the `note` field.
   *
   * Enhanced parsing logic handling comma-separated rules, attached prefixes, and fractions.
   */
  private shouldAdministerOnDate(note: string, targetDate: string): boolean {
    const trimmed = (note || '').trim();
    if (!trimmed) return false; // If no rule is specified, don't administer by default

    const dateObj = new Date(targetDate + 'T00:00:00Z');
    const targetDayOfWeek = dateObj.getUTCDay() || 7; // 1=Mon ~ 7=Sun
    const year = dateObj.getUTCFullYear();

    // Normalize: uppercase and convert fullwidth numbers to halfwidth
    const normalized = trimmed.toUpperCase().replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

    let hasRule = false;
    let matchFound = false;

    // 1. Scan for W rules (e.g., QW2, W2, W135, QW3.6, QW3、6)
    // Matches word boundary, then "QW" or "W", then digits/separators
    const wRegex = /\b(?:QW|W)([1-7][1-7\s\.,、，]*)/g;
    let wMatch;
    while ((wMatch = wRegex.exec(normalized)) !== null) {
      if (/\d{4}/.test(wMatch[0])) continue; // Ignore if contains a year-like 4-digit sequence
      hasRule = true;
      const days = wMatch[1].match(/[1-7]/g);
      if (days) {
        const dayNums = days.map(d => parseInt(d, 10));
        if (dayNums.includes(targetDayOfWeek)) matchFound = true;
      }
    }

    // 2. Scan for Date rules (MM/DD or YYYY-MM-DD or YYYY/MM/DD)
    const slashDateRegex = /(?:(\d{4})[\/\-])?(\d{1,2})[\/\-](\d{1,2})/g;
    let dMatch;
    while ((dMatch = slashDateRegex.exec(normalized)) !== null) {
      // Prevent matching fractions like "1/2 AMP" or "1/3支"
      const nextText = normalized.slice(dMatch.index + dMatch[0].length).replace(/^\s+/, '');
      if (/^(AMP|VIAL|PC|TAB|支|毫克|MG|ML|A\b|V\b)/.test(nextText) && !dMatch[1]) {
        continue;
      }
      // If preceded or followed by "/M" like "1/M", it's a frequency, not a date
      if (/^M/.test(nextText)) {
        continue;
      }

      let mYear = year;
      if (dMatch[1]) mYear = parseInt(dMatch[1], 10);
      const month = parseInt(dMatch[2], 10);
      const day = parseInt(dMatch[3], 10);

      if (this.isValidDate(month, day)) {
        hasRule = true;
        const parsed = `${mYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (parsed === targetDate) matchFound = true;
      }
    }

    // 3. Scan for MMDD (4 digits)
    // Usually at the end of a prefix (e.g., "1/M0226" -> 0226) or alone ("0305")
    const mmddRegex = /(?:^|[^\d])(\d{2})(\d{2})(?=[^\d]|$)/g;
    let mmddMatch;
    while ((mmddMatch = mmddRegex.exec(normalized)) !== null) {
      const month = parseInt(mmddMatch[1], 10);
      const day = parseInt(mmddMatch[2], 10);

      if (this.isValidDate(month, day)) {
        hasRule = true;
        const parsed = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (parsed === targetDate) matchFound = true;
      }
    }

    return hasRule ? matchFound : false;
  }

  /**
   * Quick validity check for month and day to avoid parsing doses as dates
   */
  private isValidDate(month: number, day: number): boolean {
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    if (month === 2 && day > 29) return false;
    if ([4, 6, 9, 11].includes(month) && day > 30) return false;
    return true;
  }
}
