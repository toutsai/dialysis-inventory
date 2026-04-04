// src/app/layouts/main-layout.component.ts
import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  effect,
  untracked,
  DestroyRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  Router,
  ActivatedRoute,
  RouterOutlet,
  RouterLink,
  RouterLinkActive,
  NavigationEnd,
} from '@angular/router';
import { filter, map } from 'rxjs/operators';
import {
  collection,
  query,
  where,
  onSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import { environment } from '@env/environment';
import { AuthService } from '@services/auth.service';
import {
  NotificationService,
  type AppNotification,
} from '@services/notification.service';
import { TaskStoreService } from '@services/task-store.service';
import { PatientStoreService } from '@services/patient-store.service';
import { FirebaseService } from '@services/firebase.service';
import {
  ApiManagerService,
  type ApiManager,
  type FirestoreRecord,
} from '@services/api-manager.service';
import { MemoDisplayDialogComponent } from '@app/components/dialogs/memo-display-dialog/memo-display-dialog.component';
import { getToday } from '@/utils/dateUtils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnvironmentTag {
  text: string;
  class: string;
}

interface MemoItem {
  id: string;
  patientId?: string;
  patientName?: string;
  status?: string;
  [key: string]: unknown;
}

interface AssignmentRecord extends FirestoreRecord {
  date?: string;
  names?: Record<string, string>;
  teams?: Record<
    string,
    { nurseTeam?: string; nurseTeamIn?: string; nurseTeamOut?: string }
  >;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MemoDisplayDialogComponent,
  ],
  templateUrl: './main-layout.component.html',
  styleUrl: './main-layout.component.css',
})
export class MainLayoutComponent implements OnInit, OnDestroy {
  // -------------------------------------------------------------------------
  // Injected services
  // -------------------------------------------------------------------------
  readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);
  readonly notificationService = inject(NotificationService);
  readonly taskStoreService = inject(TaskStoreService);
  private readonly patientStoreService = inject(PatientStoreService);
  private readonly firebaseService = inject(FirebaseService);
  private readonly apiManagerService = inject(ApiManagerService);
  private readonly destroyRef = inject(DestroyRef);

  // -------------------------------------------------------------------------
  // Sidebar state
  // -------------------------------------------------------------------------
  readonly isSidebarOpen = signal(false);
  readonly isManagementSectionCollapsed = signal(true);

  // -------------------------------------------------------------------------
  // Conflict count (schedule_exceptions with unresolved conflicts)
  // -------------------------------------------------------------------------
  readonly conflictCount = signal(0);
  private conflictUnsubscribe: Unsubscribe | null = null;

  // -------------------------------------------------------------------------
  // Today's assigned patient IDs (for memo notification count)
  // -------------------------------------------------------------------------
  readonly todayMyPatientIds = signal<string[]>([]);
  private assignmentsApi: ApiManager<AssignmentRecord>;

  // -------------------------------------------------------------------------
  // Memo system (Vue provide/inject equivalent)
  // -------------------------------------------------------------------------
  readonly activeMemos = signal<MemoItem[]>([]);
  readonly isMemoDialogVisible = signal(false);
  readonly patientNameForDialog = signal('');
  readonly memosForDialog = signal<MemoItem[]>([]);
  private memoUnsubscribe: Unsubscribe | null = null;

  /** Set of patient IDs that have pending memos. */
  readonly patientWithMemoIds = computed<Set<string>>(
    () =>
      new Set(
        this.activeMemos()
          .filter((memo) => memo.patientId && memo.status === 'pending')
          .map((memo) => memo.patientId!),
      ),
  );

  // -------------------------------------------------------------------------
  // Notification count (pending tasks + relevant memos)
  // -------------------------------------------------------------------------
  readonly notificationCount = computed(() => {
    if (!this.authService.currentUser()) return 0;
    const myPendingTasksCount = this.taskStoreService
      .myTasks()
      .filter((t) => t.status === 'pending').length;
    const myPendingMemosCount = this.todayRelevantMemosCount(
      this.todayMyPatientIds(),
    );
    return myPendingTasksCount + myPendingMemosCount;
  });

  // -------------------------------------------------------------------------
  // Current page title from route data
  // -------------------------------------------------------------------------
  readonly currentPageTitle = signal('\u900F\u6790\u7BA1\u7406');

  // -------------------------------------------------------------------------
  // Environment tag
  // -------------------------------------------------------------------------
  readonly environmentTag = computed<EnvironmentTag | null>(() => {
    const hostname = window.location.hostname;
    if (hostname.includes('develop') || hostname === 'localhost') {
      return { text: '(測試版)', class: 'env-tag-dev' };
    }
    return { text: '(正式版)', class: 'env-tag-prod' };
  });

  constructor() {
    this.assignmentsApi =
      this.apiManagerService.create<AssignmentRecord>('nurse_assignments');

    // Watch auth state: start/stop listeners when user logs in/out
    // Uses untracked() so only currentUser() is a tracked dependency
    effect(() => {
      const user = this.authService.currentUser();
      untracked(() => {
        if (user) {
          this.startSharedDataListeners();
          this.notificationService.startListening();
          this.startConflictListener();
          this.fetchTodayAssignedPatients();
          this.taskStoreService.startRealtimeUpdates(user.uid);
        } else {
          this.activeMemos.set([]);
          this.stopSharedDataListeners();
          sessionStorage.removeItem('hasCheckedSchedules');
          this.notificationService.stopListening();
          this.stopConflictListener();
          this.patientStoreService.reset();
          this.todayMyPatientIds.set([]);
          this.taskStoreService.cleanupListeners();
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  ngOnInit(): void {
    // Listen to route changes: update page title + close sidebar on mobile
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        map(() => this.getDeepestRouteTitle()),
      )
      .subscribe((title) => {
        this.currentPageTitle.set(
          title || '\u900F\u6790\u7BA1\u7406',
        );
        // Close sidebar on mobile when route changes (Vue: watch route.path)
        if (typeof window !== 'undefined' && window.innerWidth <= 992) {
          this.closeSidebar();
        }
      });

    // Set initial page title
    this.currentPageTitle.set(
      this.getDeepestRouteTitle() || '\u900F\u6790\u7BA1\u7406',
    );

    // Fetch patient data
    this.patientStoreService.fetchPatientsIfNeeded();

    // Register cleanup
    this.destroyRef.onDestroy(() => {
      this.cleanup();
    });
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // -------------------------------------------------------------------------
  // Public methods (used in template)
  // -------------------------------------------------------------------------

  toggleSidebar(): void {
    this.isSidebarOpen.update((open) => !open);
  }

  closeSidebar(): void {
    this.isSidebarOpen.set(false);
  }

  toggleManagement(): void {
    this.isManagementSectionCollapsed.update((c) => !c);
  }

  handleNotificationClick(notif: AppNotification): void {
    const action = notif['action'];
    if (action && typeof action === 'function') {
      (action as () => void)();
    }
  }

  async handleLogout(): Promise<void> {
    await this.authService.logout();
  }

  showPatientMemos(patientId: string): void {
    if (!patientId) return;
    const patient = this.patientStoreService.patientMap().get(patientId);
    const memoPatientName = this.activeMemos().find(
      (m) => m.patientId === patientId,
    )?.patientName;
    if (!patient && !memoPatientName) return;
    this.memosForDialog.set(
      this.activeMemos().filter(
        (memo) => memo.patientId === patientId && memo.status === 'pending',
      ),
    );
    this.patientNameForDialog.set(patient?.name ?? memoPatientName ?? '');
    this.isMemoDialogVisible.set(true);
  }

  closeMemoDialog(): void {
    this.isMemoDialogVisible.set(false);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Count memos relevant to today's assigned patients (matches Vue todayRelevantMemosCount). */
  private todayRelevantMemosCount(patientIds: string[]): number {
    if (!patientIds || patientIds.length === 0) return 0;
    const idSet = new Set(patientIds);
    const today = getToday(); // YYYY-MM-DD
    return this.taskStoreService.feedMessages().filter(
      (memo) =>
        memo.status === 'pending' &&
        memo.patientId &&
        idSet.has(memo.patientId as string) &&
        // targetDate <= today (or no targetDate means always relevant)
        (!memo['targetDate'] || (memo['targetDate'] as string) <= today) &&
        // Must have content and not be a system-generated message
        memo['content'] &&
        !(memo['content'] as string).startsWith('【'),
    ).length;
  }

  /** Start the shared memo data listener. */
  private startSharedDataListeners(): void {
    if (this.memoUnsubscribe) return;
    const memoQuery = query(
      collection(this.firebaseService.db, 'tasks'),
      where('category', '==', 'message'),
      where('status', '==', 'pending'),
    );
    this.memoUnsubscribe = onSnapshot(memoQuery, (snapshot) => {
      this.activeMemos.set(
        snapshot.docs.map(
          (docSnap) =>
            ({ id: docSnap.id, ...docSnap.data() }) as MemoItem,
        ),
      );
    });
  }

  /** Stop the shared memo data listener. */
  private stopSharedDataListeners(): void {
    if (this.memoUnsubscribe) {
      this.memoUnsubscribe();
      this.memoUnsubscribe = null;
    }
  }

  /** Start the conflict count listener on schedule_exceptions. */
  private startConflictListener(): void {
    if (!(this.authService.isAdmin() || this.authService.isEditor())) return;
    if (this.conflictUnsubscribe) return;

    const exceptionsRef = collection(
      this.firebaseService.db,
      'schedule_exceptions',
    );
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const q = query(
      exceptionsRef,
      where('status', '==', 'conflict_requires_resolution'),
      where('expireAt', '>=', today),
    );

    this.conflictUnsubscribe = onSnapshot(
      q,
      (snapshot) => {
        this.conflictCount.set(snapshot.size);
      },
      (error) => {
        console.error('Conflict listener error:', error);
        this.conflictCount.set(0);
      },
    );
  }

  /** Stop the conflict count listener. */
  private stopConflictListener(): void {
    if (this.conflictUnsubscribe) {
      this.conflictUnsubscribe();
      this.conflictUnsubscribe = null;
      this.conflictCount.set(0);
    }
  }

  /** Fetch today's nurse assignment to determine assigned patients. */
  private async fetchTodayAssignedPatients(): Promise<void> {
    const currentUser = this.authService.currentUser();
    if (
      !currentUser ||
      !(this.authService.isEditor() || this.authService.isAdmin())
    ) {
      this.todayMyPatientIds.set([]);
      return;
    }
    const today = getToday();
    try {
      const assignmentsSnapshot = await this.assignmentsApi.fetchAll([
        where('date', '==', today),
      ]);
      if (assignmentsSnapshot.length === 0) {
        this.todayMyPatientIds.set([]);
        return;
      }
      const { names, teams } = assignmentsSnapshot[0];
      const myAssignedIds = new Set<string>();
      if (names && teams) {
        for (const teamName in names) {
          if (names[teamName] === currentUser.name) {
            for (const key in teams) {
              const [patientId] = key.split('-');
              const teamAssignment = teams[key];
              if (
                teamAssignment.nurseTeam === teamName ||
                teamAssignment.nurseTeamIn === teamName ||
                teamAssignment.nurseTeamOut === teamName
              ) {
                myAssignedIds.add(patientId);
              }
            }
          }
        }
      }
      this.todayMyPatientIds.set(Array.from(myAssignedIds));
    } catch (error) {
      console.error(
        "[MainLayout] Failed to fetch today's assigned patients:",
        error,
      );
      this.todayMyPatientIds.set([]);
    }
  }

  /** Traverse the activated route tree to find the deepest child's title. */
  private getDeepestRouteTitle(): string {
    let route = this.activatedRoute;
    while (route.firstChild) {
      route = route.firstChild;
    }
    return (route.snapshot.data as { title?: string })?.title || '';
  }

  /** Cleanup all listeners on component destroy. */
  private cleanup(): void {
    this.notificationService.stopListening();
    this.stopSharedDataListeners();
    this.stopConflictListener();
    this.taskStoreService.cleanupListeners();
  }
}
