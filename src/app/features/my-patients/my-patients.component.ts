import {
  Component,
  inject,
  signal,
  computed,
  effect,
  untracked,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  doc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import { FirebaseService } from '@services/firebase.service';
import { AuthService, type AppUser } from '@services/auth.service';
import { PatientStoreService } from '@services/patient-store.service';
import { NotificationService } from '@services/notification.service';
import { TaskStoreService } from '@services/task-store.service';
import { UserDirectoryService } from '@services/user-directory.service';
import { ArchiveStoreService } from '@services/archive-store.service';
import { MedicationStoreService } from '@services/medication-store.service';
import {
  ApiManagerService,
  type ApiManager,
  type FirestoreRecord,
} from '@services/api-manager.service';
import { formatDateToYYYYMMDD } from '@/utils/dateUtils';
import { handleTaskCreated } from '@/utils/taskHandlers';

// Component Imports
import { TaskCreateDialogComponent } from '@app/components/dialogs/task-create-dialog/task-create-dialog.component';
import { ConfirmDialogComponent } from '@app/components/dialogs/confirm-dialog/confirm-dialog.component';
import { DialysisOrderModalComponent } from '@app/components/dialogs/dialysis-order-modal/dialysis-order-modal.component';
import { MarqueeBannerComponent } from '@app/components/marquee-banner/marquee-banner.component';

interface MedicationMaster {
  code: string;
  tradeName: string;
  unit: string;
}

interface MyPatientItem {
  id: string;
  patientId: string;
  name: string;
  bedNum: string;
  preparation: {
    ak: string;
    dialysateCa: string;
    heparin: string;
    bloodFlow: string;
    vascAccess: string;
  };
  injections: {
    orderCode: string;
    orderName?: string;
    dose?: string;
    unit?: string;
    note?: string;
  }[];
  memos: {
    id: string;
    content: string;
    type?: string;
    targetDate?: string;
    [key: string]: unknown;
  }[];
}

interface SelectableUser {
  uid: string;
  name: string;
  username: string;
}

@Component({
  selector: 'app-my-patients',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TaskCreateDialogComponent,
    ConfirmDialogComponent,
    DialysisOrderModalComponent,
    MarqueeBannerComponent,
  ],
  templateUrl: './my-patients.component.html',
  styleUrl: './my-patients.component.css',
})
export class MyPatientsComponent implements OnInit, OnDestroy {
  private readonly firebaseService = inject(FirebaseService);
  private readonly authService = inject(AuthService);
  private readonly patientStore = inject(PatientStoreService);
  private readonly notificationService = inject(NotificationService);
  private readonly userDirectory = inject(UserDirectoryService);
  private readonly apiManagerService = inject(ApiManagerService);
  private readonly taskStore = inject(TaskStoreService);
  private readonly archiveStore = inject(ArchiveStoreService);
  private readonly medicationStore = inject(MedicationStoreService);

  // --- State ---
  readonly selectedUserId = signal<string | null>(null);
  readonly selectedDate = signal(formatDateToYYYYMMDD());
  readonly isLoading = signal(false);
  readonly patientListByShift = signal<Record<string, MyPatientItem[]>>({});
  readonly selectableUsers = signal<SelectableUser[]>([]);
  readonly nurseGroupLabel = signal('');
  readonly nurseGroupDuties = signal<string[]>([]);

  private readonly SELECTABLE_USERS_TTL = 10 * 60 * 1000;
  private lastSelectableUsersUpdatedAt = 0;

  // Injection medication master data
  private readonly INJECTION_MEDS_MASTER: MedicationMaster[] = [
    { code: 'INES2', tradeName: 'NESP', unit: 'mcg' },
    { code: 'IREC1', tradeName: 'Recormon', unit: 'KIU' },
    { code: 'IFER2', tradeName: 'Fe-back', unit: 'mg' },
    { code: 'ICAC', tradeName: 'Cacare', unit: 'amp' },
    { code: 'IPAR1', tradeName: 'Parsabiv', unit: 'mg' },
  ];
  private readonly injectionTradeNameMap = new Map(
    this.INJECTION_MEDS_MASTER.map((med) => [med.code, med.tradeName])
  );

  // Dialog state
  readonly isCreateModalVisible = signal(false);
  readonly editingItem = signal<any>(null);
  readonly isConfirmDeleteVisible = signal(false);
  readonly itemToDelete = signal<any>(null);
  readonly isOrderModalVisible = signal(false);
  readonly selectedPatientForOrder = signal<any>(null);

  // Computed
  readonly currentUser = computed(() => this.authService.currentUser());
  readonly canSwitchUser = computed(() => !!this.currentUser());

  readonly hasAnyPatients = computed(() => {
    const shifts = this.patientListByShift();
    if (!shifts) return false;
    return Object.values(shifts).some((list) => list.length > 0);
  });

  readonly todayDateString = computed(() =>
    new Date().toLocaleDateString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  );

  readonly statusMessage = computed(() => {
    if (this.selectedUserId() !== this.currentUser()?.uid) {
      const selectedUserName =
        this.selectableUsers().find((u) => u.uid === this.selectedUserId())
          ?.name || '';
      return `${selectedUserName} 在 ${this.selectedDate()} 沒有被分配到照護病人。`;
    }
    return '您今天沒有被分配到照護病人，或班表尚未更新。';
  });

  // Watch currentUser changes — also triggers initial data fetch
  private readonly userWatcher = effect(() => {
    const user = this.authService.currentUser();
    untracked(() => {
      if (user) {
        this.selectedUserId.set(user.uid);
        this.loadSelectableUsers(true);
        // Fetch patient data after auth is confirmed
        this.fetchMyPatientData();
      } else {
        this.selectedUserId.set(null);
        this.selectableUsers.set([]);
        this.userDirectory.clearCache();
        this.lastSelectableUsersUpdatedAt = 0;
      }
    });
  });

  ngOnInit(): void {
    // Data loading is triggered by the userWatcher effect after auth completes
  }

  ngOnDestroy(): void {
    // effect cleanup is automatic
  }

  // --- Helper Functions ---
  hasPermission(role: string): boolean {
    return this.authService.hasPermission(role as any);
  }

  getShiftTitle(shiftCode: string): string {
    const map: Record<string, string> = {
      early: '早班 (主責)',
      noonOn: '午班 (上針)',
      noonOff: '午班 (收針)',
      late: '晚班 (主責)',
    };
    return map[shiftCode] || shiftCode;
  }

  getMessageTypeIcon(type: string | undefined): string {
    switch (type) {
      case '抽血':
        return '\u{1FA78}'; // blood drop
      case '衛教':
        return '\u{1F4E2}'; // loudspeaker
      case '常規':
      default:
        return '\u{1F4DD}'; // memo
    }
  }

  formatInjection(injection: any): string {
    const displayName =
      this.injectionTradeNameMap.get(injection.orderCode) ||
      injection.orderName ||
      '未知藥品';
    const parts = [
      displayName,
      `${injection.dose || ''} ${injection.unit || ''}`.trim(),
      injection.note || '',
    ];
    return parts.filter((part) => part).join(' / ');
  }

  /**
   * Extract duty descriptions for specific group letters from the hardcoded duty texts.
   * Supports both day shift and night shift duties.
   */
  private extractGroupDuties(groupLetters: string[]): string[] {
    if (groupLetters.length === 0) return [];

    const dayDuties = 'A 組：預備機化消及測餘氯。\nB 組：點班(急救車、電擊器測試)。備 12-8，午班用物。\nC 組：支援 ICU 組(含備機)，如 ICU 組被 P，接 ICU 組。\nD 組：送消、點班(衛材、庫房溫溼度)、整理供應室衛材歸位，NO.1。\nE 組：點班(氧療、冰箱溫度、補充冰箱常備藥)。NO.2。\nF 組：電訪關心病患，NO.3。\nG 組：協助準備醫師拔 D/L 備物及病人觀察。\nH 組：住院組。\nI 組：住院組。\nJ 組：W3 泡製 3 桶消毒液。W6 幫忙協助收行動 RO 機。\nK 組：擔任 Leader。';

    const nightDuties = 'A 組: 擔任 Leader，核對當日人數，將當日護理日誌、排程，隔天分組匯出轉 PDF 並存檔，下班前須到 PD 衛教室電腦開啟隔日診間叫號系統。\nB 組: 10PM 後核對隔日娃娃頭與電腦排程是否一致，並須製作隔日早班洗腎住院床病人移動方式，排主護及 Leader 牌。備隔日 B 組 AK。\nC 組: 接 ICU 組，協同 B 組核對隔日娃娃頭、W4 補充 ICU 消毒液，備隔日 C+D 組 AK。\nD 組: 點班(衛材)，備隔日 E+F 組 AK，NO.1。\nE 組: 點班(氧療、冰箱)、備隔日 I+J 組 AK，NO.2。\nF 組: 接 12-8，備隔日 G+H 組 AK。每月 1 號點消防箱物資。NO.3。\nG 組: 住院組、備隔日 K 組 AK。\nH 組: 住院組、點班(急救車)。\nI 組: 備隔日 A 組 AK。關門前結束檢查。';

    const results: string[] = [];
    const allDutyLines = [...dayDuties.split('\n'), ...nightDuties.split('\n')];

    for (const letter of groupLetters) {
      const dayLine = dayDuties.split('\n').find(l => new RegExp(`^${letter}\\s*組[：:]`).test(l));
      const nightLine = nightDuties.split('\n').find(l => new RegExp(`^${letter}\\s*組[：:]`).test(l));
      if (dayLine) results.push(`【早班】${dayLine}`);
      if (nightLine) results.push(`【晚班】${nightLine}`);
    }
    return results;
  }

  getShiftKeys(): string[] {
    const desiredOrder = ['early', 'noonOn', 'noonOff', 'late'];
    const available = this.patientListByShift();
    return desiredOrder.filter((key) => key in available);
  }

  getShiftPatients(shiftCode: string): MyPatientItem[] {
    return this.patientListByShift()[shiftCode] || [];
  }

  getShiftSupplySummary(shiftCode: string): { supplies: string; medications: string } {
    const patients = this.getShiftPatients(shiftCode);
    if (patients.length === 0) return { supplies: '', medications: '' };

    // Count AK types
    const akCounts = new Map<string, number>();
    for (const p of patients) {
      const akValue = p.preparation.ak;
      if (akValue) {
        // AK can be multi e.g. "13M/FX80"
        for (const ak of akValue.split('/')) {
          const trimmed = ak.trim();
          if (trimmed) akCounts.set(trimmed, (akCounts.get(trimmed) || 0) + 1);
        }
      }
    }
    const akParts = Array.from(akCounts.entries()).map(([name, count]) => `${name}×${count}`);
    const tubingCount = patients.length;
    const suppliesStr = akParts.length > 0
      ? `${akParts.join(', ')} + Tubing×${tubingCount}`
      : `Tubing×${tubingCount}`;

    // Count injection medications
    const medCounts = new Map<string, number>();
    for (const p of patients) {
      if (p.injections && p.injections.length > 0) {
        for (const inj of p.injections) {
          const displayName = this.injectionTradeNameMap.get(inj.orderCode) || inj.orderName || '未知';
          medCounts.set(displayName, (medCounts.get(displayName) || 0) + 1);
        }
      }
    }
    const medParts = Array.from(medCounts.entries()).map(([name, count]) => `${name}×${count}`);
    const medicationsStr = medParts.join(', ');

    return { supplies: suppliesStr, medications: medicationsStr };
  }

  // --- Data Loading ---
  async fetchMyPatientData(date?: string): Promise<void> {
    console.log('[MyPatients DEBUG] fetchMyPatientData CALLED, date param:', date);
    this.isLoading.set(true);
    try {
      const userId = this.selectedUserId();
      const targetDate = date || this.selectedDate();
      console.log('[MyPatients DEBUG] userId:', userId, 'targetDate:', targetDate);
      if (!userId) {
        console.log('[MyPatients DEBUG] EXIT: no userId');
        this.patientListByShift.set({});
        return;
      }

      // 1. Ensure patients are loaded
      await this.patientStore.fetchPatientsIfNeeded();
      console.log('[MyPatients DEBUG] patients loaded, count:', this.patientStore.allPatients().length);

      // 2. Look up user's name from UID
      await this.userDirectory.ensureUsersLoaded();
      const allUsers = this.userDirectory.allUsers();
      const targetUser = allUsers.find((u) => u.uid === userId);
      const userName = targetUser?.name;
      console.log('[MyPatients DEBUG] targetUser:', targetUser?.name, 'uid:', targetUser?.uid);
      if (!userName) {
        console.warn('[MyPatients DEBUG] EXIT: 找不到使用者名稱 for UID:', userId);
        this.patientListByShift.set({});
        return;
      }

      // 3. Fetch schedule and nurse assignments for this date
      // Past dates are in 'expired_schedules', today/future in 'schedules'
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const target = new Date(targetDate);
      target.setHours(0, 0, 0, 0);
      const isPastDate = target < today;

      const teamsApi = this.apiManagerService.create<FirestoreRecord>('nurse_assignments');

      console.log('[MyPatients DEBUG] fetching schedule and teams for:', targetDate, 'isPast:', isPastDate);

      let schedule: Record<string, any> = {};
      let teamsRecord: any = null;

      if (isPastDate) {
        // Past dates: use archive store
        const [archiveResult, teamsResults] = await Promise.all([
          this.archiveStore.fetchScheduleByDate(targetDate),
          teamsApi.fetchAll([where('date', '==', targetDate)]),
        ]);
        schedule = (archiveResult as any)?.schedule || {};
        teamsRecord = teamsResults.length > 0 ? teamsResults[0] : null;
      } else {
        // Today/future: use live schedules
        const schedulesApi = this.apiManagerService.create<FirestoreRecord>('schedules');
        const [scheduleResults, teamsResults] = await Promise.all([
          schedulesApi.fetchAll([where('date', '==', targetDate)]),
          teamsApi.fetchAll([where('date', '==', targetDate)]),
        ]);
        if (scheduleResults.length > 0) {
          schedule = (scheduleResults[0] as any).schedule || {};
        }
        teamsRecord = teamsResults.length > 0 ? teamsResults[0] : null;
      }

      console.log('[MyPatients DEBUG] schedule slots:', Object.keys(schedule).length, 'hasTeams:', !!teamsRecord);

      if (Object.keys(schedule).length === 0) {
        console.log('[MyPatients DEBUG] EXIT: no schedule data');
        this.patientListByShift.set({});
        return;
      }
      const namesMap: Record<string, string> = (teamsRecord as any)?.names || {};

      // 4. Find team keys assigned to this nurse
      const myTeamKeys = new Set<string>();
      for (const [teamKey, nurseName] of Object.entries(namesMap)) {
        if (nurseName === userName) {
          myTeamKeys.add(teamKey);
        }
      }

      // DEBUG: Log data to diagnose matching issues
      console.log('[MyPatients DEBUG] userName:', userName);
      console.log('[MyPatients DEBUG] namesMap:', JSON.stringify(namesMap));
      console.log('[MyPatients DEBUG] myTeamKeys:', [...myTeamKeys]);

      // Extract nurse group letter(s) and duties
      const groupLetters = new Set<string>();
      for (const tk of myTeamKeys) {
        const letter = tk.replace(/^[早午晚]/, '');
        if (letter) groupLetters.add(letter);
      }
      const groupArr = [...groupLetters].sort();
      this.nurseGroupLabel.set(groupArr.length > 0 ? groupArr.map(g => `${g}組`).join(' / ') : '');
      this.nurseGroupDuties.set(this.extractGroupDuties(groupArr));

      // 5. Apply teams data to schedule slots (same logic as stats.component.ts lines 590-600)
      // Teams use key format: ${patientId}-${shiftCode}
      const teamsData: Record<string, any> = (teamsRecord as any)?.teams || {};

      // Apply team info to schedule slots in memory
      for (const slotKey of Object.keys(schedule)) {
        const slot = schedule[slotKey];
        if (!slot?.patientId) continue;
        const shiftCode = slotKey.split('-').pop() || '';
        const teamKey = `${slot.patientId}-${shiftCode}`;
        const teamInfo = teamsData[teamKey];
        if (teamInfo) {
          Object.assign(slot, teamInfo);
        }
      }

      // 6. Build initial patient list and collect all my patient IDs
      const result: Record<string, MyPatientItem[]> = {};
      const patientMap = this.patientStore.patientMap();
      const feedMessages = this.taskStore.feedMessages();
      const allMyPatientIds: string[] = [];

      // Intermediate structure to hold items before injection enrichment
      interface PendingItem {
        slotKey: string;
        slotData: any;
        roles: string[];
        patient: any;
        orders: any;
        bedLabel: string;
      }
      const pendingItems: PendingItem[] = [];

      let matchCount = 0;
      for (const slotKey of Object.keys(schedule)) {
        const slotData = schedule[slotKey];
        if (!slotData?.patientId) continue;

        const shiftCode = slotKey.split('-').pop();
        const nurseTeam = slotData.nurseTeam || '';
        const nurseTeamIn = slotData.nurseTeamIn || '';
        const nurseTeamOut = slotData.nurseTeamOut || '';

        const roles: string[] = [];

        if (shiftCode === 'early' && myTeamKeys.has(nurseTeam)) {
          roles.push('early');
        }
        if (shiftCode === 'late' && myTeamKeys.has(nurseTeam)) {
          roles.push('late');
        }
        if (shiftCode === 'noon') {
          if (myTeamKeys.has(nurseTeamIn)) {
            roles.push('noonOn');
          }
          if (myTeamKeys.has(nurseTeamOut)) {
            roles.push('noonOff');
          }
        }

        if (roles.length === 0) continue;
        matchCount++;

        const patient = patientMap.get(slotData.patientId);
        if (!patient) continue;

        const orders = (patient as any).dialysisOrders || {};
        const bedLabel = slotKey.startsWith('peripheral')
          ? `外圍${slotKey.split('-')[1]}`
          : slotKey.split('-')[1] || '';

        allMyPatientIds.push(slotData.patientId);
        pendingItems.push({ slotKey, slotData, roles, patient, orders, bedLabel });
      }

      // 7. Fetch injection data from medication_orders
      let injectionsMap = new Map<string, any[]>();
      if (allMyPatientIds.length > 0) {
        try {
          const uniqueIds = [...new Set(allMyPatientIds)];
          const allInjections = await this.medicationStore.fetchDailyInjections(targetDate, uniqueIds);
          for (const inj of allInjections) {
            if (!injectionsMap.has(inj.patientId)) injectionsMap.set(inj.patientId, []);
            injectionsMap.get(inj.patientId)!.push(inj);
          }
        } catch (err) {
          console.warn('[MyPatients] 取得針劑資料失敗，將繼續不含針劑:', err);
        }
      }

      // 8. Build final patient items with injection data
      for (const item of pendingItems) {
        const patientMemos = feedMessages
          .filter(
            (m) =>
              m.patientId === item.slotData.patientId &&
              m.status !== 'completed' &&
              m.status !== 'resolved' &&
              m.status !== 'cancelled'
          )
          .map((m) => ({
            id: m.id,
            content: m.content,
            type: m.type,
            targetDate: (m as any).targetDate,
            status: m.status,
            creator: m.creator,
          }));

        const injections = injectionsMap.get(item.slotData.patientId) || [];

        const patientItem: MyPatientItem = {
          id: `${item.slotKey}`,
          patientId: item.slotData.patientId,
          name: (item.patient as any).name || '未知',
          bedNum: item.bedLabel,
          preparation: {
            ak: item.orders.ak || '',
            dialysateCa: item.orders.dialysateCa || item.orders.dialysate || '',
            heparin: item.orders.heparinLM || (item.orders.heparinInitial && item.orders.heparinMaintenance ? `${item.orders.heparinInitial}/${item.orders.heparinMaintenance}` : item.orders.heparinInitial || ''),
            bloodFlow: item.orders.bloodFlow || '',
            vascAccess: item.orders.vascAccess || (item.patient as any).vascularAccess || '',
          },
          injections,
          memos: patientMemos,
        };

        for (const role of item.roles) {
          if (!result[role]) result[role] = [];
          result[role].push(patientItem);
        }
      }

      // Sort each shift group by bed number
      for (const key of Object.keys(result)) {
        result[key].sort((a, b) => a.bedNum.localeCompare(b.bedNum, undefined, { numeric: true }));
      }

      console.log('[MyPatients DEBUG] matchCount:', matchCount, 'result keys:', Object.keys(result));
      this.patientListByShift.set(result);
    } catch (error) {
      console.error('載入今日病人資料失敗:', error);
      this.patientListByShift.set({});
    } finally {
      this.isLoading.set(false);
    }
  }

  reloadData(): void {
    this.fetchMyPatientData(this.selectedDate());
  }

  private async loadSelectableUsers(force = false): Promise<void> {
    if (!this.canSwitchUser()) {
      this.selectableUsers.set([]);
      return;
    }

    const now = Date.now();
    if (
      !force &&
      this.selectableUsers().length > 0 &&
      now - this.lastSelectableUsersUpdatedAt < this.SELECTABLE_USERS_TTL
    ) {
      return;
    }

    try {
      await this.userDirectory.ensureUsersLoaded();
      const allUsers = this.userDirectory.allUsers();
      const filteredUsers = allUsers
        .filter(
          (user) =>
            ['護理師', '護理師組長'].includes(user.title) && user.username
        )
        .map((user) => ({
          uid: user.uid,
          name: user.name,
          username: user.username!,
        }));

      this.selectableUsers.set(
        filteredUsers.sort((a, b) => {
          const idA = parseInt(a.username, 10);
          const idB = parseInt(b.username, 10);
          if (!isNaN(idA) && !isNaN(idB)) {
            return idA - idB;
          }
          return String(a.username).localeCompare(String(b.username), undefined, {
            numeric: true,
          });
        })
      );
      this.lastSelectableUsersUpdatedAt = now;
    } catch (error) {
      console.error('無法載入使用者列表:', error);
    }
  }

  // --- Dialog Event Handlers ---
  openCreateModal(itemToEdit: any = null): void {
    if (!this.hasPermission('viewer')) {
      this.notificationService.createNotification(
        '您的權限不足，無法執行此操作。',
        'error'
      );
      return;
    }
    this.editingItem.set(itemToEdit);
    this.isCreateModalVisible.set(true);
  }

  closeCreateModal(): void {
    this.isCreateModalVisible.set(false);
    this.editingItem.set(null);
  }

  async handleTaskSubmit(data: any): Promise<void> {
    const db = this.firebaseService.db;
    const user = this.currentUser();

    if (data.id) {
      // Edit mode
      const taskRef = doc(db, 'tasks', data.id);
      const { id, ...updateData } = data;
      try {
        await updateDoc(taskRef, updateData);
        this.notificationService.createNotification('備忘已更新', 'success');
      } catch (error) {
        console.error('更新項目失敗:', error);
        this.notificationService.createNotification(
          '更新失敗，請稍後再試',
          'error'
        );
      }
    } else {
      // Create mode
      try {
        await handleTaskCreated(data, user);
        this.notificationService.createNotification(
          '交辦/留言已成功新增！',
          'success'
        );
      } catch (error: any) {
        console.error('新增項目失敗:', error);
        this.notificationService.createNotification(
          `新增失敗: ${error.message}`,
          'error'
        );
      }
    }
    this.closeCreateModal();
  }

  async updateTaskStatus(task: any, newStatus: string): Promise<void> {
    const user = this.currentUser();
    if (!user) return;
    try {
      const db = this.firebaseService.db;
      const taskRef = doc(db, 'tasks', task.id);
      await updateDoc(taskRef, {
        status: newStatus,
        resolvedBy: { uid: user.uid, name: user.name },
        resolvedAt: new Date(),
      });
      this.notificationService.createNotification(
        newStatus === 'completed' ? '狀態已更新為已讀' : '狀態已移回待辦',
        'success'
      );
    } catch (error) {
      console.error('更新任務狀態失敗:', error);
      this.notificationService.createNotification(
        '更新失敗，請稍後再試',
        'error'
      );
    }
  }

  confirmDeleteTask(item: any): void {
    this.itemToDelete.set(item);
    this.isConfirmDeleteVisible.set(true);
  }

  async executeDeleteTask(): Promise<void> {
    const item = this.itemToDelete();
    if (!item) return;
    const db = this.firebaseService.db;
    const taskRef = doc(db, 'tasks', item.id);
    try {
      await deleteDoc(taskRef);
      this.notificationService.createNotification('訊息已刪除', 'info');
    } catch (error) {
      console.error('刪除任務失敗:', error);
      this.notificationService.createNotification(
        '刪除失敗，請稍後再試',
        'error'
      );
    }
    this.isConfirmDeleteVisible.set(false);
    this.itemToDelete.set(null);
  }

  openEditModal(itemToEdit: any): void {
    this.openCreateModal(itemToEdit);
  }

  openOrderModal(patientFromList: MyPatientItem): void {
    const allPatients = this.patientStore.allPatients();
    const fullPatientData = allPatients.find(
      (p) => p.id === patientFromList.patientId
    );
    if (fullPatientData) {
      this.selectedPatientForOrder.set(fullPatientData);
      this.isOrderModalVisible.set(true);
    } else {
      console.error('找不到完整的病人資料:', patientFromList.patientId);
      this.notificationService.createNotification(
        '無法載入病人醫囑，請稍後再試',
        'error'
      );
    }
  }

  closeOrderModal(): void {
    this.isOrderModalVisible.set(false);
    this.selectedPatientForOrder.set(null);
  }

  async handleOrderSave(updatedOrders: any): Promise<void> {
    const patient = this.selectedPatientForOrder();
    if (!patient) return;

    const db = this.firebaseService.db;
    const patientRef = doc(db, 'patients', patient.id);
    const historyRef = collection(db, 'dialysis_orders_history');
    const user = this.currentUser();

    try {
      await updateDoc(patientRef, {
        dialysisOrders: updatedOrders,
      });

      await addDoc(historyRef, {
        patientId: patient.id,
        patientName: patient.name,
        orders: updatedOrders,
        updatedBy: user?.name || '未知使用者',
        updatedAt: serverTimestamp(),
      });

      this.notificationService.createNotification(
        `${patient.name} 的醫囑已更新`,
        'success'
      );
      this.patientStore.updatePatientInStore(patient.id, {
        dialysisOrders: updatedOrders,
      });
      this.closeOrderModal();
      // Refresh cards and supply summary with updated orders
      this.reloadData();
    } catch (error) {
      console.error('儲存醫囑失敗:', error);
      this.notificationService.createNotification(
        '醫囑儲存失敗，請檢查網路連線',
        'error'
      );
    }
  }

  onCancelConfirmDelete(): void {
    this.isConfirmDeleteVisible.set(false);
  }
}
