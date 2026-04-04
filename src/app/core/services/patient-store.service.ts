// src/app/core/services/patient-store.service.ts
import { Injectable, inject, signal, computed } from '@angular/core';
import {
  doc,
  getDoc,
  updateDoc,
  type DocumentData,
} from 'firebase/firestore';
import { FirebaseService } from './firebase.service';
import {
  ApiManagerService,
  type ApiManager,
  type FirestoreRecord,
} from './api-manager.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleRule {
  dayOfWeek: number[];
  shift: string;
  bed?: string;
  [key: string]: unknown;
}

export interface Patient extends FirestoreRecord {
  id?: string;
  name: string;
  medicalRecordNumber: string;
  status?: string;
  isOPD?: boolean;
  dialysisOrders?: Record<string, unknown>;
  scheduleRule?: ScheduleRule | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class PatientStoreService {
  private readonly firebaseService = inject(FirebaseService);
  private readonly apiManagerService = inject(ApiManagerService);

  private readonly patientApi: ApiManager<Patient>;
  private readonly baseScheduleApi: ApiManager<FirestoreRecord>;

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------
  readonly allPatients = signal<Patient[]>([]);
  readonly isLoading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly hasFetched = signal<boolean>(false);
  readonly patientsVersion = signal<number>(0);

  /** Raw MASTER_SCHEDULE rules map (patientId -> rule). Shared across pages. */
  readonly masterScheduleRules = signal<Record<string, unknown>>({});

  // -----------------------------------------------------------------------
  // Computed signals
  // -----------------------------------------------------------------------

  /** Map of patient ID to Patient for O(1) lookup. */
  readonly patientMap = computed<Map<string, Patient>>(() => {
    const map = new Map<string, Patient>();
    for (const patient of this.allPatients()) {
      if (patient.id) {
        map.set(patient.id, patient);
      }
    }
    return map;
  });

  /** Patients marked as OPD (outpatient dialysis). */
  readonly opdPatients = computed<Patient[]>(() =>
    this.allPatients().filter((p) => p.status === 'opd'),
  );

  constructor() {
    this.patientApi = this.apiManagerService.create<Patient>('patients');
    this.baseScheduleApi =
      this.apiManagerService.create<FirestoreRecord>('base_schedules');
  }

  // -----------------------------------------------------------------------
  // Public methods
  // -----------------------------------------------------------------------

  /**
   * Fetch all patients with their MASTER_SCHEDULE rules merged in.
   * Only fetches if data hasn't been loaded yet.
   */
  async fetchPatientsIfNeeded(): Promise<void> {
    if (this.hasFetched() && this.allPatients().length > 0) {
      return;
    }
    await this.loadPatients();
  }

  /**
   * Force a full refresh of patient data (ignores the hasFetched flag).
   */
  async forceRefreshPatients(): Promise<void> {
    await this.loadPatients();
  }

  /**
   * Add a single patient to the local store without re-fetching everything.
   */
  addPatientInStore(patient: Patient): void {
    this.allPatients.update((current) => [...current, patient]);
    this.bumpVersion();
  }

  /**
   * Update a single patient in the local store by merging new fields.
   */
  updatePatientInStore(patientId: string, changes: Partial<Patient>): void {
    this.allPatients.update((current) =>
      current.map((p) =>
        p.id === patientId ? { ...p, ...changes } : p,
      ),
    );
    this.bumpVersion();
  }

  /**
   * Remove a single patient from the local store.
   */
  removePatientInStore(patientId: string): void {
    this.allPatients.update((current) =>
      current.filter((p) => p.id !== patientId),
    );
    this.bumpVersion();
  }

  /**
   * Remove a patient's rule from the MASTER_SCHEDULE document in Firestore
   * and update the local store accordingly.
   */
  async removeRuleFromMasterSchedule(patientId: string): Promise<void> {
    try {
      const db = this.firebaseService.db;
      const scheduleRef = doc(db, 'base_schedules', 'MASTER_SCHEDULE');
      const snap = await getDoc(scheduleRef);

      if (snap.exists()) {
        const data = snap.data() as DocumentData;
        const schedule = { ...(data['schedule'] as Record<string, unknown>) };
        delete schedule[patientId];
        await updateDoc(scheduleRef, { schedule });
      }

      // Update local store: clear the patient's scheduleRule
      this.updatePatientInStore(patientId, { scheduleRule: null });
    } catch (error) {
      console.error(
        '[PatientStoreService] Error removing rule from MASTER_SCHEDULE:',
        error,
      );
      throw error;
    }
  }

  /**
   * Reset all state to defaults.
   */
  reset(): void {
    this.allPatients.set([]);
    this.isLoading.set(false);
    this.error.set(null);
    this.hasFetched.set(false);
    this.patientsVersion.set(0);
    this.masterScheduleRules.set({});
  }

  // -----------------------------------------------------------------------
  // Private methods
  // -----------------------------------------------------------------------

  private async loadPatients(): Promise<void> {
    if (this.isLoading()) return;

    try {
      this.isLoading.set(true);
      this.error.set(null);

      // Fetch patients and master schedule in parallel
      const [patients, masterScheduleDoc] = await Promise.all([
        this.patientApi.fetchAll(),
        this.baseScheduleApi.fetchById('MASTER_SCHEDULE'),
      ]);

      // Build a map of patient-id -> schedule-rule
      const masterRules: Record<string, unknown> =
        (masterScheduleDoc?.['schedule'] as Record<string, unknown>) ?? {};
      this.masterScheduleRules.set(masterRules);
      const rulesMap = new Map(Object.entries(masterRules));

      // Merge schedule rules into patient objects
      const patientsWithRules: Patient[] = patients.map((patient) => ({
        ...patient,
        scheduleRule: (rulesMap.get(patient.id!) as ScheduleRule) ?? null,
      }));

      this.allPatients.set(patientsWithRules);
      this.hasFetched.set(true);
      this.bumpVersion();

      console.log(
        `[PatientStoreService] Loaded ${patientsWithRules.length} patients`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load patients';
      this.error.set(message);
      console.error('[PatientStoreService] loadPatients error:', error);
      throw error;
    } finally {
      this.isLoading.set(false);
    }
  }

  private bumpVersion(): void {
    this.patientsVersion.update((v) => v + 1);
  }
}
