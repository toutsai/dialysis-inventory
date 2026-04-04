import { Component, inject, signal, computed, OnInit, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { where } from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { FirebaseService } from '@services/firebase.service';
import { AuthService } from '@app/core/services/auth.service';
import { ApiManagerService, type ApiManager } from '@app/core/services/api-manager.service';
import { PatientStoreService } from '@app/core/services/patient-store.service';
import { UserDirectoryService } from '@app/core/services/user-directory.service';
import { AlertDialogComponent } from '@app/components/dialogs/alert-dialog/alert-dialog.component';
import { ConfirmDialogComponent } from '@app/components/dialogs/confirm-dialog/confirm-dialog.component';

@Component({
  selector: 'app-physician-schedule',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AlertDialogComponent,
    ConfirmDialogComponent,
  ],
  templateUrl: './physician-schedule.component.html',
  styleUrl: './physician-schedule.component.css'
})
export class PhysicianScheduleComponent implements OnInit, OnDestroy {
  private readonly firebaseService = inject(FirebaseService);
  private readonly authService = inject(AuthService);
  private readonly apiManagerService = inject(ApiManagerService);
  private readonly patientStore = inject(PatientStoreService);
  private readonly userDirectory = inject(UserDirectoryService);

  private usersApi!: ApiManager<any>;
  private physicianSchedulesApi!: ApiManager<any>;

  // Page state
  isLoading = signal(true);
  isSidebarLoading = signal(true);
  selectedDate = signal(new Date());
  availablePhysicians = signal<any[]>([]);
  scheduleData: Record<string, any> = {};
  consultationScheduleData: Record<string, any> = {};
  emergencyRecords: any[] = [];
  scheduleNotes = '';
  hasUnsavedChanges = signal(false);
  physicianClinicSelections: Record<string, string[]> = {};
  monthlyPdClinicSelections: Record<string, any[]> = {};
  statsViewMode = signal<'monthly' | 'ytd'>('monthly');
  yearScheduleData = signal<Record<string, any>>({});
  mobileDisplayMode = signal<'day' | 'week'>('day');
  activeMobilePanel = signal<string | null>('physicians');
  activeTab = signal<'dialysis' | 'consultation' | 'emergency'>('dialysis');

  // Patient search
  activeSearch = signal<{ type: string | null; index: number }>({ type: null, index: -1 });
  patientSearchResults = signal<any[]>([]);
  isAutocompleteVisible = signal(false);
  autocompleteStyle: Record<string, string> = { top: '0px', left: '0px', width: '0px' };

  // Panel data
  bloodDrawDate1 = '';
  bloodDrawDate2 = '';
  reportDate1 = '';
  reportDate2 = '';
  managedHolidays: any[] = [];
  holidayForm = { name: '', customName: '', date: '' };

  // Dialog state
  isAlertDialogVisible = signal(false);
  alertDialogTitle = signal('');
  alertDialogMessage = signal('');
  isConfirmDialogVisible = signal(false);
  confirmDialogTitle = signal('');
  confirmDialogMessage = signal('');
  confirmAction = signal<(() => void) | null>(null);
  cancelAction = signal<(() => void) | null>(null);

  // Holiday data
  readonly holidays2025 = [
    { name: '中華民國開國紀念日', date: '2025-01-01' },
    { name: '農曆除夕', date: '2025-01-28' },
    { name: '農曆春節', date: '2025-01-29' },
    { name: '農曆春節', date: '2025-01-30' },
    { name: '農曆春節', date: '2025-01-31' },
    { name: '和平紀念日', date: '2025-02-28' },
    { name: '兒童節', date: '2025-04-04' },
    { name: '民族掃墓節(清明節)', date: '2025-04-05' },
    { name: '端午節', date: '2025-05-31' },
    { name: '中秋節', date: '2025-10-06' },
    { name: '國慶日', date: '2025-10-10' },
  ];
  readonly holidays2026 = [
    { name: '中華民國開國紀念日', date: '2026-01-01' },
    { name: '農曆除夕', date: '2026-02-16' },
    { name: '農曆春節', date: '2026-02-17' },
    { name: '農曆春節', date: '2026-02-18' },
    { name: '農曆春節', date: '2026-02-19' },
    { name: '農曆春節', date: '2026-02-20' },
    { name: '農曆春節', date: '2026-02-21' },
    { name: '和平紀念日', date: '2026-02-28' },
    { name: '兒童節', date: '2026-04-04' },
    { name: '民族掃墓節(清明節)', date: '2026-04-05' },
    { name: '端午節', date: '2026-06-19' },
    { name: '中秋節', date: '2026-09-25' },
    { name: '國慶日', date: '2026-10-10' },
  ];
  readonly physicianColorClasses = [
    'physician-color-1', 'physician-color-2', 'physician-color-3',
    'physician-color-4', 'physician-color-5',
  ];

  // Computed
  get canManagePhysicianSchedule(): boolean {
    return this.authService.canManagePhysicianSchedule();
  }

  statusText = computed(() => this.hasUnsavedChanges() ? '有未儲存的變更' : '所有變更已儲存');
  selectedYear = computed(() => this.selectedDate().getFullYear());
  selectedMonth = computed(() => this.selectedDate().getMonth() + 1);
  selectedYearMonth = computed(() => `${this.selectedYear()}-${String(this.selectedMonth()).padStart(2, '0')}`);

  clinicOptions = computed(() => {
    const weekdays = ['一', '二', '三', '四', '五', '六'];
    const shifts: Record<string, string> = { AM: '上', PM: '下', NT: '晚' };
    const options: { value: string; text: string }[] = [];
    for (let i = 1; i <= 6; i++) {
      if (i === 6) {
        options.push({ value: `${i}-AM`, text: `週${weekdays[i - 1]}上` });
      } else {
        for (const shiftCode in shifts) {
          options.push({ value: `${i}-${shiftCode}`, text: `週${weekdays[i - 1]}${shifts[shiftCode]}` });
        }
      }
    }
    return options;
  });

  get specialDatesSet(): Set<string> {
    const dates = new Set<string>();
    if (this.bloodDrawDate1) dates.add(this.bloodDrawDate1);
    if (this.bloodDrawDate2) dates.add(this.bloodDrawDate2);
    if (this.reportDate1) dates.add(this.reportDate1);
    if (this.reportDate2) dates.add(this.reportDate2);
    return dates;
  }

  daysInMonth = computed(() => {
    const year = this.selectedYear();
    const month = this.selectedMonth() - 1;
    const date = new Date(year, month, 1);
    const days: { day: number; isWeekend: boolean }[] = [];
    while (date.getMonth() === month) {
      const dayOfWeek = date.getDay();
      days.push({ day: date.getDate(), isWeekend: dayOfWeek === 0 || dayOfWeek === 6 });
      date.setDate(date.getDate() + 1);
    }
    return days;
  });

  weeklyData = computed(() => {
    if (this.daysInMonth().length === 0) return [];
    const weeks: any[][] = [];
    const firstDayOfMonth = new Date(this.selectedYear(), this.selectedMonth() - 1, 1).getDay();
    const startDayOfWeek = (firstDayOfMonth + 6) % 7;
    let currentWeek: any[] = Array.from({ length: startDayOfWeek }, (_, i) => ({ day: null, placeholderIndex: i }));
    this.daysInMonth().forEach((dayInfo, index) => {
      currentWeek.push({
        ...dayInfo,
        fullDate: `${this.selectedYear()}-${String(this.selectedMonth()).padStart(2, '0')}-${String(dayInfo.day).padStart(2, '0')}`,
      });
      if (currentWeek.length === 7 || index === this.daysInMonth().length - 1) {
        while (currentWeek.length < 7) currentWeek.push({ day: null, placeholderIndex: currentWeek.length });
        weeks.push(currentWeek);
        currentWeek = [];
      }
    });
    return weeks;
  });

  dailyData = computed(() => this.weeklyData().flat().filter((day: any) => day.day !== null));

  scheduleStats = computed(() => {
    return this.availablePhysicians().map((doc: any) => {
      const stats = { name: doc.name, monthlyWeekday: 0, monthlyWeekend: 0, ytdTotal: 0, ytdHolidays: 0, ytdWeekends: 0 };
      const currentMonthData = this.scheduleData;
      if (Object.keys(currentMonthData).length > 0) {
        this.daysInMonth().forEach((dayInfo) => {
          ['early', 'noon', 'late'].forEach((shift) => {
            if (currentMonthData[dayInfo.day]?.[shift]?.physicianId === doc.id) {
              if (dayInfo.isWeekend) stats.monthlyWeekend++;
              else stats.monthlyWeekday++;
            }
          });
        });
      }
      for (const monthKey in this.yearScheduleData()) {
        const monthScheduleData = this.yearScheduleData()[monthKey];
        if (!monthScheduleData || !monthScheduleData.schedule) continue;
        const { schedule: monthSchedule, managedHolidays: holidays = [], year, month: monthNum } = monthScheduleData;
        const monthHolidays = new Set(holidays.map((h: any) => h.date));
        const daysInThisMonth = new Date(year, monthNum, 0).getDate();
        for (let day = 1; day <= daysInThisMonth; day++) {
          const date = new Date(year, monthNum - 1, day);
          const dayOfWeek = date.getDay();
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
          const dateStr = `${year}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const isHoliday = monthHolidays.has(dateStr);
          ['early', 'noon', 'late'].forEach((shift) => {
            if (monthSchedule[day]?.[shift]?.physicianId === doc.id) {
              stats.ytdTotal++;
              if (isHoliday && !isWeekend) stats.ytdHolidays++;
              if (isWeekend) stats.ytdWeekends++;
            }
          });
        }
      }
      return stats;
    });
  });

  physicianClassMap = computed(() => {
    const map = new Map<string, string>();
    this.availablePhysicians().forEach((doc: any, index: number) => {
      map.set(doc.id, this.physicianColorClasses[index % this.physicianColorClasses.length]);
    });
    return map;
  });

  currentYearHolidays = computed(() => {
    switch (this.selectedYear()) {
      case 2025: return this.holidays2025;
      case 2026: return this.holidays2026;
      default: return [];
    }
  });

  private previousYearMonth = '';

  ngOnInit(): void {
    this.usersApi = this.apiManagerService.create('users');
    this.physicianSchedulesApi = this.apiManagerService.create('physician_schedules');

    this.isLoading.set(true);
    this.loadAllData();
  }

  ngOnDestroy(): void {
    // Cleanup if needed
  }

  markUnsaved(): void {
    if (!this.isLoading()) {
      this.hasUnsavedChanges.set(true);
    }
  }

  onYearMonthChange(): void {
    const current = this.selectedYearMonth();
    if (current !== this.previousYearMonth && this.previousYearMonth) {
      this.loadScheduleForDate(this.selectedDate());
      this.loadYearDataInBackground(this.selectedDate());
    }
    this.previousYearMonth = current;
  }

  onHolidayNameChange(): void {
    if (this.holidayForm.name && this.holidayForm.name !== 'custom') {
      const found = this.currentYearHolidays().find((h: any) => h.name === this.holidayForm.name);
      if (found) this.holidayForm.date = found.date;
    }
  }

  handlePatientSearch(index: number, type: string): void {
    if (type !== 'emergency') return;
    const query = this.emergencyRecords[index].patientName.toLowerCase();
    if (!query) { this.patientSearchResults.set([]); return; }
    this.patientSearchResults.set(
      this.patientStore.allPatients().filter((p: any) =>
        p.name.toLowerCase().includes(query) || p.medicalRecordNumber.includes(query)
      )
    );
  }

  showAutocomplete(event: Event, index: number, type: string): void {
    this.activeSearch.set({ type, index });
    this.handlePatientSearch(index, type);
    const inputElement = event.target as HTMLElement;
    const rect = inputElement.getBoundingClientRect();
    this.autocompleteStyle = {
      top: `${rect.bottom + window.scrollY}px`,
      left: `${rect.left + window.scrollX}px`,
      width: `${rect.width}px`,
    };
    this.isAutocompleteVisible.set(true);
  }

  hideAutocomplete(): void {
    setTimeout(() => this.isAutocompleteVisible.set(false), 200);
  }

  selectPatient(patient: any, index: number, type: string): void {
    if (type === 'emergency') {
      const record = this.emergencyRecords[index];
      record.patientId = patient.id;
      record.patientName = patient.name;
      record.medicalRecordNumber = patient.medicalRecordNumber;
    }
    this.isAutocompleteVisible.set(false);
  }

  async loadScheduleForDate(date: Date): Promise<void> {
    this.isLoading.set(true);
    this.hasUnsavedChanges.set(false);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
    try {
      // ✅ 優化：只載入當月班表，年度排班在背景載入
      const existingSchedule = await this.physicianSchedulesApi.fetchById(yearMonth) as any;
      // ✅ 先用本地變數建立完整班表，避免預設班表閃現
      const blankSchedule = this.generateBlankSchedule(year, month, this.availablePhysicians());
      const blankConsultation = this.generateBlankConsultationSchedule(year, month, this.availablePhysicians());
      let emergencyRecords: any[] = [];
      const pdSelections: Record<string, any[]> = {};
      this.availablePhysicians().forEach((doc: any) => {
        pdSelections[doc.id] = [{ date: '', shift: '' }, { date: '', shift: '' }];
      });
      let notes = '';
      let bd1 = '', bd2 = '', rp1 = '', rp2 = '';
      let holidays: any[] = [];

      if (existingSchedule) {
        if (existingSchedule.schedule) {
          for (const day in existingSchedule.schedule) {
            if (blankSchedule[day]) Object.assign(blankSchedule[day], existingSchedule.schedule[day]);
          }
        }
        if (existingSchedule.consultationSchedule) {
          for (const day in existingSchedule.consultationSchedule) {
            if (blankConsultation[day]) Object.assign(blankConsultation[day], existingSchedule.consultationSchedule[day]);
          }
        }
        if (Array.isArray(existingSchedule.emergencyRecords)) emergencyRecords = existingSchedule.emergencyRecords;
        notes = existingSchedule.notes || '';
        const dates = existingSchedule.specialDates || {};
        bd1 = dates.bloodDraw1 || '';
        bd2 = dates.bloodDraw2 || '';
        rp1 = dates.report1 || '';
        rp2 = dates.report2 || '';
        holidays = existingSchedule.managedHolidays || [];
        if (existingSchedule.pdClinicHours) {
          for (const docId in existingSchedule.pdClinicHours) {
            if (pdSelections[docId]) {
              const savedPd = existingSchedule.pdClinicHours[docId];
              pdSelections[docId] = [savedPd[0] || { date: '', shift: '' }, savedPd[1] || { date: '', shift: '' }];
            }
          }
        }
      }

      // ✅ 一次性賦值，只觸發一次渲染
      this.scheduleData = blankSchedule;
      this.consultationScheduleData = blankConsultation;
      this.emergencyRecords = emergencyRecords;
      this.scheduleNotes = notes;
      this.bloodDrawDate1 = bd1;
      this.bloodDrawDate2 = bd2;
      this.reportDate1 = rp1;
      this.reportDate2 = rp2;
      this.managedHolidays = holidays;
      this.monthlyPdClinicSelections = pdSelections;
    } catch (error: any) {
      console.error(`讀取 ${yearMonth} 班表失敗:`, error);
      this.showAlert('讀取失敗', `讀取 ${yearMonth} 班表時發生錯誤。`);
      this.scheduleData = {};
      this.consultationScheduleData = {};
      this.emergencyRecords = [];
    } finally {
      this.isLoading.set(false);
      setTimeout(() => this.hasUnsavedChanges.set(false));
    }
  }

  addEmergencyRecord(): void {
    const today = new Date();
    const year = this.selectedYear();
    const month = this.selectedMonth() - 1;
    const defaultDate = today.getFullYear() === year && today.getMonth() === month
      ? today.toISOString().slice(0, 10)
      : new Date(year, month, 1).toISOString().slice(0, 10);
    this.emergencyRecords.push({
      patientId: null, date: defaultDate, patientName: '', medicalRecordNumber: '',
      reason: '緊急透析', startTime: '00:00', endTime: '00:00', physicianId: null,
    });
  }

  removeEmergencyRecord(index: number): void {
    this.emergencyRecords.splice(index, 1);
  }

  saveScheduleOnly(): Promise<any> {
    const physicianMap = new Map(this.availablePhysicians().map((p: any) => [p.id, p.name]));
    const dataToSave: any = {
      year: this.selectedYear(), month: this.selectedMonth(),
      schedule: {}, consultationSchedule: {},
      emergencyRecords: this.emergencyRecords.filter((r: any) => r.date && r.reason && r.startTime && r.endTime && r.physicianId),
      notes: this.scheduleNotes,
      specialDates: { bloodDraw1: this.bloodDrawDate1, bloodDraw2: this.bloodDrawDate2, report1: this.reportDate1, report2: this.reportDate2 },
      pdClinicHours: {}, managedHolidays: this.managedHolidays,
    };
    for (const docId in this.monthlyPdClinicSelections) {
      const validPdHours = this.monthlyPdClinicSelections[docId].filter((pd: any) => pd.date && pd.shift);
      if (validPdHours.length > 0) dataToSave.pdClinicHours[docId] = validPdHours;
    }
    for (const day in this.scheduleData) {
      if (typeof this.scheduleData[day] !== 'object' || this.scheduleData[day] === null) continue;
      dataToSave.schedule[day] = {};
      for (const shift of ['early', 'noon', 'late']) {
        const physicianId = this.scheduleData[day][shift]?.physicianId || null;
        dataToSave.schedule[day][shift] = { physicianId, name: physicianMap.get(physicianId) || null };
      }
    }
    for (const day in this.consultationScheduleData) {
      if (typeof this.consultationScheduleData[day] !== 'object' || this.consultationScheduleData[day] === null) continue;
      dataToSave.consultationSchedule[day] = {};
      for (const shift of ['morning', 'afternoon', 'night']) {
        const physicianId = this.consultationScheduleData[day][shift]?.physicianId || null;
        dataToSave.consultationSchedule[day][shift] = { physicianId, name: physicianMap.get(physicianId) || null };
      }
    }
    return this.physicianSchedulesApi.save(this.selectedYearMonth(), dataToSave);
  }

  async fetchPhysicians(): Promise<void> {
    try {
      // ✅ 優化：使用已快取的 UserDirectoryService 而非重新查 Firestore
      await this.userDirectory.fetchUsersIfNeeded();
      const physicians = this.userDirectory.allUsers()
        .filter(u => u.title === '主治醫師') as any[];
      const desiredOrder = ['廖丁瑩', '蔡宜潔', '蘇哲弘', '蔡亨政', '林天佑'];
      physicians.sort((a: any, b: any) => {
        const indexA = desiredOrder.indexOf(a.name);
        const indexB = desiredOrder.indexOf(b.name);
        if (indexA !== -1 && indexB !== -1) return indexA - indexB;
        if (indexA !== -1) return -1;
        if (indexB !== -1) return 1;
        return a.name.localeCompare(b.name, 'zh-Hant');
      });
      const clinicSelections: Record<string, string[]> = {};
      physicians.forEach((doc: any) => {
        const hours = Array.isArray(doc.clinicHours) ? doc.clinicHours : [];
        clinicSelections[doc.id] = [hours[0] || '', hours[1] || '', hours[2] || '', hours[3] || ''];
      });
      this.physicianClinicSelections = clinicSelections;
      this.availablePhysicians.set(physicians);
    } catch (error) {
      console.error('讀取主治醫師列表失敗:', error);
      this.showAlert('錯誤', '無法從使用者列表讀取主治醫師資料。');
    }
  }

  generateBlankSchedule(year: number, month: number, physicians: any[]): Record<string, any> {
    const blankSchedule: Record<string, any> = {};
    const daysCount = new Date(year, month, 0).getDate();
    for (let i = 1; i <= daysCount; i++) {
      blankSchedule[i] = { early: { physicianId: null, name: null }, noon: { physicianId: null, name: null }, late: { physicianId: null, name: null } };
    }
    physicians.forEach((physician: any) => {
      if (Array.isArray(physician.defaultSchedules) && physician.defaultSchedules.length > 0) {
        physician.defaultSchedules.forEach((rule: string) => {
          const [ruleDayOfWeek, ruleShift] = rule.split('-');
          for (let day = 1; day <= daysCount; day++) {
            const date = new Date(year, month - 1, day);
            if (date.getDay() == Number(ruleDayOfWeek)) {
              if (blankSchedule[day] && blankSchedule[day][ruleShift]) {
                blankSchedule[day][ruleShift] = { physicianId: physician.id, name: physician.name };
              }
            }
          }
        });
      }
    });
    return blankSchedule;
  }

  generateBlankConsultationSchedule(year: number, month: number, physicians: any[]): Record<string, any> {
    const blankSchedule: Record<string, any> = {};
    const daysCount = new Date(year, month, 0).getDate();
    for (let i = 1; i <= daysCount; i++) {
      blankSchedule[i] = { morning: { physicianId: null, name: null }, afternoon: { physicianId: null, name: null }, night: { physicianId: null, name: null } };
    }
    physicians.forEach((physician: any) => {
      if (Array.isArray(physician.defaultConsultationSchedules) && physician.defaultConsultationSchedules.length > 0) {
        physician.defaultConsultationSchedules.forEach((rule: string) => {
          const [ruleDayOfWeek, ruleShift] = rule.split('-');
          for (let day = 1; day <= daysCount; day++) {
            const date = new Date(year, month - 1, day);
            if (date.getDay() == Number(ruleDayOfWeek)) {
              if (blankSchedule[day] && blankSchedule[day][ruleShift]) {
                blankSchedule[day][ruleShift] = { physicianId: physician.id, name: physician.name };
              }
            }
          }
        });
      }
    });
    return blankSchedule;
  }

  async saveAllChanges(): Promise<void> {
    this.isLoading.set(true);
    const schedulePromise = this.saveScheduleOnly();
    const clinicUpdatePromises = this.availablePhysicians().map((doc: any) => {
      const selectedHours = this.physicianClinicSelections[doc.id] || [];
      const newClinicHours = selectedHours.filter((hour: string) => hour);
      if ((doc.clinicHours || []).sort().join(',') !== [...newClinicHours].sort().join(',')) {
        return this.usersApi.update(doc.id, { clinicHours: newClinicHours }).then(() => {
          // ✅ 儲存成功後直接更新本地資料，不需重新讀取
          doc.clinicHours = newClinicHours;
        });
      }
      return Promise.resolve();
    });
    try {
      await Promise.all([...clinicUpdatePromises, schedulePromise]);
      this.hasUnsavedChanges.set(false);
      this.showAlert('儲存成功', '所有變更已成功儲存！');
    } catch (error) {
      console.error('儲存所有變更失敗:', error);
      this.showAlert('儲存失敗', '儲存時發生錯誤。');
    } finally {
      this.isLoading.set(false);
    }
  }

  addHoliday(): void {
    const name = this.holidayForm.name === 'custom' ? this.holidayForm.customName : this.holidayForm.name;
    const date = this.holidayForm.date;
    if (!name || !date) { this.showAlert('輸入不完整', '請提供完整的假日名稱和日期。'); return; }
    if (this.managedHolidays.some((h: any) => h.date === date)) { this.showAlert('日期重複', '這個日期已經被設定為假日了。'); return; }
    this.managedHolidays.push({ name, date });
    this.managedHolidays.sort((a: any, b: any) => a.date.localeCompare(b.date));
    this.holidayForm = { name: '', customName: '', date: '' };
  }

  removeHoliday(index: number): void {
    this.managedHolidays.splice(index, 1);
  }

  checkClinicConflict(event: Event, day: any, shift: string): void {
    const newPhysicianId = (event.target as HTMLSelectElement).value;
    if (!newPhysicianId) return;
    const physician = this.availablePhysicians().find((p: any) => p.id === newPhysicianId);
    if (!physician) return;
    const date = new Date(this.selectedYear(), this.selectedMonth() - 1, day.day);
    const dayOfWeek = date.getDay();
    const dateStr = `${this.selectedYear()}-${String(this.selectedMonth()).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
    const shiftToCodeMapping: Record<string, string> = { early: 'AM', noon: 'PM', late: 'NT', morning: 'AM', afternoon: 'PM', night: 'NT' };
    const currentShiftCode = shiftToCodeMapping[shift];
    let conflictType: string | null = null;
    const regularConflictCode = `${dayOfWeek === 0 ? 7 : dayOfWeek}-${currentShiftCode}`;
    if ((this.physicianClinicSelections[newPhysicianId] || []).includes(regularConflictCode)) conflictType = '常規門診';
    if ((this.monthlyPdClinicSelections[newPhysicianId] || []).some((pd: any) => pd.date === dateStr && pd.shift === currentShiftCode)) conflictType = 'PD 門診';
    if (conflictType) {
      const targetSchedule = this.activeTab() === 'dialysis' ? this.scheduleData : this.consultationScheduleData;
      const originalPhysicianId = targetSchedule[day.day][shift].physicianId;
      this.confirmDialogTitle.set('門診時間衝突');
      this.confirmDialogMessage.set(`提醒：${(physician as any).name} 醫師在該時段有${conflictType}，您確定要排此班嗎？`);
      this.confirmAction.set(() => { this.isConfirmDialogVisible.set(false); });
      this.cancelAction.set(() => {
        targetSchedule[day.day][shift].physicianId = originalPhysicianId;
        (event.target as HTMLSelectElement).value = originalPhysicianId;
        this.isConfirmDialogVisible.set(false);
      });
      this.isConfirmDialogVisible.set(true);
    }
  }

  getDisplayName(physician: any): string {
    return physician.name === '蔡亨政' ? '政' : physician.name.charAt(0);
  }

  getPhysicianClassById(physicianId: string): string {
    return physicianId ? this.physicianClassMap().get(physicianId) || '' : '';
  }

  getPhysicianClass(day: any, shift: string, scheduleType: string = 'dialysis'): string {
    if (!day || !day.day) return '';
    const targetSchedule = scheduleType === 'dialysis' ? this.scheduleData : this.consultationScheduleData;
    const physicianId = targetSchedule[day.day]?.[shift]?.physicianId;
    return this.getPhysicianClassById(physicianId);
  }

  getDayClass(day: any): string {
    if (!day || !day.day) return 'is-empty';
    const dateStr = `${this.selectedYear()}-${String(this.selectedMonth()).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
    if (this.specialDatesSet.has(dateStr)) return 'is-special-date';
    if (this.managedHolidays.some((h: any) => h.date === dateStr)) return 'is-holiday';
    if (day.isWeekend) return 'is-weekend';
    return 'is-weekday';
  }

  getShiftCellClass(day: any): string {
    if (!day || !day.day) return 'is-empty';
    const dateStr = `${this.selectedYear()}-${String(this.selectedMonth()).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
    if (this.managedHolidays.some((h: any) => h.date === dateStr)) return 'is-holiday-text-only';
    if (day.isWeekend) return 'is-weekend-text-only';
    return '';
  }

  async fetchAllYearSchedules(year: number, endMonth: number): Promise<void> {
    try {
      const schedules = await this.physicianSchedulesApi.fetchAll([where('year', '==', year), where('month', '<=', endMonth)]) as any[];
      const data: Record<string, any> = {};
      schedules.forEach((doc: any) => { data[doc.id] = doc; });
      this.yearScheduleData.set(data);
    } catch (error) {
      console.error(`獲取 ${year} 年排班資料失敗:`, error);
      throw new Error(`獲取 ${year} 年的年度排班資料時發生錯誤。`);
    }
  }

  async loadAllData(): Promise<void> {
    this.isSidebarLoading.set(true);
    try {
      // ✅ Phase 1：醫師清單 + 當月班表並行載入 → 立即渲染
      await this.fetchPhysicians();
      await this.loadScheduleForDate(this.selectedDate());
    } catch (error) {
      console.error('初始化載入失敗:', error);
      this.showAlert('初始化失敗', '載入頁面所需資料時發生錯誤，請重新整理。');
      this.isLoading.set(false);
    }
    // ✅ Phase 2：背景載入年度統計 + 病人資料（不阻擋渲染）
    const date = this.selectedDate();
    Promise.all([
      this.fetchAllYearSchedules(date.getFullYear(), date.getMonth() + 1),
      this.patientStore.fetchPatientsIfNeeded(),
    ]).catch(error => {
      console.warn('背景資料載入失敗:', error);
    }).finally(() => {
      this.isSidebarLoading.set(false);
    });
  }

  /** 背景載入年度統計資料，不阻擋 UI */
  private loadYearDataInBackground(date: Date): void {
    this.isSidebarLoading.set(true);
    this.fetchAllYearSchedules(date.getFullYear(), date.getMonth() + 1)
      .catch(error => console.warn('背景年度資料載入失敗:', error))
      .finally(() => this.isSidebarLoading.set(false));
  }

  goToPreviousMonth(): void {
    const performNavigation = () => {
      const d = new Date(this.selectedDate());
      d.setMonth(d.getMonth() - 1);
      this.selectedDate.set(d);
      this.loadScheduleForDate(d);
      this.loadYearDataInBackground(d);
    };
    if (this.hasUnsavedChanges()) {
      this.confirmDialogTitle.set('未儲存的變更');
      this.confirmDialogMessage.set('您有未儲存的變更，確定要離開嗎？');
      this.confirmAction.set(performNavigation);
      this.cancelAction.set(null);
      this.isConfirmDialogVisible.set(true);
    } else {
      performNavigation();
    }
  }

  goToNextMonth(): void {
    const performNavigation = () => {
      const d = new Date(this.selectedDate());
      d.setMonth(d.getMonth() + 1);
      this.selectedDate.set(d);
      this.loadScheduleForDate(d);
      this.loadYearDataInBackground(d);
    };
    if (this.hasUnsavedChanges()) {
      this.confirmDialogTitle.set('未儲存的變更');
      this.confirmDialogMessage.set('您有未儲存的變更，確定要離開嗎？');
      this.confirmAction.set(performNavigation);
      this.cancelAction.set(null);
      this.isConfirmDialogVisible.set(true);
    } else {
      performNavigation();
    }
  }

  handleConfirm(): void {
    const action = this.confirmAction();
    if (typeof action === 'function') action();
    this.resetConfirmDialog();
  }

  handleCancel(): void {
    const action = this.cancelAction();
    if (typeof action === 'function') action();
    this.resetConfirmDialog();
  }

  resetConfirmDialog(): void {
    this.isConfirmDialogVisible.set(false);
    this.confirmDialogTitle.set('');
    this.confirmDialogMessage.set('');
    this.confirmAction.set(null);
    this.cancelAction.set(null);
  }

  showAlert(title: string, message: string): void {
    this.alertDialogTitle.set(title);
    this.alertDialogMessage.set(message);
    this.isAlertDialogVisible.set(true);
  }

  getWeekday(dateString: string): string {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('zh-TW', { weekday: 'long' }).format(date);
  }

  getPhysicianDisplayName(day: any, shift: string, scheduleType: string = 'dialysis'): string {
    if (!day || !day.day) return '--';
    const targetSchedule = scheduleType === 'dialysis' ? this.scheduleData : this.consultationScheduleData;
    const physicianId = targetSchedule[day.day]?.[shift]?.physicianId;
    if (physicianId) {
      const physician = this.availablePhysicians().find((doc: any) => doc.id === physicianId);
      return physician ? this.getDisplayName(physician) : '--';
    }
    return '--';
  }

  toggleMobilePanel(panelName: string): void {
    if (this.activeMobilePanel() === panelName) this.activeMobilePanel.set(null);
    else this.activeMobilePanel.set(panelName);
  }

  exportEmergencyRecords(): void {
    if (this.emergencyRecords.length === 0) { this.showAlert('提示', '沒有緊急出勤紀錄可供匯出。'); return; }
    const aoa: any[][] = [];
    const title = `${this.selectedMonth()}月 腎臟科醫師緊急出勤名單`;
    const headerRow = ['日期', '病人姓名', '病歷號', '出勤原因', '起(時分)', '迄(時分)', '出勤醫師'];
    aoa.push([title]);
    aoa.push(headerRow);
    const sortedRecords = [...this.emergencyRecords].sort((a, b) => a.date.localeCompare(b.date));
    sortedRecords.forEach((r) => {
      aoa.push([r.date, r.patientName, r.medicalRecordNumber, r.reason, r.startTime, r.endTime, this.getPhysicianNameById(r.physicianId)]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headerRow.length - 1 } }];
    ws['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 12 }, { wch: 35 }, { wch: 15 }, { wch: 15 }, { wch: 15 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '緊急出勤紀錄');
    XLSX.writeFile(wb, `醫師緊急出勤紀錄_${this.selectedYear()}-${this.selectedMonth()}.xlsx`);
  }

  getPhysicianNameById(physicianId: string): string {
    if (!physicianId) return '未指定';
    const physician = this.availablePhysicians().find((p: any) => p.id === physicianId);
    return physician ? (physician as any).name : '未知醫師';
  }
}
