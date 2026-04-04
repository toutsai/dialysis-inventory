import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AlertDialogComponent } from '../alert-dialog/alert-dialog.component';

interface PendingAssignment {
  patientId: string;
  patientName: string;
  bedNum: number | string;
  shiftCode: string;
  shiftId: string;
}

@Component({
  selector: 'app-bed-assignment-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, AlertDialogComponent],
  templateUrl: './bed-assignment-dialog.component.html',
  styleUrl: './bed-assignment-dialog.component.css'
})
export class BedAssignmentDialogComponent implements OnChanges, OnInit, OnDestroy {
  @Input() isVisible = false;
  @Input() title: string | null = null;
  @Input() allPatients: any[] = [];
  @Input() bedLayout: (number | string)[] = [];
  @Input() scheduleData: Record<string, any> = {};
  @Input() targetDate: string | null = null;
  @Input() shifts: string[] = [];
  @Input() freqMap: Record<string, number[]> = {};
  @Input() predefinedPatientGroups: Record<string, any[]> | null = null;
  @Input() assignmentMode = 'frequency';
  @Input() dayOfWeek = 1;
  @Input() context: any = null;
  @Input() hidePatientList = false;
  @Output() close = new EventEmitter<void>();
  @Output() assignBed = new EventEmitter<any>();

  selectedFreq = 'all';
  selectedShiftFilter = 'all';
  selectedPatientId: string | null = null;
  alertInfo = { isVisible: false, title: '', message: '' };
  localAssignedPatientIds = new Set<string>();
  isComponentMounted = false;
  pendingAssignments: PendingAssignment[] = [];
  newFreqSelection = '';

  readonly shiftDisplayNames: Record<string, string> = { early: '早班', noon: '午班', late: '晚班' };
  private readonly hepatitisBedNumbers = [31, 32, 33, 35, 36];
  private readonly FREQ_ORDER_MAP: Record<string, number> = {
    '每日': 1, '一三五': 2, '二四六': 2, '一四': 3, '二五': 3, '三六': 3,
    '一五': 3, '二六': 3, '每周一': 4, '每周二': 4, '每周三': 4,
    '每周四': 4, '每周五': 4, '每周六': 4
  };

  get effectiveDayOfWeek(): number {
    if (this.targetDate) {
      const date = new Date(this.targetDate);
      const day = date.getDay();
      return day === 0 ? 7 : day; // 1-based: Mon=1, Tue=2, ..., Sun=7
    }
    return this.dayOfWeek;
  }

  get isEditMode(): boolean {
    return this.context?.mode === 'change_freq_and_bed' || this.context?.mode === 'change_bed_only';
  }

  get currentPatient(): any {
    return this.isEditMode && this.context?.patient ? this.context.patient : null;
  }

  get dialogTitle(): string {
    if (this.title) return this.title;
    if (this.hidePatientList) return '選擇目標床位';
    if (this.context?.mode === 'change_freq_and_bed') return `變更頻率與床位：${this.currentPatient?.name || ''}`;
    if (this.context?.mode === 'change_bed_only') return `更換床位：${this.currentPatient?.name || ''}`;
    return '智慧排班助理';
  }

  get leftColumnTitle(): string {
    if (this.isEditMode) return '當前病人資訊';
    return this.predefinedPatientGroups ? '問題病人列表' : '選擇病人';
  }

  get showFreqSelector(): boolean {
    return (this.assignmentMode === 'frequency' || this.assignmentMode === 'base') && !this.predefinedPatientGroups;
  }

  get availableBedsTitle(): string {
    const patient = this.allPatients[0];
    const freq = this.targetFrequency;
    if (this.hidePatientList) return patient && freq ? `選擇目標空床 (${patient.name} - ${freq})` : '選擇目標空床';
    if (freq && freq !== 'all') return `可用空床 (${freq})`;
    return '可用空床';
  }

  get targetFrequency(): string | null {
    if (this.hidePatientList) return this.allPatients[0]?.freq || null;
    if (this.isEditMode) {
      if (this.context?.mode === 'change_freq_and_bed') return this.newFreqSelection || this.currentPatient?.freq || null;
      return this.currentPatient?.freq || null;
    }
    if (this.selectedPatientId) {
      const patient = this.allPatients.find(p => p.id === this.selectedPatientId);
      return patient?.freq || null;
    }
    if (this.selectedFreq !== 'all') return this.selectedFreq;
    return null;
  }

  get canShowBeds(): boolean {
    if (this.hidePatientList) return !!this.allPatients[0]?.freq;
    if (this.isEditMode) return !!this.targetFrequency;
    return !!this.selectedPatientId || this.selectedFreq !== 'all';
  }

  get bedEmptyMessage(): string {
    if (this.hidePatientList) return '病人無有效頻率，無法查詢空床。';
    if (this.isEditMode) {
      if (this.context?.mode === 'change_freq_and_bed') return '請先選擇新頻率以查詢空床。';
      return this.currentPatient?.freq ? '正在查詢...' : '病人頻率資訊不完整。';
    }
    return '請從左側選擇病人，或從上方選擇一個頻率來查詢空床。';
  }

  get patientGroups(): Record<string, any[]> {
    if (this.predefinedPatientGroups) return this.predefinedPatientGroups;

    if (this.assignmentMode === 'frequency' || this.assignmentMode === 'base') {
      const groups: Record<string, any[]> = { '未排床 - 急診': [], '未排床 - 住院': [], '未排床 - 門診': [], '未排床(無頻率) - 住院/急診': [] };
      const unassignedAll = this.allPatients.filter(
        p => !p.isDeleted && !p.isDiscontinued && !this.localAssignedPatientIds.has(p.id)
      );
      const filteredPatients = this.selectedFreq === 'all'
        ? unassignedAll
        : unassignedAll.filter(p => p.freq === this.selectedFreq || (!p.freq && (p.status === 'ipd' || p.status === 'er')));
      filteredPatients.forEach(patient => {
        if (!patient.freq && (patient.status === 'ipd' || patient.status === 'er')) {
          groups['未排床(無頻率) - 住院/急診'].push(patient);
        } else if (patient.freq) {
          if (patient.status === 'er') groups['未排床 - 急診'].push(patient);
          else if (patient.status === 'ipd') groups['未排床 - 住院'].push(patient);
          else if (patient.status === 'opd') groups['未排床 - 門診'].push(patient);
        }
      });
      return groups;
    }

    if (this.assignmentMode === 'singleDay') {
      const tempGroups: Record<string, any[]> = { should_ipd: [], should_er: [], should_opd: [], not_should_ipd: [], not_should_er: [], not_should_opd: [] };
      if (!this.allPatients) return {};
      this.allPatients.forEach(p => {
        if (p.isDeleted || this.localAssignedPatientIds.has(p.id) || p.isDiscontinued) return;
        const shouldSchedule = this.shouldPatientBeScheduled(p, this.effectiveDayOfWeek);
        const prefix = shouldSchedule ? 'should' : 'not_should';
        const groupKey = `${prefix}_${p.status}`;
        if (tempGroups[groupKey]) tempGroups[groupKey].push(p);
      });
      const sortPatientsByFreq = (a: any, b: any) => (this.FREQ_ORDER_MAP[a.freq] || 99) - (this.FREQ_ORDER_MAP[b.freq] || 99);
      for (const key in tempGroups) tempGroups[key].sort(sortPatientsByFreq);
      return {
        '今日應排 - 住院': tempGroups.should_ipd,
        '今日應排 - 急診': tempGroups.should_er,
        '今日應排 - 門診': tempGroups.should_opd,
        '今日非排 (臨洗) - 住院': tempGroups.not_should_ipd,
        '今日非排 (臨洗) - 急診': tempGroups.not_should_er,
        '今日非排 (臨洗) - 門診': tempGroups.not_should_opd,
      };
    }
    return {};
  }

  get availableBeds(): Record<string, (number | string)[]> {
    const results: Record<string, (number | string)[]> = {};
    this.shifts.forEach(shiftCode => {
      if (this.selectedShiftFilter === 'all' || this.selectedShiftFilter === shiftCode) results[shiftCode] = [];
    });
    const isSingleDayMode = this.hidePatientList || this.assignmentMode === 'singleDay';
    if (isSingleDayMode) {
      this.bedLayout.forEach(bedNum => {
        this.shifts.forEach(shiftCode => {
          if (!results[shiftCode]) return;
          const bedIdPart = typeof bedNum === 'string' && (bedNum as string).startsWith('peripheral-') ? bedNum : `bed-${bedNum}`;
          const dailySlotId = `${bedIdPart}-${shiftCode}`;
          if (!this.scheduleData[dailySlotId]?.patientId) results[shiftCode].push(bedNum);
        });
      });
      return results;
    }
    const targetFreq = this.targetFrequency;
    if (!targetFreq) return {};
    const dayIndices = this.freqMap[targetFreq];
    if (!dayIndices || dayIndices.length === 0) return {};
    const targetPatientId = this.isEditMode ? this.currentPatient?.id : null;
    const temporarilyAssignedBeds = new Set(this.pendingAssignments.map(a => `${a.bedNum}-${a.shiftCode}`));
    this.bedLayout.forEach(bedNum => {
      this.shifts.forEach((shiftCode, shiftIndex) => {
        if (!results[shiftCode] || temporarilyAssignedBeds.has(`${bedNum}-${shiftCode}`)) return;
        let isFullyAvailable = true;
        for (const dayIndex of dayIndices) {
          const slotIdToCheck = `${bedNum}-${shiftIndex}-${dayIndex}`;
          const currentSlotData = this.scheduleData[slotIdToCheck];
          if (currentSlotData?.patientId && currentSlotData.patientId !== targetPatientId) { isFullyAvailable = false; break; }
        }
        if (isFullyAvailable) results[shiftCode].push(bedNum);
      });
    });
    return results;
  }

  get patientGroupKeys(): string[] {
    return Object.keys(this.patientGroups);
  }

  get availableBedKeys(): string[] {
    return Object.keys(this.availableBeds);
  }

  get allBedsEmpty(): boolean {
    return Object.values(this.availableBeds).every(b => b.length === 0);
  }

  get allGroupsEmpty(): boolean {
    return Object.values(this.patientGroups).every(p => p.length === 0);
  }

  ngOnInit() { this.isComponentMounted = true; }

  ngOnDestroy() {
    this.isComponentMounted = false;
    this.pendingAssignments = [];
    this.localAssignedPatientIds.clear();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['isVisible']) {
      if (this.isVisible) {
        this.isComponentMounted = true;
        const ids = new Set<string>();
        if (this.scheduleData) {
          for (const slotData of Object.values(this.scheduleData)) {
            if (slotData?.patientId) ids.add(slotData.patientId);
          }
        }
        this.localAssignedPatientIds = ids;
        if (this.isEditMode) {
          this.selectedPatientId = this.currentPatient?.id || null;
          this.newFreqSelection = '';
        } else {
          this.selectedFreq = 'all';
          this.selectedPatientId = null;
        }
      } else {
        this.selectedPatientId = null;
        this.selectedShiftFilter = 'all';
        this.newFreqSelection = '';
        this.pendingAssignments = [];
      }
    }
    if (changes['selectedFreq']) {
      this.selectedPatientId = null;
    }
  }

  onSelectedFreqChange() {
    this.selectedPatientId = null;
  }

  closeDialog() {
    if (!this.isComponentMounted) return;
    this.close.emit();
  }

  getStatusText(status: string): string {
    return ({ opd: '門診', ipd: '住院', er: '急診' } as Record<string, string>)[status] || status;
  }

  handleFreqChange() {}

  handlePatientClick(patientId: string) {
    this.selectedPatientId = patientId;
    this.selectedFreq = 'all';
  }

  handleBedClick(bedNum: number | string, shiftCode: string) {
    if (!this.isComponentMounted) return;
    let patientIdToAssign = this.selectedPatientId;
    if (this.hidePatientList) patientIdToAssign = this.allPatients[0]?.id;
    if (!patientIdToAssign && !this.isEditMode) {
      this.alertInfo = { isVisible: true, title: '操作提示', message: '請先從左側選擇一位病人才能排床！' };
      return;
    }
    const patient = this.allPatients.find(p => p.id === patientIdToAssign);
    const finalFreq = this.isEditMode
      ? (this.context?.mode === 'change_freq_and_bed' ? this.newFreqSelection : this.currentPatient?.freq)
      : patient?.freq;
    if (!finalFreq && !this.hidePatientList && this.assignmentMode !== 'singleDay') {
      this.alertInfo = { isVisible: true, title: '操作提示', message: '病人頻率資訊不完整！' };
      return;
    }
    const bedIdPart = typeof bedNum === 'string' && (bedNum as string).startsWith('peripheral-') ? bedNum : `bed-${bedNum}`;
    const shiftId = `${bedIdPart}-${shiftCode}`;
    if (this.isEditMode || this.hidePatientList) {
      this.assignBed.emit({
        patientId: patientIdToAssign, bedNum, shiftCode, shiftId,
        newFreq: this.isEditMode && this.context?.mode === 'change_freq_and_bed' ? finalFreq : undefined
      });
      return;
    }
    if (!patient) return;
    const existingIndex = this.pendingAssignments.findIndex(a => a.patientId === patientIdToAssign);
    const newAssignment: PendingAssignment = { patientId: patientIdToAssign!, patientName: patient.name, bedNum, shiftCode, shiftId };
    if (existingIndex !== -1) this.pendingAssignments[existingIndex] = newAssignment;
    else this.pendingAssignments.push(newAssignment);
    this.localAssignedPatientIds.add(patientIdToAssign!);
    this.selectedPatientId = null;
  }

  isPendingAssignment(patientId: string): boolean {
    return this.pendingAssignments.some(a => a.patientId === patientId);
  }

  getPendingBedInfo(patientId: string): string {
    const assignment = this.pendingAssignments.find(a => a.patientId === patientId);
    if (!assignment) return '';
    const bedDisplay = typeof assignment.bedNum === 'string' ? `外圍 ${(assignment.bedNum as string).split('-')[1]}` : assignment.bedNum;
    return `${bedDisplay}床 ${this.shiftDisplayNames[assignment.shiftCode]}`;
  }

  removePendingAssignment(index: number) {
    const assignment = this.pendingAssignments.splice(index, 1)[0];
    if (assignment) this.localAssignedPatientIds.delete(assignment.patientId);
  }

  clearPendingAssignments() {
    this.pendingAssignments.forEach(a => this.localAssignedPatientIds.delete(a.patientId));
    this.pendingAssignments = [];
  }

  confirmAllAssignments() {
    if (this.pendingAssignments.length === 0 || !this.isComponentMounted) return;
    this.pendingAssignments.forEach(a => this.assignBed.emit(a));
    this.alertInfo = { isVisible: true, title: '批量排床成功', message: `總共排入 ${this.pendingAssignments.length} 位病人，請記得點選右上角"儲存床位"。` };
    this.pendingAssignments = [];
  }

  shouldPatientBeScheduled(patient: any, dayOfWeek: number): boolean {
    if (patient.freq === '臨時') return true;
    if (!patient.freq || !this.freqMap) return false;
    const scheduledDays = this.freqMap[patient.freq];
    return scheduledDays ? scheduledDays.includes(dayOfWeek) : false;
  }

  isHepatitisBed(bedNum: number | string): boolean {
    return typeof bedNum === 'number' && this.hepatitisBedNumbers.includes(bedNum);
  }

  formatBedDisplay(bedNum: number | string): string {
    return typeof bedNum === 'string' ? `外圍 ${(bedNum as string).split('-')[1]}` : String(bedNum);
  }

  freqMapKeys(): string[] {
    return Object.keys(this.freqMap);
  }
}
