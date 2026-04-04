import { Injectable, inject, signal, computed } from '@angular/core';
import {
  collection,
  getDocs,
  query,
  orderBy,
} from 'firebase/firestore';
import { FirebaseService } from '@services/firebase.service';

export interface Patient {
  id: string;
  name: string;
  medicalRecordNumber: string;
  dialysisId: string;
  gender: string;
  birthDate: string;
  diseases: string[];
  status: string;
  [key: string]: unknown;
}

@Injectable({ providedIn: 'root' })
export class PatientService {
  private readonly firebase = inject(FirebaseService);

  /** Internal writable signals */
  private readonly _patients = signal<Patient[]>([]);
  private readonly _isLoading = signal(false);
  private readonly _error = signal<string | null>(null);

  /** Public read-only signals */
  readonly patients = this._patients.asReadonly();
  readonly isLoading = this._isLoading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly patientCount = computed(() => this._patients().length);

  /**
   * Fetch all patients from Firestore.
   */
  async fetchPatients(): Promise<void> {
    if (this._isLoading()) {
      return;
    }

    this._isLoading.set(true);
    this._error.set(null);

    try {
      const patientsRef = collection(this.firebase.db, 'patients');
      const q = query(patientsRef, orderBy('name'));
      const snapshot = await getDocs(q);

      const patients: Patient[] = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      })) as Patient[];

      this._patients.set(patients);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch patients';
      this._error.set(message);
      console.error('[PatientService] Error fetching patients:', error);
    } finally {
      this._isLoading.set(false);
    }
  }

  /**
   * Get a patient by ID from the cached list.
   */
  getPatientById(id: string): Patient | undefined {
    return this._patients().find((p) => p.id === id);
  }

  /**
   * Clear the patient list and reset state.
   */
  clear(): void {
    this._patients.set([]);
    this._error.set(null);
  }
}
