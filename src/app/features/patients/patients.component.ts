import {
  Component,
  inject,
  signal,
  computed,
  effect,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import { doc, updateDoc, where } from 'firebase/firestore';
import { FirebaseService } from '@services/firebase.service';
import { AuthService } from '@services/auth.service';
import { PatientStoreService, type Patient } from '@services/patient-store.service';
import { NotificationService } from '@services/notification.service';
import {
  ApiManagerService,
  type ApiManager,
  type FirestoreRecord,
} from '@services/api-manager.service';
import { formatDateToYYYYMMDD, parseFirestoreTimestamp } from '@/utils/dateUtils';
import { escapeHtml } from '@/utils/sanitize';

// Child component imports
import { PatientFormModalComponent } from '@app/components/dialogs/patient-form-modal/patient-form-modal.component';
import { SelectionDialogComponent } from '@app/components/dialogs/selection-dialog/selection-dialog.component';
import { AlertDialogComponent } from '@app/components/dialogs/alert-dialog/alert-dialog.component';
import { ConfirmDialogComponent } from '@app/components/dialogs/confirm-dialog/confirm-dialog.component';
import { DialysisOrderModalComponent } from '@app/components/dialogs/dialysis-order-modal/dialysis-order-modal.component';
import { PatientHistoryModalComponent } from '@app/components/dialogs/patient-history-modal/patient-history-modal.component';
import { WardNumberDialogComponent } from '@app/components/dialogs/ward-number-dialog/ward-number-dialog.component';
import { PatientUpdateSchedulerDialogComponent } from '@app/components/dialogs/patient-update-scheduler-dialog/patient-update-scheduler-dialog.component';

type PatientTab = 'opd' | 'ipd' | 'er' | 'deleted';

interface PatientStats {
  source: { er: number; ipd: number; opd: number; deleted: number };
  mode: Record<string, number>;
  disease: Record<string, number>;
  freq: Record<string, number>;
  opdChanges: {
    lastMonth: { new: number; transferOut: number; death: number; details: Record<string, number> };
    thisMonth: { new: number; transferOut: number; death: number; details: Record<string, number> };
  };
}

@Component({
  selector: 'app-patients',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    PatientFormModalComponent,
    SelectionDialogComponent,
    AlertDialogComponent,
    ConfirmDialogComponent,
    DialysisOrderModalComponent,
    PatientHistoryModalComponent,
    WardNumberDialogComponent,
    PatientUpdateSchedulerDialogComponent,
  ],
  templateUrl: './patients.component.html',
  styleUrl: './patients.component.css',
})
export class PatientsComponent implements OnInit, OnDestroy {
  private readonly firebaseService = inject(FirebaseService);
  protected readonly authService = inject(AuthService);
  private readonly patientStore = inject(PatientStoreService);
  private readonly notificationService = inject(NotificationService);
  private readonly apiManagerService = inject(ApiManagerService);

  private readonly tasksApi: ApiManager<FirestoreRecord>;
  private readonly schedulesApi: ApiManager<FirestoreRecord>;
  private readonly scheduledChangesApi: ApiManager<FirestoreRecord>;
  private readonly patientHistoryApi: ApiManager<FirestoreRecord>;

  // --- Tab & Sort State ---
  readonly activeTab = signal<PatientTab>('opd');
  readonly currentSort = signal<{ column: string; order: 'asc' | 'desc' }>({
    column: 'updatedAt',
    order: 'desc',
  });
  readonly erListFilter = signal('');
  readonly ipdListFilter = signal('');
  readonly opdListFilter = signal('');
  readonly deletedSearchTerm = signal('');
  readonly globalSearchTerm = signal('');

  // --- Stats ---
  readonly patientStats = signal<PatientStats>({
    source: { er: 0, ipd: 0, opd: 0, deleted: 0 },
    mode: {},
    disease: {},
    freq: {},
    opdChanges: {
      lastMonth: { new: 0, transferOut: 0, death: 0, details: {} },
      thisMonth: { new: 0, transferOut: 0, death: 0, details: {} },
    },
  });
  readonly activePopover = signal<string | null>(null);

  // --- Modal State ---
  readonly isModalVisible = signal(false);
  readonly editingPatient = signal<any>(null);
  readonly modalType = signal<string>('ipd');
  readonly isDeleteDialogVisible = signal(false);
  readonly patientToDeleteId = signal<string | null>(null);
  readonly isAlertDialogVisible = signal(false);
  readonly alertDialogTitle = signal('');
  readonly alertDialogMessage = signal('');
  readonly isConfirmDialogVisible = signal(false);
  readonly confirmDialogTitle = signal('');
  readonly confirmDialogMessage = signal('');
  private confirmAction: (() => void) | null = null;
  readonly isOrderModalVisible = signal(false);
  readonly editingPatientForOrder = signal<any>(null);
  readonly isHistoryModalVisible = signal(false);
  readonly selectedPatientForHistory = signal<any>(null);
  readonly newPatientDataForConflict = signal<any>(null);
  readonly existingPatientForConflict = signal<any>(null);
  readonly isRestoreDialogVisible = signal(false);
  readonly patientToRestoreId = signal<string | null>(null);
  readonly isWardDialogVisible = signal(false);
  readonly currentWardNumber = signal('');
  readonly editingPatientForWardNumber = signal<any>(null);

  // Scheduler dialog state
  readonly isSchedulerDialogVisible = signal(false);
  readonly schedulerPatient = signal<any>(null);
  readonly schedulerChangeType = signal('');

  // Schedule conflict dialog state
  readonly isScheduleConflictDialogVisible = signal(false);
  readonly scheduleConflictTitle = signal('');
  readonly scheduleConflictMessage = signal('');
  private pendingOperationType = '';
  private pendingPatientId: string | null = null;
  private cachedPatientHistory: any[] | null = null;
  private pendingNewStatus: string | null = null;

  // --- Constants ---
  readonly FREQ_COLOR_MAP: Record<string, string> = {
    '一三五': 'freq-blue',
    '二四六': 'freq-green',
    '一四': 'freq-orange', '二五': 'freq-orange', '三六': 'freq-orange',
    '一五': 'freq-orange', '二六': 'freq-orange',
    '每日': 'freq-purple',
    '每周一': 'freq-teal', '每周二': 'freq-teal', '每周三': 'freq-teal',
    '每周四': 'freq-teal', '每周五': 'freq-teal', '每周六': 'freq-teal',
    '臨時': 'freq-red',
    '未設定': 'freq-grey',
  };
  readonly DELETE_REASONS = [
    { value: '死亡', text: '死亡' },
    { value: '轉外院透析', text: '轉外院透析' },
    { value: '轉PD', text: '轉PD' },
    { value: '腎臟移植', text: '腎臟移植' },
    { value: '轉安寧', text: '轉安寧' },
    { value: '腎功能恢復不須透析', text: '腎功能恢復不須透析' },
    { value: '出院', text: '出院' },
    { value: '結束治療', text: '結束治療' },
  ];
  readonly RESTORE_OPTIONS = [
    { value: 'opd', text: '復原至 門診' },
    { value: 'ipd', text: '復原至 住院' },
    { value: 'er', text: '復原至 急診' },
  ];

  // --- Computed ---
  readonly isPageLocked = computed(() => this.authService.isViewer());
  readonly isDeleteLocked = computed(
    () => this.isPageLocked() || this.authService.currentUser()?.role === 'contributor'
  );

  readonly displayedPatients = computed(() => {
    const allPatients = this.patientStore.allPatients();
    if (!allPatients) return [];

    let patientsToDisplay: Patient[];
    let searchTerm = '';

    if (this.activeTab() === 'er') {
      patientsToDisplay = allPatients.filter((p: any) => p.status === 'er' && !p.isDeleted);
      searchTerm = this.erListFilter().toLowerCase();
    } else if (this.activeTab() === 'ipd') {
      patientsToDisplay = allPatients.filter((p: any) => p.status === 'ipd' && !p.isDeleted);
      searchTerm = this.ipdListFilter().toLowerCase();
    } else if (this.activeTab() === 'opd') {
      patientsToDisplay = allPatients.filter((p: any) => p.status === 'opd' && !p.isDeleted);
      searchTerm = this.opdListFilter().toLowerCase();
    } else if (this.activeTab() === 'deleted') {
      patientsToDisplay = allPatients.filter((p: any) => p.isDeleted);
      searchTerm = this.deletedSearchTerm().toLowerCase();
    } else {
      patientsToDisplay = [];
    }

    if (searchTerm) {
      patientsToDisplay = patientsToDisplay.filter(
        (p: any) =>
          (p.name && p.name.toLowerCase().includes(searchTerm)) ||
          (p.medicalRecordNumber && p.medicalRecordNumber.includes(searchTerm))
      );
    }

    return [...patientsToDisplay].sort((a: any, b: any) => {
      const sortColumn = this.currentSort().column;
      let valA = a[sortColumn];
      let valB = b[sortColumn];

      if (sortColumn === 'patientStatus') {
        const statusA = a.patientStatus || {};
        const statusB = b.patientStatus || {};
        valA =
          (statusA.isFirstDialysis?.active ? '1' : '0') +
          (statusA.isPaused?.active ? '1' : '0') +
          (statusA.hasBloodDraw?.active ? '1' : '0');
        valB =
          (statusB.isFirstDialysis?.active ? '1' : '0') +
          (statusB.isPaused?.active ? '1' : '0') +
          (statusB.hasBloodDraw?.active ? '1' : '0');
      }

      const dateA = this.normalizeDateObject(valA);
      const dateB = this.normalizeDateObject(valB);
      let compareResult: number;

      if (dateA && dateB) {
        compareResult = dateA.getTime() - dateB.getTime();
      } else {
        const strA = valA || '';
        const strB = valB || '';
        compareResult = String(strA).localeCompare(String(strB), 'zh-Hant');
      }

      return this.currentSort().order === 'asc' ? compareResult : -compareResult;
    });
  });

  readonly sortedFreqStats = computed(() => {
    const freq = this.patientStats().freq;
    if (!freq) return [];
    const FREQ_SORT_ORDER: Record<string, number> = {
      '一三五': 1, '二四六': 2, '一四': 11, '二五': 12, '三六': 13, '一五': 14, '二六': 15,
      '每周一': 21, '每周二': 22, '每周三': 23, '每周四': 24, '每周五': 25, '每周六': 26,
      '每日': 31, '臨時': 99,
    };
    return Object.entries(freq).sort((a, b) => {
      const orderA = FREQ_SORT_ORDER[a[0]] || 100;
      const orderB = FREQ_SORT_ORDER[b[0]] || 100;
      return orderA - orderB;
    });
  });

  private popoverListener = (event: MouseEvent) => this.closePopovers(event);

  constructor() {
    this.tasksApi = this.apiManagerService.create<FirestoreRecord>('tasks');
    this.schedulesApi = this.apiManagerService.create<FirestoreRecord>('schedules');
    this.scheduledChangesApi = this.apiManagerService.create<FirestoreRecord>('scheduled_changes');
    this.patientHistoryApi = this.apiManagerService.create<FirestoreRecord>('patient_history');
  }

  ngOnInit(): void {
    this.patientStore.fetchPatientsIfNeeded().then(() => {
      // Phase 1: Instantly show source counts & disease counts from local data
      this.calculateQuickStats(this.patientStore.allPatients());
      // Phase 2: Fetch patient_history and compute full stats (opdChanges)
      this.refreshAllData();
    });
    window.addEventListener('click', this.popoverListener);
  }

  ngOnDestroy(): void {
    window.removeEventListener('click', this.popoverListener);
  }

  // --- Utility Methods ---
  private normalizeDateObject(dateInput: any): Date | null {
    if (!dateInput) return null;
    if (typeof dateInput.toDate === 'function') return dateInput.toDate();
    const date = new Date(dateInput);
    return isNaN(date.getTime()) ? null : date;
  }

  formatDate(dateInput: any): string {
    const date = this.normalizeDateObject(dateInput);
    if (!date) return '';
    return formatDateToYYYYMMDD(date);
  }

  getRowClass(p: any): string {
    if (p.patientStatus?.isPaused?.active) return 'status-discontinued';
    if (p.isDeleted) return 'status-deleted';
    const biweeklyFreq = ['一四', '二五', '三六', '一五', '二六'];
    if (biweeklyFreq.includes(p.freq)) return 'status-biweekly';
    return `status-${p.status}`;
  }

  generateDiseaseTags(diseases: string[]): string {
    if (!diseases?.length) return '';
    return diseases
      .map((tag: string) => `<span class="disease-tag">${escapeHtml(tag)}</span>`)
      .join('');
  }

  getFreqColorClass(freq: string): string {
    return this.FREQ_COLOR_MAP[freq] || 'freq-grey';
  }

  // --- Popover / Dialog Helpers ---
  togglePopover(popoverName: string): void {
    this.activePopover.set(
      this.activePopover() === popoverName ? null : popoverName
    );
  }

  closePopovers(event: MouseEvent): void {
    if (event && (event.target as HTMLElement).closest('.stats-popover-wrapper')) return;
    this.activePopover.set(null);
  }

  showAlert(title: string, message: string): void {
    this.alertDialogTitle.set(title);
    this.alertDialogMessage.set(message);
    this.isAlertDialogVisible.set(true);
  }

  showConfirm(title: string, message: string, onConfirm: () => void): void {
    this.confirmDialogTitle.set(title);
    this.confirmDialogMessage.set(message);
    this.confirmAction = onConfirm;
    this.isConfirmDialogVisible.set(true);
  }

  handleConfirm(): void {
    if (typeof this.confirmAction === 'function') this.confirmAction();
    this.isConfirmDialogVisible.set(false);
    this.confirmAction = null;
  }

  handleCancel(): void {
    this.isConfirmDialogVisible.set(false);
    this.confirmAction = null;
  }

  // --- Tab & Sort ---
  changeTab(tabName: PatientTab): void {
    this.activeTab.set(tabName);
    this.globalSearchTerm.set('');
  }

  handleSort(key: string): void {
    const current = this.currentSort();
    if (current.column === key) {
      this.currentSort.set({
        column: key,
        order: current.order === 'asc' ? 'desc' : 'asc',
      });
    } else {
      this.currentSort.set({ column: key, order: 'asc' });
    }
  }

  // --- Data Refresh ---
  async refreshAllData(): Promise<void> {
    const [_allPatientsResult, patientHistoryForStats] = await Promise.all([
      this.patientStore.forceRefreshPatients(),
      this.fetchPatientHistoryForStats(),
    ]);
    this.cachedPatientHistory = patientHistoryForStats;
    this.calculateStats(this.patientStore.allPatients(), patientHistoryForStats);
  }

  /**
   * Recalculate stats from local store data without re-fetching from Firestore.
   * Falls back to a full refresh if no cached history is available.
   */
  private async recalculateStatsLocally(): Promise<void> {
    if (!this.cachedPatientHistory) {
      this.cachedPatientHistory = await this.fetchPatientHistoryForStats();
    }
    this.calculateStats(this.patientStore.allPatients(), this.cachedPatientHistory);
  }

  private async fetchPatientHistoryForStats(): Promise<any[]> {
    try {
      const twoMonthsAgo = new Date();
      twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
      twoMonthsAgo.setDate(1);
      return await this.patientHistoryApi.fetchAll([
        where('timestamp', '>=', twoMonthsAgo.toISOString()),
      ]);
    } catch (error) {
      console.error('讀取病人歷史紀錄失敗:', error);
      this.showAlert('讀取失敗', '讀取病人歷史統計資料失敗！');
      return [];
    }
  }

  /**
   * Phase 1: Quick stats from local patient data only (no Firestore query needed).
   * Computes source counts and disease counts so the UI can display them instantly.
   */
  private calculateQuickStats(allPatientsWithDeleted: any[]): void {
    const quickStats: PatientStats = {
      source: { er: 0, ipd: 0, opd: 0, deleted: 0 },
      mode: { HD: 0, SLED: 0, CVVHDF: 0, PP: 0, DFPP: 0, Lipid: 0 },
      disease: { HBV: 0, HCV: 0, HIV: 0, RPR: 0, COVID: 0, '隔離': 0 },
      freq: {},
      opdChanges: this.patientStats().opdChanges, // preserve any existing opdChanges
    };

    allPatientsWithDeleted.forEach((p: any) => {
      if (p.isDeleted) {
        quickStats.source.deleted++;
      } else if (p.status) {
        if (!(p.status in quickStats.source)) (quickStats.source as any)[p.status] = 0;
        (quickStats.source as any)[p.status]++;
      }
      if (!p.isDeleted) {
        if (p.mode && quickStats.mode.hasOwnProperty(p.mode)) quickStats.mode[p.mode]++;
        if (p.diseases) {
          p.diseases.forEach((d: string) => {
            if (quickStats.disease.hasOwnProperty(d)) quickStats.disease[d]++;
          });
        }
        if (p.freq) {
          if (!quickStats.freq[p.freq]) quickStats.freq[p.freq] = 0;
          quickStats.freq[p.freq]++;
        }
      }
    });

    this.patientStats.set(quickStats);
  }

  /**
   * Phase 2: Full stats including opdChanges (requires patient_history from Firestore).
   */
  private calculateStats(allPatientsWithDeleted: any[], patientHistory: any[]): void {
    const toUTCDateString = (dateInput: any): string => {
      const date = this.normalizeDateObject(dateInput);
      if (!date) return '';
      return date.toISOString().split('T')[0];
    };
    const transferOutReasons = ['轉外院透析', '轉PD', '腎臟移植', '轉安寧', '腎功能恢復不須透析'];
    const opdChangesDetailsTemplate: Record<string, number> = {};
    transferOutReasons.forEach((r) => { opdChangesDetailsTemplate[r] = 0; });

    const statsResult: PatientStats = {
      source: { er: 0, ipd: 0, opd: 0, deleted: 0 },
      mode: { HD: 0, SLED: 0, CVVHDF: 0, PP: 0, DFPP: 0, Lipid: 0 },
      disease: { HBV: 0, HCV: 0, HIV: 0, RPR: 0, COVID: 0, '隔離': 0 },
      freq: {},
      opdChanges: {
        lastMonth: { new: 0, transferOut: 0, death: 0, details: { ...opdChangesDetailsTemplate } },
        thisMonth: { new: 0, transferOut: 0, death: 0, details: { ...opdChangesDetailsTemplate } },
      },
    };

    const today = new Date();
    const currentYear = today.getUTCFullYear();
    const currentMonth = today.getUTCMonth();
    const firstDayThisMonthStr = new Date(Date.UTC(currentYear, currentMonth, 1)).toISOString().split('T')[0];
    const firstDayLastMonthStr = new Date(Date.UTC(currentYear, currentMonth - 1, 1)).toISOString().split('T')[0];
    const lastDayLastMonthStr = new Date(Date.UTC(currentYear, currentMonth, 0)).toISOString().split('T')[0];
    const todayStr = toUTCDateString(today);

    allPatientsWithDeleted.forEach((p: any) => {
      if (p.isDeleted) {
        statsResult.source.deleted++;
      } else if (p.status) {
        if (!(p.status in statsResult.source)) (statsResult.source as any)[p.status] = 0;
        (statsResult.source as any)[p.status]++;
      }
      if (!p.isDeleted) {
        if (p.mode && statsResult.mode.hasOwnProperty(p.mode)) statsResult.mode[p.mode]++;
        if (p.diseases) {
          p.diseases.forEach((d: string) => {
            if (statsResult.disease.hasOwnProperty(d)) statsResult.disease[d]++;
          });
        }
        if (p.freq) {
          if (!statsResult.freq[p.freq]) statsResult.freq[p.freq] = 0;
          statsResult.freq[p.freq]++;
        }
      }
      if (p.isDeleted && p.originalStatus === 'opd') {
        const deletedAtStr = toUTCDateString(p.deletedAt);
        if (deletedAtStr) {
          const period =
            deletedAtStr >= firstDayLastMonthStr && deletedAtStr <= lastDayLastMonthStr
              ? 'lastMonth'
              : deletedAtStr >= firstDayThisMonthStr && deletedAtStr <= todayStr
                ? 'thisMonth'
                : null;
          if (period) {
            if (p.deleteReason === '死亡') {
              statsResult.opdChanges[period].death++;
            } else if (transferOutReasons.includes(p.deleteReason)) {
              statsResult.opdChanges[period].transferOut++;
              if (statsResult.opdChanges[period].details.hasOwnProperty(p.deleteReason)) {
                statsResult.opdChanges[period].details[p.deleteReason]++;
              }
            }
          }
        }
      }
    });

    patientHistory.forEach((history: any) => {
      const eventTimeStr = toUTCDateString(history.timestamp);
      if (eventTimeStr) {
        const period =
          eventTimeStr >= firstDayLastMonthStr && eventTimeStr <= lastDayLastMonthStr
            ? 'lastMonth'
            : eventTimeStr >= firstDayThisMonthStr && eventTimeStr <= todayStr
              ? 'thisMonth'
              : null;
        if (period) {
          if (
            (history.eventType === 'CREATE' && history.eventDetails?.status === 'opd') ||
            (history.eventType === 'TRANSFER' && history.eventDetails?.to === 'opd') ||
            (history.eventType === 'RESTORE_AND_TRANSFER' &&
              history.eventDetails?.restoredTo === 'opd')
          ) {
            statsResult.opdChanges[period].new++;
          }
        }
      }
    });

    this.patientStats.set(statsResult);
  }

  // --- Global Search ---
  handleGlobalSearch(query: string): void {
    if (!query?.trim()) {
      this.showAlert('提示', '請輸入病人姓名或病歷號進行搜尋。');
      return;
    }
    const searchTerm = query.trim();
    const searchTermLower = searchTerm.toLowerCase();
    const allPatients = this.patientStore.allPatients();
    const searchResults = allPatients.filter(
      (p: any) =>
        (p.medicalRecordNumber && p.medicalRecordNumber.includes(searchTerm)) ||
        (p.name && p.name.toLowerCase().includes(searchTermLower))
    );

    if (searchResults.length > 1) {
      this.showAlert('找到多位病人', `符合 "${query}" 的病人不只一位，請用更完整的資料查找。`);
      return;
    }

    const foundPatient: any = searchResults.length === 1 ? searchResults[0] : null;
    const statusMap: Record<string, string> = { ipd: '住院', opd: '門診', er: '急診' };
    const targetStatusText = statusMap[this.activeTab()] || '列表';

    if (foundPatient) {
      if (foundPatient.isDeleted) {
        const originalStatusText = statusMap[foundPatient.originalStatus] || '未知';
        this.showConfirm(
          '找到已刪除病人',
          `病人 "${foundPatient.name}" (${foundPatient.medicalRecordNumber}) 已被刪除 (原為${originalStatusText}，原因: ${foundPatient.deleteReason || '未知'})。\n\n是否要復原並移至「${targetStatusText}」清單？`,
          () => this.restorePatient(foundPatient.id)
        );
      } else if (foundPatient.status !== this.activeTab()) {
        const currentStatusText = statusMap[foundPatient.status] || '未知';
        this.showConfirm(
          '找到病人 (不同表單)',
          `病人 "${foundPatient.name}" (${foundPatient.medicalRecordNumber}) 目前在「${currentStatusText}」清單中。\n\n是否要移至「${targetStatusText}」清單？`,
          () => this.transferPatient(foundPatient.id, this.activeTab())
        );
      } else {
        this.showAlert('病人已存在', `病人 "${foundPatient.name}" 已在「${targetStatusText}」清單中。`);
      }
    } else {
      const newPatientTemplate: any = { diseases: [] };
      if (/^\d{6,}$/.test(searchTerm)) {
        newPatientTemplate.medicalRecordNumber = searchTerm;
      } else {
        newPatientTemplate.name = searchTerm;
      }
      this.editingPatient.set(newPatientTemplate);
      this.modalType.set(this.activeTab());
      this.isModalVisible.set(true);
    }
  }

  // --- Patient CRUD ---
  async handleSavePatient(patientData: any): Promise<void> {
    if (this.isPageLocked()) {
      this.showAlert('操作失敗', '操作被鎖定：權限不足。');
      return;
    }

    const user = this.authService.currentUser();
    const creatorInfo = { uid: user!.uid, name: user!.name };
    const db = this.firebaseService.db;

    // Edit existing
    if (patientData.id) {
      const allPatients = this.patientStore.allPatients();
      const originalPatient: any = allPatients.find((p) => p.id === patientData.id);
      if (!originalPatient) {
        this.showAlert('錯誤', '找不到原始病人資料，無法更新。');
        return;
      }

      const wasPaused = originalPatient.patientStatus?.isPaused?.active || false;
      const isNowPaused = patientData.patientStatus?.isPaused?.active || false;
      const wasFirstDialysis = originalPatient.patientStatus?.isFirstDialysis?.active || false;
      const isNowFirstDialysis = patientData.patientStatus?.isFirstDialysis?.active || false;
      const wasBloodDraw = originalPatient.patientStatus?.hasBloodDraw?.active || false;
      const isNowBloodDraw = patientData.patientStatus?.hasBloodDraw?.active || false;

      // Handle pause/discontinue
      if (!wasPaused && isNowPaused) {
        this.showConfirm(
          '確認暫停/中止透析',
          `您確定要將「${patientData.name}」標記為暫停/中止透析嗎？\n\n此操作將會從「總床位表」中移除该病人的固定排班规则。`,
          async () => {
            try {
              this.closeModal();
              const dataToUpdate = { ...patientData };
              delete dataToUpdate.id;
              dataToUpdate.updatedAt = new Date().toISOString();
              const patientRef = doc(db, 'patients', patientData.id);
              await Promise.all([
                updateDoc(patientRef, dataToUpdate),
                this.patientStore.removeRuleFromMasterSchedule(patientData.id),
              ]);
              this.patientStore.updatePatientInStore(patientData.id, dataToUpdate);
              await this.recalculateStatsLocally();
              window.dispatchEvent(new CustomEvent('patient-data-updated'));
              this.notificationService.createNotification(
                `暫停/中止透析：${patientData.name}`,
                'patient'
              );
              this.showAlert(
                '操作成功',
                `已將 ${patientData.name} 標記為暫停/中止，並已從總表中移除其固定排班。`
              );
            } catch (err: any) {
              this.showAlert('操作失敗', `操作失敗：${err.message}`);
            }
          }
        );
        return;
      }

      // Normal edit
      try {
        const dataToUpdate = { ...patientData };
        delete dataToUpdate.id;
        dataToUpdate.updatedAt = new Date().toISOString();

        const patientRef = doc(db, 'patients', patientData.id);
        const updatePromises: Promise<any>[] = [updateDoc(patientRef, dataToUpdate)];

        if (!wasFirstDialysis && isNowFirstDialysis) {
          updatePromises.push(this.createAutomatedTask(patientData, '衛教', creatorInfo));
        }
        if (!wasBloodDraw && isNowBloodDraw) {
          updatePromises.push(this.createAutomatedTask(patientData, '抽血', creatorInfo));
        }

        await Promise.all(updatePromises);
        this.patientStore.updatePatientInStore(patientData.id, dataToUpdate);
        await this.recalculateStatsLocally();
        window.dispatchEvent(new CustomEvent('patient-data-updated'));
        this.notificationService.createNotification(`編輯病人：${patientData.name}`, 'patient');
        this.closeModal();
      } catch (err) {
        this.showAlert('操作失敗', '更新病人資料失敗！');
      }
      return;
    }

    // Create new patient
    if (!patientData.medicalRecordNumber?.trim()) {
      this.showAlert('資料不完整', '請務必填寫病歷號。');
      return;
    }

    const allPatients = this.patientStore.allPatients();
    const existingPatient: any = allPatients.find(
      (p) => p.medicalRecordNumber === patientData.medicalRecordNumber
    );

    if (existingPatient) {
      const statusMap: Record<string, string> = { ipd: '住院', opd: '門診', er: '急診' };
      const currentStatusText = existingPatient.isDeleted
        ? `已刪除 (原為${statusMap[existingPatient.originalStatus] || '未知'})`
        : statusMap[existingPatient.status] || '未知';
      this.newPatientDataForConflict.set(patientData);
      this.existingPatientForConflict.set(existingPatient);
      this.showConfirm(
        '病歷號重複',
        `病歷號 ${patientData.medicalRecordNumber} (${existingPatient.name}) 已存在於「${currentStatusText}」清單中。您是否要直接將其轉移並更新資料？`,
        () => this.handleConflictSelected()
      );
      return;
    }

    try {
      const dataToCreate: any = {
        ...patientData,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isDeleted: false,
        status: this.modalType(),
      };

      // Use ApiManager to create patient
      const patientsApi = this.apiManagerService.create<FirestoreRecord>('patients');
      const savedPatient = await patientsApi.save(dataToCreate);

      const automatedTaskPromises: Promise<any>[] = [];
      if ((savedPatient as any).patientStatus?.isFirstDialysis?.active) {
        automatedTaskPromises.push(this.createAutomatedTask(savedPatient, '衛教', creatorInfo));
      }
      if ((savedPatient as any).patientStatus?.hasBloodDraw?.active) {
        automatedTaskPromises.push(this.createAutomatedTask(savedPatient, '抽血', creatorInfo));
      }
      if (automatedTaskPromises.length > 0) {
        await Promise.all(automatedTaskPromises);
      }

      this.patientStore.addPatientInStore({ ...dataToCreate, id: (savedPatient as any).id });
      await this.recalculateStatsLocally();
      const statusText: Record<string, string> = { ipd: '住院', opd: '門診', er: '急診' };
      this.notificationService.createNotification(
        `新增病人：${dataToCreate.name} (${statusText[this.modalType()] || '列表'})`,
        'patient'
      );
      this.closeModal();
    } catch (err: any) {
      this.showAlert('操作失敗', `新增病人失敗！${err.message}`);
    }
  }

  private async createAutomatedTask(patientData: any, taskType: string, creatorInfo: any): Promise<void> {
    if (!patientData || !taskType || !creatorInfo) return;
    const today = new Date().toISOString().split('T')[0];
    let taskPayload: any;

    if (taskType === '衛教') {
      const firstDialysisDate = patientData.patientStatus?.isFirstDialysis?.date || today;
      taskPayload = {
        patientId: patientData.id,
        patientName: patientData.name,
        creator: creatorInfo,
        content: `首透衛教 (首透日期: ${firstDialysisDate})`,
        type: '衛教',
        category: 'message',
        status: 'pending',
        createdAt: new Date(),
        targetDate: firstDialysisDate,
      };
    } else if (taskType === '抽血') {
      const bloodDrawDate = patientData.patientStatus?.hasBloodDraw?.date || today;
      taskPayload = {
        patientId: patientData.id,
        patientName: patientData.name,
        creator: creatorInfo,
        content: '抽血',
        type: '抽血',
        category: 'message',
        status: 'pending',
        createdAt: new Date(),
        targetDate: bloodDrawDate,
      };
    }

    if (taskPayload) {
      await this.tasksApi.save(taskPayload);
    }
  }

  private async handleConflictSelected(): Promise<void> {
    const existingPatient = this.existingPatientForConflict();
    const newPatientData = this.newPatientDataForConflict();
    if (!existingPatient || !newPatientData) return;

    const db = this.firebaseService.db;
    try {
      const dataToUpdate: any = {
        ...newPatientData,
        status: this.modalType(),
        isDeleted: false,
        deletedAt: null,
        deleteReason: null,
        originalStatus: null,
      };
      delete dataToUpdate.id;
      const patientRef = doc(db, 'patients', existingPatient.id);
      await updateDoc(patientRef, dataToUpdate);
      this.patientStore.updatePatientInStore(existingPatient.id, dataToUpdate);
      await this.recalculateStatsLocally();
      window.dispatchEvent(new CustomEvent('patient-data-updated'));

      const statusText: Record<string, string> = { ipd: '住院', opd: '門診', er: '急診' };
      this.notificationService.createNotification(
        `轉移病人：${newPatientData.name} 至 ${statusText[this.modalType()] || '列表'}`,
        'patient'
      );
      this.showAlert(
        '操作成功',
        `病人 ${newPatientData.name} 已成功更新並轉移至 ${statusText[this.modalType()] || '列表'} 清單。`
      );
      this.closeModal();
    } catch (err) {
      this.showAlert('操作失敗', '轉移更新病人失敗！');
    } finally {
      this.existingPatientForConflict.set(null);
      this.newPatientDataForConflict.set(null);
    }
  }

  // --- Schedule Conflict ---
  private async checkPatientInTodaySchedule(patientId: string): Promise<boolean> {
    try {
      const today = new Date();
      const dateStr = today.toISOString().split('T')[0];
      const dailyRecords = await this.schedulesApi.fetchAll([where('date', '==', dateStr)]);
      if (dailyRecords.length === 0) return false;
      const schedule: any = dailyRecords[0].schedule || {};
      for (const slotData of Object.values(schedule) as any[]) {
        if (slotData && slotData.patientId === patientId) return true;
      }
      return false;
    } catch (error) {
      console.error('檢查當日排程失敗:', error);
      return false;
    }
  }

  private showScheduleConflictDialog(
    title: string, message: string, operationType: string,
    patientId: string, newStatus: string | null
  ): void {
    this.scheduleConflictTitle.set(title);
    this.scheduleConflictMessage.set(message);
    this.pendingOperationType = operationType;
    this.pendingPatientId = patientId;
    this.pendingNewStatus = newStatus;
    this.isScheduleConflictDialogVisible.set(true);
  }

  async handleScheduleConflictConfirm(): Promise<void> {
    this.isScheduleConflictDialogVisible.set(false);
    if (this.pendingOperationType === 'delete') {
      this.patientToDeleteId.set(this.pendingPatientId);
      this.isDeleteDialogVisible.set(true);
    } else if (this.pendingOperationType === 'transfer') {
      await this.executeTransferPatient(this.pendingPatientId!, this.pendingNewStatus!);
    }
    this.pendingOperationType = '';
    this.pendingPatientId = null;
    this.pendingNewStatus = null;
  }

  handleScheduleConflictCancel(): void {
    this.isScheduleConflictDialogVisible.set(false);
    const allPatients = this.patientStore.allPatients();
    const patient = allPatients.find((p) => p.id === this.pendingPatientId);
    if (!patient) return;

    if (this.pendingOperationType === 'delete') {
      this.schedulerChangeType.set('DELETE_PATIENT');
    } else if (this.pendingOperationType === 'transfer') {
      this.schedulerChangeType.set('UPDATE_STATUS');
    }

    this.schedulerPatient.set(patient);
    this.isSchedulerDialogVisible.set(true);
    this.pendingOperationType = '';
    this.pendingPatientId = null;
    this.pendingNewStatus = null;
  }

  async handleSchedulerSubmit(dataToSubmit: any): Promise<void> {
    try {
      await this.scheduledChangesApi.save(dataToSubmit);
      this.isSchedulerDialogVisible.set(false);
      this.schedulerPatient.set(null);
      this.schedulerChangeType.set('');

      const changeTypeText: Record<string, string> = {
        DELETE_PATIENT: '刪除病人',
        UPDATE_STATUS: '身分變更',
        UPDATE_MODE: '透析模式變更',
        UPDATE_FREQ: '頻率變更',
      };
      const text = changeTypeText[dataToSubmit.changeType] || '變更';
      this.notificationService.createNotification(
        `預約${text}：${dataToSubmit.patientName} (${dataToSubmit.effectiveDate} 生效)`,
        'schedule'
      );
      this.showAlert(
        '預約成功',
        `已成功建立預約${text}。\n\n病人：${dataToSubmit.patientName}\n生效日期：${dataToSubmit.effectiveDate}`
      );
    } catch (error: any) {
      console.error('保存預約變更失敗:', error);
      this.showAlert('操作失敗', `保存預約變更失敗：${error.message}`);
    }
  }

  // --- Transfer / Delete / Restore ---
  async transferPatient(patientId: string, newStatus: string): Promise<void> {
    if (this.isPageLocked()) {
      this.showAlert('操作失敗', '操作被鎖定：權限不足。');
      return;
    }
    const allPatients = this.patientStore.allPatients();
    const patient = allPatients.find((p) => p.id === patientId);
    if (!patient) return;

    const isInTodaySchedule = await this.checkPatientInTodaySchedule(patientId);
    if (isInTodaySchedule) {
      const targetStatusText: Record<string, string> = { ipd: '住院', opd: '門診', er: '急診' };
      this.showScheduleConflictDialog(
        '當日排程中有此病人',
        `病人「${patient.name}」今天有排程透析。\n\n若直接轉移身分（至${targetStatusText[newStatus] || '未知'}），當日排程不會自動更新。\n\n是否仍要繼續操作？\n選擇「否」可使用預約變更，於未來日期生效。`,
        'transfer',
        patientId,
        newStatus
      );
    } else {
      await this.executeTransferPatient(patientId, newStatus);
    }
  }

  private async executeTransferPatient(patientId: string, newStatus: string): Promise<void> {
    const allPatients = this.patientStore.allPatients();
    const patient: any = allPatients.find((p) => p.id === patientId);
    if (!patient) return;
    const targetStatusText: Record<string, string> = { ipd: '住院', opd: '門診', er: '急診' };

    this.showConfirm(
      `確認轉為${targetStatusText[newStatus] || '未知'}`,
      `您確定要將「${patient.name}」轉為${targetStatusText[newStatus] || '未知'}嗎？`,
      async () => {
        try {
          const db = this.firebaseService.db;
          const updateData: any = { status: newStatus, updatedAt: new Date().toISOString() };
          if ((patient.status === 'ipd' || patient.status === 'er') && newStatus === 'opd') {
            updateData.wardNumber = null;
          }
          const patientRef = doc(db, 'patients', patientId);
          await updateDoc(patientRef, updateData);
          this.patientStore.updatePatientInStore(patientId, updateData);
          await this.recalculateStatsLocally();
          window.dispatchEvent(new CustomEvent('patient-data-updated'));
          this.notificationService.createNotification(
            `轉移病人：${patient.name} 至 ${targetStatusText[newStatus] || '未知'}`,
            'patient'
          );
          this.showAlert('轉移成功', `${patient.name} 已成功轉至${targetStatusText[newStatus] || '未知'}。`);
          this.globalSearchTerm.set('');
        } catch (err: any) {
          this.showAlert('操作失敗', err.message || '轉床失敗！');
        }
      }
    );
  }

  async deletePatient(patientId: string): Promise<void> {
    if (this.isDeleteLocked()) return;
    const allPatients = this.patientStore.allPatients();
    const patient = allPatients.find((p) => p.id === patientId);
    if (!patient) return;

    const isInTodaySchedule = await this.checkPatientInTodaySchedule(patientId);
    if (isInTodaySchedule) {
      this.showScheduleConflictDialog(
        '當日排程中有此病人',
        `病人「${patient.name}」今天有排程透析。\n\n若直接刪除病人，當日排程不會自動更新。\n\n是否仍要繼續操作？\n選擇「否」可使用預約變更，於未來日期生效。`,
        'delete',
        patientId,
        null
      );
    } else {
      this.patientToDeleteId.set(patientId);
      this.isDeleteDialogVisible.set(true);
    }
  }

  async handleDeleteReasonSelected(reason: string): Promise<void> {
    if (this.isDeleteLocked()) {
      this.showAlert('操作失敗', '權限不足：您的角色無法刪除病人資料。');
      return;
    }
    const patientId = this.patientToDeleteId();
    if (!patientId) return;

    const allPatients = this.patientStore.allPatients();
    const patient: any = allPatients.find((p) => p.id === patientId);
    if (!patient) {
      this.showAlert('錯誤', '找不到該病人資料。');
      return;
    }
    const patientNameForNotification = patient.name;
    const statusMap: Record<string, string> = { opd: '門診', ipd: '住院', er: '急診' };
    const fromStatusText = statusMap[patient.status] || '目前列表';

    this.isDeleteDialogVisible.set(false);
    this.patientToDeleteId.set(null);

    try {
      const db = this.firebaseService.db;
      const patientRef = doc(db, 'patients', patientId);
      await updateDoc(patientRef, {
        isDeleted: true,
        originalStatus: patient.status,
        deleteReason: reason,
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this.patientStore.removeRuleFromMasterSchedule(patientId);
      this.patientStore.updatePatientInStore(patientId, {
        isDeleted: true, originalStatus: patient.status, deleteReason: reason,
        deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } as any);
      await this.recalculateStatsLocally();
      this.notificationService.createNotification(
        `刪除病人：${patientNameForNotification} (${reason})`,
        'patient'
      );
      this.showAlert(
        '操作成功',
        `病人 "${patientNameForNotification}" 已從「${fromStatusText}」清單中刪除。\n系統將會同步更新並移除其未來的固定排程。`
      );
    } catch (err: any) {
      this.showAlert('操作失敗', `刪除病人失敗。錯誤：${err.message}`);
    }
  }

  restorePatient(patientId: string): void {
    if (this.isPageLocked()) {
      this.showAlert('操作失敗', '操作被鎖定：權限不足。');
      return;
    }
    this.patientToRestoreId.set(patientId);
    this.isRestoreDialogVisible.set(true);
  }

  async handleRestoreSelected(targetStatus: string): Promise<void> {
    this.isRestoreDialogVisible.set(false);
    const patientId = this.patientToRestoreId();
    if (!patientId || !targetStatus) return;

    const allPatients = this.patientStore.allPatients();
    const patient: any = allPatients.find((p) => p.id === patientId);
    if (!patient) {
      this.showAlert('錯誤', '找不到該病人資料。');
      return;
    }

    const statusMap: Record<string, string> = { opd: '門診', ipd: '住院', er: '急診' };
    const targetStatusText = statusMap[targetStatus] || '列表';

    try {
      const db = this.firebaseService.db;
      const newPatientCategory = targetStatus === 'opd' ? 'opd_regular' : 'non_regular';
      const patientRef = doc(db, 'patients', patientId);
      await updateDoc(patientRef, {
        isDeleted: false,
        status: targetStatus,
        deleteReason: null,
        deletedAt: null,
        originalStatus: null,
        patientCategory: newPatientCategory,
        updatedAt: new Date().toISOString(),
      });
      this.patientStore.updatePatientInStore(patientId, {
        isDeleted: false, status: targetStatus, deleteReason: null,
        deletedAt: null, originalStatus: null,
        patientCategory: newPatientCategory, updatedAt: new Date().toISOString(),
      } as any);
      await this.recalculateStatsLocally();
      this.notificationService.createNotification(
        `復原病人：${patient.name} 至 ${targetStatusText}`,
        'patient'
      );
      this.showAlert(
        '復原成功',
        `${patient.name} 已復原並移至「${targetStatusText}」清單。如需排班，請至總床位表設定。`
      );
    } catch (err) {
      this.showAlert('操作失敗', '復原病人時發生錯誤！');
    } finally {
      this.patientToRestoreId.set(null);
      this.globalSearchTerm.set('');
    }
  }

  // --- Order Modal ---
  openOrderModal(patient: any): void {
    this.editingPatientForOrder.set(JSON.parse(JSON.stringify(patient)));
    this.isOrderModalVisible.set(true);
  }

  async handleSaveOrder(orderData: any): Promise<void> {
    if (this.isPageLocked()) {
      this.showAlert('操作失敗', '操作被鎖定：權限不足。');
      return;
    }
    const patient = this.editingPatientForOrder();
    if (!patient?.id) {
      this.showAlert('儲存失敗', '找不到有效的病人資訊。');
      return;
    }

    try {
      const db = this.firebaseService.db;
      const patientRef = doc(db, 'patients', patient.id);
      await updateDoc(patientRef, { dialysisOrders: orderData, updatedAt: new Date().toISOString() });
      this.patientStore.updatePatientInStore(patient.id, { dialysisOrders: orderData, updatedAt: new Date().toISOString() } as any);
      this.isOrderModalVisible.set(false);
      this.notificationService.createNotification(`更新醫囑：${patient.name}`, 'patient');
      this.showAlert('儲存成功', `已成功更新 ${patient.name} 的透析醫囑。`);
    } catch (error: any) {
      console.error('儲存醫囑失敗:', error);
      this.showAlert('操作失敗', `儲存醫囑時發生錯誤: ${error.message}`);
    }
  }

  // --- Ward Number ---
  promptWardNumber(patient: any): void {
    if (this.isPageLocked()) return;
    if (!patient || (patient.status !== 'ipd' && patient.status !== 'er')) {
      this.showAlert('提示', '只有住院或急診病人才能設定床號');
      return;
    }
    this.editingPatientForWardNumber.set(patient);
    this.currentWardNumber.set(patient.wardNumber || '');
    this.isWardDialogVisible.set(true);
  }

  async handleWardNumberConfirm(value: string): Promise<void> {
    const trimmedValue = value.trim();
    const patient = this.editingPatientForWardNumber();
    if (!patient?.id) return;

    try {
      const db = this.firebaseService.db;
      const patientRef = doc(db, 'patients', patient.id);
      await updateDoc(patientRef, { wardNumber: trimmedValue, updatedAt: new Date().toISOString() });
      this.patientStore.updatePatientInStore(patient.id, { wardNumber: trimmedValue, updatedAt: new Date().toISOString() } as any);
      this.notificationService.createNotification(
        `更新床號：${patient.name} -> ${trimmedValue || '無'}`,
        'patient'
      );
    } catch (error: any) {
      this.showAlert('操作失敗', `更新床號失敗: ${error.message}`);
    } finally {
      this.isWardDialogVisible.set(false);
      this.editingPatientForWardNumber.set(null);
      this.currentWardNumber.set('');
    }
  }

  // --- History ---
  openHistoryModal(patientId: string): void {
    const allPatients = this.patientStore.allPatients();
    const patient = allPatients.find((p: any) => p.id === patientId);
    this.selectedPatientForHistory.set({ id: patientId, name: patient?.name || '' });
    this.isHistoryModalVisible.set(true);
  }

  // --- Edit / Close ---
  openEditPatientModal(patient: any): void {
    this.editingPatient.set(JSON.parse(JSON.stringify(patient)));
    this.modalType.set(this.activeTab());
    this.isModalVisible.set(true);
  }

  closeModal(): void {
    this.isModalVisible.set(false);
    this.editingPatient.set(null);
    this.globalSearchTerm.set('');
  }

  cancelDelete(): void {
    this.isDeleteDialogVisible.set(false);
    this.patientToDeleteId.set(null);
  }

  // --- Export ---
  exportDeletedPatients(): void {
    const allPatients = this.patientStore.allPatients();
    const deletedPatients = allPatients.filter((p: any) => p.isDeleted);
    if (deletedPatients.length === 0) {
      alert('沒有已刪除的病人資料可供匯出。');
      return;
    }
    const data = deletedPatients.map((p: any) => [
      p.name || '',
      p.medicalRecordNumber || '',
      { ipd: '住院', er: '急診', opd: '門診' }[p.originalStatus as string] || '未知',
      p.deleteReason || '',
      this.formatDate(p.deletedAt) || '',
      p.remarks || '',
    ]);
    const ws = XLSX.utils.aoa_to_sheet([
      ['姓名', '病歷號', '原狀態', '刪除原因', '刪除日期', '備註'],
      ...data,
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '已刪除病人');
    XLSX.writeFile(wb, `已刪除病人清單_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
}
