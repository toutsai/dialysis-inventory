// src/app/core/services/notification.service.ts
import {
  Injectable,
  inject,
  signal,
  OnDestroy,
  DestroyRef,
} from '@angular/core';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  addDoc,
  serverTimestamp,
  type Unsubscribe,
  type Timestamp,
} from 'firebase/firestore';
import { FirebaseService } from './firebase.service';
import { AuthService } from './auth.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationType =
  | 'schedule_change'
  | 'patient_update'
  | 'task_assigned'
  | 'memo'
  | 'alert'
  | 'schedule'
  | 'patient'
  | 'task'
  | 'message'
  | 'order'
  | 'system'
  | 'error'
  | 'success'
  | 'warning'
  | 'info'
  | 'team'
  | 'default';

export interface NotificationConfig {
  icon: string;
  bgColor: string;
  textColor: string;
}

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  createdBy: string;
  createdByName: string;
  createdAt: Timestamp | null;
  time: string;
  config: NotificationConfig;
  read?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Notification config per type
// ---------------------------------------------------------------------------

const NOTIFICATION_TYPE_CONFIG: Record<string, NotificationConfig> = {
  schedule_change: {
    icon: '📅',
    bgColor: '#3498db',
    textColor: '#fff',
  },
  schedule: {
    icon: '📅',
    bgColor: '#3498db',
    textColor: '#fff',
  },
  patient_update: {
    icon: '👤',
    bgColor: '#f39c12',
    textColor: '#fff',
  },
  patient: {
    icon: '👤',
    bgColor: '#f39c12',
    textColor: '#fff',
  },
  task_assigned: {
    icon: '✅',
    bgColor: '#27ae60',
    textColor: '#fff',
  },
  task: {
    icon: '✅',
    bgColor: '#e67e22',
    textColor: '#fff',
  },
  memo: {
    icon: '📝',
    bgColor: '#9b59b6',
    textColor: '#fff',
  },
  message: {
    icon: '💬',
    bgColor: '#9b59b6',
    textColor: '#fff',
  },
  order: {
    icon: '💊',
    bgColor: '#27ae60',
    textColor: '#fff',
  },
  alert: {
    icon: '⚠️',
    bgColor: '#e74c3c',
    textColor: '#fff',
  },
  system: {
    icon: '⚙️',
    bgColor: '#7f8c8d',
    textColor: '#fff',
  },
  error: {
    icon: '❌',
    bgColor: '#e74c3c',
    textColor: '#fff',
  },
  success: {
    icon: '✅',
    bgColor: '#27ae60',
    textColor: '#fff',
  },
  warning: {
    icon: '⚠️',
    bgColor: '#f39c12',
    textColor: '#fff',
  },
  info: {
    icon: 'ℹ️',
    bgColor: '#3498db',
    textColor: '#fff',
  },
  team: {
    icon: '👥',
    bgColor: '#27ae60',
    textColor: '#fff',
  },
  conflict: {
    icon: '⚠️',
    bgColor: '#e74c3c',
    textColor: '#fff',
  },
  exception: {
    icon: '⚡️',
    bgColor: '#c0392b',
    textColor: '#fff',
  },
  default: {
    icon: '🔔',
    bgColor: '#7f8c8d',
    textColor: '#fff',
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NOTIFICATIONS = 10;
const COLLECTION_NAME = 'global_notifications';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class NotificationService implements OnDestroy {
  private readonly firebase = inject(FirebaseService);
  private readonly authService = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------
  readonly notifications = signal<AppNotification[]>([]);

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------
  private unsubscribe: Unsubscribe | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.stopListening());
  }

  ngOnDestroy(): void {
    this.stopListening();
  }

  // -----------------------------------------------------------------------
  // Public methods
  // -----------------------------------------------------------------------

  /**
   * Start listening to real-time global notifications from Firestore.
   * Only the most recent MAX_NOTIFICATIONS items are kept.
   */
  startListening(): void {
    if (this.unsubscribe) return; // Already listening

    console.log(`[NotificationService] Starting listener on collection: ${COLLECTION_NAME}`);

    const q = query(
      collection(this.firebase.db, COLLECTION_NAME),
      orderBy('createdAt', 'desc'),
      limit(MAX_NOTIFICATIONS),
    );

    this.unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        console.log(`[NotificationService] Snapshot received: ${snapshot.docs.length} docs`);
        const items: AppNotification[] = snapshot.docs.map((doc) => {
          const data = doc.data();
          const type = (data['type'] as NotificationType) || 'default';
          const createdAt = (data['createdAt'] as Timestamp) || null;
          const config =
            NOTIFICATION_TYPE_CONFIG[type] ||
            NOTIFICATION_TYPE_CONFIG['default'];

          return {
            id: doc.id,
            type,
            title: (data['title'] as string) || '',
            message: (data['message'] as string) || '',
            createdBy: (data['createdBy'] as string) || '',
            createdByName: (data['createdByName'] as string) || '',
            createdAt,
            time: createdAt ? this.formatTime(createdAt) : '',
            config,
            read: (data['read'] as boolean) || false,
          };
        });
        this.notifications.set(items);
      },
      (error) => {
        console.error('[NotificationService] Listener error:', error);
      },
    );

    console.log('[NotificationService] Listening for notifications');
  }

  /**
   * Backward-compatible alias for startListening().
   */
  startListener(): void {
    this.startListening();
  }

  /**
   * Stop the real-time listener and clear local notification data.
   */
  stopListening(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.notifications.set([]);
    console.log('[NotificationService] Stopped listening');
  }

  /**
   * Backward-compatible alias for stopListening().
   */
  stopListener(): void {
    this.stopListening();
  }

  /**
   * Write a new global notification document to Firestore.
   *
   * @param title   - Notification headline
   * @param type    - Notification category
   * @param message - Optional detailed message body
   */
  async createGlobalNotification(
    title: string,
    type: NotificationType = 'info',
    message?: string,
  ): Promise<void> {
    try {
      const db = this.firebase.db;
      const currentUser = this.authService.currentUser();
      await addDoc(collection(db, COLLECTION_NAME), {
        title,
        type,
        message: message || '',
        createdBy: currentUser?.uid || '',
        createdByName: currentUser?.name || '',
        createdAt: serverTimestamp(),
        read: false,
      });
      console.log(
        `[NotificationService] Created notification: "${title}" (${type})`,
      );
    } catch (error) {
      console.error(
        '[NotificationService] Failed to create notification:',
        error,
      );
      throw error;
    }
  }

  /**
   * Backward-compatible alias for createGlobalNotification().
   */
  async createNotification(
    title: string,
    type: NotificationType = 'info',
    message?: string,
  ): Promise<void> {
    return this.createGlobalNotification(title, type, message);
  }

  /**
   * Show a simple notification (backward-compatible convenience method).
   */
  async show(message: string, type: NotificationType = 'info'): Promise<void> {
    return this.createGlobalNotification(message, type);
  }

  /**
   * Get the config (icon, colors) for a notification type.
   */
  getConfigForType(type: string): NotificationConfig {
    return (
      NOTIFICATION_TYPE_CONFIG[type] || NOTIFICATION_TYPE_CONFIG['default']
    );
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private formatTime(timestamp: Timestamp): string {
    const date = timestamp.toDate();
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return '剛剛';
    if (diffMin < 60) return `${diffMin} 分鐘前`;

    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours} 小時前`;

    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${month}/${day} ${hours}:${minutes}`;
  }
}
