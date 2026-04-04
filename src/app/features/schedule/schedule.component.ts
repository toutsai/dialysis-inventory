// src/app/features/schedule/schedule.component.ts
import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { where, orderBy, limit } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import * as XLSX from 'xlsx';

import { AuthService } from '@app/core/services/auth.service';
import { FirebaseService } from '@app/core/services/firebase.service';
import { PatientStoreService } from '@app/core/services/patient-store.service';
import { TaskStoreService } from '@app/core/services/task-store.service';
import { ArchiveStoreService } from '@app/core/services/archive-store.service';
import { MedicationStoreService } from '@app/core/services/medication-store.service';
import { ApiManagerService, type ApiManager, type FirestoreRecord } from '@app/core/services/api-manager.service';
import { NotificationService } from '@app/core/services/notification.service';
import { DateStateService } from '@app/core/services/date-state.service';
import { UserDirectoryService } from '@app/core/services/user-directory.service';
import { InpatientSidebarComponent } from '@app/components/inpatient-sidebar/inpatient-sidebar.component';
import { BedAssignmentDialogComponent } from '@app/components/dialogs/bed-assignment-dialog/bed-assignment-dialog.component';
import { DailyStaffDisplayComponent } from '@app/components/daily-staff-display/daily-staff-display.component';
import { StatsToolbarComponent } from '@app/components/stats-toolbar/stats-toolbar.component';
import { WardNumberDialogComponent } from '@app/components/dialogs/ward-number-dialog/ward-number-dialog.component';
import { InpatientRoundsDialogComponent } from '@app/components/dialogs/inpatient-rounds-dialog/inpatient-rounds-dialog.component';
import { IcuOrdersDialogComponent } from '@app/components/dialogs/icu-orders-dialog/icu-orders-dialog.component';
import { DialysisOrderModalComponent } from '@app/components/dialogs/dialysis-order-modal/dialysis-order-modal.component';
import { CrrtOrderModalComponent } from '@app/components/dialogs/crrt-order-modal/crrt-order-modal.component';
import { DailyRecordsSummaryDialogComponent } from '@app/components/dialogs/daily-records-summary-dialog/daily-records-summary-dialog.component';
import { DailyInjectionListDialogComponent } from '@app/components/dialogs/daily-injection-list-dialog/daily-injection-list-dialog.component';
import { DailyDraftListDialogComponent } from '@app/components/dialogs/daily-draft-list-dialog/daily-draft-list-dialog.component';
import { PatientDetailModalComponent } from '@app/components/dialogs/patient-detail-modal/patient-detail-modal.component';
import { PatientMessagesIconComponent } from '@app/components/patient-messages-icon/patient-messages-icon.component';
import { MemoDisplayDialogComponent } from '@app/components/dialogs/memo-display-dialog/memo-display-dialog.component';
import { ConditionRecordDisplayDialogComponent } from '@app/components/dialogs/condition-record-display-dialog/condition-record-display-dialog.component';
import { AutoAssignConfigDialogComponent } from '@app/components/dialogs/auto-assign-config-dialog/auto-assign-config-dialog.component';
import { AutoAssignConfigService, type AutoAssignConfig } from '@app/core/services/auto-assign-config.service';

import {
  SHIFT_CODES,
  ORDERED_SHIFT_CODES,
  getShiftDisplayName,
  earlyTeams,
  lateTeams,
  allTeams,
} from '@/constants/scheduleConstants';
import {
  createEmptySlotData,
  generateAutoNote,
  getUnifiedCellStyle,
} from '@/utils/scheduleUtils';
import {
  formatDateToYYYYMMDD,
} from '@/utils/dateUtils';
import {
  fetchTeamsByDate,
  saveTeams,
  updateTeams,
} from '@/services/nurseAssignmentsService';
import {
  fetchAllSchedules as optimizedFetchAllSchedules,
  saveSchedule as optimizedSaveSchedule,
  updateSchedule as optimizedUpdateSchedule,
  updatePatient as optimizedUpdatePatient,
  createDialysisOrderAndUpdatePatient,
} from '@/services/optimizedApiService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduleSlotData {
  patientId?: string;
  autoNote?: string;
  manualNote?: string;
  shiftId?: string;
  transportMethod?: string;
  archivedPatientInfo?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ScheduleRecord {
  id: string | null;
  date: string;
  schedule: Record<string, ScheduleSlotData>;
  names: Record<string, string>;
}

interface TeamsRecord {
  id: string | null;
  date: string;
  teams: Record<string, Record<string, string | null>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAYOUT_DATA = {
  leftWingRows: [
    ['空', 32, 31],
    [33, 35, 36],
    [39, 38, 37],
    [51, 52, 53],
    [57, 56, 55],
    [58, 59, 61],
    [65, 63, 62],
  ] as (string | number)[][],
  rightWingRows: [
    [29, 28, 27],
    [23, 25, 26],
    [22, 21, 19],
    [16, 17, 18],
    [15, 13, 12],
    [8, 9, 11],
    [7, 6, 5],
    [1, 2, 3],
  ] as number[][],
};

const ALL_BED_NUMBERS: (string | number)[] = [
  ...LAYOUT_DATA.leftWingRows.flat(),
  ...LAYOUT_DATA.rightWingRows.flat(),
].filter((b) => b !== '空');

const HEPATITIS_BEDS: (string | number)[] = ['空', 31, 32, 33, 35, 36];
const AISLE_SIDE_BEDS: number[] = [1, 7, 8, 15, 16, 22, 23, 29, 31, 36, 37, 53, 55, 61, 62, 65];
const PERIPHERAL_BED_COUNT = 6;

const FREQ_TO_DAYS: Record<string, number[]> = {
  '一三五': [1, 3, 5],
  '二四六': [2, 4, 6],
  '一四': [1, 4],
  '二五': [2, 5],
  '三六': [3, 6],
  '一五': [1, 5],
  '二六': [2, 6],
  '每周一次': [0, 1, 2, 3, 4, 5, 6],
  '臨時': [],
};

const BASE_TEAMS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@Component({
  selector: 'app-schedule',
  standalone: true,
  imports: [CommonModule, FormsModule, InpatientSidebarComponent, BedAssignmentDialogComponent, DailyStaffDisplayComponent, StatsToolbarComponent, WardNumberDialogComponent, InpatientRoundsDialogComponent, IcuOrdersDialogComponent, DialysisOrderModalComponent, CrrtOrderModalComponent, DailyRecordsSummaryDialogComponent, DailyInjectionListDialogComponent, DailyDraftListDialogComponent, PatientDetailModalComponent, PatientMessagesIconComponent, MemoDisplayDialogComponent, ConditionRecordDisplayDialogComponent, AutoAssignConfigDialogComponent],
  templateUrl: './schedule.component.html',
  styleUrl: './schedule.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScheduleComponent implements OnInit, OnDestroy {
  // Services
  readonly auth = inject(AuthService);
  private readonly firebaseService = inject(FirebaseService);
  private readonly patientStore = inject(PatientStoreService);
  private readonly taskStore = inject(TaskStoreService);
  private readonly archiveStore = inject(ArchiveStoreService);
  private readonly medicationStore = inject(MedicationStoreService);
  private readonly apiManagerService = inject(ApiManagerService);
  private readonly notificationService = inject(NotificationService);
  private readonly dateState = inject(DateStateService);
  private readonly userDirectory = inject(UserDirectoryService);
  private readonly router = inject(Router);
  private readonly autoAssignConfig = inject(AutoAssignConfigService);

  // API managers (cached — avoid re-creating per call)
  private readonly usersApi: ApiManager<FirestoreRecord>;
  private readonly ordersHistoryApi: ApiManager<FirestoreRecord>;
  private readonly schedulesApi: ApiManager<FirestoreRecord>;
  private readonly physicianSchedulesApi: ApiManager<FirestoreRecord>;

  // Expose constants to template
  readonly ORDERED_SHIFT_CODES = ORDERED_SHIFT_CODES;
  readonly SHIFT_CODES = SHIFT_CODES;
  readonly layoutData = LAYOUT_DATA;
  readonly allBedNumbers = ALL_BED_NUMBERS;
  readonly hepatitisBeds = HEPATITIS_BEDS;
  readonly aisleSideBeds = AISLE_SIDE_BEDS;
  readonly peripheralBedCount = PERIPHERAL_BED_COUNT;
  readonly earlyTeams = earlyTeams;
  readonly lateTeams = lateTeams;
  readonly allTeams = allTeams;
  readonly freqToDays = FREQ_TO_DAYS;

  // Reactive state
  readonly currentDate = signal(new Date());
  readonly hasUnsavedChanges = signal(false);
  readonly statusIndicator = signal('');
  currentRecord: ScheduleRecord = { id: null, date: '', schedule: {}, names: {} };
  readonly currentTeamsRecord = signal<TeamsRecord>({ id: null, date: '', teams: {} });
  readonly hasUnsavedTeamChanges = signal(false);
  readonly isLoading = signal(true);
  readonly isAutoAssignConfigVisible = signal(false);

  // Dialog visibility
  readonly isAlertDialogVisible = signal(false);
  readonly alertDialogTitle = signal('');
  readonly alertDialogMessage = signal('');
  readonly isAssignmentDialogVisible = signal(false);
  readonly isPatientSelectDialogVisible = signal(false);
  readonly isConfirmDialogVisible = signal(false);
  readonly confirmDialogMessage = signal('');
  readonly isSimplifiedViewVisible = signal(false);
  readonly isMemoDialogVisible = signal(false);
  readonly isConditionRecordDialogVisible = signal(false);
  readonly isDetailModalVisible = signal(false);
  readonly isWardDialogVisible = signal(false);
  readonly isInpatientRoundsDialogVisible = signal(false);
  readonly isRecordsSummaryDialogVisible = signal(false);
  readonly isInjectionDialogVisible = signal(false);
  readonly isInjectionLoading = signal(false);
  readonly isDraftDialogVisible = signal(false);
  readonly isDraftLoading = signal(false);
  readonly isIcuOrdersDialogVisible = signal(false);
  readonly isIcuSaving = signal(false);
  readonly isOrderModalVisible = signal(false);
  readonly isCRRTOrderModalVisible = signal(false);

  // Dialog data
  private onConfirmAction: (() => void) | null = null;
  readonly currentSlotId = signal<string | null>(null);
  readonly selectedPatientForDetail = signal<Record<string, unknown> | null>(null);
  readonly shiftForDetailModal = signal<string | null>(null);
  readonly patientIdForDialog = signal<string | null>(null);
  readonly patientNameForDialog = signal('');
  readonly currentWardNumber = signal('');
  readonly currentEditingShiftId = signal<string | null>(null);
  readonly shiftCodeForDialog = signal<string | null>(null);
  readonly patientIdsForDialog = signal<string[]>([]);
  readonly patientInfoMapForDialog = signal<Record<string, Record<string, string>>>({});
  readonly allDailyInjections = signal<Record<string, unknown>[]>([]);
  readonly injectionDialogDate = signal('');
  readonly filterSpecificInjections = signal(false);
  readonly dailyDrafts = signal<Record<string, unknown>[]>([]);
  readonly draftDialogDate = signal('');
  readonly patientsForDraftDialog = signal<Record<string, unknown>[]>([]);
  readonly sortedSlotsForModal = signal<Record<string, unknown>[]>([]);
  readonly currentPatientIndexForModal = signal(0);
  readonly editingPatientForOrder = signal<any>(null);
  readonly editingPatientForCRRT = signal<any>(null);
  readonly crrtOrderHistory = signal<Record<string, unknown>[]>([]);
  readonly noonTakeoffVisibility = signal({ early: false, late: false });

  readonly dailyPhysicians = signal<Record<string, unknown | null>>({ early: null, noon: null, late: null });
  readonly dailyConsultPhysicians = signal<Record<string, unknown | null>>({ morning: null, afternoon: null, night: null });

  // Computed properties
  readonly allPatients = this.patientStore.allPatients;
  readonly patientMap = this.patientStore.patientMap;

  readonly isPageLocked = computed(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentDay = new Date(this.currentDate());
    currentDay.setHours(0, 0, 0, 0);
    return currentDay < today;
  });

  readonly sortedBedNumbers = computed(() => {
    const numericBeds = ALL_BED_NUMBERS.filter((b): b is number => typeof b === 'number');
    return [...numericBeds].sort((a, b) => a - b);
  });

  readonly currentDateDisplay = computed(() => this.formatDate(this.currentDate()));
  readonly weekdayDisplay = computed(
    () => ['日', '一', '二', '三', '四', '五', '六'][this.currentDate().getDay()],
  );
  readonly dayOfWeek = computed(() => {
    const day = this.currentDate().getDay();
    return day === 0 ? 7 : day;
  });

  get scheduledPatientIds(): Set<string> {
    const ids = new Set<string>();
    if (this.currentRecord.schedule) {
      for (const [, slot] of Object.entries(this.currentRecord.schedule)) {
        if (slot?.patientId) ids.add(slot.patientId);
      }
    }
    return ids;
  }

  get statsToolbarData() {
    const counts: Record<string, Record<string, number>> = {};
    ORDERED_SHIFT_CODES.forEach((shiftCode: string) => {
      counts[shiftCode] = { total: 0, opd: 0, ipd: 0, er: 0 };
    });
    const dailyData = { counts, total: 0 };
    if (this.currentRecord.schedule) {
      for (const [shiftKey, slotData] of Object.entries(this.currentRecord.schedule)) {
        if (slotData?.patientId) {
          const patient = this.patientMap().get(slotData.patientId);
          if (!patient) continue;
          const shiftCode = shiftKey.split('-').pop()!;
          if (shiftCode && dailyData.counts[shiftCode]) {
            const shiftStats = dailyData.counts[shiftCode];
            shiftStats['total']++;
            dailyData.total++;
            const status = (patient as Record<string, unknown>)['status'] as string;
            if (status === 'opd') shiftStats['opd']++;
            else if (status === 'ipd') shiftStats['ipd']++;
            else if (status === 'er') shiftStats['er']++;
          }
        }
      }
    }
    return [dailyData];
  }

  readonly statsToolbarWeekdays = ['本日'];

  get todayInpatients() {
    const inpatientsMap = new Map<string, Record<string, unknown>>();
    if (this.currentRecord?.schedule) {
      for (const shiftId in this.currentRecord.schedule) {
        const slot = this.currentRecord.schedule[shiftId];
        if (slot?.patientId && !shiftId.startsWith('peripheral')) {
          const patientInfo = this.getArchivedOrLivePatientInfo(slot);
          const patientDetails = this.patientMap().get(slot.patientId);
          if (patientInfo && patientDetails) {
            const status = (patientInfo as Record<string, unknown>)['status'] as string;
            if (status === 'ipd' || status === 'er') {
              let shiftCode: string;
              let dialysisBed: string;
              if (shiftId.startsWith('peripheral-')) {
                const parts = shiftId.split('-');
                dialysisBed = `外圍${parts[1]}`;
                shiftCode = parts[2];
              } else {
                const parts = shiftId.split('-');
                dialysisBed = parts[1] || 'N/A';
                shiftCode = parts[2];
              }
              if (!inpatientsMap.has((patientDetails as Record<string, unknown>)['id'] as string)) {
                inpatientsMap.set((patientDetails as Record<string, unknown>)['id'] as string, {
                  id: `${(patientDetails as Record<string, unknown>)['id']}-${shiftId}`,
                  shiftId,
                  dialysisBed,
                  medicalRecordNumber: (patientDetails as Record<string, unknown>)['medicalRecordNumber'],
                  name: (patientDetails as Record<string, unknown>)['name'],
                  wardNumber: (patientInfo as Record<string, unknown>)['wardNumber'] || '未登錄',
                  shift: shiftCode,
                  transportMethod: slot.transportMethod,
                });
              }
            }
          }
        }
      }
    }
    const inpatients = Array.from(inpatientsMap.values());
    const shiftOrder: Record<string, number> = { early: 1, noon: 2, late: 3, unknown: 4 };
    inpatients.sort((a, b) => {
      const sa = shiftOrder[a['shift'] as string] || 4;
      const sb = shiftOrder[b['shift'] as string] || 4;
      if (sa !== sb) return sa - sb;
      const bedA = a['dialysisBed'] === '未排床' ? 1000 : parseInt(a['dialysisBed'] as string);
      const bedB = b['dialysisBed'] === '未排床' ? 1000 : parseInt(b['dialysisBed'] as string);
      return bedA - bedB;
    });
    return inpatients;
  }

  readonly filteredDailyInjections = computed(() => {
    if (!this.filterSpecificInjections()) return this.allDailyInjections();
    const specificMedCodes = ['ICAC', 'IFER2', 'IPAR1'];
    return this.allDailyInjections().filter((injection) =>
      specificMedCodes.includes(injection['orderCode'] as string),
    );
  });

  private previousDateStr = '';

  constructor() {
    this.usersApi = this.apiManagerService.create<FirestoreRecord>('users');
    this.ordersHistoryApi = this.apiManagerService.create<FirestoreRecord>('dialysis_orders_history');
    this.schedulesApi = this.apiManagerService.create<FirestoreRecord>('schedules');
    this.physicianSchedulesApi = this.apiManagerService.create<FirestoreRecord>('physician_schedules');

    // Watch currentDate changes
    effect(() => {
      const newDate = this.currentDate();
      const newDateStr = this.formatDate(newDate);
      if (this.previousDateStr && newDateStr !== this.previousDateStr) {
        this.medicationStore.clearCache();
        this.noonTakeoffVisibility.set({ early: false, late: false });
        this.loadDataForDay(newDate);
        this.loadDailyStaffInfo(newDate);
      }
      this.previousDateStr = newDateStr;
    });
  }

  // Lifecycle
  async ngOnInit(): Promise<void> {
    this.isLoading.set(true);
    // Restore shared date if available
    const sharedDate = this.dateState.selectedDate;
    if (sharedDate) {
      this.currentDate.set(new Date(sharedDate));
    }
    await this.auth.waitForAuthInit();
    if (this.auth.currentUser()) {
      this.taskStore.startRealtimeUpdates(this.auth.currentUser()!.uid);
    }
    await Promise.all([
      this.loadDataForDay(this.currentDate()),
      this.loadDailyStaffInfo(this.currentDate()),
    ]);
    this.isLoading.set(false);
  }

  ngOnDestroy(): void {
    // cleanup handled by service destroy
  }

  // ---------------------------------------------------------------------------
  // Public methods (used in template)
  // ---------------------------------------------------------------------------

  getShiftDisplayName(shiftCode: string): string {
    return getShiftDisplayName(shiftCode);
  }

  formatDate(date: Date): string {
    if (!date) return '';
    return formatDateToYYYYMMDD(date);
  }

  getPatientName(shiftId: string): string {
    const patientId = this.currentRecord.schedule[shiftId]?.patientId;
    const patient = this.patientMap().get(patientId || '');
    return ((patient as Record<string, unknown>)?.['name'] as string) || '';
  }

  getPatientMode(shiftId: string): string | null {
    const slotData = this.currentRecord.schedule[shiftId];
    if (!slotData?.patientId) return null;
    // 優先使用 slot 上的 modeOverride（來自臨時加洗不同模式）
    if (slotData.modeOverride && slotData.modeOverride !== 'HD') {
      return slotData.modeOverride as string;
    }
    const patient = this.patientMap().get(slotData.patientId);
    const mode = ((patient as Record<string, unknown>)?.['mode'] as string) || null;
    return mode && mode !== 'HD' ? mode : null;
  }

  getCombinedNote(shiftId: string): string {
    const slotData = this.currentRecord.schedule[shiftId];
    if (!slotData) return '';
    const autoTags = (slotData.autoNote || '').split(' ').filter(Boolean);
    const manualTags = (slotData.manualNote || '').split(' ').filter(Boolean);
    const combinedTags = [...new Set([...autoTags, ...manualTags])];
    const finalTags = combinedTags.filter((tag) => !['住', '急'].includes(tag));
    return finalTags.join(' ');
  }

  getPatientCellStyle(shiftId: string): Record<string, boolean> {
    const slotData = this.currentRecord.schedule[shiftId];
    const patientForStyle = this.getArchivedOrLivePatientInfo(slotData);
    if (!patientForStyle) return {};
    const patientId = slotData?.patientId;
    if (!patientId) return getUnifiedCellStyle(slotData, patientForStyle, null, []);
    const messageTypesForPatient =
      [...(this.taskStore.getPatientMessageTypesMapForDate(this.formatDate(this.currentDate())).get(patientId) || [])];
    return getUnifiedCellStyle(slotData, patientForStyle, null, messageTypesForPatient);
  }

  getMessageTypesForPatient(patientId: string): string[] {
    if (!patientId) return [];
    return this.taskStore.getPendingMessageTypesMap().get(patientId) || [];
  }

  // --- Message Icon Dialog ---
  selectedPatientForDialog = signal<{ id: string; name: string } | null>(null);

  handleIconClick(event: { patientId: string; context: string; type: string }): void {
    const { patientId, type } = event;
    const patient = this.patientMap().get(patientId);
    if (patient) {
      this.selectedPatientForDialog.set({ id: patientId, name: (patient as any).name });
      if (type === 'record') {
        this.isConditionRecordDialogVisible.set(true);
      } else {
        this.isMemoDialogVisible.set(true);
      }
    }
  }

  closeMemoDialog(): void {
    this.isMemoDialogVisible.set(false);
    this.selectedPatientForDialog.set(null);
  }

  closeConditionRecordDialog(): void {
    this.isConditionRecordDialogVisible.set(false);
    this.selectedPatientForDialog.set(null);
  }

  getPatientWardNumber(patientId: string | undefined): string {
    if (!patientId) return '';
    const patient = this.patientMap().get(patientId);
    return ((patient as Record<string, unknown>)?.['wardNumber'] as string) || '';
  }

  isInpatientOrER(shiftId: string): boolean {
    const slotData = this.currentRecord.schedule[shiftId];
    const patientInfo = this.getArchivedOrLivePatientInfo(slotData);
    const status = (patientInfo as Record<string, unknown>)?.['status'] as string;
    return status === 'ipd' || status === 'er';
  }

  getNurseTeam(shiftId: string, type: string): string {
    const slot = this.currentRecord.schedule[shiftId];
    if (!slot?.patientId) return '';
    const shiftCode = shiftId.split('-').pop()!;
    const key = `${slot.patientId}-${shiftCode}`;
    const teamData = this.currentTeamsRecord().teams[key];
    if (!teamData) return '';
    if (type === 'single') return teamData['nurseTeam'] || '';
    else if (type === 'in') return teamData['nurseTeamIn'] || '';
    else if (type === 'out') return teamData['nurseTeamOut'] || '';
    return '';
  }

  changeDate(days: number): void {
    const performChange = () => {
      const newDate = new Date(this.currentDate());
      newDate.setDate(newDate.getDate() + days);
      this.currentDate.set(newDate);
      this.dateState.setDate(newDate.toISOString());
    };
    if ((this.hasUnsavedChanges() || this.hasUnsavedTeamChanges()) && !this.isPageLocked()) {
      this.showConfirm('注意', '您有未儲存的變更，確定要切換日期嗎？', performChange);
    } else {
      performChange();
    }
  }

  goToToday(): void {
    const performChange = () => {
      const today = new Date();
      this.currentDate.set(today);
      this.dateState.setDate(today.toISOString());
    };
    if ((this.hasUnsavedChanges() || this.hasUnsavedTeamChanges()) && !this.isPageLocked()) {
      this.showConfirm('注意', '您有未儲存的變更，確定要切換到今天嗎？', performChange);
    } else {
      performChange();
    }
  }

  handleSlotClick(shiftId: string): void {
    const slotData = this.currentRecord.schedule[shiftId];
    if (this.isPageLocked()) return;
    if (!slotData?.patientId) {
      this.currentSlotId.set(shiftId);
      this.isPatientSelectDialogVisible.set(true);
      return;
    }
    const patient = this.patientMap().get(slotData.patientId);
    const name = (patient as Record<string, unknown>)?.['name'] as string || '未知';
    this.showConfirm(`確認移除`, `確定要將「${name}」從此班次中移除嗎？`, () => {
      this.handleSlotUpdate(shiftId, null);
    });
  }

  handleSimplifiedCellClick(shiftId: string): void {
    const patientId = this.currentRecord.schedule[shiftId]?.patientId;
    if (patientId) {
      this.openDetailModalForPatient(patientId);
    }
  }

  async saveDataToCloud(): Promise<void> {
    if (this.isPageLocked()) {
      this.showAlert('操作失敗', '操作被鎖定：權限不足或日期已過。');
      return;
    }
    this.statusIndicator.set('儲存中...');
    try {
      const promises: Promise<unknown>[] = [];
      if (this.hasUnsavedChanges()) {
        const dataToSave = {
          date: this.currentRecord.date,
          schedule: this.currentRecord.schedule || {},
          names: this.currentRecord.names || {},
        };
        if (this.currentRecord.id) {
          promises.push(optimizedUpdateSchedule(this.currentRecord.id, dataToSave));
        } else if (Object.keys(dataToSave.schedule).length > 0) {
          promises.push(
            optimizedSaveSchedule(dataToSave).then((savedRecord: { id: string }) => {
              this.currentRecord.id = savedRecord.id;
            }),
          );
        }
      }
      const teamsRec = this.currentTeamsRecord();
      if (this.hasUnsavedTeamChanges() && Object.keys(teamsRec.teams).length > 0) {
        const teamsToSave = { date: teamsRec.date, teams: teamsRec.teams };
        if (teamsRec.id) {
          promises.push(updateTeams(teamsRec.id, teamsToSave));
        } else {
          promises.push(
            saveTeams(teamsToSave).then((savedRecord: { id: string }) => {
              this.currentTeamsRecord.update((r) => ({ ...r, id: savedRecord.id }));
            }),
          );
        }
      }
      await Promise.all(promises);
      this.hasUnsavedChanges.set(false);
      this.hasUnsavedTeamChanges.set(false);
      this.statusIndicator.set('儲存成功！');
      this.showAlert('操作成功', '排程已成功儲存！');
    } catch (error: unknown) {
      console.error('儲存失敗:', error);
      this.statusIndicator.set('儲存失敗');
      const msg = error instanceof Error ? error.message : '未知錯誤';
      this.showAlert('操作失敗', `儲存失敗: ${msg}`);
    }
  }

  runScheduleCheck(): void {
    const warnings: string[] = [];
    const statusMap: Record<string, string> = { opd: '門診', ipd: '住院', er: '急診' };
    const today = this.dayOfWeek();
    // Build scheduled IDs directly (not from computed signal, since currentRecord is not a signal)
    const scheduledIds = new Set<string>();
    if (this.currentRecord.schedule) {
      for (const [, slot] of Object.entries(this.currentRecord.schedule)) {
        if (slot?.patientId) scheduledIds.add(slot.patientId);
      }
    }

    // 1. 重複排班 — same patient appears more than once today
    const duplicateNames = new Set<string>();
    const tempScheduled: Record<string, boolean> = {};
    Object.values(this.currentRecord.schedule).forEach((slot) => {
      if (slot?.patientId) {
        if (tempScheduled[slot.patientId]) {
          const patient = this.patientMap().get(slot.patientId);
          const name = (patient as Record<string, unknown>)?.['name'] as string;
          if (name) duplicateNames.add(name);
        }
        tempScheduled[slot.patientId] = true;
      }
    });
    if (duplicateNames.size > 0) {
      warnings.push(`【重複排班】:\n- ${Array.from(duplicateNames).join('\n- ')}`);
    }

    // 2. 頻率不符 — scheduled patients whose freq does NOT include today
    const freqMismatch: string[] = [];
    for (const [, slot] of Object.entries(this.currentRecord.schedule)) {
      if (!slot?.patientId) continue;
      const patient = this.patientMap().get(slot.patientId) as Record<string, unknown> | undefined;
      if (!patient || patient['isDeleted'] || patient['status'] !== 'opd') continue;
      const freq = patient['freq'] as string;
      if (!freq) continue;
      const expectedDays = this.freqToDays[freq];
      if (expectedDays && !expectedDays.includes(today)) {
        freqMismatch.push(`${patient['name']} (頻率: ${freq})`);
      }
    }
    if (freqMismatch.length > 0) {
      warnings.push(`【頻率不符】(排入但非當日頻率):\n- ${freqMismatch.join('\n- ')}`);
    }

    // 3. 重要未排 — IPD/ER patients whose freq includes today but not scheduled
    const unassignedCritical = this.allPatients()
      .filter((p: any) => {
        if (p.isDeleted || p.isDiscontinued || scheduledIds.has(p.id)) return false;
        if (p.status !== 'ipd' && p.status !== 'er') return false;
        if (!p.freq) return false;
        const days = this.freqToDays[p.freq as string];
        return days ? days.includes(today) : false;
      });
    if (unassignedCritical.length > 0) {
      const names = unassignedCritical
        .map((p: any) => `${p.name} (${statusMap[p.status] || p.status}, ${p.freq})`)
        .join('\n- ');
      warnings.push(`【重要病人未排班】(住院/急診):\n- ${names}`);
    }

    // 4. 當日應排但未排 — patients whose freq includes today but not scheduled (OPD only, excluding already listed IPD/ER)
    const unassignedToday = this.allPatients()
      .filter((p: any) => {
        if (p.isDeleted || p.isDiscontinued || scheduledIds.has(p.id)) return false;
        if (p.status === 'ipd' || p.status === 'er') return false; // already in category 3
        if (!p.freq) return false;
        const days = this.freqToDays[p.freq as string];
        return days ? days.includes(today) : false;
      });
    if (unassignedToday.length > 0) {
      const names = unassignedToday
        .map((p: any) => `${p.name} (${p.freq})`)
        .join('\n- ');
      warnings.push(`【當日應排但未排】(門診):\n- ${names}`);
    }

    if (warnings.length > 0) {
      this.showAlert('排班檢查結果', warnings.join('\n\n'));
    } else {
      this.showAlert('排班檢視完畢', '未發現明顯的排班或遺漏問題。');
    }
  }

  updateNurseTeam(event: Event, shiftId: string, type: string): void {
    const target = event.target as HTMLSelectElement;
    if (this.isPageLocked()) {
      target.value = this.getNurseTeam(shiftId, type);
      return;
    }
    const slot = this.currentRecord.schedule[shiftId];
    if (!slot?.patientId) {
      target.value = '';
      return;
    }
    const value = target.value;
    const shiftCode = shiftId.split('-').pop()!;
    const key = `${slot.patientId}-${shiftCode}`;
    const teamsRec = { ...this.currentTeamsRecord() };
    if (!teamsRec.teams[key]) {
      teamsRec.teams[key] = {};
    }
    const teamData = teamsRec.teams[key];
    const isPeripheralNoon = shiftId.startsWith('peripheral') && shiftId.endsWith(SHIFT_CODES.NOON);
    if (type === 'single' && isPeripheralNoon) {
      teamData['nurseTeamIn'] = value || null;
      teamData['nurseTeamOut'] = value || null;
      teamData['nurseTeam'] = null;
    } else if (type === 'single') {
      teamData['nurseTeam'] = value || null;
    } else if (type === 'in') {
      teamData['nurseTeamIn'] = value || null;
    } else if (type === 'out') {
      teamData['nurseTeamOut'] = value || null;
    }
    if (!teamData['nurseTeam'] && !teamData['nurseTeamIn'] && !teamData['nurseTeamOut']) {
      delete teamsRec.teams[key];
    }
    this.currentTeamsRecord.set(teamsRec);
    this.setTeamChange();
  }

  updateNote(event: Event, shiftId: string): void {
    const target = event.target as HTMLElement;
    if (this.isPageLocked()) {
      target.textContent = this.getCombinedNote(shiftId);
      return;
    }
    if (!this.currentRecord.schedule[shiftId]) {
      this.currentRecord.schedule[shiftId] = createEmptySlotData(shiftId);
    }
    this.currentRecord.schedule[shiftId].manualNote = (target.textContent || '').trim();
    this.setChange();
  }

  async copyMedicalRecordNumber(mrn: string | undefined): Promise<void> {
    if (!mrn) return;
    try {
      await navigator.clipboard.writeText(mrn);
    } catch (err) {
      console.error('複製失敗:', err);
      this.showAlert('複製失敗', '無法將病歷號複製到剪貼簿，您的瀏覽器可能不支援或未授予權限。');
    }
  }

  promptWardNumber(shiftId: string): void {
    if (this.isPageLocked()) return;
    const slot = this.currentRecord.schedule[shiftId];
    if (!slot?.patientId) return;
    const patient = this.patientMap().get(slot.patientId);
    const patientInfo = this.getArchivedOrLivePatientInfo(slot);
    const status = (patientInfo as Record<string, unknown>)?.['status'] as string;
    if (!patient || !patientInfo || (status !== 'ipd' && status !== 'er')) {
      this.showAlert('提示', '只有住院或急診病人才能設定床號');
      return;
    }
    this.currentEditingShiftId.set(shiftId);
    this.currentWardNumber.set(((patient as Record<string, unknown>)['wardNumber'] as string) || '');
    this.isWardDialogVisible.set(true);
  }

  async handleWardNumberConfirm(value: string): Promise<void> {
    if (!this.currentEditingShiftId()) return;
    const slot = this.currentRecord.schedule[this.currentEditingShiftId()!];
    if (!slot?.patientId) return;
    try {
      await optimizedUpdatePatient(slot.patientId, { wardNumber: value });
      await this.patientStore.forceRefreshPatients();
      this.showAlert('操作成功', '床號已更新');
    } catch (error: unknown) {
      console.error('更新床號失敗:', error);
      this.showAlert('操作失敗', '更新床號失敗');
    }
    this.isWardDialogVisible.set(false);
    this.currentEditingShiftId.set(null);
    this.currentWardNumber.set('');
  }

  handleInpatientRoundsSave(patients: any[]): void {
    // Update transport methods in schedule slots
    for (const patient of patients) {
      if (patient.shiftId && this.currentRecord.schedule[patient.shiftId]) {
        this.currentRecord.schedule[patient.shiftId].transportMethod = patient.transportMethod;
      }
    }
    this.hasUnsavedChanges.set(true);
    this.statusIndicator.set('住院趴趴走已更新，請儲存');
  }

  async handleIcuOrdersSaveAndPrint(data: { localNotes: Record<string, string>; crrtEmergencyData: Record<string, any> }): Promise<void> {
    try {
      const updates: Promise<void>[] = [];
      // Save ICU notes to patients
      for (const [patientId, note] of Object.entries(data.localNotes)) {
        updates.push(optimizedUpdatePatient(patientId, { icuNote: note }));
      }
      // Save CRRT emergency data
      for (const [patientId, emergency] of Object.entries(data.crrtEmergencyData)) {
        updates.push(optimizedUpdatePatient(patientId, {
          crrtEmergencyWithdraw: emergency.withdraw,
          crrtEmergencyNote: emergency.note,
        }));
      }
      await Promise.all(updates);
      await this.patientStore.forceRefreshPatients();
    } catch (error) {
      console.error('ICU資料儲存失敗:', error);
      this.showAlert('操作失敗', 'ICU資料儲存失敗');
    }
  }

  handleIcuDateChange(dateString: string): void {
    const newDate = new Date(dateString + 'T00:00:00');
    if (!isNaN(newDate.getTime())) {
      this.currentDate.set(newDate);
    }
  }

  async handleIcuOrdersSave(payload: { localNotes: Record<string, string>; crrtEmergencyData: Record<string, any> }): Promise<void> {
    if (this.isPageLocked()) {
      this.showAlert('操作失敗', '無法修改ICU醫囑單資料，請確認權限或日期。');
      return;
    }
    this.isIcuSaving.set(true);
    const { localNotes: notes, crrtEmergencyData: crrtEmergency } = payload;
    const updatePromises: Promise<void>[] = [];

    // Save notes to each patient's dialysisOrders.memo
    for (const patientId in notes) {
      const note = notes[patientId];
      const patient = this.patientMap().get(patientId);
      if (patient) {
        const newDialysisOrders = { ...(patient.dialysisOrders || {}) };
        newDialysisOrders.memo = note;
        updatePromises.push(optimizedUpdatePatient(patientId, { dialysisOrders: newDialysisOrders }));
      }
    }

    // Save CRRT emergency data
    for (const patientId in crrtEmergency) {
      const { withdraw, note } = crrtEmergency[patientId];
      updatePromises.push(
        optimizedUpdatePatient(patientId, {
          emergencyWithdraw: withdraw,
          emergencyWithdrawNote: note || '',
        }),
      );
    }

    try {
      if (updatePromises.length > 0) {
        await Promise.all(updatePromises);
        await this.patientStore.forceRefreshPatients();
      }
      this.showAlert('儲存成功', '醫囑單資料已儲存');
    } catch (error: any) {
      console.error('儲存 ICU 醫囑單資料發生錯誤：', error);
      this.showAlert('儲存失敗', `儲存 ICU 醫囑單資料發生錯誤: ${error.message}`);
    } finally {
      this.isIcuSaving.set(false);
    }
  }

  openOrderModalFromIcu(patient: any): void {
    if (patient && patient.id) {
      this.editingPatientForOrder.set(JSON.parse(JSON.stringify(patient)));
      this.isOrderModalVisible.set(true);
    }
  }

  openCrrtOrderModalFromIcu(patient: any): void {
    if (patient && patient.id) {
      this.editingPatientForCRRT.set(JSON.parse(JSON.stringify(patient)));
      this.isCRRTOrderModalVisible.set(true);
    }
  }

  async handleSaveOrder(orderData: any): Promise<void> {
    if (this.isPageLocked()) {
      this.showAlert('操作失敗', '過去的排程無法修改。');
      return;
    }
    const patient = this.editingPatientForOrder();
    if (!patient?.id) {
      this.showAlert('儲存失敗', '找不到目標病人資訊。');
      return;
    }
    try {
      await createDialysisOrderAndUpdatePatient(patient.id, patient.name, orderData);
      await this.patientStore.forceRefreshPatients();
      await this.loadDataForDay(this.currentDate());
      this.isOrderModalVisible.set(false);
      this.showAlert('儲存成功', `已更新病人 ${patient.name} 的醫囑。`);
    } catch (error: any) {
      console.error('儲存醫囑失敗:', error);
      this.showAlert('儲存失敗', `儲存醫囑發生錯誤: ${error.message}`);
    }
  }

  async handleSaveCrrtOrder(orderData: any): Promise<void> {
    const patient = this.editingPatientForCRRT();
    if (!patient?.id) {
      this.showAlert('儲存失敗', '找不到目標病人資訊。');
      return;
    }
    try {
      await optimizedUpdatePatient(patient.id, { crrtOrders: orderData });
      await this.patientStore.forceRefreshPatients();
      this.isCRRTOrderModalVisible.set(false);
      this.showAlert('儲存成功', `已更新病人 ${patient.name} 的CRRT醫囑。`);
    } catch (error: any) {
      console.error('儲存 CRRT 醫囑失敗:', error);
      this.showAlert('儲存失敗', `儲存 CRRT 醫囑發生錯誤: ${error.message}`);
    }
  }

  exportScheduleToExcel(): void {
    if (this.isLoading()) {
      this.showAlert('提示', '資料正在載入中，請稍後再試。');
      return;
    }
    const data: unknown[][] = [];
    const stats = this.statsToolbarData[0];
    const statsString = `總計: ${stats.total}人 (早: ${stats.counts['early']?.['total']}, 午: ${stats.counts['noon']?.['total']}, 晚: ${stats.counts['late']?.['total']})`;
    data.push(['部立台北醫院 每日排程表']);
    data.push(['日期:', this.currentDateDisplay()]);
    data.push(['人數統計:', statsString]);
    data.push([]);
    const headers = ['床號', getShiftDisplayName('early'), getShiftDisplayName('noon'), getShiftDisplayName('late')];
    data.push(headers);
    const allBedsToExport: (string | number)[] = [...this.sortedBedNumbers()];
    for (let i = 1; i <= PERIPHERAL_BED_COUNT; i++) {
      allBedsToExport.push(`外圍 ${i}`);
    }
    allBedsToExport.forEach((bedKey) => {
      const row: unknown[] = [bedKey];
      ORDERED_SHIFT_CODES.forEach((shiftCode: string) => {
        const bedNum = String(bedKey).replace('外圍 ', '');
        const shiftId = String(bedKey).startsWith('外圍')
          ? `peripheral-${bedNum}-${shiftCode}`
          : `bed-${bedNum}-${shiftCode}`;
        const slot = this.currentRecord.schedule[shiftId];
        if (slot?.patientId) {
          const patient = this.patientMap().get(slot.patientId) as Record<string, unknown>;
          const statusMap: Record<string, string> = { opd: '門診', ipd: '住院', er: '急診' };
          const cellText = `${patient?.['name'] || '未知'} (${patient?.['medicalRecordNumber'] || 'N/A'})\n[${statusMap[patient?.['status'] as string] || '未知'}]\n${this.getCombinedNote(shiftId)}`;
          row.push(cellText);
        } else {
          row.push('');
        }
      });
      data.push(row);
    });
    const worksheet = XLSX.utils.aoa_to_sheet(data);
    worksheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
      { s: { r: 1, c: 1 }, e: { r: 1, c: 3 } },
      { s: { r: 2, c: 1 }, e: { r: 2, c: 3 } },
    ];
    worksheet['!cols'] = [{ wch: 10 }, { wch: 30 }, { wch: 30 }, { wch: 30 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '每日排程');
    XLSX.writeFile(workbook, `每日排程表_${this.formatDate(this.currentDate())}.xlsx`);
  }

  async showShiftInjections(shiftCode: string): Promise<void> {
    if (!shiftCode) return;

    // Build patientId → {shift, bedNum} map from schedule
    const patientInfoMap = new Map<string, { shift: string; bedNum: string }>();
    const patientIds: string[] = [];
    for (const [shiftId, slot] of Object.entries(this.currentRecord.schedule)) {
      if (slot?.patientId && shiftId.endsWith(`-${shiftCode}`)) {
        patientIds.push(slot.patientId);
        const parts = shiftId.split('-');
        const bedNum = parts[0] === 'peripheral'
          ? `外${parts[1]}`
          : parts[1];
        patientInfoMap.set(slot.patientId, { shift: shiftCode, bedNum });
      }
    }

    this.injectionDialogDate.set(this.formatDate(this.currentDate()));
    this.isInjectionDialogVisible.set(true);
    this.isInjectionLoading.set(true);
    this.allDailyInjections.set([]);
    this.filterSpecificInjections.set(false);
    try {
      const injectionsForShift = await this.medicationStore.fetchDailyInjections(
        this.injectionDialogDate(),
        patientIds,
      );
      // Enrich with shift/bed info from schedule
      const enriched = injectionsForShift.map((inj: any) => {
        const info = patientInfoMap.get(inj.patientId);
        return {
          ...inj,
          shift: info?.shift || shiftCode,
          bedNum: info?.bedNum || '',
        };
      });
      // Sort by bed number
      enriched.sort((a: any, b: any) => {
        const bedA = String(a.bedNum).startsWith('外') ? 1000 + parseInt(String(a.bedNum).substring(1)) : parseInt(a.bedNum) || 999;
        const bedB = String(b.bedNum).startsWith('外') ? 1000 + parseInt(String(b.bedNum).substring(1)) : parseInt(b.bedNum) || 999;
        if (bedA !== bedB) return bedA - bedB;
        return (a.patientName || '').localeCompare(b.patientName || '');
      });
      this.allDailyInjections.set(enriched);
    } catch (error: unknown) {
      console.error('[ScheduleView] 獲取應打針劑失敗:', error);
      const msg = error instanceof Error ? error.message : '未知錯誤';
      this.showAlert('查詢失敗', `獲取應打針劑清單時發生錯誤: ${msg}`);
      this.isInjectionDialogVisible.set(false);
    } finally {
      this.isInjectionLoading.set(this.medicationStore.isLoading());
    }
  }

  async showShiftMedicationDrafts(shiftCode: string): Promise<void> {
    if (!shiftCode) return;
    const patientsInShift = Object.entries(this.currentRecord.schedule)
      .filter(([shiftId, slot]) => slot?.patientId && shiftId.endsWith(`-${shiftCode}`))
      .map(([shiftId, slot]) => {
        const patientData = this.patientMap().get(slot.patientId!) as Record<string, unknown>;
        if (!patientData) return null;
        const bedNum = shiftId.startsWith('peripheral') ? `外${shiftId.split('-')[1]}` : shiftId.split('-')[1];
        const shift = shiftId.split('-')[2];
        return { ...patientData, bedNum, shift };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => {
        const bedA = String(a.bedNum).startsWith('外') ? 1000 + parseInt(String(a.bedNum).substring(1)) : parseInt(a.bedNum);
        const bedB = String(b.bedNum).startsWith('外') ? 1000 + parseInt(String(b.bedNum).substring(1)) : parseInt(b.bedNum);
        return bedA - bedB;
      });
    this.patientsForDraftDialog.set(patientsInShift as Record<string, unknown>[]);
    const patientIds = patientsInShift.map((p: any) => p['id'] as string);
    this.draftDialogDate.set(this.formatDate(this.currentDate()));
    this.isDraftDialogVisible.set(true);
    this.isDraftLoading.set(true);
    this.dailyDrafts.set([]);
    if (patientIds.length === 0) {
      this.isDraftLoading.set(false);
      return;
    }
    try {
      const getDailyMedicationDrafts = httpsCallable(this.firebaseService.functions, 'getDailyMedicationDrafts');
      const CHUNK_SIZE = 30;
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < patientIds.length; i += CHUNK_SIZE) {
        const chunk = patientIds.slice(i, i + CHUNK_SIZE);
        const payload = { targetDate: this.draftDialogDate(), patientIds: chunk };
        promises.push(getDailyMedicationDrafts(payload));
      }
      const results = await Promise.all(promises);
      let combinedDrafts: Record<string, unknown>[] = [];
      for (const result of results) {
        const data = (result as { data: { success: boolean; drafts: Record<string, unknown>[] } }).data;
        if (data?.success) {
          combinedDrafts = combinedDrafts.concat(data.drafts);
        }
      }
      this.dailyDrafts.set(combinedDrafts);
    } catch (error: unknown) {
      console.error(`獲取 ${shiftCode} 班藥囑草稿失敗:`, error);
      const msg = error instanceof Error ? error.message : '獲取藥囑草稿時發生未知錯誤';
      this.showAlert('查詢失敗', `獲取藥囑草稿清單時發生錯誤: ${msg}`);
      this.isDraftDialogVisible.set(false);
    } finally {
      this.isDraftLoading.set(false);
    }
  }

  showShiftRecordsSummary(shiftCode: string): void {
    const patientIds = new Set<string>();
    const patientInfoMap: Record<string, Record<string, string>> = {};
    for (const shiftId in this.currentRecord.schedule) {
      if (shiftId.endsWith(`-${shiftCode}`)) {
        const slot = this.currentRecord.schedule[shiftId];
        if (slot?.patientId) {
          patientIds.add(slot.patientId);
          const parts = shiftId.split('-');
          const bedNum = parts[0] === 'peripheral' ? `外${parts[1]}` : parts[1];
          const patient = this.patientMap().get(slot.patientId) as Record<string, unknown>;
          patientInfoMap[slot.patientId] = {
            bedNum,
            medicalRecordNumber: (patient?.['medicalRecordNumber'] as string) || '',
          };
        }
      }
    }
    this.shiftCodeForDialog.set(shiftCode);
    this.patientIdsForDialog.set(Array.from(patientIds));
    this.patientInfoMapForDialog.set(patientInfoMap);
    this.isRecordsSummaryDialogVisible.set(true);
  }

  closeRecordsSummaryDialog(): void {
    this.isRecordsSummaryDialogVisible.set(false);
    this.shiftCodeForDialog.set(null);
    this.patientIdsForDialog.set([]);
    this.patientInfoMapForDialog.set({});
  }

  async autoAssignNurseTeams(): Promise<void> {
    if (this.isPageLocked()) {
      this.showAlert('操作失敗', '頁面已鎖定，無法執行自動分組。');
      return;
    }
    // Load latest config before executing
    await this.autoAssignConfig.fetchConfig();
    this.showConfirm('確認操作', '此操作將會覆蓋現有的護理師分組，您確定要繼續嗎？', () => {
      this.executeAutoAssignment();
    });
  }


  handleConfirm(): void {
    if (typeof this.onConfirmAction === 'function') this.onConfirmAction();
    this.isConfirmDialogVisible.set(false);
    this.onConfirmAction = null;
  }

  handleCancel(): void {
    this.isConfirmDialogVisible.set(false);
    this.onConfirmAction = null;
  }

  // Drag and drop
  onDrop(event: DragEvent, targetShiftId: string): void {
    if (this.isPageLocked()) return;
    event.preventDefault();
    document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    const sourceShiftId = event.dataTransfer?.getData('sourceShiftId') || '';
    const jsonData = event.dataTransfer?.getData('application/json');
    if (!jsonData) return;
    const droppedSlotData = JSON.parse(jsonData);
    if (!droppedSlotData?.patientId) return;
    const patient = this.patientMap().get(droppedSlotData.patientId) as Record<string, unknown>;
    if (!patient) return;
    const targetSlotData = this.currentRecord.schedule[targetShiftId];
    if (sourceShiftId === 'sidebar' && this.scheduledPatientIds.has(patient['id'] as string)) {
      this.showConfirm('重複排班警告', `病人 ${patient['name']} 在本日已有排班，您確定要重複排班嗎？`, () => {
        if (targetSlotData?.patientId) {
          this.showAlert('操作失敗', '目標床位已被佔用，無法放置！');
          return;
        }
        this.handleSlotUpdate(targetShiftId, droppedSlotData.patientId, droppedSlotData);
      });
      return;
    }
    if (targetSlotData?.patientId) {
      if (sourceShiftId === 'sidebar') {
        this.showAlert('操作失敗', '目標床位已被佔用，無法從側邊欄拖曳至此。');
        return;
      }
      this.handleSlotUpdate(targetShiftId, droppedSlotData.patientId, droppedSlotData);
      this.handleSlotUpdate(sourceShiftId, targetSlotData.patientId, targetSlotData);
    } else {
      this.handleSlotUpdate(targetShiftId, droppedSlotData.patientId, droppedSlotData);
      if (sourceShiftId && sourceShiftId !== 'sidebar') {
        this.handleSlotUpdate(sourceShiftId, null);
      }
    }
  }

  onBedDragStart(event: DragEvent, sourceShiftId: string): void {
    if (this.isPageLocked()) {
      event.preventDefault();
      return;
    }
    const slotData = this.currentRecord.schedule[sourceShiftId];
    if (!slotData?.patientId) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData('sourceShiftId', sourceShiftId);
    event.dataTransfer?.setData('application/json', JSON.stringify(slotData));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  onDragOver(event: DragEvent): void {
    if (this.isPageLocked()) return;
    event.preventDefault();
    const targetCell = (event.target as HTMLElement).closest('.patient-name, .peripheral-patient-name');
    if (targetCell) targetCell.classList.add('drag-over');
  }

  onDragLeave(event: DragEvent): void {
    (event.target as HTMLElement).closest('.patient-name, .peripheral-patient-name')?.classList.remove('drag-over');
  }

  handlePatientSelect(data: { patientId: string }): void {
    if (!data.patientId || !this.currentSlotId()) return;
    this.isPatientSelectDialogVisible.set(false);
    if (this.scheduledPatientIds.has(data.patientId)) {
      const patient = this.patientMap().get(data.patientId) as Record<string, unknown>;
      this.showAlert('重複排班警告', `病人 ${patient?.['name']} 在本日已有排班，無法重複排入。`);
      this.currentSlotId.set(null);
      return;
    }
    this.handleSlotUpdate(this.currentSlotId()!, data.patientId);
    this.currentSlotId.set(null);
  }

  handleAssignBed(data: { patientId: string; shiftId: string }): void {
    if (!data.patientId || !data.shiftId || this.isPageLocked()) return;
    if (this.scheduledPatientIds.has(data.patientId)) {
      const patient = this.patientMap().get(data.patientId) as Record<string, unknown>;
      this.showConfirm('重複排班警告', `病人 ${patient?.['name']} 在本日已有排班，您確定要重複排班嗎？`, () => {
        if (this.currentRecord.schedule[data.shiftId]?.patientId) {
          this.showAlert('錯誤', '目標床位已被佔用！');
          return;
        }
        this.handleSlotUpdate(data.shiftId, data.patientId);
      });
      return;
    }
    this.handleSlotUpdate(data.shiftId, data.patientId);
  }

  // Sidebar drag start
  onSidebarDragStart(event: DragEvent, patient: any): void {
    if (this.isPageLocked()) return;
    const slotData = { patientId: patient.id };
    event.dataTransfer?.setData('sourceShiftId', 'sidebar');
    event.dataTransfer?.setData('application/json', JSON.stringify(slotData));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private getArchivedOrLivePatientInfo(slotData: ScheduleSlotData | undefined): Record<string, unknown> | null {
    if (!slotData?.patientId) return null;
    if (slotData.archivedPatientInfo) return slotData.archivedPatientInfo;
    return (this.patientMap().get(slotData.patientId) as Record<string, unknown>) || null;
  }

  private showAlert(title: string, message: string): void {
    this.alertDialogTitle.set(title);
    this.alertDialogMessage.set(message);
    this.isAlertDialogVisible.set(true);
  }

  private showConfirm(title: string, message: string, onConfirm: () => void): void {
    this.confirmDialogMessage.set(message);
    this.onConfirmAction = onConfirm;
    this.isConfirmDialogVisible.set(true);
  }

  private setChange(): void {
    if (this.isPageLocked()) return;
    this.hasUnsavedChanges.set(true);
    this.statusIndicator.set('有未儲存的變更');
  }

  private setTeamChange(): void {
    if (this.isPageLocked()) return;
    this.hasUnsavedTeamChanges.set(true);
    this.hasUnsavedChanges.set(true);
    this.statusIndicator.set('有未儲存的變更');
  }

  private handleSlotUpdate(shiftId: string, patientId: string | null, fullSlotData?: ScheduleSlotData): void {
    if (this.isPageLocked()) return;
    if (patientId) {
      const patient = this.patientMap().get(patientId) as Record<string, unknown>;
      if (!patient) return;
      const correctShiftCode = shiftId.split('-').pop()!;
      let newSlotData: ScheduleSlotData;
      if (fullSlotData) {
        newSlotData = { ...fullSlotData, patientId };
      } else {
        newSlotData = { patientId, manualNote: patient['status'] === 'ipd' ? '住' : '' };
      }
      newSlotData.autoNote = generateAutoNote(patient);
      newSlotData.shiftId = correctShiftCode;
      this.currentRecord.schedule[shiftId] = newSlotData;
    } else {
      delete this.currentRecord.schedule[shiftId];
    }
    this.setChange();
  }

  private openDetailModalForPatient(patientId: string): void {
    const patient = this.patientMap().get(patientId) as Record<string, unknown>;
    if (!patient) return;

    const slotList = Object.entries(this.currentRecord.schedule)
      .filter(([, slot]) => slot?.patientId)
      .map(([shiftId, slot]) => {
        const p = this.patientMap().get(slot.patientId) as Record<string, unknown>;
        if (!p) return null;
        const parts = shiftId.split('-');
        const bedNum = parts[0] === 'peripheral' ? `外${parts[1]}` : parts[1];
        return { ...p, shiftId, bedNum };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => {
        const getKey = (sid: string) => {
          const parts = sid.split('-');
          if (parts[0] === 'peripheral') return 1000 + parseInt(parts[1], 10);
          return parseInt(parts[1], 10) || 999;
        };
        return getKey(a.shiftId) - getKey(b.shiftId);
      });

    const idx = slotList.findIndex((s: any) => s['id'] === patientId);
    this.sortedSlotsForModal.set(slotList as any);
    this.currentPatientIndexForModal.set(idx >= 0 ? idx : 0);
    this.selectedPatientForDetail.set(patient);
    this.isDetailModalVisible.set(true);
  }

  switchPatient(newIndex: number): void {
    const slots = this.sortedSlotsForModal();
    if (newIndex >= 0 && newIndex < slots.length) {
      this.currentPatientIndexForModal.set(newIndex);
      this.selectedPatientForDetail.set(slots[newIndex]);
    }
  }

  private async loadDataForDay(date: Date): Promise<void> {
    this.hasUnsavedChanges.set(false);
    this.hasUnsavedTeamChanges.set(false);
    this.statusIndicator.set('讀取中...');
    this.isLoading.set(true);
    const dateStr = this.formatDate(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    try {
      const isPastDate = targetDate < today;
      // ✅ 優化：病人、排程、護理分組三者完全並行載入
      const [, scheduleRecord, teamsData] = await Promise.all([
        isPastDate ? Promise.resolve() : this.patientStore.fetchPatientsIfNeeded(),
        isPastDate
          ? this.archiveStore.fetchScheduleByDate(dateStr)
          : this.fetchLiveSchedule(dateStr),
        fetchTeamsByDate(dateStr),
      ]);
      this.currentRecord.id = ((scheduleRecord as Record<string, unknown>)?.['id'] as string) || null;
      this.currentRecord.date = dateStr;
      this.currentRecord.schedule = ((scheduleRecord as Record<string, unknown>)?.['schedule'] as Record<string, ScheduleSlotData>) || {};
      this.currentRecord.names = ((scheduleRecord as Record<string, unknown>)?.['names'] as Record<string, string>) || {};
      this.currentTeamsRecord.set(teamsData || { id: null, date: dateStr, teams: {} });
      this.statusIndicator.set(((scheduleRecord as Record<string, unknown>)?.['id']) ? '資料已載入' : '本日無排程資料');
    } catch (error: unknown) {
      console.error(`載入 ${dateStr} 資料失敗:`, error);
      this.statusIndicator.set('讀取失敗');
    } finally {
      this.isLoading.set(false);
    }
  }

  private async fetchLiveSchedule(dateStr: string): Promise<Record<string, unknown>> {
    // ✅ 優化：使用快取的 schedulesApi 實例
    const dailyRecords = await this.schedulesApi.fetchAll([where('date', '==', dateStr)]);
    if (dailyRecords.length === 0) return { date: dateStr, schedule: {} };
    const record = dailyRecords[0] as Record<string, unknown>;
    const finalSchedule: Record<string, unknown> = {};
    const schedule = record['schedule'] as Record<string, Record<string, unknown>>;
    if (schedule) {
      for (const shiftId in schedule) {
        const dbSlotData = schedule[shiftId];
        if (dbSlotData?.['patientId'] && this.patientMap().has(dbSlotData['patientId'] as string)) {
          const patient = this.patientMap().get(dbSlotData['patientId'] as string) as Record<string, unknown>;
          const mergedSlot = { ...createEmptySlotData(shiftId), ...dbSlotData };
          if (patient) mergedSlot['autoNote'] = generateAutoNote(patient);
          finalSchedule[shiftId] = mergedSlot;
        }
      }
    }
    record['schedule'] = finalSchedule;
    return record;
  }

  private async loadDailyStaffInfo(date: Date): Promise<void> {
    try {
      const dateStr = this.formatDate(date).substring(0, 7);
      // ✅ 優化：使用者清單與醫師排班完全並行載入
      const [, monthScheduleDoc] = await Promise.all([
        this.userDirectory.fetchUsersIfNeeded(),
        this.physicianSchedulesApi.fetchById(dateStr),
      ]);
      const usersSnapshot = this.userDirectory.allUsers()
        .filter(u => u.title === '主治醫師' || u.title === '專科護理師');
      const userMap = new Map(usersSnapshot.map((u) => [u['id'], u]));
      const dialysisPhysiciansData: Record<string, unknown> = { early: null, noon: null, late: null };
      const consultPhysiciansData: Record<string, unknown> = { morning: null, afternoon: null, night: null };
      if (monthScheduleDoc) {
        const dayOfMonth = date.getDate();
        const doc = monthScheduleDoc as Record<string, unknown>;
        const schedule = doc['schedule'] as Record<string, Record<string, Record<string, unknown>>>;
        const daySchedule = schedule?.[dayOfMonth];
        if (daySchedule) {
          dialysisPhysiciansData['early'] = userMap.get(daySchedule['early']?.['physicianId'] as string) || null;
          dialysisPhysiciansData['noon'] = userMap.get(daySchedule['noon']?.['physicianId'] as string) || null;
          dialysisPhysiciansData['late'] = userMap.get(daySchedule['late']?.['physicianId'] as string) || null;
        }
        const consultationSchedule = doc['consultationSchedule'] as Record<string, Record<string, Record<string, unknown>>>;
        const consultationDaySchedule = consultationSchedule?.[dayOfMonth];
        if (consultationDaySchedule) {
          consultPhysiciansData['morning'] = userMap.get(consultationDaySchedule['morning']?.['physicianId'] as string) || null;
          consultPhysiciansData['afternoon'] = userMap.get(consultationDaySchedule['afternoon']?.['physicianId'] as string) || null;
          consultPhysiciansData['night'] = userMap.get(consultationDaySchedule['night']?.['physicianId'] as string) || null;
        }
      }
      this.dailyPhysicians.set(dialysisPhysiciansData);
      this.dailyConsultPhysicians.set(consultPhysiciansData);
    } catch (error: unknown) {
      console.error('載入每日負責人資訊失敗:', error);
      this.dailyPhysicians.set({ early: null, noon: null, late: null });
      this.dailyConsultPhysicians.set({ morning: null, afternoon: null, night: null });
    }
  }

  private executeAutoAssignment(): void {
    // Clear existing teams
    const teamsRec = { ...this.currentTeamsRecord(), teams: {} as Record<string, any> };

    // Helper: get patients for a given shift code from current schedule
    const getRichPatientList = (shiftCode: string) => {
      return Object.entries(this.currentRecord.schedule)
        .filter(([shiftId, slot]) => slot?.patientId && shiftId.endsWith(shiftCode))
        .map(([shiftId, slot]) => {
          const patientData = this.patientMap().get(slot.patientId) as Record<string, unknown> | undefined;
          if (!patientData) return null;
          const bedNumberStr = shiftId.split('-')[1];
          const bedNumber = parseInt(bedNumberStr, 10);
          return {
            id: slot.patientId,
            shiftId,
            shiftCode,
            status: patientData['status'] as string,
            isHepatitis: !isNaN(bedNumber) && HEPATITIS_BEDS.includes(bedNumber),
            isPeripheral: shiftId.startsWith('peripheral'),
          };
        })
        .filter(Boolean) as { id: string; shiftId: string; shiftCode: string; status: string; isHepatitis: boolean; isPeripheral: boolean }[];
    };

    const mainArea = (list: any[]) => list.filter(p => !p.isPeripheral);
    const peripheral = (list: any[]) => list.filter(p => p.isPeripheral);
    const sortByBed = (list: any[]) => [...list].sort((a, b) => {
      const getKey = (id: string) => {
        const parts = id.split('-');
        if (parts[0] === 'peripheral') return 100 + parseInt(parts[1], 10);
        const num = parseInt(parts[1], 10);
        return isNaN(num) ? 999 : num;
      };
      return getKey(a.shiftId) - getKey(b.shiftId);
    });

    // distributePatients function (ported from Vue useTeamAssigner)
    const distributePatients = (
      allPatients: any[],
      teams: string[],
      rules: { priorityTeams: any; mainDistribution: any; teamMaxCapacity?: Record<string, number> }
    ) => {
      const assignments: Record<string, any[]> = {};
      teams.forEach(t => assignments[t] = []);
      const assignedIds = new Set<string>();
      const addPatient = (team: string, patient: any) => {
        if (patient && assignments[team] && !assignedIds.has(patient.id)) {
          assignments[team].push(patient);
          assignedIds.add(patient.id);
          return true;
        }
        return false;
      };

      // Step 1: Priority teams (hepatitis, IPD/ER)
      const { hepatitis, inPatientTeams, inPatientCapacity } = rules.priorityTeams;
      if (hepatitis) {
        allPatients.filter(p => p.isHepatitis).forEach(p => addPatient(hepatitis, p));
      }
      if (inPatientTeams && inPatientCapacity) {
        const unassignedIPD = allPatients.filter(p => (p.status === 'ipd' || p.status === 'er') && !assignedIds.has(p.id));
        // Sequential fill: fill H first, then I, then J (not round-robin)
        unassignedIPD.forEach(patient => {
          for (const team of inPatientTeams) {
            if ((assignments[team]?.length || 0) < inPatientCapacity[team]) {
              if (addPatient(team, patient)) break;
            }
          }
        });
      }

      // Step 2: Special team (A)
      const { specialTeam, regularTeams } = rules.mainDistribution;
      if (specialTeam) {
        const availableOPD = allPatients.filter(p => !assignedIds.has(p.id) && p.status === 'opd' && !p.isHepatitis);
        availableOPD.slice(0, specialTeam.capacity).forEach(p => addPatient(specialTeam.name, p));
      }

      // Step 3: Distribute remaining evenly across regular teams
      const maxCap = rules.teamMaxCapacity || {};
      const participating = regularTeams;
      const remaining = allPatients.filter(p => !assignedIds.has(p.id));
      let totalWorkload = remaining.length;
      participating.forEach((team: string) => totalWorkload += assignments[team]?.length || 0);

      if (totalWorkload > 0 && participating.length > 0) {
        const base = Math.floor(totalWorkload / participating.length);
        const rem = totalWorkload % participating.length;
        const targets: Record<string, number> = {};
        participating.forEach((team: string, i: number) => {
          let target = base + (i < rem ? 1 : 0);
          // Enforce max capacity for specific teams (e.g., H/I capped at 3)
          if (maxCap[team] !== undefined) target = Math.min(target, maxCap[team]);
          targets[team] = target;
        });
        let pi = 0;
        for (const team of participating) {
          const needed = Math.max(0, targets[team] - (assignments[team]?.length || 0));
          if (needed > 0) {
            remaining.slice(pi, pi + needed).forEach(p => addPatient(team, p));
            pi += needed;
          }
        }
      }
      return assignments;
    };

    // Collect patients per shift
    const allEarlyPatients = getRichPatientList(SHIFT_CODES.EARLY);
    const allNoonPatients = getRichPatientList(SHIFT_CODES.NOON);
    const allLatePatients = getRichPatientList(SHIFT_CODES.LATE);

    // Read config
    const cfg = this.autoAssignConfig.config();
    const earlyCfg = cfg.earlyShift;
    const lateCfg = cfg.lateShift;

    // --- Early shift ---
    const earlyMain = mainArea(allEarlyPatients);
    const useEarlyLeader = earlyMain.length > earlyCfg.leaderThreshold;
    const earlyTeamsToUse = BASE_TEAMS.filter(t => t !== 'L' && t !== '外圍').map(t => `早${t}`);
    const earlyRegularTeams = earlyCfg.regularTeams.map(t => `早${t}`);
    const earlyInpatientTeams = earlyCfg.inpatientTeams.map(t => `早${t}`);
    const earlyInpatientCap: Record<string, number> = {};
    for (const [k, v] of Object.entries(earlyCfg.inpatientCapacity)) earlyInpatientCap[`早${k}`] = v;

    // H/I per-shift max capacity = 3 (inpatients + OPD combined)
    const earlyMaxCap: Record<string, number> = {};
    for (const t of earlyInpatientTeams) earlyMaxCap[t] = 3;

    const earlyRules = {
      priorityTeams: { hepatitis: `早${earlyCfg.hepatitisTeam}`, inPatientTeams: earlyInpatientTeams, inPatientCapacity: earlyInpatientCap },
      mainDistribution: { specialTeam: useEarlyLeader ? { name: `早${earlyCfg.leaderTeam}`, capacity: earlyCfg.leaderCapacity } : null, regularTeams: earlyRegularTeams },
      teamMaxCapacity: earlyMaxCap,
    };

    const earlyAssignments = distributePatients(sortByBed(earlyMain), earlyTeamsToUse, earlyRules);
    earlyAssignments['早外圍'] = peripheral(allEarlyPatients);

    // Count early shift inpatients per inpatient team (for cross-shift cap)
    const earlyInpatientCounts: Record<string, number> = {};
    for (const team of earlyInpatientTeams) {
      earlyInpatientCounts[team] = (earlyAssignments[team] || []).filter(
        (p: any) => p.status === 'ipd' || p.status === 'er'
      ).length;
    }

    // --- Noon shift (on = early teams, off = late teams) ---
    const noonMain = mainArea(allNoonPatients);
    const useNoonLeader = noonMain.length > earlyCfg.leaderThreshold;

    // Adjust noon inpatient capacity: cross-shift max 3 per group
    const noonInpatientCap: Record<string, number> = {};
    for (const [k, v] of Object.entries(earlyCfg.inpatientCapacity)) {
      const teamKey = `早${k}`;
      const usedInEarly = earlyInpatientCounts[teamKey] || 0;
      noonInpatientCap[teamKey] = Math.max(0, 3 - usedInEarly);
    }

    const noonOnRules = {
      priorityTeams: { hepatitis: `早${earlyCfg.hepatitisTeam}`, inPatientTeams: earlyInpatientTeams, inPatientCapacity: noonInpatientCap },
      mainDistribution: { specialTeam: useNoonLeader ? { name: `早${earlyCfg.leaderTeam}`, capacity: earlyCfg.leaderCapacity } : null, regularTeams: earlyRegularTeams },
      teamMaxCapacity: earlyMaxCap,
    };
    const noonOnAssignments = distributePatients(sortByBed(noonMain), earlyTeamsToUse, noonOnRules);
    noonOnAssignments['早外圍'] = peripheral(allNoonPatients);

    // --- Late shift ---
    const lateTeamsToUse = lateCfg.regularTeams.map(t => `晚${t}`);
    const lateInpatientTeams = lateCfg.inpatientTeams.map(t => `晚${t}`);
    const lateInpatientCap: Record<string, number> = {};
    for (const [k, v] of Object.entries(lateCfg.inpatientCapacity)) lateInpatientCap[`晚${k}`] = v;

    const lateRules = {
      priorityTeams: { hepatitis: `晚${lateCfg.hepatitisTeam}`, inPatientTeams: lateInpatientTeams, inPatientCapacity: lateInpatientCap },
      mainDistribution: { specialTeam: null, regularTeams: lateTeamsToUse },
    };

    const noonOffAssignments = distributePatients(sortByBed(noonMain), lateTeamsToUse, lateRules);
    noonOffAssignments['晚外圍'] = peripheral(allNoonPatients);

    const lateMain = mainArea(allLatePatients);
    const lateAssignments = distributePatients(sortByBed(lateMain), lateTeamsToUse, lateRules);
    lateAssignments['晚外圍'] = peripheral(allLatePatients);

    // Write results to teams record
    for (const team in earlyAssignments) {
      for (const patient of earlyAssignments[team]) {
        const key = `${patient.id}-${SHIFT_CODES.EARLY}`;
        if (!teamsRec.teams[key]) teamsRec.teams[key] = {};
        teamsRec.teams[key].nurseTeam = team;
      }
    }
    for (const team in noonOnAssignments) {
      for (const patient of noonOnAssignments[team]) {
        const key = `${patient.id}-${SHIFT_CODES.NOON}`;
        if (!teamsRec.teams[key]) teamsRec.teams[key] = {};
        teamsRec.teams[key].nurseTeamIn = team;
      }
    }
    for (const team in noonOffAssignments) {
      for (const patient of noonOffAssignments[team]) {
        const key = `${patient.id}-${SHIFT_CODES.NOON}`;
        if (!teamsRec.teams[key]) teamsRec.teams[key] = {};
        teamsRec.teams[key].nurseTeamOut = team;
      }
    }
    for (const team in lateAssignments) {
      for (const patient of lateAssignments[team]) {
        const key = `${patient.id}-${SHIFT_CODES.LATE}`;
        if (!teamsRec.teams[key]) teamsRec.teams[key] = {};
        teamsRec.teams[key].nurseTeam = team;
      }
    }

    this.currentTeamsRecord.set(teamsRec);
    this.setTeamChange();
    this.hasUnsavedChanges.set(true);
    this.statusIndicator.set('自動分組完成，請確認並儲存');
    this.showAlert('操作成功', '四個班次的自動分組已全部完成！請檢視結果並點擊「儲存」。');
  }

  // Helper to generate array for ngFor
  peripheralBedRange(): number[] {
    return Array.from({ length: PERIPHERAL_BED_COUNT }, (_, i) => i + 1);
  }
}
