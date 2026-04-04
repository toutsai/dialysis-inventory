// src/app/core/services/archive-store.service.ts
import { Injectable, inject, signal } from '@angular/core';
import {
  collection,
  query,
  where,
  getDocs,
  limit,
} from 'firebase/firestore';
import { FirebaseService } from './firebase.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleSlot {
  patientId: string;
  patientName?: string;
  medicalRecordNumber?: string;
  bed?: string;
  shift?: string;
  nurseTeam?: string | null;
  nurseTeamIn?: string | null;
  nurseTeamOut?: string | null;
  manualNote?: string;
  autoNote?: string;
  [key: string]: unknown;
}

export interface ArchivedSchedule {
  id: string;
  date: string;
  schedule: Record<string, ScheduleSlot>;
  createdAt?: unknown;
  updatedAt?: unknown;
  [key: string]: unknown;
}

interface CacheEntry {
  data: ArchivedSchedule | null;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class ArchiveStoreService {
  private readonly firebaseService = inject(FirebaseService);

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------
  readonly isLoading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  // -----------------------------------------------------------------------
  // Cache (keyed by date string YYYY-MM-DD)
  // -----------------------------------------------------------------------
  private readonly cache = new Map<string, CacheEntry>();

  // -----------------------------------------------------------------------
  // Public methods
  // -----------------------------------------------------------------------

  /**
   * Fetch the schedule document for a given date.
   * Returns the cached result if available and not expired.
   *
   * @param dateStr - YYYY-MM-DD date string
   * @returns The schedule document, or null if none exists for that date.
   */
  async fetchScheduleByDate(dateStr: string): Promise<ArchivedSchedule | null> {
    if (!dateStr) return null;

    // Check cache
    const cached = this.getFromCache(dateStr);
    if (cached !== undefined) {
      return cached;
    }

    try {
      this.isLoading.set(true);
      this.error.set(null);

      const db = this.firebaseService.db;
      const q = query(
        collection(db, 'expired_schedules'),
        where('date', '==', dateStr),
        limit(1),
      );
      const snapshot = await getDocs(q);

      if (snapshot.empty) {
        this.setCache(dateStr, null);
        return null;
      }

      const docSnap = snapshot.docs[0];
      const schedule = {
        id: docSnap.id,
        ...docSnap.data(),
      } as ArchivedSchedule;

      this.setCache(dateStr, schedule);

      console.log(
        `[ArchiveStoreService] Fetched schedule for ${dateStr} (${
          Object.keys(schedule.schedule || {}).length
        } slots)`,
      );

      return schedule;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to fetch archived schedule';
      this.error.set(message);
      console.error(
        '[ArchiveStoreService] fetchScheduleByDate error:',
        error,
      );
      throw error;
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Batch-fetch archived schedules for multiple dates in a single Firestore query.
   * Uses the cache when possible, only queries for uncached dates.
   *
   * @param dateStrings - Array of YYYY-MM-DD date strings
   * @returns Map of dateStr -> ArchivedSchedule | null
   */
  async fetchSchedulesByDates(dateStrings: string[]): Promise<Map<string, ArchivedSchedule | null>> {
    const results = new Map<string, ArchivedSchedule | null>();
    const uncachedDates: string[] = [];

    // Check cache first for each date
    for (const dateStr of dateStrings) {
      const cached = this.getFromCache(dateStr);
      if (cached !== undefined) {
        results.set(dateStr, cached);
      } else {
        uncachedDates.push(dateStr);
      }
    }

    if (uncachedDates.length === 0) return results;

    try {
      this.isLoading.set(true);
      this.error.set(null);

      const db = this.firebaseService.db;
      // Firestore 'in' queries support up to 30 values, which is sufficient for weekly views
      const q = query(
        collection(db, 'expired_schedules'),
        where('date', 'in', uncachedDates),
      );
      const snapshot = await getDocs(q);

      // Map returned docs by date
      const fetchedByDate = new Map<string, ArchivedSchedule>();
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        const schedule = { id: docSnap.id, ...data } as ArchivedSchedule;
        fetchedByDate.set(schedule.date, schedule);
      });

      // Cache all results (including nulls for dates with no data)
      for (const dateStr of uncachedDates) {
        const schedule = fetchedByDate.get(dateStr) || null;
        this.setCache(dateStr, schedule);
        results.set(dateStr, schedule);
      }

      console.log(
        `[ArchiveStoreService] Batch-fetched ${snapshot.size} schedules for ${uncachedDates.length} dates`,
      );

      return results;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to batch-fetch archived schedules';
      this.error.set(message);
      console.error('[ArchiveStoreService] fetchSchedulesByDates error:', error);
      throw error;
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Clear all cached schedule data.
   */
  clearCache(): void {
    this.cache.clear();
    console.log('[ArchiveStoreService] Cache cleared');
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Return cached data, or `undefined` if not present / expired.
   * (null is a valid cached value meaning "no document for that date".)
   */
  private getFromCache(key: string): ArchivedSchedule | null | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > CACHE_TTL) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  private setCache(key: string, data: ArchivedSchedule | null): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }
}
