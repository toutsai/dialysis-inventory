// src/app/core/services/auth.service.ts
import {
  Injectable,
  inject,
  signal,
  computed,
  DestroyRef,
  OnDestroy,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  onAuthStateChanged,
  signInWithCustomToken,
  signOut,
  type User,
  type Unsubscribe,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { FirebaseService } from './firebase.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppUser {
  id: string;
  uid: string;
  name: string;
  displayName?: string;
  role: UserRole;
  title: string;
  email: string;
  lastLogin: string;
  [key: string]: unknown;
}

export type UserRole = 'admin' | 'editor' | 'contributor' | 'viewer';

export interface AuthClaims {
  role: UserRole;
  name: string;
  title: string;
  email: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Permission hierarchy
// ---------------------------------------------------------------------------

const ROLE_HIERARCHY: Record<UserRole, number> = {
  viewer: 1,
  contributor: 2,
  editor: 3,
  admin: 4,
} as const;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class AuthService implements OnDestroy {
  private readonly firebase = inject(FirebaseService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------
  readonly currentUser = signal<AppUser | null>(null);
  readonly authLoading = signal<boolean>(true);
  readonly claims = signal<AuthClaims | null>(null);
  readonly isAuthReady = signal<boolean>(false);

  // -----------------------------------------------------------------------
  // Computed signals
  // -----------------------------------------------------------------------
  readonly isLoggedIn = computed(() => !!this.currentUser());
  readonly isAdmin = computed(() => this.hasPermission('admin'));
  readonly isEditor = computed(() => this.hasPermission('editor'));
  readonly isContributor = computed(() => this.hasPermission('contributor'));
  readonly isViewer = computed(() => this.currentUser()?.role === 'viewer');

  readonly canEditSchedules = computed(() => this.hasPermission('editor'));
  readonly canEditPatients = computed(() => this.hasPermission('editor'));
  readonly canManageOrders = computed(() => this.hasPermission('contributor'));
  readonly canManagePhysicianSchedule = computed(() =>
    this.hasPermission('editor'),
  );
  readonly canEditClinicalNotesAndOrders = computed(() => {
    const role = this.currentUser()?.role;
    return role === 'admin' || role === 'contributor';
  });

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------
  private authUnsubscribe: Unsubscribe | null = null;
  private authReadyResolve: (() => void) | null = null;
  private readonly authReadyPromise: Promise<void>;

  constructor() {
    this.authReadyPromise = new Promise<void>((resolve) => {
      this.authReadyResolve = resolve;
    });

    this.initAuthListener();

    this.destroyRef.onDestroy(() => {
      this.cleanup();
    });
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // -----------------------------------------------------------------------
  // Public methods
  // -----------------------------------------------------------------------

  /**
   * Login using the custom Cloud Function "customLogin".
   * The function returns a custom token which is then used to sign in via
   * Firebase Auth.
   */
  async login(
    username: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.authLoading.set(true);

      const customLoginFn = httpsCallable<
        { username: string; password: string },
        { token: string }
      >(this.firebase.functions, 'customLogin');

      const result = await customLoginFn({ username, password });
      const { token } = result.data;

      await signInWithCustomToken(this.firebase.auth, token);

      return { success: true };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : '登入失敗，請稍後再試';
      console.error('[AuthService] Login failed:', message);
      return { success: false, error: message };
    } finally {
      this.authLoading.set(false);
    }
  }

  /**
   * Sign out and redirect to /login.
   */
  async logout(): Promise<void> {
    try {
      await signOut(this.firebase.auth);
      this.currentUser.set(null);
      this.claims.set(null);
      this.router.navigate(['/login']);
    } catch (error) {
      console.error('[AuthService] Logout failed:', error);
      // Force redirect even on error
      this.router.navigate(['/login']);
    }
  }

  /**
   * Change the current user's password via a Cloud Function.
   */
  async updatePassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const changePasswordFn = httpsCallable<
        { oldPassword: string; newPassword: string },
        { success: boolean }
      >(this.firebase.functions, 'changeUserPassword');

      await changePasswordFn({ oldPassword, newPassword });
      return { success: true };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : '密碼更新失敗';
      console.error('[AuthService] Password change failed:', message);
      return { success: false, error: message };
    }
  }

  /**
   * Check whether the current user has at least the given role level.
   */
  hasPermission(requiredRole: UserRole): boolean {
    const user = this.currentUser();
    if (!user) return false;
    const userLevel = ROLE_HIERARCHY[user.role] ?? 0;
    const requiredLevel = ROLE_HIERARCHY[requiredRole] ?? Infinity;
    return userLevel >= requiredLevel;
  }

  /**
   * Returns a Promise that resolves once the initial auth state has been
   * determined (either a user is found or confirmed as null).
   */
  waitForAuthInit(): Promise<void> {
    return this.authReadyPromise;
  }

  /**
   * Clear any auth error state (convenience for components).
   */
  clearError(): void {
    // Intentionally blank -- errors are returned from methods, not stored
    // in a signal. Kept for backward compatibility with the old stub.
  }

  // -----------------------------------------------------------------------
  // Private methods
  // -----------------------------------------------------------------------

  private initAuthListener(): void {
    this.authUnsubscribe = onAuthStateChanged(
      this.firebase.auth,
      async (firebaseUser: User | null) => {
        try {
          if (firebaseUser) {
            await this.handleUserSignedIn(firebaseUser);
          } else {
            this.handleUserSignedOut();
          }
        } catch (error) {
          console.error(
            '[AuthService] Error in auth state change handler:',
            error,
          );
          this.handleUserSignedOut();
        } finally {
          this.authLoading.set(false);
          if (!this.isAuthReady()) {
            this.isAuthReady.set(true);
            this.authReadyResolve?.();
          }
        }
      },
    );
  }

  private async handleUserSignedIn(firebaseUser: User): Promise<void> {
    // Force-refresh to get latest custom claims
    const tokenResult = await firebaseUser.getIdTokenResult(true);
    const customClaims = tokenResult.claims as unknown as AuthClaims;

    const role = (customClaims.role as UserRole) || 'viewer';
    const name =
      (customClaims.name as string) || firebaseUser.displayName || '';
    const title = (customClaims.title as string) || '';
    const email =
      (customClaims.email as string) || firebaseUser.email || '';

    const appUser: AppUser = {
      id: firebaseUser.uid,
      uid: firebaseUser.uid,
      name,
      role,
      title,
      email,
      lastLogin: new Date().toISOString(),
    };

    this.currentUser.set(appUser);
    this.claims.set(customClaims);

    console.log(
      `[AuthService] User signed in: ${name} (${role})`,
    );
  }

  private handleUserSignedOut(): void {
    this.currentUser.set(null);
    this.claims.set(null);
  }

  private cleanup(): void {
    if (this.authUnsubscribe) {
      this.authUnsubscribe();
      this.authUnsubscribe = null;
    }
  }
}
