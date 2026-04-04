// src/app/core/services/task-store.service.ts
import {
  Injectable,
  inject,
  signal,
  computed,
  OnDestroy,
  DestroyRef,
} from '@angular/core';
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  type Unsubscribe,
  type Timestamp,
} from 'firebase/firestore';
import { FirebaseService } from './firebase.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskItem {
  id: string;
  patientId?: string;
  patientName?: string;
  content: string;
  type?: string;
  category?: 'task' | 'message';
  status: 'pending' | 'resolved' | 'cancelled';
  targetDate?: string;
  creator: { uid: string; name: string };
  assignee?: { uid: string; name: string };
  createdAt: Timestamp | string | Date;
  resolvedAt?: Timestamp | string | Date | null;
  resolvedBy?: { uid: string; name: string } | null;
  [key: string]: unknown;
}

export interface FeedMessage {
  id: string;
  patientId?: string;
  patientName?: string;
  content: string;
  type?: string;
  category?: string;
  status: string;
  creator: { uid: string; name: string };
  createdAt: Timestamp | string | Date;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get an ISO date string N days ago from today (Taipei timezone). */
function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

/** Get today's date as YYYY-MM-DD (Taipei timezone). */
function todayStr(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

/** Normalise Firestore timestamp / string / Date to a JS Date. */
function toDate(value: Timestamp | string | Date | undefined | null): Date {
  if (!value) return new Date(0);
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  if (typeof (value as Timestamp).toDate === 'function') {
    return (value as Timestamp).toDate();
  }
  return new Date(0);
}

/** Returns YYYY-MM-DD from a Firestore-compatible timestamp. */
function toDateStr(
  value: Timestamp | string | Date | undefined | null,
): string {
  const d = toDate(value);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// Retention window
const RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class TaskStoreService implements OnDestroy {
  private readonly firebaseService = inject(FirebaseService);
  private readonly destroyRef = inject(DestroyRef);

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------
  readonly myTasks = signal<TaskItem[]>([]);
  readonly mySentTasks = signal<TaskItem[]>([]);
  readonly feedMessages = signal<FeedMessage[]>([]);
  readonly feedMessagesVersion = signal<number>(0);
  readonly isLoading = signal<boolean>(false);
  readonly conditionRecordPatientIds = signal<Set<string>>(new Set());

  // -----------------------------------------------------------------------
  // Computed signals
  // -----------------------------------------------------------------------

  /** Feed messages sorted newest-first. */
  readonly sortedFeedMessages = computed<FeedMessage[]>(() => {
    return [...this.feedMessages()].sort(
      (a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime(),
    );
  });

  /** Number of pending tasks assigned to the current user today. */
  readonly todayTaskCount = computed<number>(() => {
    const today = todayStr();
    return this.myTasks().filter(
      (t) => t.status === 'pending' && toDateStr(t.targetDate) === today,
    ).length;
  });

  // -----------------------------------------------------------------------
  // Internal listener management
  // -----------------------------------------------------------------------
  private listeners: Unsubscribe[] = [];
  private currentUid: string | null = null;
  private readonly _myTasksByValue = signal<TaskItem[]>([]);
  private readonly _myTasksByRole = signal<TaskItem[]>([]);

  /** Merge tasks from value-based and role-based queries, deduplicating by id. */
  private _mergeMyTasks(): void {
    const all = [...this._myTasksByValue(), ...this._myTasksByRole()];
    const unique = Array.from(new Map(all.map((t) => [t.id, t])).values());
    this.myTasks.set(unique);
  }

  constructor() {
    this.destroyRef.onDestroy(() => this.cleanupListeners());
  }

  ngOnDestroy(): void {
    this.cleanupListeners();
  }

  // -----------------------------------------------------------------------
  // Public methods
  // -----------------------------------------------------------------------

  /**
   * Begin real-time Firestore listeners for tasks and messages related to
   * the given user id.
   */
  startRealtimeUpdates(uid: string): void {
    // Avoid duplicate listeners for the same user
    if (this.currentUid === uid && this.listeners.length > 0) return;

    this.cleanupListeners();
    this.currentUid = uid;
    this.isLoading.set(true);

    const db = this.firebaseService.db;
    const cutoff = daysAgoISO(RETENTION_DAYS);

    // -- Tasks assigned to this user by UID (within retention window) --
    const myTasksQuery = query(
      collection(db, 'tasks'),
      where('assignee.value', '==', uid),
      where('targetDate', '>=', cutoff),
      orderBy('targetDate', 'desc'),
    );
    this.listeners.push(
      onSnapshot(myTasksQuery, (snapshot) => {
        const tasks: TaskItem[] = [];
        snapshot.forEach((doc) =>
          tasks.push({ id: doc.id, ...doc.data() } as TaskItem),
        );
        this._myTasksByValue.set(tasks);
        this._mergeMyTasks();
        this.isLoading.set(false);
      }, (error) => {
        console.error('[TaskStoreService] myTasks (value) listener error:', error);
        this.isLoading.set(false);
      }),
    );

    // -- Tasks assigned by role (e.g., 'editor' for nurse leaders) --
    const roleTasksQuery = query(
      collection(db, 'tasks'),
      where('assignee.type', '==', 'role'),
      where('targetDate', '>=', cutoff),
      orderBy('targetDate', 'desc'),
    );
    this.listeners.push(
      onSnapshot(roleTasksQuery, (snapshot) => {
        const tasks: TaskItem[] = [];
        snapshot.forEach((doc) =>
          tasks.push({ id: doc.id, ...doc.data() } as TaskItem),
        );
        this._myTasksByRole.set(tasks);
        this._mergeMyTasks();
      }, (error) => {
        console.error('[TaskStoreService] myTasks (role) listener error:', error);
      }),
    );

    // -- Tasks sent by this user --
    const sentTasksQuery = query(
      collection(db, 'tasks'),
      where('creator.uid', '==', uid),
      where('targetDate', '>=', cutoff),
      orderBy('targetDate', 'desc'),
    );
    this.listeners.push(
      onSnapshot(sentTasksQuery, (snapshot) => {
        const tasks: TaskItem[] = [];
        snapshot.forEach((doc) =>
          tasks.push({ id: doc.id, ...doc.data() } as TaskItem),
        );
        this.mySentTasks.set(tasks);
      }, (error) => {
        console.error('[TaskStoreService] sentTasks listener error:', error);
      }),
    );

    // -- Feed messages (previously memos, now all in tasks collection) --
    const feedQuery = query(
      collection(db, 'tasks'),
      where('category', '==', 'message'),
      where('targetDate', '>=', cutoff),
      orderBy('targetDate', 'desc'),
    );
    this.listeners.push(
      onSnapshot(feedQuery, (snapshot) => {
        const messages: FeedMessage[] = [];
        snapshot.forEach((doc) =>
          messages.push({
            id: doc.id,
            ...doc.data(),
          } as FeedMessage),
        );
        this.feedMessages.set(messages);
        this.feedMessagesVersion.update((v) => v + 1);
      }, (error) => {
        console.error('[TaskStoreService] feedMessages listener error:', error);
      }),
    );

    // -- Condition records: track which patient IDs have condition entries --
    const conditionQuery = query(
      collection(db, 'condition_records'),
      where('date', '>=', cutoff),
    );
    this.listeners.push(
      onSnapshot(conditionQuery, (snapshot) => {
        const ids = new Set<string>();
        snapshot.forEach((doc) => {
          const data = doc.data();
          if (data['patientId']) {
            ids.add(data['patientId'] as string);
          }
        });
        this.conditionRecordPatientIds.set(ids);
      }, (error) => {
        console.error(
          '[TaskStoreService] conditionRecords listener error:',
          error,
        );
      }),
    );

    console.log(
      `[TaskStoreService] Real-time listeners started for user ${uid}`,
    );
  }

  /**
   * Stop all active Firestore listeners and clear data.
   */
  stopRealtimeUpdates(): void {
    this.cleanupListeners();
    this.myTasks.set([]);
    this.mySentTasks.set([]);
    this.feedMessages.set([]);
    this.conditionRecordPatientIds.set(new Set());
    this.currentUid = null;
    console.log('[TaskStoreService] Real-time listeners stopped');
  }

  /**
   * Build a map from patientId to a Set of message types for a given date.
   * Useful for showing icons on the schedule grid.
   */
  getPatientMessageTypesMapForDate(
    dateStr: string,
  ): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const msg of this.feedMessages()) {
      if (toDateStr(msg.createdAt) !== dateStr) continue;
      const pid = msg.patientId;
      if (!pid) continue;
      if (!map.has(pid)) {
        map.set(pid, new Set<string>());
      }
      map.get(pid)!.add(msg.type || '常規');
    }
    return map;
  }

  /**
   * Build a map from patientId to an array of message types for ALL pending
   * messages (no date filter). Useful for showing icons on any page.
   */
  getPendingMessageTypesMap(): Map<string, string[]> {
    const excludedStatuses = new Set(['completed', 'resolved', 'cancelled']);
    const map = new Map<string, Set<string>>();
    for (const msg of this.feedMessages()) {
      // Skip completed/resolved messages, show everything else
      if (msg.status && excludedStatuses.has(msg.status)) continue;
      const pid = msg.patientId;
      if (!pid) continue;
      if (!map.has(pid)) {
        map.set(pid, new Set<string>());
      }
      map.get(pid)!.add(msg.type || '常規');
    }
    // Also add 'record' for patients with condition records
    for (const pid of this.conditionRecordPatientIds()) {
      if (!map.has(pid)) {
        map.set(pid, new Set<string>());
      }
      map.get(pid)!.add('record');
    }
    const result = new Map<string, string[]>();
    for (const [pid, types] of map) {
      result.set(pid, Array.from(types));
    }
    return result;
  }

  /**
   * Unsubscribe from all active Firestore snapshot listeners.
   */
  cleanupListeners(): void {
    for (const unsub of this.listeners) {
      try {
        unsub();
      } catch {
        // Ignore errors during unsubscribe
      }
    }
    this.listeners = [];
  }
}
