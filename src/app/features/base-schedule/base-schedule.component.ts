import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import { FirebaseService } from '@services/firebase.service';
import { AuthService } from '@app/core/services/auth.service';
import { ApiManagerService, type ApiManager } from '@app/core/services/api-manager.service';
import { PatientStoreService } from '@app/core/services/patient-store.service';
import { AlertDialogComponent } from '@app/components/dialogs/alert-dialog/alert-dialog.component';
import { ConfirmDialogComponent } from '@app/components/dialogs/confirm-dialog/confirm-dialog.component';
import { SelectionDialogComponent } from '@app/components/dialogs/selection-dialog/selection-dialog.component';
import { PatientSelectDialogComponent } from '@app/components/dialogs/patient-select-dialog/patient-select-dialog.component';
import { BedAssignmentDialogComponent } from '@app/components/dialogs/bed-assignment-dialog/bed-assignment-dialog.component';
import { StatsToolbarComponent } from '@app/components/stats-toolbar/stats-toolbar.component';
import { ScheduleTableComponent } from '@app/components/schedule-table/schedule-table.component';
import { updatePatient } from '@/services/optimizedApiService';
import { ORDERED_SHIFT_CODES } from '@/constants/scheduleConstants';
import {
  generateAutoNote,
  getUnifiedCellStyle,
  hasFrequencyConflict,
} from '@/utils/scheduleUtils';
import { getToday } from '@/utils/dateUtils';

@Component({
  selector: 'app-base-schedule',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AlertDialogComponent,
    ConfirmDialogComponent,
    SelectionDialogComponent,
    PatientSelectDialogComponent,
    BedAssignmentDialogComponent,
    StatsToolbarComponent,
    ScheduleTableComponent,
  ],
  templateUrl: './base-schedule.component.html',
  styleUrl: './base-schedule.component.css'
})
export class BaseScheduleComponent implements OnInit, OnDestroy {
  private readonly firebaseService = inject(FirebaseService);
  private readonly authService = inject(AuthService);
  private readonly apiManagerService = inject(ApiManagerService);
  readonly patientStore = inject(PatientStoreService);

  private baseSchedulesApi!: ApiManager<any>;

  readonly SHIFTS = ORDERED_SHIFT_CODES;
  readonly WEEKDAYS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
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
  readonly ACTION_OPTIONS = [
    { value: 'delete_rule', text: '刪除此排班規則' },
    { value: 'change_freq_and_bed', text: '變更頻率與床位' },
    { value: 'change_bed_only', text: '僅更換床位 (同頻率)' },
  ];

  masterRecord = signal<any>(null);
  statusText = signal('');
  draggedItem = signal<any>(null);
  columnWidths = signal<number[]>([]);
  leftOffset = signal(0);
  isAlertDialogVisible = signal(false);
  alertDialogTitle = signal('');
  alertDialogMessage = signal('');
  isConfirmDialogVisible = signal(false);
  confirmDialogTitle = signal('');
  confirmDialogMessage = signal('');
  confirmAction = signal<(() => void) | null>(null);
  isPatientSelectDialogVisible = signal(false);
  currentSlotId = signal<string | null>(null);
  searchQueryValue = signal('');
  isSearchFocused = signal(false);
  isActionDialogVisible = signal(false);
  actionTarget = signal<{ patientId: string | null; patientName: string }>({ patientId: null, patientName: '' });
  isAssignmentDialogVisible = signal(false);
  assignmentContext = signal<any>({ mode: 'base', patient: null });
  tableKey = signal(Date.now());

  isPageLocked = computed(() => !this.authService.canEditSchedules());

  weekScheduleMap = computed(() => {
    const combinedSchedule: Record<string, any> = {};
    const record = this.masterRecord();
    const pMap = this.patientStore.patientMap();
    if (!record || !record.schedule || !pMap) return combinedSchedule;
    for (const patientId in record.schedule) {
      const patient = pMap.get(patientId);
      if (patient && !(patient as any).isDeleted) {
        const ruleData = record.schedule[patientId];
        if (ruleData?.freq) {
          const dayIndices = this.FREQ_MAP_TO_DAY_INDEX[ruleData.freq] || [];
          const { bedNum, shiftIndex } = ruleData;
          if (bedNum !== undefined && shiftIndex !== undefined && !isNaN(shiftIndex)) {
            dayIndices.forEach((dayIndex: number) => {
              const weeklySlotId = `${bedNum}-${shiftIndex}-${dayIndex}`;
              combinedSchedule[weeklySlotId] = {
                ...ruleData,
                patientId: patientId,
                shiftId: this.SHIFTS[shiftIndex],
              };
            });
          }
        }
      }
    }
    return combinedSchedule;
  });

  weeklyCellStyleMap = computed(() => {
    const styleMap = new Map<string, any>();
    const wsm = this.weekScheduleMap();
    const pMap = this.patientStore.patientMap();
    for (const slotId in wsm) {
      const slotData = wsm[slotId];
      const patient = pMap.get(slotData?.patientId);
      // Regenerate autoNote from live patient data to prevent stale status tags
      const freshSlotData = patient
        ? { ...slotData, autoNote: generateAutoNote(patient) }
        : slotData;
      styleMap.set(slotId, getUnifiedCellStyle(freshSlotData, patient));
    }
    return styleMap;
  });

  statsToolbarData = computed(() => {
    const dailyCounts = Array.from({ length: 6 }, () => ({
      counts: {
        early: { total: 0, opd: 0, ipd: 0, er: 0 },
        noon: { total: 0, opd: 0, ipd: 0, er: 0 },
        late: { total: 0, opd: 0, ipd: 0, er: 0 },
      },
      total: 0,
    }));
    const record = this.masterRecord();
    const pMap = this.patientStore.patientMap();
    if (!record || !record.schedule) return dailyCounts;
    for (const patientId in record.schedule) {
      const ruleData = record.schedule[patientId];
      if (ruleData?.freq && ruleData.shiftIndex !== undefined) {
        const patient = pMap.get(patientId);
        if (!patient || (patient as any).isDeleted) continue;
        const shiftCode = this.SHIFTS[ruleData.shiftIndex];
        const dayIndices = this.FREQ_MAP_TO_DAY_INDEX[ruleData.freq] || [];
        dayIndices.forEach((dayIndex: number) => {
          if (dayIndex >= 0 && dayIndex < 6 && shiftCode && (dailyCounts[dayIndex].counts as any)[shiftCode]) {
            const shiftStats = (dailyCounts[dayIndex].counts as any)[shiftCode];
            shiftStats.total++;
            dailyCounts[dayIndex].total++;
            if ((patient as any).status === 'opd') shiftStats.opd++;
            else if ((patient as any).status === 'ipd') shiftStats.ipd++;
            else if ((patient as any).status === 'er') shiftStats.er++;
          }
        });
      }
    }
    return dailyCounts;
  });

  statsToolbarWeekdays = computed(() => this.WEEKDAYS.map(w => w.slice(-1)));

  searchResults = computed(() => {
    if (!this.searchQueryValue()) return [];
    const query = this.searchQueryValue().toLowerCase();
    return this.patientStore.allPatients()
      .filter((p: any) =>
        (p.name && p.name.toLowerCase().includes(query)) ||
        (p.medicalRecordNumber && p.medicalRecordNumber.includes(query))
      )
      .slice(0, 5);
  });

  filteredPatientsForSelect = computed(() => {
    return this.patientStore.allPatients().filter((p: any) => p.freq);
  });

  private handlePatientDataUpdateBound = this.handlePatientDataUpdate.bind(this);
  private handleScheduleUpdateBound = this.handleScheduleUpdate.bind(this);

  ngOnInit(): void {
    this.baseSchedulesApi = this.apiManagerService.create('base_schedules');
    this.loadAllData();
    window.addEventListener('patient-data-updated', this.handlePatientDataUpdateBound);
    window.addEventListener('schedule-updated', this.handleScheduleUpdateBound);
  }

  ngOnDestroy(): void {
    window.removeEventListener('patient-data-updated', this.handlePatientDataUpdateBound);
    window.removeEventListener('schedule-updated', this.handleScheduleUpdateBound);
  }

  getBaseCellStyle = (slotId: string): any => {
    return this.weeklyCellStyleMap().get(slotId) || {};
  };

  updateLeftOffset(newOffset: number): void {
    this.leftOffset.set(newOffset);
  }

  updateColumnWidths(newWidths: number[]): void {
    this.columnWidths.set(newWidths);
  }

  handleSearchBlur(): void {
    setTimeout(() => {
      this.isSearchFocused.set(false);
    }, 200);
  }

  locatePatientOnGrid(patientId: string): void {
    this.searchQueryValue.set('');
    this.isSearchFocused.set(false);
    const record = this.masterRecord();
    if (!record || !record.schedule) return;
    const ruleData = record.schedule[patientId];
    if (!ruleData) {
      this.showAlert('提示', '該病人未被排入總床位表。');
      return;
    }
    const dayIndices = this.FREQ_MAP_TO_DAY_INDEX[ruleData.freq] || [];
    if (dayIndices.length === 0) return;
    const { bedNum, shiftIndex } = ruleData;
    const firstDayIndex = dayIndices[0];
    const targetSlotId = `${bedNum}-${shiftIndex}-${firstDayIndex}`;
    setTimeout(() => {
      const targetElement = document.querySelector(`[data-slot-id="${targetSlotId}"]`);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        targetElement.classList.add('highlight-flash');
        setTimeout(() => targetElement.classList.remove('highlight-flash'), 2000);
      }
    });
  }

  handleGridClick(slotId: string): void {
    const slotData = this.weekScheduleMap()[slotId];
    const patientId = slotData?.patientId;
    if (this.isPageLocked()) return;

    if (patientId) {
      this.actionTarget.set({
        patientId: patientId,
        patientName: this.patientStore.patientMap().get(patientId)?.name || '未知病人',
      });
      this.isActionDialogVisible.set(true);
    } else {
      this.currentSlotId.set(slotId);
      this.isPatientSelectDialogVisible.set(true);
    }
  }

  handleActionSelect(actionValue: string): void {
    this.isActionDialogVisible.set(false);
    const patientId = this.actionTarget().patientId;
    if (!patientId) return;
    if (actionValue === 'delete_rule') this.handleDeleteRule();
    else if (actionValue === 'change_freq_and_bed') this.openChangeFreqAndBedDialog();
    else if (actionValue === 'change_bed_only') this.openChangeBedOnlyDialog();
  }

  handleScheduleCheck(): void {
    const results = this.runBedCheck();
    let issueMessage = '';
    if (results.duplicates.length > 0)
      issueMessage += '【床位衝突】:\n- ' + results.duplicates.join('\n- ') + '\n\n';
    if (results.unassignedCrucial.length > 0)
      issueMessage += '【重要病人未排床】:\n- ' + results.unassignedCrucial.join('\n- ') + '\n\n';
    if (results.freqMismatch.length > 0)
      issueMessage += '【頻率不符問題】:\n- ' + results.freqMismatch.join('\n- ') + '\n\n';

    if (issueMessage) {
      this.alertDialogTitle.set('排班問題檢查結果');
      this.alertDialogMessage.set(issueMessage);
    } else {
      this.alertDialogTitle.set('排程檢視完畢');
      this.alertDialogMessage.set('太棒了！未發現明顯的排班問題。');
    }
    this.isAlertDialogVisible.set(true);
  }

  openBaseAssignmentDialog(): void {
    if (this.isPageLocked()) return;
    this.assignmentContext.set({ mode: 'base', patient: null });
    this.isAssignmentDialogVisible.set(true);
  }

  async handlePatientSelect(event: { patientId: string; fillType?: string }): Promise<void> {
    const { patientId } = event;
    if (this.isPageLocked() || !patientId || !this.currentSlotId()) return;
    const patient = this.patientStore.patientMap().get(patientId) as any;
    if (!patient || !patient.freq) {
      this.showAlert('操作失敗', `病人 ${patient?.name || '未知'} 沒有設定頻率，無法排入總表。`);
      return;
    }
    const record = this.masterRecord();
    if (record?.schedule && record.schedule[patientId]) {
      this.showAlert('操作失敗', `病人 ${patient.name} 已存在於總床位表中。`);
      return;
    }

    const parts = this.currentSlotId()!.split('-');
    let bedNum: string, shiftIndex: number;
    if (parts[0] === 'peripheral') {
      bedNum = `${parts[0]}-${parts[1]}`;
      shiftIndex = parseInt(parts[2], 10);
    } else {
      bedNum = parts[0];
      shiftIndex = parseInt(parts[1], 10);
    }
    this.isPatientSelectDialogVisible.set(false);

    const newRuleData = {
      bedNum: bedNum,
      shiftIndex: shiftIndex,
      freq: patient.freq,
      manualNote: patient.baseNote || '',
      autoNote: generateAutoNote(patient),
    };

    await this.updateRuleInCloud(patientId, newRuleData);
    this.currentSlotId.set(null);
  }

  async handleBedAssigned(event: { patientId: string; bedNum: any; shiftCode: string; newFreq?: string }): Promise<void> {
    const { patientId, bedNum, shiftCode, newFreq } = event;
    const patient = this.patientStore.patientMap().get(patientId) as any;
    if (!patient) return;
    const newShiftIndex = this.SHIFTS.indexOf(shiftCode);
    if (newShiftIndex === -1) return;

    const record = this.masterRecord();
    const currentRule = record?.schedule?.[patientId];
    const finalFreq = newFreq || currentRule?.freq || patient.freq;
    if (!finalFreq) {
      this.showAlert('操作失敗', `病人 ${patient.name} 沒有設定頻率，無法排入總表。`);
      return;
    }

    for (const pId in record.schedule) {
      if (pId === patientId) continue;
      const rule = record.schedule[pId];
      if (
        rule.bedNum == bedNum &&
        rule.shiftIndex == newShiftIndex &&
        hasFrequencyConflict(finalFreq, rule.freq)
      ) {
        const conflictPatient = this.patientStore.patientMap().get(pId);
        this.showAlert(
          '排班衝突',
          `此床位已有 ${(conflictPatient as any)?.name || '其他病人'} (${rule.freq})，與您選擇的頻率 (${finalFreq}) 有時間衝突。`
        );
        return;
      }
    }

    if (newFreq && patient.freq !== newFreq) {
      try {
        await updatePatient(patientId, { freq: newFreq });
        await this.patientStore.forceRefreshPatients();
      } catch (error: any) {
        console.error('更新病人頻率失敗:', error);
        this.showAlert('錯誤', '更新病人頻率失敗，請稍後再試。');
        return;
      }
    }

    const newRuleData = {
      ...(currentRule || {}),
      bedNum: bedNum,
      shiftIndex: newShiftIndex,
      freq: finalFreq,
      autoNote: generateAutoNote({ ...patient, freq: finalFreq }),
      manualNote: currentRule?.manualNote || patient.baseNote || '',
    };

    await this.updateRuleInCloud(patientId, newRuleData);
    this.isAssignmentDialogVisible.set(false);
  }

  onDragStart(event: DragEvent, slotId: string): void {
    if (this.isPageLocked()) {
      event.preventDefault();
      return;
    }
    const slotData = this.weekScheduleMap()[slotId];
    if (!slotData || !slotData.patientId) {
      event.preventDefault();
      return;
    }
    this.draggedItem.set({ sourcePatientId: slotData.patientId });
    event.dataTransfer!.effectAllowed = 'move';
  }

  async onDrop(event: DragEvent, targetSlotId: string): Promise<void> {
    if (this.isPageLocked()) return;
    if (!event || typeof event.preventDefault !== 'function') return;
    event.preventDefault();
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

    const itemToDrop = this.draggedItem();
    if (!itemToDrop || !itemToDrop.sourcePatientId) {
      this.draggedItem.set(null);
      return;
    }

    const { sourcePatientId } = itemToDrop;
    const record = this.masterRecord();
    const sourceRuleData = record.schedule[sourcePatientId];
    if (!sourceRuleData) {
      this.draggedItem.set(null);
      return;
    }

    const targetParts = targetSlotId.split('-');
    let bedNum: string, shiftIndex: number;
    if (targetParts[0] === 'peripheral') {
      bedNum = `${targetParts[0]}-${targetParts[1]}`;
      shiftIndex = parseInt(targetParts[2], 10);
    } else {
      bedNum = targetParts[0];
      shiftIndex = parseInt(targetParts[1], 10);
    }

    if (sourceRuleData.bedNum == bedNum && sourceRuleData.shiftIndex == shiftIndex) {
      this.draggedItem.set(null);
      return;
    }

    const draggedPatientFreq = sourceRuleData.freq;
    const currentSchedule = record.schedule;
    for (const patientId in currentSchedule) {
      if (patientId === sourcePatientId) continue;
      const rule = currentSchedule[patientId];
      if (
        rule.bedNum == bedNum &&
        rule.shiftIndex == shiftIndex &&
        hasFrequencyConflict(draggedPatientFreq, rule.freq)
      ) {
        const conflictPatient = this.patientStore.patientMap().get(patientId);
        this.showAlert(
          '排班衝突',
          `無法放置！目標床位的 ${(conflictPatient as any)?.name || '未知病人'} (${rule.freq}) 與您拖曳的病人的頻率 (${draggedPatientFreq}) 有時間衝突。`
        );
        this.draggedItem.set(null);
        return;
      }
    }

    const newRuleData = { ...sourceRuleData, bedNum, shiftIndex };
    await this.updateRuleInCloud(sourcePatientId, newRuleData);
    this.draggedItem.set(null);
  }

  onDragOver(event: DragEvent): void {
    if (this.isPageLocked()) return;
    event.preventDefault();
    const targetSlot = (event.target as HTMLElement).closest('.schedule-slot');
    if (targetSlot) targetSlot.classList.add('drag-over');
  }

  onDragLeave(event: DragEvent): void {
    (event.target as HTMLElement).closest('.schedule-slot')?.classList.remove('drag-over');
  }

  exportBaseScheduleToExcel(): void {
    const record = this.masterRecord();
    if (!record || !record.schedule) {
      this.showAlert('提示', '沒有總表資料可匯出。');
      return;
    }
    const pMap = this.patientStore.patientMap();
    const data: any[][] = [];
    const exportDate = getToday();
    data.push(['部立台北醫院 透析排程總表 (固定規則)']);
    data.push([`匯出日期: ${exportDate}`]);
    data.push([]);
    const headers = ['病人姓名', '病歷號', '目前身分別', '固定床位', '固定班別', '固定頻率', '手動備註', '自動備註'];
    data.push(headers);
    const sortedRules = Object.entries(record.schedule).sort(([, ruleA]: any, [, ruleB]: any) => {
      const bedA = String(ruleA.bedNum).startsWith('p') ? 9999 + parseInt(String(ruleA.bedNum).slice(-1)) : parseInt(ruleA.bedNum);
      const bedB = String(ruleB.bedNum).startsWith('p') ? 9999 + parseInt(String(ruleB.bedNum).slice(-1)) : parseInt(ruleB.bedNum);
      if (bedA !== bedB) return bedA - bedB;
      return ruleA.shiftIndex - ruleB.shiftIndex;
    });
    const shiftDisplayMap: Record<string, string> = { early: '早班', noon: '午班', late: '晚班' };
    const statusMap: Record<string, string> = { opd: '門診', ipd: '住院', er: '急診' };
    sortedRules.forEach(([patientId, rule]: any) => {
      const patient = pMap.get(patientId) as any;
      if (patient) {
        data.push([
          patient.name, patient.medicalRecordNumber, statusMap[patient.status] || '未知',
          rule.bedNum, shiftDisplayMap[this.SHIFTS[rule.shiftIndex]] || '未知', rule.freq,
          rule.manualNote || '', rule.autoNote || '',
        ]);
      }
    });
    const worksheet = XLSX.utils.aoa_to_sheet(data);
    worksheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: headers.length - 1 } },
    ];
    worksheet['!cols'] = [
      { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
      { wch: 10 }, { wch: 12 }, { wch: 30 }, { wch: 30 },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '總床位表');
    XLSX.writeFile(workbook, `總床位表_備份_${exportDate}.xlsx`);
  }

  handleConfirm(): void {
    const action = this.confirmAction();
    if (typeof action === 'function') action();
    this.isConfirmDialogVisible.set(false);
    this.confirmAction.set(null);
  }

  handleCancel(): void {
    this.isConfirmDialogVisible.set(false);
    this.confirmAction.set(null);
  }

  private showAlert(title: string, message: string): void {
    this.alertDialogTitle.set(title);
    this.alertDialogMessage.set(message);
    this.isAlertDialogVisible.set(true);
  }

  private async updateRuleInCloud(patientId: string, newRuleData: any): Promise<void> {
    if (this.isPageLocked()) {
      this.showAlert('權限不足', '您沒有權限執行此操作。');
      return;
    }
    this.statusText.set('儲存中...');
    try {
      await this.baseSchedulesApi.update('MASTER_SCHEDULE', {
        [`schedule.${patientId}`]: newRuleData,
        updatedAt: new Date(),
        lastModifiedBy: this.authService.currentUser()?.uid || 'system_user',
      });
      this.statusText.set('總表已更新');
      await this.loadAllData();
    } catch (error: any) {
      this.statusText.set('儲存失敗');
      this.showAlert('操作失敗', `儲存規則時發生錯誤: ${error.message}`);
      console.error(`[BaseScheduleView] 更新規則失敗 for ${patientId}:`, error);
      await this.loadAllData();
    }
  }

  private async handleDeleteRule(): Promise<void> {
    const patientId = this.actionTarget().patientId;
    const patientName = this.actionTarget().patientName;
    if (!patientId) return;

    this.confirmDialogTitle.set('刪除排班規則');
    this.confirmDialogMessage.set(`您確定要將 ${patientName} 從總表中移除嗎？\n\n此操作將立即從後台刪除其固定規則，並自動取消所有相關的未來調班申請。`);

    this.confirmAction.set(async () => {
      this.statusText.set(`正在移除 ${patientName} 的規則...`);
      try {
        await this.patientStore.removeRuleFromMasterSchedule(patientId);
        await this.loadAllData();
        this.showAlert('操作成功', `已成功將 ${patientName} 從總表中移除。`);
        this.statusText.set('總表規則已更新');
      } catch (error: any) {
        console.error('[BaseScheduleView] 刪除規則失敗:', error);
        this.showAlert('操作失敗', `移除排班規則時發生錯誤: ${error.message}`);
        this.statusText.set('操作失敗');
      }
    });
    this.isConfirmDialogVisible.set(true);
  }

  private openChangeFreqAndBedDialog(): void {
    const patient = this.patientStore.patientMap().get(this.actionTarget().patientId!);
    if (!patient) return;
    this.assignmentContext.set({ mode: 'change_freq_and_bed', patient: patient });
    this.isAssignmentDialogVisible.set(true);
  }

  private openChangeBedOnlyDialog(): void {
    const patient = this.patientStore.patientMap().get(this.actionTarget().patientId!);
    if (!patient) return;
    this.assignmentContext.set({ mode: 'change_bed_only', patient: patient });
    this.isAssignmentDialogVisible.set(true);
  }

  private runBedCheck(): { duplicates: string[]; unassignedCrucial: string[]; freqMismatch: string[] } {
    const validationResult = { duplicates: [] as string[], unassignedCrucial: [] as string[], freqMismatch: [] as string[] };
    const record = this.masterRecord();
    if (!record || !record.schedule) return validationResult;
    const pMap = this.patientStore.patientMap();

    const schedule = record.schedule;
    const scheduledPatientIds = new Set(Object.keys(schedule));
    const occupiedSlots = new Map<string, string>();

    for (const patientId in schedule) {
      const rule = schedule[patientId];
      const slotKey = `${rule.bedNum}-${rule.shiftIndex}`;
      const freqDays = this.FREQ_MAP_TO_DAY_INDEX[rule.freq] || [];
      for (const dayIndex of freqDays) {
        const daySlotKey = `${slotKey}-${dayIndex}`;
        if (occupiedSlots.has(daySlotKey)) {
          const existingPatientName = (pMap.get(occupiedSlots.get(daySlotKey)!) as any)?.name || '未知病人';
          const newPatientName = (pMap.get(patientId) as any)?.name || '未知病人';
          validationResult.duplicates.push(
            `床位衝突: ${newPatientName} 與 ${existingPatientName} 在 ${this.WEEKDAYS[dayIndex]} 的同一個床位/班別中有時間重疊。`
          );
        } else {
          occupiedSlots.set(daySlotKey, patientId);
        }
      }
    }

    const unassignedCrucialPatients = this.patientStore.allPatients().filter(
      (p: any) =>
        !scheduledPatientIds.has(p.id) &&
        (p.status === 'ipd' || p.status === 'er') &&
        !p.isDeleted &&
        !p.isDiscontinued
    );
    unassignedCrucialPatients.forEach((p: any) =>
      validationResult.unassignedCrucial.push(`${p.name} (${p.status === 'ipd' ? '住院' : '急診'})`)
    );

    for (const patientId in schedule) {
      const ruleData = schedule[patientId];
      if (ruleData?.freq) {
        const patient = pMap.get(patientId) as any;
        if (patient && patient.freq && patient.freq !== ruleData.freq) {
          validationResult.freqMismatch.push(
            `${patient.name} - 規則頻率: ${ruleData.freq}, 病人設定頻率: ${patient.freq} (建議同步)`
          );
        }
      }
    }
    return validationResult;
  }

  private async loadAllData(): Promise<void> {
    this.statusText.set('讀取中...');
    try {
      await this.patientStore.fetchPatientsIfNeeded();
      const baseScheduleDoc = await this.baseSchedulesApi.fetchById('MASTER_SCHEDULE');
      if (baseScheduleDoc && (baseScheduleDoc as any).schedule) {
        this.masterRecord.set({ id: (baseScheduleDoc as any).id, schedule: (baseScheduleDoc as any).schedule });
      } else {
        this.masterRecord.set({ id: 'MASTER_SCHEDULE', schedule: {} });
      }
      this.statusText.set('總床位表已載入');
      this.tableKey.set(Date.now());
    } catch (error) {
      console.error('[BaseScheduleView] 載入資料失敗:', error);
      this.statusText.set('讀取失敗');
      this.masterRecord.set({ id: 'MASTER_SCHEDULE', schedule: {} });
    }
  }

  private async handlePatientDataUpdate(): Promise<void> {
    await this.loadAllData();
  }

  private handleScheduleUpdate(): void {
    this.loadAllData();
  }
}
