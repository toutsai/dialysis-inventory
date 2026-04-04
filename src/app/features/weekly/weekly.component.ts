import { Component, inject, signal, computed, OnInit, OnDestroy, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { where } from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { FirebaseService } from '@services/firebase.service';
import { AuthService } from '@app/core/services/auth.service';
import { ApiManagerService, type ApiManager, type FirestoreRecord } from '@app/core/services/api-manager.service';
import { PatientStoreService } from '@app/core/services/patient-store.service';
import { TaskStoreService } from '@app/core/services/task-store.service';
import { ArchiveStoreService } from '@app/core/services/archive-store.service';
import { AlertDialogComponent } from '@app/components/dialogs/alert-dialog/alert-dialog.component';
import { ConfirmDialogComponent } from '@app/components/dialogs/confirm-dialog/confirm-dialog.component';
import { SelectionDialogComponent } from '@app/components/dialogs/selection-dialog/selection-dialog.component';
import { PatientSelectDialogComponent } from '@app/components/dialogs/patient-select-dialog/patient-select-dialog.component';
import { BedAssignmentDialogComponent } from '@app/components/dialogs/bed-assignment-dialog/bed-assignment-dialog.component';
import { MemoDisplayDialogComponent } from '@app/components/dialogs/memo-display-dialog/memo-display-dialog.component';
import { StatsToolbarComponent } from '@app/components/stats-toolbar/stats-toolbar.component';
import { ScheduleTableComponent } from '@app/components/schedule-table/schedule-table.component';
import { InpatientSidebarComponent } from '@app/components/inpatient-sidebar/inpatient-sidebar.component';
import {
  saveSchedule as optimizedSaveSchedule,
  updateSchedule as optimizedUpdateSchedule,
} from '@/services/optimizedApiService';
import { ORDERED_SHIFT_CODES, getShiftDisplayName } from '@/constants/scheduleConstants';
import {
  createEmptySlotData,
  generateAutoNote,
  getUnifiedCellStyle,
} from '@/utils/scheduleUtils';
import { formatDateToYYYYMMDD, addDays } from '@/utils/dateUtils';

@Component({
  selector: 'app-weekly',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AlertDialogComponent,
    ConfirmDialogComponent,
    SelectionDialogComponent,
    PatientSelectDialogComponent,
    BedAssignmentDialogComponent,
    MemoDisplayDialogComponent,
    StatsToolbarComponent,
    ScheduleTableComponent,
    InpatientSidebarComponent,
  ],
  templateUrl: './weekly.component.html',
  styleUrl: './weekly.component.css'
})
export class WeeklyComponent implements OnInit, OnDestroy {
  private readonly firebaseService = inject(FirebaseService);
  private readonly authService = inject(AuthService);
  private readonly apiManagerService = inject(ApiManagerService);
  readonly patientStore = inject(PatientStoreService);
  private readonly taskStore = inject(TaskStoreService);
  private readonly archiveStore = inject(ArchiveStoreService);
  private readonly destroyRef = inject(DestroyRef);

  readonly SHIFTS = ORDERED_SHIFT_CODES;
  readonly WEEKDAYS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  readonly CLEAR_OPTIONS = [
    { value: 'single', text: '僅清除此床' },
    { value: 'this_week_for_patient', text: '刪除病人本週所有排程' },
  ];
  readonly bedLayout: any[] = [
    1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 15, 16, 17, 18, 19,
    21, 22, 23, 25, 26, 27, 28, 29, 31, 32, 33, 35, 36, 37, 38, 39,
    51, 52, 53, 55, 56, 57, 58, 59, 61, 62, 63, 65,
    ...Array.from({ length: 6 }, (_, i) => `peripheral-${i + 1}`),
  ].sort((a: any, b: any) => {
    const numA = typeof a === 'number' ? a : Infinity;
    const numB = typeof b === 'number' ? b : Infinity;
    if (numA !== Infinity || numB !== Infinity) return numA - numB;
    return String(a).localeCompare(String(b));
  });
  readonly hepatitisBeds = [31, 32, 33, 35, 36];
  readonly FREQ_MAP_TO_DAY_INDEX: Record<string, number[]> = {
    '一三五': [0, 2, 4], '二四六': [1, 3, 5], '一四': [0, 3], '二五': [1, 4],
    '三六': [2, 5], '一五': [0, 4], '二六': [1, 5], '每日': [0, 1, 2, 3, 4, 5],
    '每周一': [0], '每周二': [1], '每周三': [2], '每周四': [3], '每周五': [4], '每周六': [5],
  };

  weekScheduleRecords = signal<Map<string, any>>(new Map());
  currentWeekStartDate = signal<Date>(this.getStartOfWeek(new Date()));
  hasUnsavedChanges = signal(false);
  statusText = signal('資料已載入');
  draggedItem = signal<any>(null);
  columnWidths = signal<number[]>([]);
  leftOffset = signal(0);
  isPatientSelectDialogVisible = signal(false);
  isProblemSolverDialogVisible = signal(false);
  currentSlotId = signal<string | null>(null);
  isClearDialogVisible = signal(false);
  clearingSlotId = signal<string | null>(null);
  isAlertDialogVisible = signal(false);
  alertDialogTitle = signal('');
  alertDialogMessage = signal('');
  isConfirmDialogVisible = signal(false);
  confirmDialogTitle = signal('');
  confirmDialogMessage = signal('');
  confirmAction = signal<(() => void) | null>(null);
  isMemoDialogVisible = signal(false);
  patientIdForDialog = signal<string | null>(null);
  patientNameForDialog = signal('');
  searchQuery = signal('');
  isSearchFocused = signal(false);

  get searchQueryValue(): string { return this.searchQuery(); }
  set searchQueryValue(value: string) { this.searchQuery.set(value); }

  isPageLocked = computed(() => !this.authService.canEditSchedules());
  allPatients = computed(() => this.patientStore.allPatients());
  patientMap = computed(() => this.patientStore.patientMap());

  typesMapForThisWeek = computed(() => {
    const weekDatesVal = this.weekDates();
    if (weekDatesVal.length < 6) return new Map<string, string[]>();
    const endOfWeekDateStr = weekDatesVal[5].queryDate;
    const map = new Map<string, Set<string>>();
    const pendingMessages = this.taskStore.sortedFeedMessages().filter((msg: any) => msg.status === 'pending');
    for (const msg of pendingMessages) {
      if (!msg.patientId) continue;
      if (!msg.targetDate || msg.targetDate <= endOfWeekDateStr) {
        if (!map.has(msg.patientId)) map.set(msg.patientId, new Set());
        map.get(msg.patientId)!.add(msg.type || '常規');
      }
    }
    const finalMap = new Map<string, string[]>();
    for (const [patientId, typeSet] of map.entries()) finalMap.set(patientId, Array.from(typeSet));
    return finalMap;
  });

  weekDisplay = computed(() => {
    const start = new Date(this.currentWeekStartDate());
    const end = new Date(start);
    end.setDate(start.getDate() + 5);
    return `${this.formatDate(start, true)} ~ ${this.formatDate(end, true)}`;
  });

  weekDates = computed(() =>
    Array.from({ length: 6 }).map((_, i) => {
      const d = addDays(this.currentWeekStartDate(), i);
      return { weekday: this.WEEKDAYS[i], date: `(${this.formatDate(d)})`, queryDate: formatDateToYYYYMMDD(d) };
    })
  );

  weekScheduleMap = computed(() => {
    const combinedSchedule: Record<string, any> = {};
    this.weekDates().forEach((day: any, dayIndex: number) => {
      const dailyRecord = this.weekScheduleRecords().get(day.queryDate);
      if (dailyRecord?.schedule) {
        for (const idInDailySchedule in dailyRecord.schedule) {
          const slotData = dailyRecord.schedule[idInDailySchedule];
          if (slotData) {
            const parts = idInDailySchedule.split('-');
            let bedNumber: string, shiftCode: string;
            if (parts[0] === 'peripheral') {
              bedNumber = `${parts[0]}-${parts[1]}`;
              shiftCode = parts[parts.length - 1];
            } else {
              bedNumber = parts[1];
              shiftCode = parts[parts.length - 1];
            }
            const shiftIndex = this.SHIFTS.indexOf(shiftCode);
            if (bedNumber !== undefined && shiftIndex !== -1) {
              combinedSchedule[`${bedNumber}-${shiftIndex}-${dayIndex}`] = slotData;
            }
          }
        }
      }
    });
    return combinedSchedule;
  });

  scheduledPatientIds = computed(() => {
    const ids = new Set<string>();
    const wsm = this.weekScheduleMap();
    for (const slotId in wsm) {
      if (wsm[slotId]?.patientId) ids.add(wsm[slotId].patientId);
    }
    return ids;
  });

  problemsToSolve = computed(() => ({
    '本週未排床病人 (有頻率)': this.allPatients().filter((p: any) =>
      !this.scheduledPatientIds().has(p.id) && p.freq && !p.isDeleted && !p.isDiscontinued
    ),
  }));

  statsToolbarData = computed(() => {
    const baseData = this.WEEKDAYS.map(() => ({
      counts: { early: { total: 0, opd: 0, ipd: 0, er: 0 }, noon: { total: 0, opd: 0, ipd: 0, er: 0 }, late: { total: 0, opd: 0, ipd: 0, er: 0 } },
      total: 0,
    }));
    for (const [dateStr, record] of this.weekScheduleRecords().entries()) {
      if (record?.schedule) {
        const d = new Date(dateStr + 'T00:00:00');
        const dayIndex = d.getDay() === 0 ? 6 : d.getDay() - 1;
        if (dayIndex >= 0 && dayIndex < 6 && baseData[dayIndex]) {
          for (const [dailyShiftKey, slotData] of Object.entries(record.schedule)) {
            const patientInfo = this.getArchivedOrLivePatientInfo(slotData);
            if (!patientInfo) continue;
            const shiftCode = dailyShiftKey.split('-').pop()!;
            if (shiftCode && (baseData[dayIndex].counts as any)[shiftCode]) {
              const shiftStats = (baseData[dayIndex].counts as any)[shiftCode];
              shiftStats.total++;
              baseData[dayIndex].total++;
              if ((patientInfo as any).status === 'opd') shiftStats.opd++;
              else if ((patientInfo as any).status === 'ipd') shiftStats.ipd++;
              else if ((patientInfo as any).status === 'er') shiftStats.er++;
            }
          }
        }
      }
    }
    return baseData;
  });

  statsToolbarWeekdays = computed(() => this.WEEKDAYS.map(w => w.slice(-1)));

  /** Extract just the date display strings for ScheduleTable header */
  weekDateStrings = computed(() => this.weekDates().map((d: any) => d.date));

  searchResults = computed(() => {
    const q = this.searchQuery();
    if (!q) return [];
    const query = q.toLowerCase();
    return this.allPatients()
      .filter((p: any) => (p.name?.toLowerCase().includes(query)) || (p.medicalRecordNumber?.includes(query)))
      .slice(0, 5);
  });

  ngOnInit(): void {
    this.loadDataForWeek();
  }

  ngOnDestroy(): void {}

  getStartOfWeek(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(new Date(d.setDate(diff)).setHours(0, 0, 0, 0));
  }

  formatDate(date: Date, withYear = false): string {
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    const dateStr = formatDateToYYYYMMDD(d);
    const [year, month, day] = dateStr.split('-');
    return withYear ? `${year}/${month}/${day}` : `${month}/${day}`;
  }

  getArchivedOrLivePatientInfo(slotData: any): any {
    if (!slotData?.patientId) return null;
    if (slotData.archivedPatientInfo) return slotData.archivedPatientInfo;
    return this.patientMap().get(slotData.patientId) || null;
  }

  async fetchArchivedSchedulesForWeek(dateStrings: string[]): Promise<any[]> {
    if (dateStrings.length === 0) return [];
    const resultsMap = await this.archiveStore.fetchSchedulesByDates(dateStrings);
    return Array.from(resultsMap.values()).filter(Boolean);
  }

  async fetchLiveSchedulesForWeek(dateStrings: string[]): Promise<any[]> {
    if (dateStrings.length === 0) return [];
    const schedulesApi = this.apiManagerService.create<FirestoreRecord>('schedules');
    const records = await schedulesApi.fetchAll([where('date', 'in', dateStrings)]);
    records.forEach((record: any) => {
      if (record.schedule) {
        for (const shiftId in record.schedule) {
          const slot = record.schedule[shiftId];
          if (slot?.patientId && this.patientMap().has(slot.patientId)) {
            slot.autoNote = generateAutoNote(this.patientMap().get(slot.patientId)) || '';
          }
        }
      }
    });
    return records;
  }

  async loadDataForWeek(): Promise<void> {
    this.hasUnsavedChanges.set(false);
    this.statusText.set('讀取中...');
    try {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const datesToFetch = this.weekDates().map((d: any) => d.queryDate);
      const pastDates = datesToFetch.filter((d: string) => new Date(d + 'T00:00:00') < today);
      const liveDates = datesToFetch.filter((d: string) => new Date(d + 'T00:00:00') >= today);

      // Parallel fetch: patients + live schedules + archived schedules
      const [_patients, liveRecords, archivedRecords] = await Promise.all([
        this.patientStore.fetchPatientsIfNeeded(),
        this.fetchLiveSchedulesForWeek(liveDates),
        this.fetchArchivedSchedulesForWeek(pastDates),
      ]);

      const fetchedRecords = [...liveRecords, ...archivedRecords];

      // Regenerate autoNotes for live records now that patientMap is ready
      liveRecords.forEach((record: any) => {
        if (record?.schedule) {
          for (const shiftId in record.schedule) {
            const slot = record.schedule[shiftId];
            if (slot?.patientId && this.patientMap().has(slot.patientId)) {
              slot.autoNote = generateAutoNote(this.patientMap().get(slot.patientId)) || '';
            }
          }
        }
      });

      const newWeekRecords = new Map<string, any>();
      this.weekDates().forEach((day: any) => newWeekRecords.set(day.queryDate, { id: null, date: day.queryDate, schedule: {} }));
      fetchedRecords.forEach((record: any) => {
        if (record?.date) newWeekRecords.set(record.date, record);
      });

      this.weekScheduleRecords.set(newWeekRecords);
      this.statusText.set('資料已載入');
    } catch (error) {
      console.error('[WeeklyView] 讀取週排班資料失敗:', error);
      this.statusText.set('讀取失敗');
    }
  }

  getWeeklyCellStyle = (slotId: string): Record<string, string> => {
    const slotData = this.weekScheduleMap()[slotId];
    const patientForStyle = this.getArchivedOrLivePatientInfo(slotData);
    if (!patientForStyle) return {};
    const patientId = slotData?.patientId;
    if (!patientId) return getUnifiedCellStyle(slotData, patientForStyle, null, []);
    return getUnifiedCellStyle(slotData, patientForStyle, null, this.typesMapForThisWeek().get(patientId) || []);
  };

  updateLeftOffset(newOffset: number): void { this.leftOffset.set(newOffset); }
  updateColumnWidths(newWidths: number[]): void { this.columnWidths.set(newWidths); }

  locatePatientOnGrid(patientId: string): void {
    this.searchQuery.set('');
    this.isSearchFocused.set(false);
    const targetSlotId = Object.keys(this.weekScheduleMap()).find(slotId => this.weekScheduleMap()[slotId]?.patientId === patientId);
    if (!targetSlotId) {
      this.showAlert('提示', '該病人本週無排班。');
      return;
    }
    setTimeout(() => {
      const el = document.querySelector(`[data-slot-id="${targetSlotId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        el.classList.add('highlight-flash');
        setTimeout(() => el.classList.remove('highlight-flash'), 2000);
      }
    });
  }

  handleSearchBlur(): void { setTimeout(() => this.isSearchFocused.set(false), 200); }

  showPatientMemos(patientId: string): void {
    if (!patientId) return;
    const patient = this.patientMap().get(patientId) as any;
    if (!patient) return;
    this.patientIdForDialog.set(patientId);
    this.patientNameForDialog.set(patient.name);
    this.isMemoDialogVisible.set(true);
  }

  isDateInPast = (dayIndex: number): boolean => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const scheduleDate = new Date(this.currentWeekStartDate());
    scheduleDate.setDate(scheduleDate.getDate() + dayIndex);
    return scheduleDate.getTime() < today.getTime();
  };

  setChange(): void {
    if (this.isPageLocked()) return;
    this.hasUnsavedChanges.set(true);
    this.statusText.set('有未儲存的變更');
  }

  getDailyShiftIdFromWeekly(weeklySlotId: string): { dateStr: string; dailyShiftId: string } | null {
    if (!weeklySlotId) return null;
    const parts = weeklySlotId.split('-');
    const bed = parts.slice(0, -2).join('-');
    const dayIndex = parseInt(parts[parts.length - 1], 10);
    const shiftCode = this.SHIFTS[parseInt(parts[parts.length - 2], 10)];
    const dateStr = this.weekDates()[dayIndex]?.queryDate;
    if (!dateStr || !shiftCode) return null;
    return { dateStr, dailyShiftId: bed.startsWith('peripheral') ? `${bed}-${shiftCode}` : `bed-${bed}-${shiftCode}` };
  }

  handleSlotUpdate(weeklySlotId: string, slotData: any): void {
    if (this.isPageLocked()) return;
    const targetInfo = this.getDailyShiftIdFromWeekly(weeklySlotId);
    if (!targetInfo) return;
    const { dateStr, dailyShiftId } = targetInfo;
    if (this.isDateInPast(this.weekDates().findIndex((d: any) => d.queryDate === dateStr))) {
      this.showAlert('操作禁止', '無法修改已過去的排程。');
      return;
    }
    const newWeekRecords = new Map(this.weekScheduleRecords());
    const oldRecord = newWeekRecords.get(dateStr) || { id: null, date: dateStr, schedule: {}, names: {} };
    const newDailySchedule = { ...oldRecord.schedule };
    if (slotData?.patientId) {
      const patient = this.patientMap().get(slotData.patientId);
      const newSlot = createEmptySlotData(dailyShiftId);
      Object.assign(newSlot, slotData);
      newSlot.shiftId = dailyShiftId.split('-').pop();
      newSlot.autoNote = patient ? generateAutoNote(patient) : '';
      newDailySchedule[dailyShiftId] = newSlot;
    } else {
      delete newDailySchedule[dailyShiftId];
    }
    newWeekRecords.set(dateStr, { ...oldRecord, schedule: newDailySchedule });
    this.weekScheduleRecords.set(newWeekRecords);
    this.setChange();
  }

  handleGridClick(slotId: string): void {
    const dayIndex = parseInt(slotId.split('-').pop()!, 10);
    if (this.isPageLocked() || this.isDateInPast(dayIndex)) {
      const patientId = this.weekScheduleMap()[slotId]?.patientId;
      if (patientId) this.showPatientMemos(patientId);
      return;
    }
    if (this.weekScheduleMap()[slotId]?.patientId) {
      this.clearingSlotId.set(slotId);
      this.isClearDialogVisible.set(true);
    } else {
      this.currentSlotId.set(slotId);
      this.isPatientSelectDialogVisible.set(true);
    }
  }

  handlePatientSelect(event: { patientId: string; fillType: string }): void {
    const { patientId, fillType } = event;
    if (this.isPageLocked() || !patientId || !this.currentSlotId()) return;
    const patient = this.patientMap().get(patientId) as any;
    if (!patient) return;
    this.isPatientSelectDialogVisible.set(false);
    const newPatientData = { patientId, manualNote: patient.baseNote || (patient.status === 'ipd' ? '住' : '') };
    if (fillType === 'single') {
      this.handleSlotUpdate(this.currentSlotId()!, newPatientData);
    } else if (fillType === 'frequency') {
      const dayIndices = this.FREQ_MAP_TO_DAY_INDEX[patient.freq] || [];
      if (dayIndices.length === 0) {
        this.showAlert('排班提示', `病人 ${patient.name} 未設定有效頻率，僅單次排入。`);
        this.handleSlotUpdate(this.currentSlotId()!, newPatientData);
        this.currentSlotId.set(null);
        return;
      }
      const conflicts: string[] = [];
      const parts = this.currentSlotId()!.split('-');
      const bed = parts.slice(0, -2).join('-');
      const shiftIndex = parts[parts.length - 2];
      dayIndices.forEach((di: number) => {
        if (!this.isDateInPast(di) && this.weekScheduleMap()[`${bed}-${shiftIndex}-${di}`]?.patientId)
          conflicts.push(this.WEEKDAYS[di]);
      });
      if (conflicts.length > 0) {
        this.showAlert('排班衝突', `無法依頻率排入，以下日期的床位已被佔用：\n${conflicts.join(', ')}`);
      } else {
        dayIndices.forEach((di: number) => { if (!this.isDateInPast(di)) this.handleSlotUpdate(`${bed}-${shiftIndex}-${di}`, newPatientData); });
      }
    }
    this.currentSlotId.set(null);
  }

  handleAssignBed(event: { patientId: string; bedNum: any; shiftCode: string }): void {
    if (this.isPageLocked()) return;
    const patient = this.patientMap().get(event.patientId) as any;
    if (!patient?.freq) return;
    const dayIndices = this.FREQ_MAP_TO_DAY_INDEX[patient.freq] || [];
    const shiftIndex = this.SHIFTS.indexOf(event.shiftCode);
    if (shiftIndex === -1 || dayIndices.length === 0) return;
    const newPatientData = { patientId: event.patientId, manualNote: patient.baseNote || (patient.status === 'ipd' ? '住' : patient.status === 'er' ? '急' : '') };
    dayIndices.forEach((di: number) => {
      if (!this.isDateInPast(di) && !this.weekScheduleMap()[`${event.bedNum}-${shiftIndex}-${di}`]?.patientId)
        this.handleSlotUpdate(`${event.bedNum}-${shiftIndex}-${di}`, newPatientData);
    });
    this.isProblemSolverDialogVisible.set(false);
  }

  handleClearSelect(selectedValue: string): void {
    if (this.isPageLocked() || !this.clearingSlotId()) return;
    const patientIdToClear = this.weekScheduleMap()[this.clearingSlotId()!]?.patientId;
    const startDayIndex = parseInt(this.clearingSlotId()!.split('-').pop()!, 10);
    if (this.isDateInPast(startDayIndex) && selectedValue !== 'this_week_for_patient') {
      this.showAlert('操作禁止', '無法修改已過去的排程。');
      this.isClearDialogVisible.set(false);
      return;
    }
    if (selectedValue === 'single') {
      this.handleSlotUpdate(this.clearingSlotId()!, null);
    } else if (selectedValue === 'this_week_for_patient' && patientIdToClear) {
      for (const slotId in this.weekScheduleMap()) {
        const currentDayIndex = parseInt(slotId.split('-').pop()!, 10);
        if (this.weekScheduleMap()[slotId]?.patientId === patientIdToClear && !this.isDateInPast(currentDayIndex))
          this.handleSlotUpdate(slotId, null);
      }
    }
    this.isClearDialogVisible.set(false);
    this.clearingSlotId.set(null);
  }

  async saveChangesToCloud(): Promise<void> {
    if (this.isPageLocked()) { this.showAlert('操作失敗', '操作被鎖定：權限不足。'); return; }
    this.statusText.set('儲存中...');
    try {
      const promises: Promise<any>[] = [];
      for (const date of this.weekDates().map((d: any) => d.queryDate)) {
        if (this.isDateInPast(this.weekDates().findIndex((d: any) => d.queryDate === date))) continue;
        const dailyRecord = this.weekScheduleRecords().get(date);
        if (dailyRecord) {
          const scheduleToSave: Record<string, any> = {};
          for (const shiftId in dailyRecord.schedule) {
            const slotData = dailyRecord.schedule[shiftId];
            if (slotData?.patientId) {
              const cleanSlotData = { patientId: slotData.patientId, shiftId: slotData.shiftId, autoNote: slotData.autoNote || '', manualNote: slotData.manualNote || '' };
              if (cleanSlotData.shiftId === undefined) {
                this.showAlert('儲存失敗', `資料錯誤：在 ${date} 的排班中發現無效資料（shiftId 未定義），無法儲存。請重新整理頁面後，再進行操作。`);
                this.statusText.set('儲存失敗');
                return;
              }
              scheduleToSave[shiftId] = cleanSlotData;
            }
          }
          const dataToSave = { date, schedule: scheduleToSave };
          if (dailyRecord.id) promises.push(optimizedUpdateSchedule(dailyRecord.id, dataToSave));
          else if (Object.keys(scheduleToSave).length > 0) promises.push(optimizedSaveSchedule(dataToSave));
        }
      }
      await Promise.all(promises);
      this.hasUnsavedChanges.set(false);
      this.statusText.set('變更已儲存！');
      this.showAlert('操作成功', '週排班已成功儲存！');
      await this.loadDataForWeek();
    } catch (error: any) {
      console.error('[WeeklyView] 儲存失敗:', error);
      this.statusText.set('儲存失敗');
      this.showAlert('儲存失敗', `儲存失敗：${error.message}`);
    }
  }

  onDrop(event: DragEvent, targetWeeklySlotId: string): void {
    if (this.isPageLocked()) return;
    if (event?.preventDefault) event.preventDefault();
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    const dragged = this.draggedItem();
    if (!dragged) return;
    const targetDayIndex = parseInt(targetWeeklySlotId.split('-').pop()!, 10);
    if (this.isDateInPast(targetDayIndex)) { this.draggedItem.set(null); return; }
    const sourceWeeklySlotId = dragged.source;
    const sourceSlotData = { ...dragged.data };
    const targetSlotData = { ...this.weekScheduleMap()[targetWeeklySlotId] };
    if (targetSlotData?.patientId) {
      if (sourceWeeklySlotId === 'sidebar') { this.showAlert('操作失敗', '目標床位已被佔用，無法從側邊欄拖曳至此。'); this.draggedItem.set(null); return; }
      const sourceDayIndex = parseInt(sourceWeeklySlotId.split('-').pop()!, 10);
      if (this.isDateInPast(sourceDayIndex)) { this.draggedItem.set(null); return; }
      this.handleSlotUpdate(targetWeeklySlotId, sourceSlotData);
      this.handleSlotUpdate(sourceWeeklySlotId, targetSlotData);
    } else {
      this.handleSlotUpdate(targetWeeklySlotId, sourceSlotData);
      if (sourceWeeklySlotId !== 'sidebar') this.handleSlotUpdate(sourceWeeklySlotId, null);
    }
    this.draggedItem.set(null);
  }

  onDragStart(event: DragEvent, slotId: string): void {
    if (this.isPageLocked()) { event.preventDefault(); return; }
    const dayIndex = parseInt(slotId.split('-').pop()!, 10);
    if (this.isDateInPast(dayIndex)) { event.preventDefault(); return; }
    const slotData = this.weekScheduleMap()[slotId];
    if (!slotData?.patientId) { event.preventDefault(); return; }
    this.draggedItem.set({ source: slotId, data: { ...slotData } });
    event.dataTransfer!.effectAllowed = 'move';
  }

  onSidebarDragStart(event: DragEvent, patient: any): void {
    if (this.isPageLocked() || !patient?.id) { event.preventDefault(); return; }
    this.draggedItem.set({ source: 'sidebar', data: { patientId: patient.id, manualNote: patient.status === 'ipd' ? '住' : '' } });
    event.dataTransfer!.effectAllowed = 'move';
  }

  showConfirmDialog(title: string, message: string, onConfirm: () => void): void {
    this.confirmDialogTitle.set(title);
    this.confirmDialogMessage.set(message);
    this.confirmAction.set(onConfirm);
    this.isConfirmDialogVisible.set(true);
  }

  changeWeek(days: number): void {
    const doChange = () => {
      const newDate = new Date(this.currentWeekStartDate());
      newDate.setDate(newDate.getDate() + days);
      this.currentWeekStartDate.set(newDate);
      this.loadDataForWeek();
    };
    if (this.hasUnsavedChanges() && !this.isPageLocked()) {
      this.showConfirmDialog('未儲存的變更', '您有未儲存的變更，確定要切換日期嗎？', doChange);
    } else { doChange(); }
  }

  goToToday(): void {
    const doChange = () => { this.currentWeekStartDate.set(this.getStartOfWeek(new Date())); this.loadDataForWeek(); };
    if (this.hasUnsavedChanges() && !this.isPageLocked()) {
      this.showConfirmDialog('未儲存的變更', '您有未儲存的變更，確定要切換到本週嗎？', doChange);
    } else { doChange(); }
  }

  handleConfirm(): void {
    const action = this.confirmAction();
    if (typeof action === 'function') action();
    this.isConfirmDialogVisible.set(false);
    this.confirmAction.set(null);
  }

  handleCancel(): void { this.isConfirmDialogVisible.set(false); this.confirmAction.set(null); }

  onDragOver(event: DragEvent): void {
    if (this.isPageLocked()) return;
    event.preventDefault();
    const targetSlot = (event.target as HTMLElement).closest('.schedule-slot');
    if (targetSlot) {
      const slotId = (targetSlot as HTMLElement).dataset['slotId'];
      if (slotId && !this.isDateInPast(parseInt(slotId.split('-').pop()!, 10))) targetSlot.classList.add('drag-over');
    }
  }

  onDragLeave(event: DragEvent): void {
    (event.target as HTMLElement).closest('.schedule-slot')?.classList.remove('drag-over');
  }

  runScheduleCheck(): void {
    const validationResult: any = { duplicates: [], freqMismatch: [], unassignedCrucial: [], unassignedAll: [] };
    for (let dayIndex = 0; dayIndex < 6; dayIndex++) {
      if (this.isDateInPast(dayIndex)) continue;
      const dayPatients = new Map<string, string[]>();
      for (const slotId in this.weekScheduleMap()) {
        const parts = slotId.split('-');
        let slotDayIndex: number, shiftIndex: number, bedInfo: string;
        if (parts[0] === 'peripheral') { bedInfo = `外圍床位${parts[1]}`; shiftIndex = parseInt(parts[2], 10); slotDayIndex = parseInt(parts[3], 10); }
        else { bedInfo = `${parts[0]}號床`; shiftIndex = parseInt(parts[1], 10); slotDayIndex = parseInt(parts[2], 10); }
        if (slotDayIndex === dayIndex) {
          const slotData = this.weekScheduleMap()[slotId];
          if (slotData?.patientId) {
            const patient = this.patientMap().get(slotData.patientId) as any;
            if (patient) {
              const shiftNames: Record<number, string> = { 0: '早班', 1: '午班', 2: '晚班' };
              if (!dayPatients.has(patient.name)) dayPatients.set(patient.name, []);
              dayPatients.get(patient.name)!.push(`${bedInfo}${shiftNames[shiftIndex] || '未知班次'}`);
            }
          }
        }
      }
      for (const [patientName, locations] of dayPatients.entries()) {
        if (locations.length > 1) validationResult.duplicates.push(`${this.WEEKDAYS[dayIndex]}: ${patientName} 重複排班 (${locations.join('、')})`);
      }
    }
    const scheduledIds = new Set<string>();
    for (const slotId in this.weekScheduleMap()) {
      const slotData = this.weekScheduleMap()[slotId];
      if (slotData?.patientId) scheduledIds.add(slotData.patientId);
    }
    this.allPatients().filter((p: any) => !scheduledIds.has(p.id) && (p.status === 'ipd' || p.status === 'er') && !p.isDeleted && !p.isDiscontinued)
      .forEach((p: any) => validationResult.unassignedCrucial.push(`${p.name} (${p.status === 'ipd' ? '住院' : '急診'})`));
    this.allPatients().filter((p: any) => !scheduledIds.has(p.id) && !p.isDeleted && !p.isDiscontinued)
      .forEach((p: any) => validationResult.unassignedAll.push(`${p.name} (${p.status === 'opd' ? '門診' : p.status === 'ipd' ? '住院' : p.status === 'er' ? '急診' : '未知'})`));
    const patientSchedules = new Map<string, Set<number>>();
    for (const slotId in this.weekScheduleMap()) {
      const slotData = this.weekScheduleMap()[slotId];
      if (slotData?.patientId) {
        const di = parseInt(slotId.split('-').pop()!, 10);
        if (!this.isDateInPast(di)) {
          if (!patientSchedules.has(slotData.patientId)) patientSchedules.set(slotData.patientId, new Set());
          patientSchedules.get(slotData.patientId)!.add(di);
        }
      }
    }
    for (const [patientId, scheduledDays] of patientSchedules.entries()) {
      const patient = this.patientMap().get(patientId) as any;
      if (!patient?.freq || patient.status !== 'opd') continue;
      const expectedDays = new Set((this.FREQ_MAP_TO_DAY_INDEX[patient.freq] || []).filter((d: number) => !this.isDateInPast(d)));
      if (scheduledDays.size !== expectedDays.size || ![...scheduledDays].every(d => expectedDays.has(d))) {
        const actualDaysText = [...scheduledDays].sort().map(d => this.WEEKDAYS[d].replace('星期', '')).join('');
        const expectedDaysText = [...expectedDays].sort().map(d => this.WEEKDAYS[d].replace('星期', '')).join('');
        validationResult.freqMismatch.push(`${patient.name} (頻率: ${patient.freq}) - 實際排程: 週${actualDaysText || '無'}, 應排程: 週${expectedDaysText}`);
      }
    }
    let issueMessage = '';
    if (validationResult.unassignedCrucial.length > 0) issueMessage += '【重要病人未排班】:\n- ' + validationResult.unassignedCrucial.join('\n- ') + '\n\n';
    if (validationResult.duplicates.length > 0) issueMessage += '【重複排班問題】:\n- ' + validationResult.duplicates.join('\n- ') + '\n\n';
    if (validationResult.freqMismatch.length > 0) issueMessage += '【頻率不符問題】:\n- ' + validationResult.freqMismatch.join('\n- ') + '\n\n';
    if (validationResult.unassignedAll.length > 0) issueMessage += '【本週完全未排班病人】:\n- ' + validationResult.unassignedAll.join('\n- ') + '\n\n';
    this.showAlert(issueMessage ? '排班檢查結果 (僅未來日期)' : '排程檢視完畢', issueMessage || '太棒了！未來排程沒有發現問題。');
  }

  openBedAssignmentDialog(): void { if (!this.isPageLocked()) this.isProblemSolverDialogVisible.set(true); }

  exportWeeklyScheduleToExcel(): void {
    if (this.patientStore.isLoading()) { this.showAlert('提示', '資料正在載入中，請稍後再試。'); return; }
    const data: any[][] = [['部立台北醫院 週排班總表'], [`週別: ${this.weekDisplay()}`], []];
    const headers = ['床號', ...this.weekDates().map((d: any) => `${d.weekday} ${d.date}`)];
    data.push(headers);
    const statusMap: Record<string, string> = { opd: '門診', ipd: '住院', er: '急診' };
    const allBedsToExport = [
      ...this.bedLayout.filter((b: any) => typeof b === 'number').sort((a: any, b: any) => a - b),
      ...this.bedLayout.filter((b: any) => typeof b === 'string').sort(),
    ].map((b: any) => (String(b).startsWith('peripheral-') ? `外圍 ${String(b).split('-')[1]}` : b));
    allBedsToExport.forEach((bedKey: any) => {
      const row: any[] = [bedKey];
      for (let dayIndex = 0; dayIndex < 6; dayIndex++) {
        let cellText = '';
        ORDERED_SHIFT_CODES.forEach((shiftCode: string) => {
          const shiftIndex = this.SHIFTS.indexOf(shiftCode);
          const bedNumForId = String(bedKey).startsWith('外圍') ? `peripheral-${String(bedKey).replace('外圍 ', '')}` : bedKey;
          const slot = this.weekScheduleMap()[`${bedNumForId}-${shiftIndex}-${dayIndex}`];
          if (slot?.patientId) {
            const patient = this.patientMap().get(slot.patientId) as any;
            const patientInfo = this.getArchivedOrLivePatientInfo(slot);
            if (patient && patientInfo) cellText += `${getShiftDisplayName(shiftCode)}: ${patient.name} (${statusMap[patientInfo.status] || '未知'})\n`;
          }
        });
        row.push(cellText.trim());
      }
      data.push(row);
    });
    const worksheet = XLSX.utils.aoa_to_sheet(data);
    worksheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: headers.length - 1 } }];
    worksheet['!cols'] = [{ wch: 8 }, ...Array(6).fill({ wch: 30 })];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '週排班表');
    XLSX.writeFile(workbook, `週排班表_${formatDateToYYYYMMDD(this.currentWeekStartDate())}.xlsx`);
  }

  showAlert(title: string, message: string): void {
    this.alertDialogTitle.set(title);
    this.alertDialogMessage.set(message);
    this.isAlertDialogVisible.set(true);
  }
}
