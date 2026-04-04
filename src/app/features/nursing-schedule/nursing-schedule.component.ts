import {
  Component,
  inject,
  signal,
  computed,
  OnInit,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import { httpsCallable } from 'firebase/functions';
import { AuthService } from '@app/core/services/auth.service';
import { FirebaseService } from '@services/firebase.service';
import { ApiManagerService } from '@app/core/services/api-manager.service';
import { NotificationService } from '@app/core/services/notification.service';
import { GroupAssignerService } from './group-assigner.service';
import {
  fetchNursingGroupConfig,
  getDefaultConfig,
  calculate74Groups,
  generateDayShiftGroups,
  generateNightShiftGroups,
} from '@/services/nursingGroupConfigService';
import { AlertDialogComponent } from '@app/components/dialogs/alert-dialog/alert-dialog.component';
import { NursingGroupConfigDialogComponent } from '@app/components/dialogs/nursing-group-config-dialog/nursing-group-config-dialog.component';

@Component({
  selector: 'app-nursing-schedule',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AlertDialogComponent,
    NursingGroupConfigDialogComponent,
  ],
  templateUrl: './nursing-schedule.component.html',
  styleUrl: './nursing-schedule.component.css',
})
export class NursingScheduleComponent implements OnInit {
  private readonly firebase = inject(FirebaseService);
  protected readonly auth = inject(AuthService);
  private readonly apiManagerService = inject(ApiManagerService);
  private readonly notificationService = inject(NotificationService);

  private readonly nursingSchedulesApi = this.apiManagerService.create<any>('nursing_schedules');

  // --- 通用狀態 ---
  activeTab = signal<'master' | 'weekly' | 'responsibilities'>('master');
  hasChanges = signal(false);
  editingCell: { type: string; rowIndex: number; field: string } | null = null;
  private inputRef: HTMLInputElement | HTMLTextAreaElement | null = null;

  // --- "當月總班表" 頁籤的狀態 ---
  selectedFile: File | null = null;
  isUploading = signal(false);
  isLoadingSchedule = signal(true);
  uploadStatus = signal('');
  monthlySchedule: any = null;
  selectedMonth = new Date().toISOString().slice(0, 7);
  showUsername = false;

  // --- 跨月班表狀態 ---
  prevMonthSchedule: any = null;
  nextMonthSchedule: any = null;
  adjacentMonthsLoading = signal(false);

  // --- "當月週班表" 頁籤的狀態 ---
  isGroupEditMode = signal(false);
  tempScheduleWithGroups: any = null;
  activeWeekTab = signal(1);
  isShiftEditMode = signal(false);
  hasUnsavedShiftChanges = signal(false);
  shiftFilter = signal<'all' | 'day' | 'night'>('all');

  // --- 為避免 *ngFor 每次 change detection 重建 DOM，使用 signal 觸發重算 ---
  private _scheduleVersion = signal(0);
  private _cachedWeeklyData: any[] = [];
  private _cachedWeeklyDataKey = '';
  private _cachedSortedSchedule: Record<string, any> = {};
  private _cachedSortedScheduleKey = '';

  // --- "工作職責" 頁籤的狀態 ---
  announcementText = '';
  dayShiftData = { codes: '', tasks: '' };
  nightShiftDuties: any[] = [];
  checklistItems: string[] = [];
  teamworkItems: string[] = [];
  lastModifiedInfo = { date: '', user: '' };

  // --- 護理組別配置 ---
  groupConfig: any = getDefaultConfig();
  configSourceMonth: string | null = null;
  showGroupConfigDialog = signal(false);

  // --- 組別衝突提示 ---
  showGroupConflictAlert = signal(false);
  groupConflictMessage = signal('');

  // --- 常數定義 ---
  shiftOptions = ['', '74', '75', '816', '74/L', '311', '休', '例', '國定'];

  // ========================================
  // 計算屬性 (Computed Properties)
  // ========================================

  get monthDays(): any[] {
    const source = this.isGroupEditMode()
      ? this.tempScheduleWithGroups
      : this.monthlySchedule;
    if (!source?.yearMonth && !this.selectedMonth) return [];
    const yearMonth = source?.yearMonth || this.selectedMonth;
    const [year, month] = yearMonth.split('-').map(Number);
    const daysInMonth =
      source?.maxDaysInMonth || new Date(year, month, 0).getDate();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const days: any[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month - 1, day);
      const dayOfWeek = date.getDay();
      days.push({
        day: day,
        weekday: weekdays[dayOfWeek],
        isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
      });
    }
    return days;
  }

  /** 排序後的護理師班表（使用快取避免 *ngFor 重建 DOM） */
  get sortedSchedule(): Record<string, any> {
    const scheduleData = this.isGroupEditMode()
      ? this.tempScheduleWithGroups
      : this.monthlySchedule;
    if (!scheduleData || !scheduleData.scheduleByNurse) {
      return {};
    }

    // 用版本號 + 資料來源建立快取 key
    const ver = this._scheduleVersion();
    const cacheKey = `${ver}_${this.isGroupEditMode()}_sorted`;
    if (cacheKey === this._cachedSortedScheduleKey) {
      return this._cachedSortedSchedule;
    }

    const nurses = Object.entries(scheduleData.scheduleByNurse) as [string, any][];

    if (
      scheduleData.processingOrder &&
      scheduleData.processingOrder.length > 0
    ) {
      const orderMap = new Map(
        scheduleData.processingOrder.map((id: string, index: number) => [id, index])
      );
      nurses.sort((a, b) => {
        const orderA = (orderMap.get(a[0]) as number) ?? 999;
        const orderB = (orderMap.get(b[0]) as number) ?? 999;
        return orderA - orderB;
      });
    } else {
      nurses.sort((a, b) => {
        const numA = parseInt(a[0]) || 999;
        const numB = parseInt(b[0]) || 999;
        if (numA !== numB) {
          return numA - numB;
        }
        return a[0].localeCompare(b[0]);
      });
    }

    this._cachedSortedSchedule = Object.fromEntries(nurses);
    this._cachedSortedScheduleKey = cacheKey;
    return this._cachedSortedSchedule;
  }

  /** 週班表資料（使用快取避免回傳新陣列導致 *ngFor 重建 DOM） */
  get weeklyData(): any[] {
    const source = this.isGroupEditMode()
      ? this.tempScheduleWithGroups
      : this.monthlySchedule;
    if (!source || !source.yearMonth) return [];

    // 用版本號 + yearMonth 建立快取 key
    const ver = this._scheduleVersion();
    const cacheKey = `${ver}_${source.yearMonth}_${this.isGroupEditMode()}`;
    if (cacheKey === this._cachedWeeklyDataKey) {
      return this._cachedWeeklyData;
    }

    const yearMonth = source.yearMonth;
    const [year, month] = yearMonth.split('-').map(Number);
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const weeks: any[] = [];

    const firstDayOfMonth = new Date(year, month - 1, 1);
    const lastDayOfMonth = new Date(year, month, 0);
    const firstDayWeekday = firstDayOfMonth.getDay();
    const lastDate = lastDayOfMonth.getDate();
    const lastDayWeekday = lastDayOfMonth.getDay();

    let firstWeekMonday: Date;
    if (firstDayWeekday === 0) {
      firstWeekMonday = new Date(year, month - 1, 2);
    } else if (firstDayWeekday === 1) {
      firstWeekMonday = new Date(year, month - 1, 1);
    } else {
      const daysBack = firstDayWeekday - 1;
      firstWeekMonday = new Date(year, month - 1, 1 - daysBack);
    }

    let lastWeekSaturday: Date;
    if (lastDayWeekday === 6) {
      lastWeekSaturday = new Date(year, month - 1, lastDate);
    } else if (lastDayWeekday === 0) {
      lastWeekSaturday = new Date(year, month - 1, lastDate - 1);
    } else {
      const daysForward = 6 - lastDayWeekday;
      lastWeekSaturday = new Date(year, month - 1, lastDate + daysForward);
    }

    const allDays: any[] = [];
    const currentDate = new Date(firstWeekMonday);

    while (currentDate <= lastWeekSaturday) {
      const dayOfWeek = currentDate.getDay();

      if (dayOfWeek !== 0) {
        const dayYear = currentDate.getFullYear();
        const dayMonth = currentDate.getMonth() + 1;
        const dayDate = currentDate.getDate();
        const isCurrentMonth = dayYear === year && dayMonth === month;
        const isPrevMonth =
          dayYear < year || (dayYear === year && dayMonth < month);
        const isNextMonth =
          dayYear > year || (dayYear === year && dayMonth > month);

        let adjacentYearMonth: string | null = null;
        if (isPrevMonth || isNextMonth) {
          adjacentYearMonth = `${dayYear}-${String(dayMonth).padStart(2, '0')}`;
        }

        allDays.push({
          date: `${dayYear}-${String(dayMonth).padStart(2, '0')}-${String(dayDate).padStart(2, '0')}`,
          day: dayDate,
          month: dayMonth,
          year: dayYear,
          weekday: weekdays[dayOfWeek],
          isWeekend: dayOfWeek === 6,
          dayIndex: dayDate - 1,
          isCurrentMonth,
          isPrevMonth,
          isNextMonth,
          adjacentYearMonth,
          displayText: isCurrentMonth ? `${dayDate}` : `${dayMonth}/${dayDate}`,
        });
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    let weekNumber = 1;
    for (let i = 0; i < allDays.length; i += 6) {
      const weekDays = allDays.slice(i, i + 6);
      if (weekDays.length > 0) {
        const firstDay = weekDays[0];
        const lastDay = weekDays[weekDays.length - 1];
        weeks.push({
          weekNumber: weekNumber++,
          days: weekDays,
          startDate: `${firstDay.month}/${firstDay.day}`,
          endDate: `${lastDay.month}/${lastDay.day}`,
        });
      }
    }

    this._cachedWeeklyData = weeks;
    this._cachedWeeklyDataKey = cacheKey;
    return weeks;
  }

  get filteredSortedSchedule(): Record<string, any> {
    if (this.shiftFilter() === 'all' || this.activeWeekTab() === 0) {
      return this.sortedSchedule;
    }
    const filtered: Record<string, any> = {};
    Object.entries(this.sortedSchedule).forEach(
      ([nurseId, nurseData]: [string, any]) => {
        let hasMatchingShift = false;
        let hasOnlyHolidays = true;
        const currentWeek = this.weeklyData[this.activeWeekTab() - 1];
        if (currentWeek) {
          currentWeek.days.forEach((day: any) => {
            if (day.isCurrentMonth) {
              const shift = nurseData.shifts?.[day.dayIndex];
              if (shift) {
                const s = shift.trim();
                const isHoliday =
                  s.includes('休') ||
                  s.includes('例') ||
                  s.includes('國定') ||
                  s === '';
                if (!isHoliday) {
                  hasOnlyHolidays = false;
                  if (
                    this.shiftFilter() === 'day' &&
                    this.isDayShift(shift)
                  ) {
                    hasMatchingShift = true;
                  } else if (
                    this.shiftFilter() === 'night' &&
                    this.isNightShift(shift)
                  ) {
                    hasMatchingShift = true;
                  }
                }
              }
            }
          });
        }
        if (hasMatchingShift && !hasOnlyHolidays) {
          filtered[nurseId] = nurseData;
        }
      }
    );
    return filtered;
  }

  // trackBy 函數 - 避免 *ngFor 重建 DOM
  trackByWeekNumber = (_index: number, week: any) => week.weekNumber;
  trackByNurseId = (_index: number, entry: [string, any]) => entry[0];

  /** 取得目前選取的週班表資料（直接渲染，不需 *ngFor + *ngIf 組合） */
  get currentWeekData(): any | null {
    const tabIndex = this.activeWeekTab();
    if (tabIndex <= 0) return null;
    const weeks = this.weeklyData;
    return weeks[tabIndex - 1] || null;
  }

  /** 點擊週次頁籤 */
  onWeekTabClick(weekIndex: number): void {
    this.activeWeekTab.set(weekIndex + 1);
  }

  // groupCountsDashboard - uses GroupAssignerService for config-based groups
  get groupCountsDashboard(): { header: string[]; nurses: any[] } {
    const source = this.isGroupEditMode()
      ? this.tempScheduleWithGroups
      : this.monthlySchedule;
    if (!source || !source.scheduleByNurse) {
      return { header: ['護理師'], nurses: [] };
    }

    const groupSet = new Set<string>();
    const nurses: any[] = [];

    Object.entries(source.scheduleByNurse).forEach(
      ([nurseId, nurseData]: [string, any]) => {
        const counts: Record<string, number> = {};
        if (nurseData.groups) {
          nurseData.groups.forEach((group: string, idx: number) => {
            if (group) {
              const key = group.startsWith('白') || group.startsWith('晚')
                ? group
                : this.isDayShift(nurseData.shifts?.[idx])
                  ? `白${group}`
                  : this.isNightShift(nurseData.shifts?.[idx])
                    ? `晚${group}`
                    : group;
              groupSet.add(key);
              counts[key] = (counts[key] || 0) + 1;
            }
          });
        }
        // Count standby75Days
        if (nurseData.standby75Days) {
          const standbyKey = '預備75';
          groupSet.add(standbyKey);
          counts[standbyKey] = (counts[standbyKey] || 0) + nurseData.standby75Days.length;
        }
        nurses.push({
          id: nurseId,
          name: nurseData.nurseName || nurseId,
          counts,
        });
      }
    );

    const sortedGroups = Array.from(groupSet).sort((a, b) => {
      // Put day shifts first, then night shifts, then standby
      const order = (g: string) => {
        if (g.startsWith('白')) return 0;
        if (g.startsWith('晚')) return 1;
        if (g === '預備75') return 2;
        return 3;
      };
      return order(a) - order(b) || a.localeCompare(b);
    });

    return {
      header: ['護理師', ...sortedGroups],
      nurses,
    };
  }

  // ========================================
  // Lifecycle
  // ========================================

  ngOnInit(): void {
    this.loadGroupConfig();
    this.loadMonthlySchedule();
    this.loadData();
  }

  // ========================================
  // 方法定義 (Methods)
  // ========================================

  // --- 日期判斷函式 ---
  isDateInPast(dateStr: string): boolean {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const checkDate = new Date(dateStr);
    checkDate.setHours(0, 0, 0, 0);
    return checkDate < today;
  }

  // --- 輔助函數 ---
  isStandby75(nurseId: string, dayIndex: number): boolean {
    const source = this.isGroupEditMode()
      ? this.tempScheduleWithGroups
      : this.monthlySchedule;
    if (!source || !source.scheduleByNurse[nurseId]) return false;
    return source.scheduleByNurse[nurseId].standby75Days?.includes(dayIndex);
  }

  canBeStandby75(nurseId: string, dayIndex: number): boolean {
    const source = this.isGroupEditMode()
      ? this.tempScheduleWithGroups
      : this.monthlySchedule;
    if (!source || !source.scheduleByNurse[nurseId]) return false;
    const shift = source.scheduleByNurse[nurseId].shifts?.[dayIndex];
    return shift === '74';
  }

  isNightShift(shift: string): boolean {
    const s = (shift || '').trim();
    return ['311', '3-11'].some((ns) => s.includes(ns));
  }

  isDayShift(shift: string): boolean {
    const s = (shift || '').trim();
    return ['74', '74/L', '75', '816', '84', '815'].includes(s);
  }

  shouldDimCell(nurseData: any, dayInfo: any): boolean {
    if (!dayInfo.isCurrentMonth || this.shiftFilter() === 'all') return false;
    const shift = nurseData.shifts?.[dayInfo.dayIndex];
    if (!shift) return true;
    const s = shift.trim();
    if (s.includes('休') || s.includes('例') || s.includes('國定')) {
      return true;
    }
    if (this.shiftFilter() === 'day' && !this.isDayShift(shift)) {
      return true;
    }
    if (this.shiftFilter() === 'night' && !this.isNightShift(shift)) {
      return true;
    }
    return false;
  }

  getAdjacentMonthData(nurseId: string, dayInfo: any): any {
    if (dayInfo.isCurrentMonth) return null;

    const schedule = dayInfo.isPrevMonth
      ? this.prevMonthSchedule
      : this.nextMonthSchedule;

    if (!schedule || !schedule.scheduleByNurse) {
      return { notUploaded: true };
    }

    const nurseData = schedule.scheduleByNurse[nurseId];
    if (!nurseData) {
      return { notFound: true };
    }

    const shift = nurseData.shifts?.[dayInfo.dayIndex] || '';
    const group = nurseData.groups?.[dayInfo.dayIndex] || '';
    const isStandby =
      nurseData.standby75Days?.includes(dayInfo.dayIndex) || false;

    return {
      shift: shift.trim(),
      group,
      isStandby,
      notUploaded: false,
      notFound: false,
    };
  }

  canAssignGroup(shift: string): boolean {
    const s = (shift || '').trim();
    if (!s || s.includes('休') || s.includes('例') || s.includes('國定'))
      return false;
    return s === '74' || s === '75' || this.isNightShift(s);
  }

  getAvailableGroups(shift: string, date: string, nurseId: string): string[] {
    const s = (shift || '').trim();
    const dayOfWeek = new Date(date).getDay();
    const config = this.groupConfig || getDefaultConfig();

    const getWeekdayKey = () => {
      if ([1, 3, 5].includes(dayOfWeek)) return '135';
      return '246';
    };

    const getDayShiftGroups = () => {
      const weekdayKey = getWeekdayKey();
      const groupCounts = config.groupCounts || {};
      const dayRules = config.dayShiftRules || {};

      const dayShiftCount = groupCounts[weekdayKey]?.dayShiftCount || 8;
      const dayShiftAvailable = generateDayShiftGroups(dayShiftCount);

      const shift75Groups = dayRules[weekdayKey]?.shift75Groups || ['F'];

      const shift74Groups = calculate74Groups(dayShiftAvailable, shift75Groups);

      return {
        groups74: shift74Groups,
        groups75: shift75Groups,
      };
    };

    const getNightShiftGroups = () => {
      const weekdayKey = getWeekdayKey();
      const groupCounts = config.groupCounts || {};
      const nightShiftCount = groupCounts[weekdayKey]?.nightShiftCount || 9;
      return generateNightShiftGroups(nightShiftCount);
    };

    if (s === '74') {
      return getDayShiftGroups().groups74;
    }
    if (s === '75') {
      return getDayShiftGroups().groups75;
    }
    if (['311', '3-11'].some((ns) => s.includes(ns))) {
      let groups = [...getNightShiftGroups()];
      if (
        nurseId &&
        this.isGroupEditMode() &&
        this.tempScheduleWithGroups
      ) {
        const cannotBeNightLeaderIds =
          config.cannotBeNightLeader || [];
        if (cannotBeNightLeaderIds.includes(nurseId)) {
          groups = groups.filter((g: string) => g !== 'A');
        }
      }
      return groups;
    }
    return [];
  }

  getGroupClass(group: string): string {
    if (!group) return '';
    const groupChar = group.charAt(0).toUpperCase();
    if (group === '外圍') return 'group-peripheral';
    return `group-${groupChar}`;
  }

  handleGroupChange(nurseId: string, dayIndex: number, event: Event): void {
    const newGroup = (event.target as HTMLSelectElement).value;
    if (!newGroup || !this.tempScheduleWithGroups) return;

    const conflictingNurses: { name: string; shift: string }[] = [];
    const currentNurseData =
      this.tempScheduleWithGroups.scheduleByNurse[nurseId];
    const currentShift =
      currentNurseData?.shifts?.[dayIndex]?.trim() || '';

    Object.entries(this.tempScheduleWithGroups.scheduleByNurse).forEach(
      ([otherId, otherData]: [string, any]) => {
        if (otherId === nurseId) return;

        const otherGroup = otherData.groups?.[dayIndex];
        const otherShift = otherData.shifts?.[dayIndex]?.trim() || '';

        if (otherGroup === newGroup) {
          const isCurrentDayShift = ['74', '75', '816', '74/L'].includes(
            currentShift
          );
          const isOtherDayShift = ['74', '75', '816', '74/L'].includes(
            otherShift
          );
          const isCurrentNightShift =
            currentShift.includes('311') || currentShift.includes('3-11');
          const isOtherNightShift =
            otherShift.includes('311') || otherShift.includes('3-11');

          if (
            (isCurrentDayShift && isOtherDayShift) ||
            (isCurrentNightShift && isOtherNightShift)
          ) {
            conflictingNurses.push({
              name: otherData.nurseName || otherId,
              shift: otherShift,
            });
          }
        }
      }
    );

    if (conflictingNurses.length > 0) {
      const conflictList = conflictingNurses
        .map((n) => `${n.name} (${n.shift}班)`)
        .join('、');
      this.groupConflictMessage.set(
        `${conflictList} 已經是 ${newGroup} 組，與您的修改有衝突。\n\n請確認是否需要調整。`
      );
      this.showGroupConflictAlert.set(true);
    }
  }

  getShiftClass(shift: string): string {
    if (!shift) return '';
    const shiftStr = String(shift).trim();
    const EARLY_SHIFTS = ['74', '75', '84', '74/L', '816', '815'];
    const LATE_SHIFTS = ['3-11', '311'];
    if (EARLY_SHIFTS.some((s) => shiftStr.includes(s)))
      return 'shift-badge shift-早班';
    if (LATE_SHIFTS.some((s) => shiftStr.includes(s)))
      return 'shift-badge shift-晚班';
    if (shiftStr === '休' || shiftStr.includes('休息'))
      return 'shift-badge shift-休息';
    if (shiftStr === '例' || shiftStr.includes('例假'))
      return 'shift-badge shift-例假';
    if (shiftStr.includes('國定')) return 'shift-badge shift-國定';
    return 'shift-badge shift-其他';
  }

  // --- Excel 匯出 ---
  exportWeeklyScheduleToExcel(): void {
    if (!this.monthlySchedule || this.activeWeekTab() === 0) {
      alert(
        !this.monthlySchedule
          ? '沒有班表資料可供匯出。'
          : '請先選擇一個週次，再進行匯出。'
      );
      return;
    }

    const currentWeekIndex = this.activeWeekTab() - 1;
    const currentWeek = this.weeklyData[currentWeekIndex];
    const nursesToExport = this.filteredSortedSchedule;

    if (!currentWeek || !nursesToExport) {
      alert('無法獲取週次資料，請稍後再試。');
      return;
    }

    const headers = [
      '員工編號',
      '護理師',
      ...currentWeek.days.map(
        (day: any) => `${day.displayText} (${day.weekday})`
      ),
    ];

    const dataRows = Object.entries(nursesToExport).map(
      ([nurseId, nurseData]: [string, any]) => {
        const row: string[] = [
          nurseData.nurseUsername || '-',
          nurseData.nurseName,
        ];
        currentWeek.days.forEach((dayInfo: any) => {
          if (!dayInfo.isCurrentMonth) {
            row.push('-');
            return;
          }
          const dayIndex = dayInfo.dayIndex;
          const shift = nurseData.shifts?.[dayIndex] || '';
          const group = nurseData.groups?.[dayIndex] || '';
          const isStandby = this.isStandby75(nurseId, dayIndex);

          let cellText = shift;
          if (group) cellText += ` ${group}組`;
          if (isStandby) cellText += ' ⭐';

          row.push(cellText.trim() || '-');
        });
        return row;
      }
    );

    const excelTitle = `${this.selectedMonth} 第${currentWeek.weekNumber}週 (${currentWeek.startDate} - ${currentWeek.endDate}) 護理班表`;

    const titleRow = [excelTitle];
    const emptyRow: string[] = [];

    const dataForSheet = [titleRow, emptyRow, headers, ...dataRows];

    try {
      const worksheet = XLSX.utils.aoa_to_sheet(dataForSheet);

      const merge = {
        s: { r: 0, c: 0 },
        e: { r: 0, c: headers.length - 1 },
      };
      if (!worksheet['!merges']) worksheet['!merges'] = [];
      worksheet['!merges'].push(merge);

      if (worksheet['A1']) {
        worksheet['A1'].s = {
          alignment: { horizontal: 'center', vertical: 'center' },
        };
      }

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        workbook,
        worksheet,
        `第${currentWeek.weekNumber}週班表`
      );

      const filename = `護理週班表_${this.selectedMonth}_第${currentWeek.weekNumber}週.xlsx`;
      XLSX.writeFile(workbook, filename);
    } catch (error: any) {
      console.error('匯出 Excel 失敗:', error);
      alert('匯出 Excel 時發生錯誤，請查看主控台訊息。');
    }
  }

  // --- 儲存邏輯 ---
  async executeShiftSave(): Promise<void> {
    this.isUploading.set(true);
    this.uploadStatus.set('正在儲存班別變更...');
    try {
      const documentId = this.selectedMonth;
      const scheduleDataToSave = this.monthlySchedule.scheduleByNurse;
      const adminName =
        this.auth.currentUser()?.name || '未知管理員';

      const dataWithAdmin = {
        scheduleByNurse: scheduleDataToSave,
        lastModifiedBy: adminName,
        lastModifiedAt: new Date(),
      };

      await this.nursingSchedulesApi.update(documentId, dataWithAdmin);
      this.uploadStatus.set(
        `班別變更成功儲存！(由 ${adminName} 確認)`
      );
      this.notificationService.createGlobalNotification(
        `班別已成功更新 (管理員：${adminName})`,
        'success'
      );
      this.isShiftEditMode.set(false);
      this.hasUnsavedShiftChanges.set(false);
      await this.loadMonthlySchedule();
    } catch (error: any) {
      console.error('儲存護理班別失敗:', error);
      this.uploadStatus.set(`儲存失敗：${error.message}`);
    } finally {
      this.isUploading.set(false);
    }
  }

  async executeWeekSave(): Promise<void> {
    this.isUploading.set(true);
    this.uploadStatus.set(`正在儲存第${this.activeWeekTab()}週分組...`);

    try {
      const weekData = this.weeklyData[this.activeWeekTab() - 1];
      if (!weekData) throw new Error('無法取得週次資料');

      const weekDays = weekData.days.filter((d: any) => d.isCurrentMonth);
      const startIndex = weekDays[0]?.dayIndex;
      const endIndex = weekDays[weekDays.length - 1]?.dayIndex;

      if (startIndex === undefined || endIndex === undefined) {
        throw new Error('無法確定週次的日期範圍');
      }

      const partialUpdate: Record<string, any> = {};
      const totalDaysInMonth = this.monthlySchedule.maxDaysInMonth;
      Object.entries(
        this.tempScheduleWithGroups.scheduleByNurse
      ).forEach(([nurseId, nurseData]: [string, any]) => {
        const originalNurseData =
          this.monthlySchedule.scheduleByNurse[nurseId] || {};
        partialUpdate[nurseId] = { ...originalNurseData };

        const existingGroups = partialUpdate[nurseId].groups || [];
        const denseGroups = Array.from(
          { length: totalDaysInMonth },
          (_, k) => existingGroups[k] || ''
        );

        const existingStandbyDays =
          partialUpdate[nurseId].standby75Days || [];
        const denseStandbyDays = Array.from(
          { length: totalDaysInMonth },
          (_, k) => (existingStandbyDays.includes(k) ? k : null)
        ).filter((v) => v !== null);

        partialUpdate[nurseId].groups = denseGroups;
        partialUpdate[nurseId].standby75Days = denseStandbyDays;

        for (let i = startIndex; i <= endIndex; i++) {
          partialUpdate[nurseId].groups[i] =
            nurseData.groups?.[i] || '';
          const idx = partialUpdate[nurseId].standby75Days.indexOf(i);
          if (idx > -1) {
            partialUpdate[nurseId].standby75Days.splice(idx, 1);
          }
          if (nurseData.standby75Days?.includes(i)) {
            partialUpdate[nurseId].standby75Days.push(i);
          }
        }
        partialUpdate[nurseId].standby75Days.sort(
          (a: number, b: number) => a - b
        );
      });

      const documentId = this.selectedMonth;
      const adminName =
        this.auth.currentUser()?.name || '未知管理員';
      const dataToSave = {
        scheduleByNurse: partialUpdate,
        weekConfirmed: {
          ...(this.monthlySchedule.weekConfirmed || {}),
          [`week${this.activeWeekTab()}`]: true,
        },
        lastModifiedBy: adminName,
        lastModifiedAt: new Date(),
      };

      await this.nursingSchedulesApi.update(documentId, dataToSave);

      if (!this.tempScheduleWithGroups.weekConfirmed) {
        this.tempScheduleWithGroups.weekConfirmed = {};
      }
      this.tempScheduleWithGroups.weekConfirmed[
        `week${this.activeWeekTab()}`
      ] = true;

      this.uploadStatus.set(
        `第${this.activeWeekTab()}週分組已儲存！(由 ${adminName} 確認)`
      );
      this.notificationService.createGlobalNotification(
        `第${this.activeWeekTab()}週分組已成功儲存 (管理員：${adminName})`,
        'success'
      );

      this.monthlySchedule.scheduleByNurse = partialUpdate;
      this.monthlySchedule.weekConfirmed = dataToSave.weekConfirmed;
      this._scheduleVersion.update(v => v + 1);
    } catch (error: any) {
      console.error('儲存週次分組失敗:', error);
      this.uploadStatus.set(`儲存失敗：${error.message}`);
    } finally {
      this.isUploading.set(false);
    }
  }

  async executeMonthSave(): Promise<void> {
    this.isUploading.set(true);
    this.uploadStatus.set('正在儲存分組結果...');
    try {
      const documentId = this.selectedMonth;
      const adminName =
        this.auth.currentUser()?.name || '未知管理員';
      const dataToSave = {
        scheduleByNurse:
          this.tempScheduleWithGroups.scheduleByNurse,
        weekConfirmed:
          this.tempScheduleWithGroups.weekConfirmed || {},
        lastModifiedBy: adminName,
        lastModifiedAt: new Date(),
      };
      await this.nursingSchedulesApi.update(documentId, dataToSave);
      this.uploadStatus.set(`分組成功儲存！(由 ${adminName} 確認)`);
      this.notificationService.createGlobalNotification(
        `整月分組已成功儲存 (管理員：${adminName})`,
        'success'
      );
      this.isGroupEditMode.set(false);
      this.tempScheduleWithGroups = null;
      await this.loadMonthlySchedule();
      this.activeWeekTab.set(1);
    } catch (error: any) {
      console.error('儲存護理分組失敗:', error);
      this.uploadStatus.set(`儲存失敗：${error.message}`);
    } finally {
      this.isUploading.set(false);
    }
  }

  // --- 班別與分組管理 ---
  toggleStandby75(nurseId: string, dayIndex: number): void {
    if (!this.isGroupEditMode() || !this.tempScheduleWithGroups) return;

    const weekData = this.weeklyData[this.activeWeekTab() - 1];
    const dayInfo = weekData?.days.find(
      (d: any) => d.dayIndex === dayIndex
    );
    if (dayInfo && this.isDateInPast(dayInfo.date)) {
      alert('無法修改過去日期的預備班設定');
      return;
    }

    Object.values(
      this.tempScheduleWithGroups.scheduleByNurse
    ).forEach((nurse: any) => {
      if (!nurse.standby75Days) {
        nurse.standby75Days = [];
      }
    });
    const nurseData =
      this.tempScheduleWithGroups.scheduleByNurse[nurseId];
    const isCurrentStandby =
      nurseData.standby75Days.includes(dayIndex);
    Object.values(
      this.tempScheduleWithGroups.scheduleByNurse
    ).forEach((nurse: any) => {
      const idx = nurse.standby75Days.indexOf(dayIndex);
      if (idx > -1) {
        nurse.standby75Days.splice(idx, 1);
      }
    });
    if (!isCurrentStandby) {
      nurseData.standby75Days.push(dayIndex);
      nurseData.standby75Days.sort((a: number, b: number) => a - b);
    }
  }

  async saveCurrentWeek(): Promise<void> {
    if (!this.tempScheduleWithGroups || this.activeWeekTab() === 0) return;

    const weekData = this.weeklyData[this.activeWeekTab() - 1];
    const hasAnyFutureDay = weekData.days.some(
      (d: any) => d.isCurrentMonth && !this.isDateInPast(d.date)
    );

    if (!hasAnyFutureDay) {
      alert('此週已完全過去，無法修改');
      return;
    }

    await this.executeWeekSave();
  }

  async saveShiftChanges(): Promise<void> {
    if (!this.hasUnsavedShiftChanges()) {
      alert('沒有偵測到任何變更。');
      return;
    }
    await this.executeShiftSave();
  }

  async saveGroupAssignments(): Promise<void> {
    if (!this.tempScheduleWithGroups) return;
    await this.executeMonthSave();
  }

  redistributeRemainingWeeks(): void {
    if (
      !this.tempScheduleWithGroups ||
      !confirm('這將重新分配所有未確認的週次，確定要繼續嗎？')
    ) {
      return;
    }
    this.uploadStatus.set('正在重新分配剩餘週次...');
    try {
      // Note: The actual redistribute logic from useGroupAssigner composable
      // would need to be implemented here or in a separate service
      const assigner = new GroupAssignerService(this.groupConfig, this.prevMonthSchedule, this.nextMonthSchedule);
      this.tempScheduleWithGroups = assigner.redistributeRemainingWeeks(this.tempScheduleWithGroups, this.weeklyData);
      this._scheduleVersion.update(v => v + 1);
    } catch (error: any) {
      console.error('重新分配失敗:', error);
      this.uploadStatus.set(`重新分配失敗：${error.message}`);
    }
  }

  enterShiftEditMode(): void {
    if (!this.monthlySchedule) {
      alert('請先載入月班表資料！');
      return;
    }
    this.isShiftEditMode.set(true);
    this.hasUnsavedShiftChanges.set(false);
    this.uploadStatus.set('');
  }

  cancelShiftEditMode(): void {
    if (this.hasUnsavedShiftChanges()) {
      if (confirm('您有未儲存的班別修改，確定要放棄嗎？')) {
        this.isShiftEditMode.set(false);
        this.hasUnsavedShiftChanges.set(false);
        this.loadMonthlySchedule();
      }
    } else {
      this.isShiftEditMode.set(false);
    }
  }

  enterGroupEditMode(): void {
    if (!this.monthlySchedule) {
      alert('請先載入月班表資料！');
      return;
    }
    const hasGroups = Object.values(
      this.monthlySchedule.scheduleByNurse
    ).some(
      (nurse: any) => nurse.groups && nurse.groups.some((g: string) => g)
    );
    if (!hasGroups) {
      // Auto-group using GroupAssignerService
      const assigner = new GroupAssignerService(this.groupConfig, this.prevMonthSchedule, this.nextMonthSchedule);
      this.tempScheduleWithGroups = assigner.generateGroupAssignments(this.monthlySchedule);
    } else {
      this.tempScheduleWithGroups = JSON.parse(
        JSON.stringify(this.monthlySchedule)
      );
    }
    if (!this.tempScheduleWithGroups.weekConfirmed) {
      this.tempScheduleWithGroups.weekConfirmed =
        this.monthlySchedule.weekConfirmed || {
          week1: false,
          week2: false,
          week3: false,
          week4: false,
          week5: false,
        };
    }
    this.activeWeekTab.set(0);
    this.isGroupEditMode.set(true);
    this._scheduleVersion.update(v => v + 1);
  }

  cancelGroupEditMode(): void {
    this.isGroupEditMode.set(false);
    this.tempScheduleWithGroups = null;
    this.uploadStatus.set('');
    this.activeWeekTab.set(1);
    this._scheduleVersion.update(v => v + 1);
  }

  // --- 檔案處理 ---
  handleFileUpload(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.selectedFile = target.files?.[0] || null;
    this.uploadStatus.set('');
  }

  private fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () =>
        resolve((reader.result as string).split(',')[1]);
      reader.onerror = (error) => reject(error);
    });
  }

  async processAndUpload(): Promise<void> {
    if (!this.selectedFile) {
      this.uploadStatus.set('請先選擇一個 Excel 檔案');
      return;
    }
    this.isUploading.set(true);
    this.uploadStatus.set('正在上傳檔案...');
    try {
      const fileContentBase64 = await this.fileToBase64(this.selectedFile);
      const payload = {
        fileName: this.selectedFile.name,
        fileContentBase64: fileContentBase64,
      };
      const saveScheduleFunction = httpsCallable(
        this.firebase.functions,
        'saveNursingSchedule'
      );
      const result: any = await saveScheduleFunction(payload);
      if (!result.data.success)
        throw new Error(result.data.message || '處理失敗');
      this.uploadStatus.set(`成功！${result.data.message}`);
      this.selectedFile = null;
      if (result.data.stats?.month) {
        this.selectedMonth = result.data.stats.month;
      }
      await this.loadMonthlySchedule();
    } catch (error: any) {
      console.error('上傳失敗:', error);
      this.uploadStatus.set(
        `失敗：${error.message || '發生未知錯誤'}`
      );
    } finally {
      this.isUploading.set(false);
    }
  }

  // --- 月份管理 ---
  private getAdjacentMonths(yearMonth: string) {
    const [year, month] = yearMonth.split('-').map(Number);

    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYearMonth = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;

    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYearMonth = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;

    return { prevYearMonth, nextYearMonth };
  }

  async loadMonthlySchedule(): Promise<void> {
    this.isLoadingSchedule.set(true);
    this.uploadStatus.set('');
    this.cancelGroupEditMode();
    this.isShiftEditMode.set(false);
    this.hasUnsavedShiftChanges.set(false);
    try {
      const documentId = this.selectedMonth;
      const schedule = await this.nursingSchedulesApi.fetchById(documentId);
      this.monthlySchedule = schedule || null;
      this._scheduleVersion.update(v => v + 1);
      this.activeWeekTab.set(1);

      this.loadAdjacentMonthSchedules(documentId);
    } catch (error) {
      console.error('載入月班表失敗:', error);
      this.monthlySchedule = null;
      this._scheduleVersion.update(v => v + 1);
    } finally {
      this.isLoadingSchedule.set(false);
    }
  }

  private async loadAdjacentMonthSchedules(
    currentYearMonth: string
  ): Promise<void> {
    this.adjacentMonthsLoading.set(true);
    this.prevMonthSchedule = null;
    this.nextMonthSchedule = null;

    try {
      const { prevYearMonth, nextYearMonth } =
        this.getAdjacentMonths(currentYearMonth);

      const [prevSchedule, nextSchedule] = await Promise.all([
        this.nursingSchedulesApi
          .fetchById(prevYearMonth)
          .catch(() => null),
        this.nursingSchedulesApi
          .fetchById(nextYearMonth)
          .catch(() => null),
      ]);

      this.prevMonthSchedule = prevSchedule || null;
      this.nextMonthSchedule = nextSchedule || null;
    } catch (error) {
      console.error('載入相鄰月份班表失敗:', error);
    } finally {
      this.adjacentMonthsLoading.set(false);
    }
  }

  // --- "工作職責" 頁籤相關函式 ---
  formatText(text: string): string {
    if (!text) return '';
    let escapedText = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const groups = [
      'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'ICU',
    ];
    const qwGroups = ['QW1', 'QW2', 'QW3', 'QW4', 'QW5', 'QW6', 'QW7'];
    const allGroups = [...groups, ...qwGroups];
    allGroups.forEach((group) => {
      const patterns = [
        new RegExp(`\\b${group}\\s*組[:：]?`, 'g'),
        new RegExp(`^${group}\\s*[:：]`, 'gm'),
        new RegExp(`(?<=[，,、]\\s*)${group}\\s*組`, 'g'),
      ];
      patterns.forEach((pattern) => {
        escapedText = escapedText.replace(
          pattern,
          (match) =>
            `<span class="group-tag group-${group}">${match}</span>`
        );
      });
    });
    escapedText = escapedText.replace(
      /^(※[^\n]*)/gm,
      '<span class="group-tag is-note">$1</span>'
    );
    escapedText = escapedText.replace(
      /^(組長[:：][^\n]*)/gm,
      '<span class="group-tag is-leader">$1</span>'
    );
    escapedText = escapedText.replace(
      /^(互助小組長[:：][^\n]*)/gm,
      '<span class="group-tag is-leader">$1</span>'
    );
    escapedText = escapedText.replace(
      /^(\d+\.\s)/gm,
      '<span class="group-tag is-numeric">$1</span>'
    );
    return escapedText;
  }

  setInputRef(el: HTMLInputElement | HTMLTextAreaElement | null): void {
    if (el) this.inputRef = el;
  }

  enterEditMode(type: string, rowIndex: number, field: string): void {
    if (!this.auth.isAdmin()) return;
    this.editingCell = { type, rowIndex, field };
    setTimeout(() => {
      if (this.inputRef) {
        this.inputRef.focus();
        this.inputRef.select();
      }
    });
  }

  exitEditMode(): void {
    this.editingCell = null;
  }

  isEditing(type: string, rowIndex: number, field: string): boolean {
    return (
      this.editingCell?.type === type &&
      this.editingCell?.rowIndex === rowIndex &&
      this.editingCell?.field === field
    );
  }

  loadData(): void {
    this.announcementText =
      '一、班別規則：護病比為1:4為原則，採團隊分工方式執行，無法執行時主動告知與協助。\n二、休息時間：實際狀況依各組協調調整，給予30分鐘。務必配合以免影響他人，白班為11:00-11:30；11:30-12:00；13:20-13:50，晚班為18:00-18:30；18:30-19:00；19:00-19:30。\n三、各班組別工作內容';
    this.dayShiftData = {
      codes: '7-3*9\n8-4*1\n7-5*2',
      tasks:
        'A 組：預備機化消及測餘氯。\nB 組：點班(急救車、電擊器測試)。備 12-8，午班用物。\nQW3 血糖機測試並上傳測試數值。 (試劑沒有向檢驗科拿，試紙沒了請書記備)\nC 組：支援 ICU 組(含備機)，如 ICU 組被 P，接 ICU 組， ICU 機台化消及餘氯檢測，需 cover ICU 組吃飯時間 30 分鐘(要自行電話與 ICU 組約時間但要避開 OPD 上下針時間 11:30-13:00)。\nD 組：送消、點班(衛材、庫房溫溼度)、整理供應室衛材歸位， NO.1。\nE 組：點班(氧療、冰箱溫度、補充冰箱常備藥)。 NO.2。每月最後一周 W1 須執行氧氣桶鋼瓶 查核表(114.07.17)\nF 組：電訪關心病患， NO.3。\nG 組：協助準備醫師拔 D/L 備物及病人觀察。\nH 組： 住院組。\nI 組： 住院組。\nJ 組： W3 泡製 3 桶消毒液。 W6 幫忙協助收行動 RO 機(若 ICU 組無法收機時)\nK 組：擔任 Leader。\nICU 組：接 ICU 組， ICU 機台化消及餘氯檢測， W6 協助收行動 RO 機。\n※若放 P 一整天，則該組工作由 G 組負責。\n※若當日僅有十組組別，組長則併入 A 組， A 組負責工作由 G 組協助完成。\n※白班 12-8 組別由 Leader 安排。',
    };
    this.nightShiftDuties = [
      {
        code: '3-11*8or9',
        tasks:
          'A 組: 擔任 Leader，核對當日人數， 將當日護理日誌、排程，隔天分組匯出轉 PDF 黨並存檔 (114.09.01 更新) ， 下班前須到 PD 衛教室電腦開啟隔日診間叫號系統(114.09.22 更新)。\nB 組: 10PM 後核對隔日娃娃頭與電腦排程是否一致，並須製作隔日早班洗腎住院床 病人移動方式，排主護(排到中班收針列)及 Leader 牌。備隔日 B 組 AK。\nC 組: 接 ICU 組，協同 B 組核對隔日娃娃頭、 W4 補充 ICU 消毒液，備隔日 C+D 組 AK。若 G 組 放 P 時，備 K 組 AK。\nD 組: 點班(衛材)，備隔日 E+F 組 AK， NO.1。\nE 組: 點班(氧療、冰箱)、備隔日 I+J 組 AK， NO.2，若 H 組放 P，協助點班(急 救車)。\nF 組: 接 12-8，備隔日 G+H 組 AK。 (每月 1 號點消防箱物資，遇假日順延。 )， NO.3。\nG 組: 住院組、 備隔日 K 組 AK。\nH 組: 住院組、 點班(急救車) 。\nI 組: 備隔日 A 組 AK。關門前結束檢查(項目見背面)若 C 組去洗 ICU，則協同 B 組核對隔日 娃娃頭。\n※若當日僅有 8 組組別， I 組負責工作由 A 組協助完成。\nQW4 夜班倒酸。\n 若放 P3-8 班，放 P 人員須自行完成該組工作職責。\n 每個月雙週的 W5 需刷機器。\n 每週星期一夜班汙水管需倒漂白水(A 組倒 1-7 床； B 組倒 8-15； C 組倒 16-22 床； D 組 倒 23-29 床； E 組倒 35-41 床； F 組倒 42-48 床； G 組倒 49-55 床； H 組倒 31-33 床)(若 H 組放 P 則由 G 組協助倒漂白水)',
      },
    ];
    this.checklistItems = [
      '電視儀器電源，遙控器收回。',
      '周圍設備歸位，空桶補好，管路放好。',
      '1234 門及庫房門上鎖。',
      '護理車關機，物品確認補充否。',
      '儀器及病床周邊消毒無血漬。',
      '護理站餐桌維持整齊，無標示者丟棄。',
      '護理站關電腦及燈光。',
      '檢體送檢。',
    ];
    this.teamworkItems = [
      '組長: C. A. B. C. 一組。',
      '組長: F. D. E. F. 一組（夜班加 I 組）。',
      '組長: H. G. H. I. 一組。',
      '互助小組長: (現場至少要有三位巡視)',
      '1. 關懷分配同仁用餐。',
      '2. 用餐前確認工作並告知病人誰 COVER。',
      '3. COVER 者主動巡視病人或協助查房。',
    ];
    this.lastModifiedInfo = { date: '114.09.22', user: '系統預設' };
    setTimeout(() => {
      this.hasChanges.set(false);
    });
  }

  async saveData(): Promise<void> {
    if (!this.hasChanges() || !this.auth.isAdmin()) return;
    try {
      const now = new Date();
      const formattedDate = `${now.getFullYear() - 1911}.${String(
        now.getMonth() + 1
      ).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
      const currentUserFullName =
        this.auth.currentUser()?.name || '未知使用者';
      const rawPayload = {
        announcement: this.announcementText,
        dayShift: this.dayShiftData,
        nightShift: this.nightShiftDuties,
        checklist: this.checklistItems,
        teamwork: this.teamworkItems,
        lastModified: { date: formattedDate, user: currentUserFullName },
      };
      const payload = JSON.parse(JSON.stringify(rawPayload));
      // API call would go here
      this.lastModifiedInfo = payload.lastModified;
      this.hasChanges.set(false);
      this.exitEditMode();
      this.notificationService.createGlobalNotification(
        '工作職責已成功儲存！',
        'success'
      );
    } catch (error: any) {
      this.notificationService.createGlobalNotification(
        error.message || '儲存失敗，請稍後再試',
        'error'
      );
    }
  }

  // --- 護理組別配置 ---
  async loadGroupConfig(): Promise<void> {
    try {
      const result = await fetchNursingGroupConfig(this.selectedMonth);
      this.groupConfig = {
        ...getDefaultConfig(),
        ...result.config,
      };
      this.configSourceMonth = result.sourceMonth;
      console.log(
        `護理組別配置已載入 (來源: ${result.sourceMonth || '預設值'})`
      );
    } catch (error) {
      console.error('載入護理組別配置失敗:', error);
      this.groupConfig = getDefaultConfig();
      this.configSourceMonth = null;
    }
  }

  onGroupConfigSaved(newConfig: any): void {
    this.groupConfig = newConfig;
    this.configSourceMonth = this.selectedMonth;
    this.uploadStatus.set(`${this.selectedMonth} 組別配置已更新`);
  }

  onMonthChange(): void {
    this.loadGroupConfig();
    this.loadMonthlySchedule();
  }

  onTabChange(tab: 'master' | 'weekly' | 'responsibilities'): void {
    this.activeTab.set(tab);
    if (tab !== 'weekly') {
      this.shiftFilter.set('all');
    }
  }

  markUnsaved(): void {
    this.hasChanges.set(true);
  }

  markShiftUnsaved(): void {
    if (this.isShiftEditMode()) {
      this.hasUnsavedShiftChanges.set(true);
    }
  }

  getWeekConfirmed(weekIndex: number): boolean {
    const source = this.tempScheduleWithGroups?.weekConfirmed ?? this.monthlySchedule?.weekConfirmed;
    return source?.[`week${weekIndex + 1}`] ?? false;
  }

  objectEntries(obj: any): [string, any][] {
    return obj ? Object.entries(obj) : [];
  }
}
