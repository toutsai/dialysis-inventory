// src/app/core/services/api-manager.service.ts
import { Injectable, inject } from '@angular/core';
import {
  collection,
  getDocs,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  getDoc,
  type QueryConstraint,
  type FirestoreDataConverter,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import { FirebaseService } from './firebase.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FirestoreRecord = { id?: string; [key: string]: unknown };

export interface ApiManager<T extends FirestoreRecord> {
  fetchAll: (queryConstraints?: QueryConstraint[]) => Promise<T[]>;
  fetchById: (id: string) => Promise<T | null>;
  save: (idOrData: string | T, data?: T) => Promise<T>;
  update: (id: string, data: Partial<T>) => Promise<T>;
  delete: (id: string) => Promise<{ id: string }>;
  create: (data: T) => Promise<T>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class ApiManagerService {
  private readonly firebaseService = inject(FirebaseService);

  /**
   * Create a typed Firestore CRUD manager for a given collection.
   *
   * Usage:
   * ```ts
   * private patientApi = this.apiManager.create<Patient>('patients');
   * const all = await this.patientApi.fetchAll();
   * ```
   */
  create<T extends FirestoreRecord>(resourceType: string): ApiManager<T> {
    const db: Firestore = this.firebaseService.db;

    if (!db) {
      throw new Error(
        "[ApiManagerService] Firestore 'db' instance is not available. Check Firebase configuration.",
      );
    }

    // -------------------------------------------------------------------
    // Converter
    // -------------------------------------------------------------------
    const converter: FirestoreDataConverter<T> = {
      toFirestore(data: T): DocumentData {
        const { id, ...rest } = data;
        return rest as DocumentData;
      },
      fromFirestore(snapshot): T {
        return { id: snapshot.id, ...(snapshot.data() as T) } as T;
      },
    };

    const collectionRef = collection(db, resourceType).withConverter(converter);

    // -------------------------------------------------------------------
    // fetchAll
    // -------------------------------------------------------------------
    const fetchAll = async (
      queryConstraints: QueryConstraint[] = [],
    ): Promise<T[]> => {
      try {
        const q =
          queryConstraints.length > 0
            ? query(collectionRef, ...queryConstraints)
            : collectionRef;
        const querySnapshot = await getDocs(q);
        const allData: T[] = [];
        querySnapshot.forEach((docSnapshot) => {
          allData.push({ id: docSnapshot.id, ...(docSnapshot.data() as T) });
        });
        return allData;
      } catch (error) {
        console.error(
          `[ApiManagerService] Error fetching ${resourceType}:`,
          error,
        );
        throw error;
      }
    };

    // -------------------------------------------------------------------
    // save  --  save(data) for auto-ID  |  save(id, data) for explicit ID
    // -------------------------------------------------------------------
    const save = async (idOrData: string | T, data?: T): Promise<T> => {
      try {
        // Case 1: auto-generated ID  (addDoc)
        if (typeof idOrData === 'object' && data === undefined) {
          const dataToSave = idOrData;
          const docRef = await addDoc(collectionRef, dataToSave);
          console.log(
            `[ApiManagerService] Added new document to ${resourceType} with ID: ${docRef.id}`,
          );
          return { id: docRef.id, ...dataToSave };
        }
        // Case 2: explicit ID  (setDoc with merge)
        else if (typeof idOrData === 'string' && typeof data === 'object') {
          const id = idOrData;
          const dataToSave = data;
          const docRef = doc(db, resourceType, id);
          await setDoc(docRef, dataToSave as DocumentData, { merge: true });
          console.log(
            `[ApiManagerService] Set document with ID ${id} in ${resourceType}`,
          );
          return { id, ...dataToSave };
        }
        // Case 3: bad arguments
        else {
          throw new Error(
            'Invalid arguments for save function. Use save(data) or save(id, data).',
          );
        }
      } catch (error) {
        console.error(
          `[ApiManagerService] Error saving to ${resourceType}:`,
          error,
        );
        throw error;
      }
    };

    // -------------------------------------------------------------------
    // update
    // -------------------------------------------------------------------
    const update = async (id: string, data: Partial<T>): Promise<T> => {
      if (!id || typeof id !== 'string') {
        const msg = `[ApiManagerService] Invalid or missing ID for update in ${resourceType}.`;
        console.error(msg);
        throw new Error(msg);
      }

      try {
        const docRef = doc(db, resourceType, id);
        await updateDoc(docRef, data as DocumentData);
        console.log(
          `[ApiManagerService] Updated document ${id} in ${resourceType}`,
        );
        return { id, ...(data as T) };
      } catch (error) {
        console.error(
          `[ApiManagerService] Error updating document ${id}:`,
          error,
        );
        throw error;
      }
    };

    // -------------------------------------------------------------------
    // fetchById
    // -------------------------------------------------------------------
    const fetchById = async (id: string): Promise<T | null> => {
      if (!id || typeof id !== 'string') {
        console.warn(
          `[ApiManagerService] fetchById called with invalid ID in ${resourceType}. Returning null.`,
        );
        return null;
      }

      try {
        const docRef = doc(db, resourceType, id);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
          return { id: docSnap.id, ...(docSnap.data() as T) };
        } else {
          console.warn(
            `[ApiManagerService] No document found with ID ${id} in ${resourceType}`,
          );
          return null;
        }
      } catch (error) {
        console.error(
          `[ApiManagerService] Error fetching document ${id}:`,
          error,
        );
        throw error;
      }
    };

    // -------------------------------------------------------------------
    // delete
    // -------------------------------------------------------------------
    const deleteDocument = async (id: string): Promise<{ id: string }> => {
      if (!id || typeof id !== 'string') {
        const msg = `[ApiManagerService] Invalid or missing ID for deletion in ${resourceType}.`;
        console.error(msg);
        throw new Error(msg);
      }

      try {
        const docRef = doc(db, resourceType, id);
        await deleteDoc(docRef);
        console.log(
          `[ApiManagerService] Deleted document ${id} from ${resourceType}`,
        );
        return { id };
      } catch (error) {
        console.error(
          `[ApiManagerService] Error deleting document ${id}:`,
          error,
        );
        throw error;
      }
    };

    // -------------------------------------------------------------------
    // create  --  convenience alias for save(data) with auto-ID
    // -------------------------------------------------------------------
    const createDocument = async (data: T): Promise<T> => {
      return save(data);
    };

    return {
      fetchAll,
      save,
      update,
      delete: deleteDocument,
      fetchById,
      create: createDocument,
    };
  }
}
