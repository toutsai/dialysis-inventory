// src/app/features/collaboration/collaboration.component.ts
import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  doc,
  updateDoc,
  setDoc,
  arrayUnion,
  deleteDoc,
  onSnapshot,
  where,
  Unsubscribe,
} from 'firebase/firestore';

import { AuthService } from '@app/core/services/auth.service';
import { FirebaseService } from '@app/core/services/firebase.service';
import { PatientStoreService } from '@app/core/services/patient-store.service';
import { TaskStoreService } from '@app/core/services/task-store.service';
import { ApiManagerService, type ApiManager, type FirestoreRecord } from '@app/core/services/api-manager.service';
import { NotificationService } from '@app/core/services/notification.service';
import { TaskCreateDialogComponent } from '@app/components/dialogs/task-create-dialog/task-create-dialog.component';

import {
  formatDateToYYYYMMDD,
  formatDateTimeToLocal,
  addDays,
  getDayOfWeek,
  parseFirestoreTimestamp,
} from '@/utils/dateUtils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MainViewTab = 'my' | 'all';
type ShiftFilter = 'all' | 'early' | 'noon' | 'late';
type MobileTab = 'patients' | 'messages' | 'tasks';

interface PatientListItem {
  id: string;
  name: string;
  medicalRecordNumber: string;
  shift?: string;
  bed?: number;
  [key: string]: unknown;
}

interface TaskItem {
  id: string;
  patientId?: string;
  patientName?: string;
  content: string;
  status: string;
  type?: string;
  targetDate?: string;
  assignee?: { type: string; value?: string; name?: string; title?: string };
  creator?: { uid: string; name: string };
  createdAt?: unknown;
  resolvedBy?: { uid?: string; name?: string };
  resolvedAt?: unknown;
  [key: string]: unknown;
}

interface PatientOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@Component({
  selector: 'app-collaboration',
  standalone: true,
  imports: [CommonModule, FormsModule, TaskCreateDialogComponent],
  templateUrl: './collaboration.component.html',
  styleUrl: './collaboration.component.css',
})
export class CollaborationComponent implements OnInit, OnDestroy {
  // Services
  protected readonly auth = inject(AuthService);
  private readonly firebaseService = inject(FirebaseService);
  readonly patientStore = inject(PatientStoreService);
  readonly taskStore = inject(TaskStoreService);
  private readonly apiManagerService = inject(ApiManagerService);
  private readonly notificationService = inject(NotificationService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  // API managers
  private readonly schedulesApi: ApiManager<FirestoreRecord>;
  private readonly assignmentsApi: ApiManager<FirestoreRecord>;
  private readonly logsApi: ApiManager<FirestoreRecord>;

  // Reactive state
  readonly isLoading = signal({ patients: true, bulletin: true });
  readonly allDailyPatients = signal<PatientListItem[]>([]);
  readonly myAssignedPatients = signal<PatientListItem[]>([]);
  readonly selectedPatient = signal<PatientListItem | null>(null);
  readonly isCreateModalVisible = signal(false);
  readonly yesterdaysLogItems = signal<string[]>([]);
  readonly todaysAnnouncements = signal<TaskItem[]>([]);
  readonly newAnnouncementText = signal('');
  readonly mainPatientViewTab = signal<MainViewTab>('my');
  readonly shiftFilterTab = signal<ShiftFilter>('all');
  readonly activeMobileTab = signal<MobileTab>('patients');
  readonly selectedMessagePatientId = signal<string>('all');
  readonly editingItem = signal<TaskItem | null>(null);
  readonly isConfirmDeleteVisible = signal(false);
  readonly itemToDelete = signal<TaskItem | null>(null);
  readonly showSystemMessages = signal(false);

  private bulletinUnsubscribe: Unsubscribe | null = null;

  // Computed
  readonly patientMap = this.patientStore.patientMap;
  readonly allPatientsFromStore = this.patientStore.allPatients;

  readonly displayDate = computed(() => {
    const queryDate = this.route.snapshot.queryParamMap.get('date');
    return queryDate || formatDateToYYYYMMDD();
  });

  readonly weekdayDisplay = computed(() => {
    const d = this.displayDate();
    if (!d) return '';
    try {
      return ['日', '一', '二', '三', '四', '五', '六'][getDayOfWeek(d)];
    } catch {
      return '';
    }
  });

  readonly isPageLocked = computed(() => {
    return !this.auth.currentUser();
  });

  readonly canPostAnnouncement = computed(() => {
    const user = this.auth.currentUser();
    if (!user) return false;
    return ['admin', 'editor'].includes((user as Record<string, unknown>)['role'] as string);
  });

  readonly patientsForList = computed(() => {
    if (this.mainPatientViewTab() === 'all') {
      return (this.allPatientsFromStore() || []).filter(
        (p: Record<string, unknown>) => !p['isDeleted'] && !p['isDiscontinued'],
      ) as PatientListItem[];
    }
    return this.myAssignedPatients();
  });

  readonly filteredByShiftPatients = computed(() => {
    if (this.mainPatientViewTab() === 'all') return this.patientsForList();
    if (this.shiftFilterTab() === 'all') return this.patientsForList();
    return this.patientsForList().filter((p) => p.shift === this.shiftFilterTab());
  });

  readonly groupedPatients = computed((): Record<string, PatientListItem[]> => {
    const patientsToGroup = this.filteredByShiftPatients();
    if (this.mainPatientViewTab() === 'all') {
      if (!Array.isArray(patientsToGroup) || patientsToGroup.length === 0) return {};
      const sorted = [...patientsToGroup].sort((a, b) =>
        a.name.localeCompare(b.name, 'zh-Hant'),
      );
      return { '\u6240\u6709\u75C5\u4EBA': sorted };
    }
    const groups: Record<string, PatientListItem[]> = {
      '\u65E9\u73ED': [],
      '\u5348\u73ED': [],
      '\u665A\u73ED': [],
    };
    if (!Array.isArray(patientsToGroup)) return {};
    for (const patient of patientsToGroup) {
      if (patient.shift === 'early') groups['\u65E9\u73ED'].push(patient);
      else if (patient.shift === 'noon') groups['\u5348\u73ED'].push(patient);
      else if (patient.shift === 'late') groups['\u665A\u73ED'].push(patient);
    }
    for (const key of Object.keys(groups)) {
      if (groups[key].length === 0) delete groups[key];
    }
    return groups;
  });

  readonly patientWardNumberMap = computed(() => {
    const map = new Map<string, string>();
    for (const patient of this.allPatientsFromStore() as Record<string, unknown>[]) {
      if (patient['id'] && patient['wardNumber']) {
        map.set(patient['id'] as string, patient['wardNumber'] as string);
      }
    }
    return map;
  });

  readonly sortedMyTasks = computed(() => {
    const tasks = (this.taskStore.myTasks() as unknown as TaskItem[])
      .filter((t) => t.category === 'task' || t.assignee);
    return this.sortItems(tasks);
  });

  readonly sortedMySentTasks = computed(() => {
    const tasks = (this.taskStore.mySentTasks() as unknown as TaskItem[])
      .filter((t) => t.category === 'task' || t.assignee);
    return this.sortItems(tasks);
  });

  readonly baseMessages = computed(() => {
    const sorted = this.taskStore.sortedFeedMessages() as unknown as TaskItem[];
    if (this.mainPatientViewTab() === 'all') return sorted;
    const myPatientIds = new Set(this.patientsForList().map((p) => p.id));
    return sorted.filter((msg) => myPatientIds.has(msg.patientId || ''));
  });

  readonly filteredFeedMessages = computed(() => {
    let messages = this.baseMessages();
    if (!this.showSystemMessages()) {
      messages = messages.filter((msg) => !msg.content.startsWith('\u3010'));
    }
    if (this.selectedMessagePatientId() === 'all') return messages;
    return messages.filter((msg) => msg.patientId === this.selectedMessagePatientId());
  });

  readonly messagePatientOptions = computed(() => {
    const patientSet = new Map<string, PatientOption>();
    const userMessages = this.baseMessages().filter(
      (msg) => !msg.content.startsWith('\u3010'),
    );
    userMessages.forEach((msg) => {
      if (msg.patientId && msg.patientName && !patientSet.has(msg.patientId)) {
        patientSet.set(msg.patientId, { id: msg.patientId, name: msg.patientName });
      }
    });
    return Array.from(patientSet.values()).sort((a, b) =>
      a.name.localeCompare(b.name, 'zh-Hant'),
    );
  });

  readonly roleDisplayNames: Record<string, string> = {
    clerk: '\u66F8\u8A18',
    doctor: '\u91AB\u5E2B',
    np: '\u5C08\u79D1\u8B77\u7406\u5E2B',
    editor: '\u8B77\u7406\u5E2B\u7D44\u9577',
    admin: '\u7BA1\u7406\u54E1',
  };

  constructor() {
    this.schedulesApi = this.apiManagerService.create<FirestoreRecord>('schedules');
    this.assignmentsApi = this.apiManagerService.create<FirestoreRecord>('nurse_assignments');
    this.logsApi = this.apiManagerService.create<FirestoreRecord>('daily_logs');
  }

  // Lifecycle
  async ngOnInit(): Promise<void> {
    await this.auth.waitForAuthInit();
    if (this.auth.currentUser()) {
      await Promise.all([
        this.patientStore.fetchPatientsIfNeeded(),
        this.loadDailyPatientData(this.displayDate()),
        this.listenToBulletinData(this.displayDate()),
      ]);
    }
  }

  ngOnDestroy(): void {
    if (this.bulletinUnsubscribe) this.bulletinUnsubscribe();
  }

  // Template helpers
  objectKeys(obj: Record<string, unknown>): string[] {
    return Object.keys(obj);
  }

  formatBedNumber(bed: number | undefined): string {
    if (bed === undefined) return '';
    return bed > 999 ? `\u5916${bed - 1000}` : String(bed);
  }

  getMessageTypeIcon(type: string | undefined): string {
    switch (type) {
      case '\u62BD\u8840': return '\uD83E\uDE78';
      case '\u885B\u6559': return '\uD83D\uDCE2';
      case '\u5E38\u898F':
      default: return '\uD83D\uDCDD';
    }
  }

  formatTimestamp(ts: unknown): string {
    if (!ts) return '';
    const date = parseFirestoreTimestamp(ts);
    if (isNaN(date.getTime())) return '';
    return formatDateTimeToLocal(date, { year: undefined, second: undefined });
  }

  getAssigneeName(assignee: TaskItem['assignee']): string {
    if (!assignee) return '\u672A\u77E5';
    if (assignee.type === 'role') {
      return this.roleDisplayNames[assignee.value || ''] || assignee.value || '';
    }
    if (assignee.type === 'user') {
      const titleSuffix = assignee.title ? `\uFF08${assignee.title}\uFF09` : '';
      return `${assignee.name || '\u6307\u5B9A\u6210\u54E1'}${titleSuffix}`;
    }
    return '\u7279\u5B9A\u4F7F\u7528\u8005';
  }

  canModify(item: TaskItem): boolean {
    const user = this.auth.currentUser();
    if (!user) return false;
    if (['admin', 'editor'].includes((user as Record<string, unknown>)['role'] as string)) return true;
    return item.creator?.uid === (user as Record<string, unknown>)['uid'];
  }

  selectPatient(patient: PatientListItem): void {
    this.selectedPatient.set(patient);
    if (typeof window !== 'undefined' && window.innerWidth <= 992) {
      this.activeMobileTab.set('messages');
    }
  }

  openCreateModal(itemToEdit: TaskItem | null = null): void {
    const user = this.auth.currentUser();
    if (!user) return;
    if (!this.auth.hasPermission('viewer')) {
      console.warn('Permission denied.');
      return;
    }
    this.editingItem.set(itemToEdit);
    this.isCreateModalVisible.set(true);
  }

  closeCreateModal(): void {
    this.isCreateModalVisible.set(false);
    this.editingItem.set(null);
  }

  async handleTaskSubmit(data: TaskItem): Promise<void> {
    if (this.editingItem()) {
      // Edit mode: dialog emitted update data, we need to save it
      await this.updateTask(data);
    } else {
      // New creation: dialog already saved to Firestore
      this.handleTaskCreated();
    }
    this.closeCreateModal();
  }

  async updateTaskStatus(taskId: string, newStatus: string, collectionName = 'tasks'): Promise<void> {
    const user = this.auth.currentUser();
    if (!user) return;
    try {
      const taskRef = doc(this.firebaseService.db, collectionName, taskId);
      await updateDoc(taskRef, {
        status: newStatus,
        resolvedBy: {
          uid: (user as Record<string, unknown>)['uid'],
          name: (user as Record<string, unknown>)['name'],
        },
        resolvedAt: new Date(),
      });
      this.notificationService.show(
        newStatus === 'completed' ? '\u72C0\u614B\u5DF2\u66F4\u65B0\u70BA\u5DF2\u8B80' : '\u72C0\u614B\u5DF2\u79FB\u56DE\u5F85\u8FA6',
        'success',
      );
    } catch (error: unknown) {
      console.error('\u66F4\u65B0\u4EFB\u52D9\u72C0\u614B\u5931\u6557:', error);
      alert('\u66F4\u65B0\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66\u3002');
    }
  }

  confirmDeleteTask(item: TaskItem): void {
    this.itemToDelete.set(item);
    this.isConfirmDeleteVisible.set(true);
  }

  async executeDeleteTask(): Promise<void> {
    const toDelete = this.itemToDelete();
    if (!toDelete) return;
    await this.deleteTask(toDelete.id);
    this.isConfirmDeleteVisible.set(false);
    this.itemToDelete.set(null);
  }

  cancelDelete(): void {
    this.isConfirmDeleteVisible.set(false);
    this.itemToDelete.set(null);
  }

  async handleSaveAnnouncement(): Promise<void> {
    const text = this.newAnnouncementText();
    const user = this.auth.currentUser();
    if (!text.trim() || !user) return;
    const dateStr = this.displayDate();
    const logDocRef = doc(this.firebaseService.db, 'daily_logs', dateStr);
    const newAnnouncement = {
      id: Date.now().toString(),
      content: text.trim(),
      creator: {
        uid: (user as Record<string, unknown>)['uid'],
        name: (user as Record<string, unknown>)['name'],
      },
      createdAt: new Date(),
    };
    try {
      await setDoc(logDocRef, { announcements: arrayUnion(newAnnouncement) }, { merge: true });
      this.newAnnouncementText.set('');
    } catch (error: unknown) {
      console.error('\u767C\u5E03\u516C\u544A\u5931\u6557:', error);
      alert('\u767C\u5E03\u516C\u544A\u5931\u6557\uFF0C\u8ACB\u6AA2\u67E5\u7DB2\u8DEF\u9023\u7DDA\u6216\u806F\u7E6B\u7BA1\u7406\u54E1\u3002');
    }
  }

  // Private helpers
  private sortItems(items: TaskItem[]): TaskItem[] {
    if (!Array.isArray(items)) return [];
    return [...items].sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;
      const getSafeDate = (timestamp: unknown): Date => {
        if (!timestamp) return new Date(0);
        return (timestamp as { toDate?: () => Date }).toDate
          ? (timestamp as { toDate: () => Date }).toDate()
          : new Date(timestamp as string);
      };
      const dateA = getSafeDate(a.resolvedAt || a.createdAt);
      const dateB = getSafeDate(b.resolvedAt || b.createdAt);
      return dateB.getTime() - dateA.getTime();
    });
  }

  private async updateTask(data: TaskItem): Promise<void> {
    const editItem = this.editingItem();
    const collectionName = 'tasks';
    const taskRef = doc(this.firebaseService.db, collectionName, data.id);
    const { id, ...updateData } = data;
    try {
      await updateDoc(taskRef, updateData);
      console.log(`[CollaborationView] Task/Memo ${id} updated in ${collectionName}.`);
    } catch (error: unknown) {
      console.error('\u66F4\u65B0\u9805\u76EE\u5931\u6557:', error);
      alert('\u66F4\u65B0\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66\u3002');
    }
  }

  private async deleteTask(taskId: string): Promise<void> {
    const toDelete = this.itemToDelete();
    const collectionName = 'tasks';
    try {
      const taskRef = doc(this.firebaseService.db, collectionName, taskId);
      await deleteDoc(taskRef);
      this.notificationService.show('\u8A0A\u606F\u5DF2\u522A\u9664', 'info');
    } catch (error: unknown) {
      console.error('\u522A\u9664\u4EFB\u52D9\u5931\u6557:', error);
      alert('\u522A\u9664\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66\u3002');
    }
  }

  private handleTaskCreated(): void {
    console.log('Task created successfully.');
  }

  private async listenToBulletinData(dateStr: string): Promise<void> {
    if (this.bulletinUnsubscribe) this.bulletinUnsubscribe();
    this.isLoading.update((v) => ({ ...v, bulletin: true }));
    this.yesterdaysLogItems.set([]);
    this.todaysAnnouncements.set([]);

    const today = new Date(dateStr + 'T00:00:00');
    const yesterdayStr = formatDateToYYYYMMDD(addDays(today, -1));
    const dayBeforeYesterdayStr = formatDateToYYYYMMDD(addDays(today, -2));

    const fetchLastWorkingDayLog = async () => {
      try {
        const yesterdayLog = await this.logsApi.fetchById(yesterdayStr);
        if (yesterdayLog && (yesterdayLog as Record<string, unknown>)['otherNotes']) {
          const notes = ((yesterdayLog as Record<string, unknown>)['otherNotes'] as string)
            .split('\n')
            .map((item: string) => item.trim())
            .filter((item: string) => item);
          this.yesterdaysLogItems.set(notes);
          return;
        }
        const dayBeforeLog = await this.logsApi.fetchById(dayBeforeYesterdayStr);
        if (dayBeforeLog && (dayBeforeLog as Record<string, unknown>)['otherNotes']) {
          const notes = ((dayBeforeLog as Record<string, unknown>)['otherNotes'] as string)
            .split('\n')
            .map((item: string) => item.trim())
            .filter((item: string) => item);
          this.yesterdaysLogItems.set(notes);
        }
      } catch (err: unknown) {
        console.error('\u7372\u53D6\u820A\u5DE5\u4F5C\u65E5\u8A8C\u5931\u6557:', err);
      }
    };

    const bulletinPromise = new Promise<void>((resolve, reject) => {
      const todayLogRef = doc(this.firebaseService.db, 'daily_logs', dateStr);
      this.bulletinUnsubscribe = onSnapshot(
        todayLogRef,
        (docSnap) => {
          if (docSnap.exists() && docSnap.data()['announcements']) {
            this.todaysAnnouncements.set(
              docSnap
                .data()
                ['announcements'].sort(
                  (a: Record<string, unknown>, b: Record<string, unknown>) =>
                    (b['createdAt'] as { toMillis: () => number }).toMillis() -
                    (a['createdAt'] as { toMillis: () => number }).toMillis(),
                ),
            );
          } else {
            this.todaysAnnouncements.set([]);
          }
          resolve();
        },
        (error) => {
          console.error('\u76E3\u807D\u672C\u65E5\u516C\u544A\u5931\u6557:', error);
          reject(error);
        },
      );
    });

    await Promise.all([fetchLastWorkingDayLog(), bulletinPromise]).finally(() => {
      this.isLoading.update((v) => ({ ...v, bulletin: false }));
    });
  }

  private async loadDailyPatientData(date: string): Promise<void> {
    this.isLoading.update((v) => ({ ...v, patients: true }));
    this.allDailyPatients.set([]);
    this.myAssignedPatients.set([]);

    const user = this.auth.currentUser();
    if (!user) {
      this.isLoading.update((v) => ({ ...v, patients: false }));
      return;
    }

    try {
      await this.patientStore.fetchPatientsIfNeeded();
      const schedules = await this.schedulesApi.fetchAll([where('date', '==', date)]);
      if (schedules.length === 0 || !(schedules[0] as Record<string, unknown>)['schedule']) {
        this.isLoading.update((v) => ({ ...v, patients: false }));
        return;
      }
      const scheduleData = (schedules[0] as Record<string, unknown>)['schedule'] as Record<string, Record<string, unknown>>;
      const assignments = await this.assignmentsApi.fetchAll([where('date', '==', date)]);
      const localPatientMap = this.patientStore.patientMap();

      const getBedNumber = (shiftId: string): number => {
        const parts = shiftId.split('-');
        return parts[0] === 'peripheral' ? 1000 + parseInt(parts[1], 10) : parseInt(parts[1], 10);
      };

      const tempAllDaily: PatientListItem[] = [];
      for (const shiftId in scheduleData) {
        const slot = scheduleData[shiftId];
        if (slot?.['patientId'] && localPatientMap.has(slot['patientId'] as string)) {
          const patientDetail = localPatientMap.get(slot['patientId'] as string) as Record<string, unknown>;
          tempAllDaily.push({
            ...patientDetail,
            id: patientDetail['id'] as string,
            name: patientDetail['name'] as string,
            medicalRecordNumber: patientDetail['medicalRecordNumber'] as string,
            shift: shiftId.split('-').pop(),
            bed: getBedNumber(shiftId),
          } as PatientListItem);
        }
      }

      const sortLogic = (a: PatientListItem, b: PatientListItem) => {
        const shiftOrder: Record<string, number> = { early: 1, noon: 2, late: 3 };
        if (a.shift !== b.shift)
          return (shiftOrder[a.shift || ''] || 99) - (shiftOrder[b.shift || ''] || 99);
        return (a.bed || 0) - (b.bed || 0);
      };
      this.allDailyPatients.set(tempAllDaily.sort(sortLogic));

      if (assignments.length > 0) {
        const assignmentData = assignments[0] as Record<string, unknown>;
        const names = assignmentData['names'] as Record<string, string>;
        const teams = assignmentData['teams'] as Record<string, Record<string, string>>;
        if (names && teams) {
          const myAssignedIds = new Set<string>();
          const userName = (user as Record<string, unknown>)['name'] as string;
          for (const teamName in names) {
            if (names[teamName] === userName) {
              for (const key in teams) {
                const [patientId] = key.split('-');
                const teamAssignment = teams[key];
                if (
                  teamAssignment['nurseTeam'] === teamName ||
                  teamAssignment['nurseTeamIn'] === teamName ||
                  teamAssignment['nurseTeamOut'] === teamName
                ) {
                  myAssignedIds.add(patientId);
                }
              }
            }
          }
          this.myAssignedPatients.set(
            this.allDailyPatients().filter((p) => myAssignedIds.has(p.id)),
          );
        }
      }
    } catch (error: unknown) {
      console.error('\u7372\u53D6\u6BCF\u65E5\u75C5\u4EBA\u5217\u8868\u5931\u6557:', error);
    } finally {
      this.isLoading.update((v) => ({ ...v, patients: false }));
    }
  }
}
