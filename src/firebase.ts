// src/firebase.ts
//
// Compatibility shim for existing framework-agnostic services and utilities
// under src/services/ and src/utils/ that import from '@/firebase'.
//
// These modules (api_manager.ts, optimizedApiService.js, firestoreUtils.js,
// taskHandlers.js, scheduleService.js, nurseAssignmentsService.js, etc.)
// rely on bare `app`, `auth`, `db`, and `functions` exports.
//
// In the Angular app the canonical source of truth is FirebaseService
// (src/app/core/services/firebase.service.ts), but because the legacy
// modules are plain JS/TS files outside Angular's DI container they cannot
// use `inject()`.  This file initialises the same Firebase instances with
// the same configuration so that both worlds share the same project /
// emulator setup.

import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import {
  initializeFirestore,
  getFirestore,
  connectFirestoreEmulator,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { environment } from './environments/environment';

const app = initializeApp(environment.firebase);
const auth = getAuth(app);

// Use initializeFirestore with persistence; fall back to getFirestore
// if already initialized by FirebaseService.
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  });
} catch {
  db = getFirestore(app);
}

const functions = getFunctions(app, 'asia-east1');

if (environment.useEmulators) {
  try {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', {
      disableWarnings: true,
    });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  } catch (e) {
    // Emulators may already be connected if FirebaseService initialised first
    console.warn('[firebase shim] Emulator connection skipped:', e);
  }
}

export { app, auth, db, functions };

