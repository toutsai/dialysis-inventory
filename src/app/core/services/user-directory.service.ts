// src/app/core/services/user-directory.service.ts
import { Injectable, inject, signal, computed } from '@angular/core';
import { collection, getDocs } from 'firebase/firestore';
import { FirebaseService } from './firebase.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DirectoryUser {
  id: string;
  uid: string;
  name: string;
  displayName?: string;
  role: string;
  title: string;
  email: string;
  username?: string;
  isActive?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION_NAME = 'users';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class UserDirectoryService {
  private readonly firebaseService = inject(FirebaseService);

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------
  readonly allUsers = signal<DirectoryUser[]>([]);
  readonly isLoading = signal<boolean>(false);

  // -----------------------------------------------------------------------
  // Computed signals
  // -----------------------------------------------------------------------

  /** Map of user ID to DirectoryUser for O(1) lookup. */
  readonly userMap = computed<Map<string, DirectoryUser>>(() => {
    const map = new Map<string, DirectoryUser>();
    for (const user of this.allUsers()) {
      if (user.id) {
        map.set(user.id, user);
      }
      // Also index by uid if it differs from id
      if (user.uid && user.uid !== user.id) {
        map.set(user.uid, user);
      }
    }
    return map;
  });

  /** Map of user name to DirectoryUser for lookup by display name. */
  readonly userNameMap = computed<Map<string, DirectoryUser>>(() => {
    const map = new Map<string, DirectoryUser>();
    for (const user of this.allUsers()) {
      if (user.name) {
        map.set(user.name, user);
      }
    }
    return map;
  });

  /** Only active users. */
  readonly activeUsers = computed<DirectoryUser[]>(() =>
    this.allUsers().filter((u) => u.isActive !== false),
  );

  // -----------------------------------------------------------------------
  // Internal state
  // -----------------------------------------------------------------------
  private hasFetched = false;

  // -----------------------------------------------------------------------
  // Public methods
  // -----------------------------------------------------------------------

  /**
   * Fetch all users from Firestore. Skips if already fetched unless
   * force-refreshed via refresh().
   */
  async fetchUsersIfNeeded(): Promise<void> {
    if (this.hasFetched && this.allUsers().length > 0) {
      return;
    }
    await this.loadUsers();
  }

  /**
   * Force a fresh fetch of all users from Firestore.
   */
  async refresh(): Promise<void> {
    this.hasFetched = false;
    await this.loadUsers();
  }

  /**
   * Look up a user by their document ID or uid.
   */
  getUserById(id: string): DirectoryUser | undefined {
    return this.userMap().get(id);
  }

  /**
   * Look up a user by their display name.
   */
  getUserByName(name: string): DirectoryUser | undefined {
    return this.userNameMap().get(name);
  }

  /**
   * Get a display-friendly name for a user ID. Returns the name if found,
   * otherwise returns the raw ID as a fallback.
   */
  getDisplayName(idOrUid: string): string {
    const user = this.getUserById(idOrUid);
    return user?.name || idOrUid;
  }

  /**
   * Backward-compatible alias for fetchUsersIfNeeded().
   */
  async ensureUsersLoaded(): Promise<void> {
    return this.fetchUsersIfNeeded();
  }

  /**
   * Backward-compatible alias for allUsers signal.
   */
  get users() {
    return this.allUsers;
  }

  /**
   * Backward-compatible alias for refresh().
   */
  async clearCache(): Promise<void> {
    return this.refresh();
  }

  // -----------------------------------------------------------------------
  // Private methods
  // -----------------------------------------------------------------------

  private async loadUsers(): Promise<void> {
    if (this.isLoading()) return;

    try {
      this.isLoading.set(true);

      const db = this.firebaseService.db;
      const snapshot = await getDocs(collection(db, COLLECTION_NAME));

      const users: DirectoryUser[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        users.push({
          id: doc.id,
          uid: (data['uid'] as string) || doc.id,
          name: (data['name'] as string) || '',
          role: (data['role'] as string) || 'viewer',
          title: (data['title'] as string) || '',
          email: (data['email'] as string) || '',
          username: (data['username'] as string) || '',
          isActive: data['isActive'] !== false,
          ...data,
        });
      });

      this.allUsers.set(users);
      this.hasFetched = true;

      console.log(
        `[UserDirectoryService] Loaded ${users.length} users`,
      );
    } catch (error) {
      console.error('[UserDirectoryService] Failed to load users:', error);
      throw error;
    } finally {
      this.isLoading.set(false);
    }
  }
}
