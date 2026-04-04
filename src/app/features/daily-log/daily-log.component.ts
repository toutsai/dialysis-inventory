import { Component, inject, signal, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '@app/core/services/auth.service';
import { FirebaseService } from '@services/firebase.service';
import { ApiManagerService, type ApiManager, type FirestoreRecord } from '@app/core/services/api-manager.service';
import { PatientStoreService } from '@services/patient-store.service';
import { where, doc, getDoc, setDoc, onSnapshot, type Unsubscribe } from 'firebase/firestore';
import { updatePatient as optimizedUpdatePatient } from '@/services/optimizedApiService';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { WardNumberDialogComponent } from '@app/components/dialogs/ward-number-dialog/ward-number-dialog.component';
import { ConfirmDialogComponent } from '@app/components/dialogs/confirm-dialog/confirm-dialog.component';
import { AlertDialogComponent } from '@app/components/dialogs/alert-dialog/alert-dialog.component';
import { HandoverNotesDialogComponent } from '@app/components/dialogs/handover-notes-dialog/handover-notes-dialog.component';
import { MarqueeEditDialogComponent } from '@app/components/dialogs/marquee-edit-dialog/marquee-edit-dialog.component';

@Component({
  selector: 'app-daily-log',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    WardNumberDialogComponent,
    ConfirmDialogComponent,
    AlertDialogComponent,
    HandoverNotesDialogComponent,
    MarqueeEditDialogComponent,
  ],
  templateUrl: './daily-log.component.html',
  styleUrl: './daily-log.component.css',
})
export class DailyLogComponent implements OnInit, OnDestroy {
  // ===================================================================
  // Services
  // ===================================================================
  readonly authService = inject(AuthService);
  private readonly firebase = inject(FirebaseService);
  private readonly apiManagerService = inject(ApiManagerService);
  readonly patientStore = inject(PatientStoreService);

  // API Managers
  private readonly dailyLogsApi: ApiManager<FirestoreRecord>;
  private readonly schedulesApi: ApiManager<FirestoreRecord>;

  // ===================================================================
  // Core State
  // ===================================================================
  isLoading = signal(false);
  selectedDate = signal(this.formatDate(new Date()));
  hasUnsavedChanges = signal(false);
  currentSchedule: any = {};
  dailyLog: any;

  // ===================================================================
  // UI State
  // ===================================================================
  @ViewChild('otherNotesTextarea') otherNotesTextareaRef?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('hiddenDateInput') hiddenDateInputRef?: ElementRef<HTMLInputElement>;
  isStaffingDetailsVisible = false;
  private marqueeUnsubscribe: Unsubscribe | null = null;
  private dailyLogCache = new Map<string, any>();

  // ===================================================================
  // Dialog State
  // ===================================================================
  isWardDialogVisible = false;
  isConfirmDialogVisible = false;
  isAlertDialogVisible = false;
  isHandoverDialogVisible = false;
  isMarqueeDialogVisible = false;

  // Dialog Data
  handoverNotes = '';
  marqueeHtmlContent = '';
  confirmDialogTitle = '';
  confirmDialogMessage = '';
  confirmAction: (() => void) | null = null;
  alertDialogTitle = '';
  alertDialogMessage = '';
  currentEditingMovementIndex = -1;

  // ===================================================================
  // Autocomplete State
  // ===================================================================
  newMovementId: number | null = null;
  activeSearch = { type: null as string | null, index: -1 };
  patientSearchResults: any[] = [];
  isAutocompleteVisible = false;
  autocompleteStyle = { top: '0px', left: '0px', width: '0px' };

  // ===================================================================
  // Constructor
  // ===================================================================
  constructor() {
    this.dailyLogsApi = this.apiManagerService.create<FirestoreRecord>('daily_logs');
    this.schedulesApi = this.apiManagerService.create<FirestoreRecord>('schedules');
    this.dailyLog = this.initialLogState();
  }

  // ===================================================================
  // Computed Properties (getters)
  // ===================================================================
  get isPageLocked(): boolean {
    return !this.authService.canEditSchedules();
  }

  get currentUser(): any {
    return this.authService.currentUser();
  }

  get selectedDateDisplay(): string {
    const d = new Date(this.selectedDate());
    if (isNaN(d.getTime())) return this.selectedDate();
    const year = d.getFullYear();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${year}/${month}/${day}`;
  }

  get weekdayDisplay(): string {
    try {
      const d = new Date(this.selectedDate());
      return ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    } catch {
      return '';
    }
  }

  get statusText(): string {
    if (this.hasUnsavedChanges()) return '有未儲存的變更';
    const isSigned = Object.values(this.dailyLog.leader).some((l: any) => l && l.userId);
    return isSigned ? '變更已儲存' : '尚未簽核';
  }

  get totalPatients(): { early: number; noon: number; late: number } {
    const totals: any = { early: 0, noon: 0, late: 0 };
    for (const shift of ['early', 'noon', 'late']) {
      totals[shift] =
        (this.dailyLog.stats.main_beds[shift]?.total || 0) +
        (this.dailyLog.stats.peripheral_beds[shift]?.total || 0);
    }
    return totals;
  }

  get calculatedStaffingTotals(): { early: number; noon: number; late: number; total: number } {
    const totals = { early: 0, noon: 0, late: 0, total: 0 };
    const staffingData = this.dailyLog.stats.staffing;
    if (staffingData && Array.isArray(staffingData.details)) {
      staffingData.details.forEach((item: any) => {
        const count = Number(item.count) || 0;
        totals.early += count * (Number(item.ratio1) || 0);
        totals.noon += count * (Number(item.ratio2) || 0);
        totals.late += count * (Number(item.ratio3) || 0);
      });
    }
    if (staffingData) {
      const adjustments = staffingData.adjustments || staffingData.deductions || {};
      totals.early += (Number(adjustments.shift1) || 0) * 0.125;
      totals.noon += (Number(adjustments.shift2) || 0) * 0.125;
      totals.late += (Number(adjustments.shift3) || 0) * 0.125;
    }
    totals.early = Math.max(0, totals.early);
    totals.noon = Math.max(0, totals.noon);
    totals.late = Math.max(0, totals.late);
    totals.total = totals.early + totals.noon + totals.late;
    return totals;
  }

  get nursePatientRatios(): { early: string; noon: string; late: string; total: string } {
    const calculateRatio = (patients: number, staff: number): string => {
      if (!staff || staff === 0) return 'N/A';
      return (patients / staff).toFixed(2);
    };
    const totalStaff = this.calculatedStaffingTotals.total;
    const totalPatientCount =
      this.totalPatients.early + this.totalPatients.noon + this.totalPatients.late;
    return {
      early: calculateRatio(this.totalPatients.early, this.calculatedStaffingTotals.early),
      noon: calculateRatio(this.totalPatients.noon, this.calculatedStaffingTotals.noon),
      late: calculateRatio(this.totalPatients.late, this.calculatedStaffingTotals.late),
      total: calculateRatio(totalPatientCount, totalStaff),
    };
  }

  get wardDialogCurrentValue(): string {
    if (this.currentEditingMovementIndex > -1) {
      const patientId = this.dailyLog.patientMovements[this.currentEditingMovementIndex]?.patientId;
      return (this.patientStore.patientMap().get(patientId) as any)?.wardNumber || '';
    }
    return '';
  }

  // ===================================================================
  // Lifecycle
  // ===================================================================
  async ngOnInit(): Promise<void> {
    await this.loadDailyLog(this.selectedDate());
    const marqueeRef = doc(this.firebase.db, 'site_config', 'marquee_announcements');
    this.marqueeUnsubscribe = onSnapshot(marqueeRef, (docSnap) => {
      this.marqueeHtmlContent = docSnap.exists() ? docSnap.data()?.['content'] || '' : '';
    });
  }

  ngOnDestroy(): void {
    if (this.marqueeUnsubscribe) this.marqueeUnsubscribe();
  }

  // ===================================================================
  // Change Tracking
  // ===================================================================
  markDirty(): void {
    if (this.isLoading()) return;
    this.hasUnsavedChanges.set(true);
  }

  // ===================================================================
  // Initial State Factory
  // ===================================================================
  initialLogState(): any {
    return {
      id: null,
      date: this.selectedDate ? this.selectedDate() : this.formatDate(new Date()),
      stats: {
        main_beds: {
          early: { opd: 0, ipd: 0, er: 0, total: 0 },
          noon: { opd: 0, ipd: 0, er: 0, total: 0 },
          late: { opd: 0, ipd: 0, er: 0, total: 0 },
        },
        peripheral_beds: {
          early: { ipd: 0, er: 0, total: 0 },
          noon: { ipd: 0, er: 0, total: 0 },
          late: { ipd: 0, er: 0, total: 0 },
        },
        patient_care: {
          onDL: { early: '', noon: '', late: '' },
          akChange: { early: '', noon: '', late: '' },
          noShow: { early: '', noon: '', late: '' },
        },
        staffing: {
          details: [
            { id: Date.now() + 1, label: '7-4(洗腎室)', count: 0, ratio1: 1, ratio2: 1, ratio3: 0, isLocked: true },
            { id: Date.now() + 2, label: '7-5(洗腎室)', count: 0, ratio1: 1, ratio2: 1, ratio3: 0.25, isLocked: true },
            { id: Date.now() + 3, label: '8-16(ICU)', count: 0, ratio1: 1, ratio2: 1, ratio3: 0, isLocked: true },
            { id: Date.now() + 4, label: '12-8', count: 0, ratio1: 0, ratio2: 0.375, ratio3: 0.625, isLocked: true },
            { id: Date.now() + 5, label: '3-11(夜班)', count: 0, ratio1: 0, ratio2: 0, ratio3: 1, isLocked: true },
          ],
          adjustments: { shift1: null, shift2: null, shift3: null },
          early: 0,
          noon: 0,
          late: 0,
        },
      },
      patientMovements: [],
      vascularAccessLog: [],
      otherNotes: '',
      leader: {
        early: { userId: null, name: null, signedAt: null },
        noon: { userId: null, name: null, signedAt: null },
        late: { userId: null, name: null, signedAt: null },
      },
    };
  }

  // ===================================================================
  // Core Business Logic
  // ===================================================================
  async loadDailyLog(dateStr: string): Promise<void> {
    this.isLoading.set(true);
    this.hasUnsavedChanges.set(false);
    Object.assign(this.dailyLog, this.initialLogState(), { date: dateStr });
    this.currentSchedule = {};
    this.handoverNotes = '';
    this.newMovementId = null;

    try {
      const patientFetchPromise = this.patientStore.fetchPatientsIfNeeded();

      const cachedLog = this.dailyLogCache.get(dateStr);
      if (cachedLog && this.patientStore.hasFetched()) {
        this.applyLoadedData(
          this.cloneData(cachedLog.dailyLog),
          this.cloneData(cachedLog.schedule),
          cachedLog.handoverNotes,
        );
        this.isLoading.set(false);
        setTimeout(() => this.handleTextareaInput(), 0);
        return;
      }

      await patientFetchPromise;

      const [logResult, handoverLogSnap, scheduleData] = await Promise.all([
        this.dailyLogsApi.fetchById(dateStr),
        getDoc(doc(this.firebase.db, 'handover_logs', 'latest')),
        this.schedulesApi.fetchAll([where('date', '==', dateStr)]),
      ]);

      if (handoverLogSnap.exists()) {
        this.handoverNotes = handoverLogSnap.data()?.['content'] || '';
      } else {
        this.handoverNotes = '';
      }

      if (logResult) {
        const mergedLog = { ...this.initialLogState(), ...logResult };
        if (mergedLog.handoverNotes && typeof mergedLog.otherNotes === 'undefined') {
          mergedLog.otherNotes = mergedLog.handoverNotes;
        }
        delete mergedLog.handoverNotes;

        const logStats = (logResult as any).stats;
        if (logStats && (!logStats.staffing || !logStats.staffing.details)) {
          const oldStaffingData = logStats.staffing || {};
          const newStaffingStructure = this.initialLogState().stats.staffing;
          const oldTotal =
            (oldStaffingData.early || 0) + (oldStaffingData.noon || 0) + (oldStaffingData.late || 0);
          if (oldTotal > 0) {
            newStaffingStructure.details = [
              {
                id: Date.now(),
                label: '舊日誌人力總計',
                count: 1,
                ratio1: oldStaffingData.early || 0,
                ratio2: oldStaffingData.noon || 0,
                ratio3: oldStaffingData.late || 0,
              },
            ];
          } else {
            newStaffingStructure.details = this.initialLogState().stats.staffing.details;
          }
          logStats.staffing = newStaffingStructure;
        }

        if (logStats?.staffing) {
          if (logStats.staffing.deductions && !logStats.staffing.adjustments) {
            logStats.staffing.adjustments = logStats.staffing.deductions;
          }
          if (!logStats.staffing.adjustments) {
            logStats.staffing.adjustments = { shift1: null, shift2: null, shift3: null };
          }
        }

        Object.assign(this.dailyLog, mergedLog);
      } else {
        this.dailyLog.otherNotes = '';
      }

      if (scheduleData.length > 0) {
        const scheduleRecord = scheduleData[0] as any;
        this.currentSchedule = scheduleRecord.schedule || {};
        // Recalculate from schedule if:
        // 1. No saved log exists, OR
        // 2. Saved log has no stats data (e.g. created by saveJustMovements), OR
        // 3. All stats totals are 0 (corrupted/reset data)
        const savedStats = (logResult as any)?.stats;
        const hasValidStats = savedStats?.main_beds &&
          (
            savedStats.main_beds.early?.total > 0 ||
            savedStats.main_beds.noon?.total > 0 ||
            savedStats.main_beds.late?.total > 0 ||
            savedStats.peripheral_beds?.early?.total > 0 ||
            savedStats.peripheral_beds?.noon?.total > 0 ||
            savedStats.peripheral_beds?.late?.total > 0
          );
        if (!hasValidStats) {
          this.calculateStatsFromSchedule(scheduleRecord);
        }
      }

      this.dailyLogCache.set(dateStr, {
        dailyLog: this.cloneData(this.dailyLog),
        schedule: this.cloneData(this.currentSchedule),
        handoverNotes: this.handoverNotes,
      });
    } catch (error) {
      console.error('載入日誌失敗:', error);
      this.showAlert('載入失敗', '載入日誌時發生錯誤');
    } finally {
      this.isLoading.set(false);
      setTimeout(() => this.handleTextareaInput(), 0);
    }
  }

  async saveLog(options: { successMessage?: string; showSuccessAlert?: boolean } = {}): Promise<void> {
    const { successMessage = '日誌已儲存！', showSuccessAlert = true } = options;
    if (this.isLoading()) return;
    this.isLoading.set(true);

    // Sync staffing totals before saving
    const totals = this.calculatedStaffingTotals;
    if (this.dailyLog.stats.staffing) {
      this.dailyLog.stats.staffing.early = totals.early;
      this.dailyLog.stats.staffing.noon = totals.noon;
      this.dailyLog.stats.staffing.late = totals.late;
    }

    this.dailyLog.patientMovements = this.dailyLog.patientMovements.filter(
      (item: any) => item.name || item.medicalRecordNumber,
    );
    this.dailyLog.vascularAccessLog = this.dailyLog.vascularAccessLog.filter(
      (item: any) => item.name || item.medicalRecordNumber,
    );

    try {
      const dataToSave = JSON.parse(JSON.stringify(this.dailyLog));
      if (dataToSave.stats?.staffing) {
        if (dataToSave.stats.staffing.deductions) {
          dataToSave.stats.staffing.adjustments = dataToSave.stats.staffing.deductions;
          delete dataToSave.stats.staffing.deductions;
        }
        if (!dataToSave.stats.staffing.adjustments) {
          dataToSave.stats.staffing.adjustments = { shift1: null, shift2: null, shift3: null };
        }
      }
      if ('handoverNotes' in dataToSave) {
        delete dataToSave.handoverNotes;
      }

      if (this.dailyLog.id) {
        await this.dailyLogsApi.update(this.dailyLog.id, dataToSave);
      } else {
        const docId = this.selectedDate();
        await this.dailyLogsApi.save(docId, dataToSave);
        this.dailyLog.id = docId;
      }
      this.hasUnsavedChanges.set(false);
      this.dailyLogCache.delete(this.selectedDate());
      if (showSuccessAlert) {
        this.showAlert('操作成功', successMessage);
      }
    } catch (error) {
      console.error('儲存日誌失敗:', error);
      this.showAlert('儲存失敗', '儲存日誌時發生錯誤');
    } finally {
      this.isLoading.set(false);
    }
  }

  async handleMarqueeSave(newContent: string): Promise<void> {
    if (this.isPageLocked) {
      this.showAlert('權限不足', '您沒有權限修改全域公告。');
      return;
    }
    try {
      const marqueeRef = doc(this.firebase.db, 'site_config', 'marquee_announcements');
      await setDoc(marqueeRef, {
        content: newContent,
        updatedAt: new Date(),
        updatedBy: {
          uid: this.currentUser.uid,
          name: this.currentUser.name,
        },
      });
      this.isMarqueeDialogVisible = false;
      this.showAlert('儲存成功', '全域跑馬燈公告已更新！');
    } catch (error) {
      console.error('儲存跑馬燈公告失敗:', error);
      this.showAlert('儲存失敗', '更新公告時發生錯誤。');
    }
  }

  // ===================================================================
  // Stats Calculation
  // ===================================================================
  calculateStatsFromSchedule(scheduleRecord: any): void {
    const newStats: any = {
      main_beds: {
        early: { opd: 0, ipd: 0, er: 0, total: 0 },
        noon: { opd: 0, ipd: 0, er: 0, total: 0 },
        late: { opd: 0, ipd: 0, er: 0, total: 0 },
      },
      peripheral_beds: {
        early: { ipd: 0, er: 0, total: 0 },
        noon: { ipd: 0, er: 0, total: 0 },
        late: { ipd: 0, er: 0, total: 0 },
      },
    };
    if (!scheduleRecord || !scheduleRecord.schedule) {
      this.dailyLog.stats.main_beds = newStats.main_beds;
      this.dailyLog.stats.peripheral_beds = newStats.peripheral_beds;
      return;
    }
    const patientMap = this.patientStore.patientMap();
    for (const shiftKey in scheduleRecord.schedule) {
      const slotData = scheduleRecord.schedule[shiftKey];
      if (!slotData?.patientId) continue;
      const patient = patientMap.get(slotData.patientId);
      if (!patient) continue;
      const shiftCode = shiftKey.split('-').pop()!;
      const isPeripheral = shiftKey.startsWith('peripheral');
      if (['early', 'noon', 'late'].includes(shiftCode)) {
        if (isPeripheral) {
          newStats.peripheral_beds[shiftCode].total++;
          if (patient.status === 'ipd') newStats.peripheral_beds[shiftCode].ipd++;
          else if (patient.status === 'er') newStats.peripheral_beds[shiftCode].er++;
        } else {
          newStats.main_beds[shiftCode].total++;
          if (patient.status === 'opd') newStats.main_beds[shiftCode].opd++;
          else if (patient.status === 'ipd') newStats.main_beds[shiftCode].ipd++;
          else if (patient.status === 'er') newStats.main_beds[shiftCode].er++;
        }
      }
    }
    this.dailyLog.stats.main_beds = newStats.main_beds;
    this.dailyLog.stats.peripheral_beds = newStats.peripheral_beds;
  }

  getStatsFromSchedule(scheduleRecord: any): any {
    const stats: any = {
      main_beds: {
        early: { opd: 0, ipd: 0, er: 0, total: 0 },
        noon: { opd: 0, ipd: 0, er: 0, total: 0 },
        late: { opd: 0, ipd: 0, er: 0, total: 0 },
      },
      peripheral_beds: {
        early: { ipd: 0, er: 0, total: 0 },
        noon: { ipd: 0, er: 0, total: 0 },
        late: { ipd: 0, er: 0, total: 0 },
      },
    };
    if (!scheduleRecord || !scheduleRecord.schedule) return stats;
    const patientMap = this.patientStore.patientMap();
    for (const shiftKey in scheduleRecord.schedule) {
      const slotData = scheduleRecord.schedule[shiftKey];
      if (!slotData?.patientId) continue;
      const patient = patientMap.get(slotData.patientId);
      if (!patient) continue;
      const shiftCode = shiftKey.split('-').pop()!;
      const isPeripheral = shiftKey.startsWith('peripheral');
      if (['early', 'noon', 'late'].includes(shiftCode)) {
        if (isPeripheral) {
          stats.peripheral_beds[shiftCode].total++;
          if (patient.status === 'ipd') stats.peripheral_beds[shiftCode].ipd++;
          else if (patient.status === 'er') stats.peripheral_beds[shiftCode].er++;
        } else {
          stats.main_beds[shiftCode].total++;
          if (patient.status === 'opd') stats.main_beds[shiftCode].opd++;
          else if (patient.status === 'ipd') stats.main_beds[shiftCode].ipd++;
          else if (patient.status === 'er') stats.main_beds[shiftCode].er++;
        }
      }
    }
    return stats;
  }

  compareStats(currentStats: any, scheduleStats: any): any[] {
    const differences: any[] = [];
    const shiftLabels: any = { early: '第一班', noon: '第二班', late: '第三班' };
    const categoryLabels: any = { opd: '門診', ipd: '住院', er: '急診', total: '小計' };

    for (const shift of ['early', 'noon', 'late']) {
      for (const category of ['opd', 'ipd', 'er', 'total']) {
        const current = currentStats.main_beds?.[shift]?.[category] || 0;
        const schedule = scheduleStats.main_beds?.[shift]?.[category] || 0;
        if (current !== schedule) {
          differences.push({ area: '洗腎中心', shift: shiftLabels[shift], category: categoryLabels[category], current, schedule });
        }
      }
    }
    for (const shift of ['early', 'noon', 'late']) {
      for (const category of ['ipd', 'er', 'total']) {
        const current = currentStats.peripheral_beds?.[shift]?.[category] || 0;
        const schedule = scheduleStats.peripheral_beds?.[shift]?.[category] || 0;
        if (current !== schedule) {
          differences.push({ area: '急重症', shift: shiftLabels[shift], category: categoryLabels[category], current, schedule });
        }
      }
    }
    return differences;
  }

  formatDifferencesMessage(differences: any[]): string {
    if (differences.length === 0) return '';
    const mainBedsDiffs = differences.filter(d => d.area === '洗腎中心');
    const peripheralDiffs = differences.filter(d => d.area === '急重症');
    let message = '以下人數與排程表不符：\n\n';
    if (mainBedsDiffs.length > 0) {
      message += '【洗腎中心床位】\n';
      mainBedsDiffs.forEach(d => { message += `  ${d.shift} ${d.category}: ${d.current} → ${d.schedule}\n`; });
      message += '\n';
    }
    if (peripheralDiffs.length > 0) {
      message += '【急重症床位】\n';
      peripheralDiffs.forEach(d => { message += `  ${d.shift} ${d.category}: ${d.current} → ${d.schedule}\n`; });
    }
    return message;
  }

  async checkAndSyncBeforeSave(onComplete: () => Promise<void>): Promise<void> {
    try {
      const scheduleData = await this.schedulesApi.fetchAll([where('date', '==', this.selectedDate())]);
      if (scheduleData.length === 0) {
        await onComplete();
        return;
      }
      const scheduleStats = this.getStatsFromSchedule(scheduleData[0] as any);
      const differences = this.compareStats(this.dailyLog.stats, scheduleStats);
      if (differences.length === 0) {
        await onComplete();
        return;
      }
      const diffMessage = this.formatDifferencesMessage(differences);
      this.showConfirm(
        '人數統計需要同步',
        `${diffMessage}\n是否同步為排程表的人數後再儲存？`,
        async () => {
          this.dailyLog.stats.main_beds = scheduleStats.main_beds;
          this.dailyLog.stats.peripheral_beds = scheduleStats.peripheral_beds;
          await onComplete();
        },
      );
    } catch (error) {
      console.error('檢查人數統計時發生錯誤:', error);
      await onComplete();
    }
  }

  // ===================================================================
  // Staffing Calculation
  // ===================================================================
  toggleStaffingDetails(): void {
    this.isStaffingDetailsVisible = !this.isStaffingDetailsVisible;
  }

  addStaffingRow(): void {
    this.dailyLog.stats.staffing.details.push({
      id: Date.now(), label: '', count: 0, ratio1: 0, ratio2: 0, ratio3: 0, isLocked: false,
    });
  }

  deleteStaffingRow(index: number): void {
    this.dailyLog.stats.staffing.details.splice(index, 1);
  }

  // ===================================================================
  // PDF Export
  // ===================================================================
  async exportToPDF(): Promise<void> {
    if (this.isLoading()) {
      this.showAlert('提示', '目前正在載入資料，請稍後再試。');
      return;
    }
    if (this.hasUnsavedChanges() && !this.isPageLocked) {
      await this.saveLog({ showSuccessAlert: false });
    }
    const originalLoadingText = document.querySelector('.loading-overlay p')?.textContent || '';
    const loadingTextElement = document.querySelector('.loading-overlay p');
    this.isLoading.set(true);
    await new Promise(resolve => setTimeout(resolve, 0));

    try {
      const exportArea = document.getElementById('pdf-export-area');
      if (!exportArea) {
        this.showAlert('錯誤', '找不到要匯出的內容！');
        return;
      }
      exportArea.classList.add('pdf-export-mode');
      await new Promise(resolve => setTimeout(resolve, 100));

      const canvas = await html2canvas(exportArea, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        ignoreElements: (element: Element) =>
          element.classList.contains('header-right') || element.classList.contains('loading-overlay'),
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      const ratio = canvas.width / pdfWidth;
      const scaledHeight = canvas.height / ratio;
      let heightLeft = scaledHeight;
      let position = 0;
      const margin = 10;

      pdf.addImage(imgData, 'JPEG', margin, position + margin, pdfWidth - margin * 2, scaledHeight - margin * 2);
      heightLeft -= pdfHeight - margin * 2;
      while (heightLeft > 0) {
        position -= pdfHeight - margin * 2;
        pdf.addPage();
        pdf.addImage(imgData, 'JPEG', margin, position + margin, pdfWidth - margin * 2, scaledHeight - margin * 2);
        heightLeft -= pdfHeight - margin * 2;
      }
      pdf.save(`血液透析中心工作日誌_${this.selectedDate()}.pdf`);
    } catch (error) {
      console.error('匯出 PDF 失敗:', error);
      this.showAlert('錯誤', '匯出 PDF 時發生錯誤，請檢查主控台訊息。');
    } finally {
      const exportArea = document.getElementById('pdf-export-area');
      if (exportArea) exportArea.classList.remove('pdf-export-mode');
      if (loadingTextElement) loadingTextElement.textContent = originalLoadingText;
      this.isLoading.set(false);
    }
  }

  // ===================================================================
  // Date Navigation
  // ===================================================================
  changeDate(days: number): void {
    const newDate = new Date(this.selectedDate());
    newDate.setDate(newDate.getDate() + days);
    const formatted = this.formatDate(newDate);
    this.selectedDate.set(formatted);
    this.loadDailyLog(formatted);
  }

  goToToday(): void {
    const formatted = this.formatDate(new Date());
    this.selectedDate.set(formatted);
    this.loadDailyLog(formatted);
  }

  onDateChange(newDate: string): void {
    this.selectedDate.set(newDate);
    if (newDate) this.loadDailyLog(newDate);
  }

  triggerDateInput(): void {
    (this.hiddenDateInputRef?.nativeElement as any)?.showPicker?.();
  }

  // ===================================================================
  // Dynamic Table Row Management
  // ===================================================================
  addRow(targetArrayKey: string): void {
    if (this.newMovementId) {
      this.showAlert('提示', '請先儲存目前新增的動態，再新增下一筆。');
      return;
    }
    const newId = Date.now();
    if (targetArrayKey === 'patientMovements') {
      this.dailyLog.patientMovements.push({
        id: newId, type: '手動', name: '', medicalRecordNumber: '', bedChange: '',
        admissionDate: '', dischargeDate: '', physician: '', reason: '', remarks: '',
      });
      this.newMovementId = newId;
    } else if (targetArrayKey === 'vascularAccessLog') {
      this.dailyLog.vascularAccessLog.push({
        id: newId, name: '', medicalRecordNumber: '', date: this.selectedDate(), interventions: [], location: '',
      });
    }
  }

  deleteRow(index: number, targetArrayKey: string): void {
    const item = this.dailyLog[targetArrayKey][index];
    this.showConfirm('確認移除', '您確定要移除這一行嗎？', () => {
      if (item.id === this.newMovementId) this.newMovementId = null;
      this.dailyLog[targetArrayKey].splice(index, 1);
    });
  }

  isRowInEditMode(item: any): boolean {
    return item.id === this.newMovementId || !!item.isEdited;
  }

  unlockMovement(item: any): void {
    item.isEdited = true;
  }

  async saveMovement(item: any): Promise<void> {
    if (!item.name) {
      this.showAlert('資料不完整', '請至少填寫病人姓名。');
      return;
    }
    if (item.isEdited && item.originalType) {
      item.originalAutoId = item.id;
      item.id = `edited_${item.id}`;
      item.type = '手動';
    }
    if (item.id === this.newMovementId) this.newMovementId = null;
    item.isEdited = false;
    await this.saveJustMovements();
  }

  async saveJustMovements(): Promise<void> {
    this.isLoading.set(true);
    try {
      const docId = this.selectedDate();
      if (this.dailyLog.id) {
        // Document exists: only update patientMovements
        const dataToUpdate = {
          patientMovements: JSON.parse(JSON.stringify(this.dailyLog.patientMovements)),
        };
        await this.dailyLogsApi.update(docId, dataToUpdate);
      } else {
        // Document doesn't exist: save full log to avoid losing other fields
        // (stats, staffing, patient_care, leader, etc.)
        const fullData = JSON.parse(JSON.stringify(this.dailyLog));
        await this.dailyLogsApi.save(docId, fullData);
        this.dailyLog.id = docId;
      }
      this.hasUnsavedChanges.set(false);
      this.dailyLogCache.delete(docId); // Clear cache to force fresh reload
      this.showAlert('操作成功', '病人動態已更新！');
    } catch (error) {
      console.error('儲存病人動態失敗:', error);
      this.showAlert('儲存失敗', '更新病人動態時發生錯誤。');
    } finally {
      this.isLoading.set(false);
    }
  }

  // ===================================================================
  // Patient Autocomplete
  // ===================================================================
  handlePatientSearch(index: number, type: string): void {
    const targetArray = type === 'movements' ? this.dailyLog.patientMovements : this.dailyLog.vascularAccessLog;
    const query = (targetArray[index].name || '').toLowerCase();
    if (!query) { this.patientSearchResults = []; return; }
    this.patientSearchResults = this.patientStore.allPatients().filter(
      (p: any) => p.name.toLowerCase().includes(query) || p.medicalRecordNumber.includes(query),
    );
  }

  showAutocomplete(event: FocusEvent, index: number, type: string): void {
    this.activeSearch = { type, index };
    this.handlePatientSearch(index, type);
    const inputElement = event.target as HTMLElement;
    const rect = inputElement.getBoundingClientRect();
    this.autocompleteStyle.top = `${rect.bottom + window.scrollY}px`;
    this.autocompleteStyle.left = `${rect.left + window.scrollX}px`;
    this.autocompleteStyle.width = `${rect.width}px`;
    this.isAutocompleteVisible = true;
  }

  hideAutocomplete(): void {
    setTimeout(() => { this.isAutocompleteVisible = false; }, 200);
  }

  selectPatient(patient: any, index: number, type: string): void {
    const targetArray = type === 'movements' ? this.dailyLog.patientMovements : this.dailyLog.vascularAccessLog;
    targetArray[index].name = patient.name;
    targetArray[index].patientId = patient.id;
    targetArray[index].medicalRecordNumber = patient.medicalRecordNumber;
    if (type === 'movements') {
      targetArray[index].admissionDate = patient.admissionDate || '';
      targetArray[index].physician = patient.physician || '';
      let foundBed = '';
      if (this.currentSchedule) {
        for (const shiftKey in this.currentSchedule) {
          const slot = this.currentSchedule[shiftKey];
          if (slot.patientId === patient.id) {
            const parts = shiftKey.split('-');
            foundBed = parts[0] === 'peripheral' ? `外圍${parts[1]}` : parts[1];
            break;
          }
        }
      }
      targetArray[index].bedChange = foundBed;
    }
    this.isAutocompleteVisible = false;
  }

  // ===================================================================
  // Checkbox Group (Interventions)
  // ===================================================================
  isInterventionChecked(item: any, value: string): boolean {
    return item.interventions && item.interventions.includes(value);
  }

  toggleIntervention(item: any, value: string): void {
    if (!item.interventions) item.interventions = [];
    const idx = item.interventions.indexOf(value);
    if (idx === -1) { item.interventions.push(value); } else { item.interventions.splice(idx, 1); }
    this.markDirty();
  }

  // ===================================================================
  // Dialog Management
  // ===================================================================
  showConfirm(title: string, message: string, onConfirmCallback: () => void): void {
    this.confirmDialogTitle = title;
    this.confirmDialogMessage = message;
    this.confirmAction = onConfirmCallback;
    this.isConfirmDialogVisible = true;
  }

  handleConfirm(): void {
    if (typeof this.confirmAction === 'function') this.confirmAction();
    this.handleCancel();
  }

  handleCancel(): void {
    this.isConfirmDialogVisible = false;
    this.confirmDialogTitle = '';
    this.confirmDialogMessage = '';
    this.confirmAction = null;
  }

  showAlert(title: string, message: string): void {
    this.alertDialogTitle = title;
    this.alertDialogMessage = message;
    this.isAlertDialogVisible = true;
  }

  onNotesUpdated(newNotes: string): void {
    this.handoverNotes = newNotes;
    this.isHandoverDialogVisible = false;
  }

  // ===================================================================
  // Ward Number Dialog
  // ===================================================================
  promptWardNumber(index: number): void {
    const patientId = this.dailyLog.patientMovements[index]?.patientId;
    if (!patientId) {
      this.showAlert('操作失敗', '請先透過「姓名」欄位選擇一位病人，才能設定床號。');
      return;
    }
    const patient = this.patientStore.patientMap().get(patientId);
    if (!patient || !['ipd', 'er'].includes(patient.status || '')) {
      this.showAlert('提示', `病人「${patient?.name || ''}」目前的狀態是「${patient?.status === 'opd' ? '門診' : '未知'}」，無法設定住院床號。`);
      return;
    }
    this.currentEditingMovementIndex = index;
    this.isWardDialogVisible = true;
  }

  async handleWardNumberConfirm(newWardNumber: string): Promise<void> {
    const index = this.currentEditingMovementIndex;
    if (index < 0) return;
    const patientId = this.dailyLog.patientMovements[index]?.patientId;
    if (!patientId) return;
    try {
      await optimizedUpdatePatient(patientId, { wardNumber: newWardNumber });
      await this.patientStore.forceRefreshPatients();
      this.showAlert('操作成功', '住院床號已更新！');
    } catch (error) {
      console.error('更新住院床號失敗:', error);
      this.showAlert('操作失敗', '更新住院床號時發生錯誤。');
    } finally {
      this.handleWardNumberCancel();
    }
  }

  handleWardNumberCancel(): void {
    this.isWardDialogVisible = false;
    this.currentEditingMovementIndex = -1;
  }

  // ===================================================================
  // Leader Signature
  // ===================================================================
  async signAsLeader(shift: string): Promise<void> {
    if (!this.currentUser) return;

    const performSignAndSave = async (isOverride = false) => {
      this.dailyLog.leader[shift] = {
        userId: this.currentUser.uid,
        name: this.currentUser.name,
        signedAt: new Date().toISOString(),
      };
      const successMsg = isOverride ? '覆蓋簽核成功！日誌已更新。' : '簽核成功！日誌已儲存。';
      await this.saveLog({ successMessage: successMsg });
    };

    const performSign = async (isOverride = false) => {
      await this.checkAndSyncBeforeSave(async () => {
        await performSignAndSave(isOverride);
      });
    };

    const existingLeader = this.dailyLog.leader[shift];
    let confirmMsg = `您確定要以「${this.currentUser.name}」的名義簽核此班別，並儲存所有變更嗎？`;
    let confirmTitle = '確認簽核';
    if (existingLeader?.userId && existingLeader.userId !== this.currentUser.uid) {
      confirmTitle = '覆蓋簽核';
      confirmMsg = `此班別已由 ${existingLeader.name} 簽核。\n\n` + confirmMsg;
    } else if (existingLeader?.userId && !this.hasUnsavedChanges()) {
      this.showAlert('提示', '您已簽核，且日誌無未儲存的變更。');
      return;
    } else if (this.hasUnsavedChanges()) {
      confirmTitle = '更新簽核並儲存';
    }
    this.showConfirm(confirmTitle, confirmMsg, () => performSign());
  }

  async unsignLeader(shift: string): Promise<void> {
    if (!this.currentUser) return;

    const performUnsignAndSave = async () => {
      this.dailyLog.leader[shift] = { userId: null, name: null, signedAt: null };
      await this.saveLog({ successMessage: '撤銷簽核成功！日誌已更新。' });
    };

    const performUnsign = async () => {
      await this.checkAndSyncBeforeSave(async () => {
        await performUnsignAndSave();
      });
    };

    if (this.dailyLog.leader[shift]?.userId) {
      if (
        this.dailyLog.leader[shift]?.userId === this.currentUser.uid ||
        this.currentUser.role === 'admin'
      ) {
        this.showConfirm(
          '撤銷簽核',
          `您確定要撤銷 ${this.dailyLog.leader[shift].name} 的簽核並儲存變更嗎？`,
          performUnsign,
        );
      } else {
        this.showAlert('權限不足', '您沒有權限撤銷其他人的簽核。');
      }
    }
  }

  // ===================================================================
  // Misc UI Handlers
  // ===================================================================
  handleTextareaInput(): void {
    const textarea = this.otherNotesTextareaRef?.nativeElement;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }

  filterJoin(values: any[]): string {
    const filtered = values.filter(Boolean);
    return filtered.length > 0 ? filtered.join(', ') : '無';
  }

  // ===================================================================
  // Utility Functions
  // ===================================================================
  formatDate(date: Date): string {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private cloneData(data: any): any {
    return data ? JSON.parse(JSON.stringify(data)) : data;
  }

  private applyLoadedData(logData: any, scheduleData: any, handoverContent: string): void {
    Object.assign(this.dailyLog, this.initialLogState(), logData || { date: this.selectedDate() });
    this.currentSchedule = scheduleData || {};
    this.handoverNotes = handoverContent || '';
    this.hasUnsavedChanges.set(false);
  }

  formatSignTime(isoString: string | null): string {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
}
