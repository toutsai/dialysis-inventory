import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FirebaseService } from '@services/firebase.service';
import { deleteDoc, doc, getDoc, getDocs, collection, query, where } from 'firebase/firestore';
import { PatientSelectDialogComponent } from '@app/components/dialogs/patient-select-dialog/patient-select-dialog.component';
import { BedAssignmentDialogComponent } from '@app/components/dialogs/bed-assignment-dialog/bed-assignment-dialog.component';

@Component({
  selector: 'app-exception-create-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, PatientSelectDialogComponent, BedAssignmentDialogComponent],
  templateUrl: './exception-create-dialog.component.html',
  styleUrl: './exception-create-dialog.component.css'
})
export class ExceptionCreateDialogComponent implements OnChanges {
  private readonly firebase = inject(FirebaseService);

  @Input() isVisible = true;
  @Input() allPatients: any[] = [];
  @Input() isPageLocked = false;
  @Input() initialData: any = null;
  @Output() close = new EventEmitter<void>();
  @Output() submit = new EventEmitter<any>();
  @Output() delete = new EventEmitter<string>();

  isPatientDialogVisible = false;
  isBedAssignmentVisible = false;
  isSubmitting = false;
  isFetchingSource = false;
  sourceScheduleMessage = '';
  dailyScheduleForSwap: any = null;
  isFetchingSwapSchedule = false;
  patientB_SwapSelection = '';
  bedAssignmentProps: any = null;

  formData: any = this.defaultFormData();

  readonly shifts = ['early', 'noon', 'late'];
  readonly bedLayout = [1,2,3,5,6,7,8,9,11,12,13,15,16,17,18,19,21,22,23,25,26,27,28,29,31,32,33,35,36,37,38,39,51,52,53,55,56,57,58,59,61,62,63,65];
  readonly modeOptions = ['HD', 'SLED', 'CVVHDF', 'PP', 'DFPP', 'Lipid'];
  readonly freqMap: Record<string, number[]> = {
    '一三五': [0,2,4], '二四六': [1,3,5],
    '一四': [0,3], '二五': [1,4], '三六': [2,5],
    '一五': [0,4], '二六': [1,5],
    '每日': [0,1,2,3,4,5],
    '每周一': [0], '每周二': [1], '每周三': [2],
    '每周四': [3], '每周五': [4], '每周六': [5],
  };

  private defaultFormData(): any {
    return {
      id: null, patientId: '', patientName: '', type: null,
      date: '', startDate: '', endDate: '', reason: '',
      from: { sourceDate: '', bedNum: null, shiftCode: null },
      to: { goalDate: '', bedNum: null, shiftCode: null },
      patient1: null, patient2: null,
      mode: 'HD',
    };
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      if (this.initialData) {
        this.formData = {
          ...this.defaultFormData(),
          ...JSON.parse(JSON.stringify(this.initialData)),
          reason: '',
          to: { goalDate: this.initialData?.to?.goalDate || '', bedNum: null, shiftCode: null },
        };
      } else {
        this.formData = this.defaultFormData();
      }
    }
  }

  get selectedPatientAsArray(): any[] {
    const p = this.allPatients.find(pt => pt.id === this.formData.patientId);
    return p ? [p] : [];
  }

  get selectedPatientDisplay(): string {
    const p = this.allPatients.find(pt => pt.id === this.formData.patientId);
    if (!p) return '';
    const statusMap: Record<string, string> = { er: '急診', ipd: '住院', opd: '門診' };
    const status = statusMap[p.status] || '';
    return `<strong>${p.name}</strong> (${p.medicalRecordNumber}) ${status} ${p.freq || ''}`;
  }

  get isEditingMode(): boolean {
    return !!this.initialData;
  }

  get dialogTitle(): string {
    if (this.isEditingMode) return '解決排程衝突';
    const typeMap: Record<string, string> = { MOVE: '臨時調班', SUSPEND: '區間暫停', ADD_SESSION: '臨時加洗', SWAP: '同日互調' };
    const title = typeMap[this.formData.type] ? ` - ${typeMap[this.formData.type]}` : '';
    return `新增調班申請${title}`;
  }

  get sourceBedDisplay(): string {
    if (this.isFetchingSource) return '查詢中...';
    if (this.sourceScheduleMessage) return this.sourceScheduleMessage;
    if (this.formData.from.bedNum && this.formData.from.shiftCode) {
      const shiftMap: Record<string, string> = { early: '早', noon: '午', late: '晚' };
      const shiftText = shiftMap[this.formData.from.shiftCode] || this.formData.from.shiftCode;
      const bedText = String(this.formData.from.bedNum).startsWith('peripheral')
        ? `外圍 ${this.formData.from.bedNum.split('-')[1]}`
        : `${this.formData.from.bedNum}床`;
      return `${bedText} / ${shiftText}班`;
    }
    return '待查詢...';
  }

  get targetBedDisplay(): string {
    if (this.formData.to.bedNum && this.formData.to.shiftCode) {
      const shiftMap: Record<string, string> = { early: '早', noon: '午', late: '晚' };
      const shiftText = shiftMap[this.formData.to.shiftCode] || this.formData.to.shiftCode;
      const bedText = String(this.formData.to.bedNum).startsWith('peripheral')
        ? `外圍 ${this.formData.to.bedNum.split('-')[1]}`
        : `${this.formData.to.bedNum}床`;
      return `${bedText} / ${shiftText}班`;
    }
    return '點擊以選擇目標床位...';
  }

  get isFormValid(): boolean {
    if (!this.formData.type || !this.formData.patientId) return false;
    const hasReason = this.isEditingMode || !!this.formData.reason?.trim();
    switch (this.formData.type) {
      case 'MOVE': return !!(this.formData.from.bedNum && this.formData.to.bedNum && this.formData.to.goalDate && hasReason);
      case 'SUSPEND': return !!(this.formData.startDate && this.formData.endDate && this.formData.endDate >= this.formData.startDate && hasReason);
      case 'ADD_SESSION': return !!(this.formData.to.goalDate && this.formData.to.bedNum && hasReason);
      case 'SWAP': return !!(this.formData.date && this.formData.patient1 && this.formData.patient2 && hasReason);
      default: return false;
    }
  }

  onClose(): void {
    this.close.emit();
  }

  handlePatientSelected(event: any): void {
    const patient = this.allPatients.find(p => p.id === event.patientId);
    if (patient) {
      this.formData.patientId = patient.id;
      this.formData.patientName = patient.name;
      this.formData.mode = patient.mode || 'HD';
    }
    this.isPatientDialogVisible = false;
  }

  submitForm(): void {
    if (!this.isFormValid) return;
    const dataToSubmit = JSON.parse(JSON.stringify(this.formData));
    switch (dataToSubmit.type) {
      case 'MOVE':
        dataToSubmit.startDate = dataToSubmit.from.sourceDate;
        dataToSubmit.endDate = dataToSubmit.to.goalDate;
        break;
      case 'ADD_SESSION':
        dataToSubmit.startDate = dataToSubmit.to.goalDate;
        dataToSubmit.endDate = dataToSubmit.to.goalDate;
        dataToSubmit.from = null;
        dataToSubmit.mode = this.formData.mode || 'HD';
        break;
      case 'SWAP':
        dataToSubmit.startDate = dataToSubmit.date;
        dataToSubmit.endDate = dataToSubmit.date;
        dataToSubmit.from = null;
        dataToSubmit.to = null;
        break;
    }
    this.submit.emit(dataToSubmit);
  }

  async handleDelete(): Promise<void> {
    if (!this.isEditingMode || !this.initialData?.id) return;
    this.isSubmitting = true;
    try {
      await deleteDoc(doc(this.firebase.db, 'schedule_exceptions', this.initialData.id));
      this.delete.emit(this.initialData.id);
    } catch (error) {
      console.error('撤銷申請失敗:', error);
    } finally {
      this.isSubmitting = false;
      this.onClose();
    }
  }

  handleTargetBedAssigned(event: any): void {
    this.formData.to.bedNum = event.bedNum;
    this.formData.to.shiftCode = event.shiftCode;
    this.isBedAssignmentVisible = false;
  }

  // --- Schedule Lookup Methods ---

  async fetchSourceSchedule(): Promise<void> {
    const date = this.formData.from.sourceDate;
    const patientId = this.formData.patientId;
    if (!date || !patientId) return;

    this.isFetchingSource = true;
    this.sourceScheduleMessage = '';
    this.formData.from.bedNum = null;
    this.formData.from.shiftCode = null;

    try {
      const docRef = doc(this.firebase.db, 'schedules', date);
      const docSnap = await getDoc(docRef);
      if (!docSnap.exists()) {
        this.sourceScheduleMessage = '該日無排班資料';
        return;
      }
      const schedule = docSnap.data()['schedule'] || {};

      for (const shiftId in schedule) {
        if (schedule[shiftId]?.patientId === patientId) {
          const parts = shiftId.split('-');
          const shiftCode = parts.pop()!;
          const bedNum = shiftId.replace(`-${shiftCode}`, '').replace('bed-', '');
          this.formData.from.bedNum = bedNum;
          this.formData.from.shiftCode = shiftCode;
          return;
        }
      }
      this.sourceScheduleMessage = '當日無此病人排班';
    } catch (error) {
      console.error('查詢原始排班失敗:', error);
      this.sourceScheduleMessage = '查詢失敗';
    } finally {
      this.isFetchingSource = false;
    }
  }

  async openBedAssignmentForTarget(): Promise<void> {
    const targetDate = this.formData.to.goalDate;
    if (!targetDate) return;

    let scheduleData: any = {};
    try {
      const docRef = doc(this.firebase.db, 'schedules', targetDate);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        scheduleData = docSnap.data()['schedule'] || {};
      }
    } catch (error) {
      console.error('查詢目標日排班失敗:', error);
    }

    this.bedAssignmentProps = {
      scheduleData,
      targetDate,
      assignmentMode: 'singleDay',
    };
    this.isBedAssignmentVisible = true;
  }

  async fetchScheduleForSwap(): Promise<void> {
    const date = this.formData.date;
    const patientId = this.formData.patientId;
    if (!date || !patientId) {
      this.dailyScheduleForSwap = null;
      this.formData.patient1 = null;
      return;
    }

    this.isFetchingSwapSchedule = true;
    this.dailyScheduleForSwap = null;
    this.formData.patient1 = null;
    this.formData.patient2 = null;
    this.patientB_SwapSelection = '';

    try {
      const docRef = doc(this.firebase.db, 'schedules', date);
      const docSnap = await getDoc(docRef);
      const schedule = docSnap.exists() ? (docSnap.data()['schedule'] || null) : null;
      this.dailyScheduleForSwap = schedule;

      if (schedule) {
        for (const [key, slot] of Object.entries(schedule) as [string, any][]) {
          if (slot?.patientId === patientId) {
            const parts = key.split('-');
            const shiftCode = parts.pop()!;
            const bedNum = key.replace(`-${shiftCode}`, '').replace('bed-', '');
            this.formData.patient1 = {
              patientId,
              patientName: this.formData.patientName,
              fromBedNum: bedNum,
              fromShiftCode: shiftCode,
            };
            break;
          }
        }
      }
    } catch (error) {
      console.error('取得互調排班資料失敗:', error);
    } finally {
      this.isFetchingSwapSchedule = false;
    }
  }

  get patientA_SwapDisplay(): string {
    if (!this.formData.date) return '請先選擇日期...';
    if (this.isFetchingSwapSchedule) return '查詢排班中...';
    if (!this.formData.patient1) return `當日無 ${this.formData.patientName} 的排班`;
    const { fromBedNum, fromShiftCode } = this.formData.patient1;
    const shiftMap: Record<string, string> = { early: '早', noon: '午', late: '晚' };
    const shiftText = shiftMap[fromShiftCode] || fromShiftCode;
    const bedText = String(fromBedNum).startsWith('peripheral')
      ? `外圍 ${fromBedNum.split('-')[1]}`
      : `${fromBedNum}床`;
    return `${this.formData.patientName} (${bedText} / ${shiftText}班)`;
  }

  get availableSlotsForPatientB(): any[] {
    if (!this.dailyScheduleForSwap || !this.formData.patient1) return [];
    const shiftMap: Record<string, string> = { early: '早', noon: '午', late: '晚' };
    const slots: any[] = [];
    for (const [key, slot] of Object.entries(this.dailyScheduleForSwap) as [string, any][]) {
      if (slot?.patientId && slot.patientId !== this.formData.patientId) {
        const parts = key.split('-');
        const shiftCode = parts.pop()!;
        const bedNum = key.replace(`-${shiftCode}`, '').replace('bed-', '');
        const patient = this.allPatients.find(p => p.id === slot.patientId);
        const name = patient?.name || slot.patientName || `ID: ${slot.patientId}`;
        const shiftText = shiftMap[shiftCode] || shiftCode;
        const bedText = String(bedNum).startsWith('peripheral')
          ? `外圍 ${bedNum.split('-')[1]}`
          : `${bedNum}床`;
        slots.push({
          key,
          displayText: `${name} (${bedText} / ${shiftText}班)`,
          data: {
            patientId: slot.patientId,
            patientName: name,
            fromBedNum: bedNum,
            fromShiftCode: shiftCode,
          },
        });
      }
    }
    const shiftOrder: Record<string, number> = { early: 1, noon: 2, late: 3 };
    return slots.sort((a, b) => {
      const so = (shiftOrder[a.data.fromShiftCode] || 99) - (shiftOrder[b.data.fromShiftCode] || 99);
      if (so !== 0) return so;
      const bedA = String(a.data.fromBedNum).startsWith('peripheral') ? 1000 : parseInt(a.data.fromBedNum, 10);
      const bedB = String(b.data.fromBedNum).startsWith('peripheral') ? 1000 : parseInt(b.data.fromBedNum, 10);
      return bedA - bedB;
    });
  }
}
