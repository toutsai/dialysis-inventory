import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import ApiManager from '@/services/api_manager';
import { ORDERED_SHIFT_CODES } from '@/constants/scheduleConstants';
import { AuthService } from '@services/auth.service';
import { getTomorrow } from '@/utils/dateUtils';
import { escapeHtml } from '@/utils/sanitize';
import { BedAssignmentDialogComponent } from '../bed-assignment-dialog/bed-assignment-dialog.component';

@Component({
  selector: 'app-patient-update-scheduler-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, BedAssignmentDialogComponent],
  templateUrl: './patient-update-scheduler-dialog.component.html',
  styleUrl: './patient-update-scheduler-dialog.component.css'
})
export class PatientUpdateSchedulerDialogComponent implements OnChanges {
  private readonly authService = inject(AuthService);
  private schedulesApi = ApiManager('schedules');
  private baseSchedulesApi = ApiManager('base_schedules');

  @Input() isVisible = true;
  @Input() patient: any = null;
  @Input() changeType = '';
  @Input() allPatients: any[] = [];
  @Input() isEditing = false;
  @Input() initialData: any = null;
  @Output() close = new EventEmitter<void>();
  @Output() submit = new EventEmitter<any>();

  isSubmitting = false;
  isBedAssignmentVisible = false;
  bedAssignmentScheduleData: any = {};
  formData: any = { effectiveDate: '', payload: {} };

  readonly shifts = ORDERED_SHIFT_CODES;
  readonly bedLayout = [
    1,2,3,5,6,7,8,9,11,12,13,15,16,17,18,19,21,22,23,25,26,27,28,29,
    31,32,33,35,36,37,38,39,51,52,53,55,56,57,58,59,61,62,63,65,
    ...Array.from({ length: 6 }, (_, i) => `peripheral-${i + 1}`),
  ];
  readonly freqMap: Record<string, number[]> = {
    '\u4E00\u4E09\u4E94': [0,2,4], '\u4E8C\u56DB\u516D': [1,3,5],
    '\u4E00\u56DB': [0,3], '\u4E8C\u4E94': [1,4], '\u4E09\u516D': [2,5],
    '\u4E00\u4E94': [0,4], '\u4E8C\u516D': [1,5],
    '\u6BCF\u65E5': [0,1,2,3,4,5],
    '\u6BCF\u5468\u4E00': [0], '\u6BCF\u5468\u4E8C': [1], '\u6BCF\u5468\u4E09': [2],
    '\u6BCF\u5468\u56DB': [3], '\u6BCF\u5468\u4E94': [4], '\u6BCF\u5468\u516D': [5],
  };
  readonly FREQ_OPTIONS = Object.keys(this.freqMap);
  readonly DELETE_REASONS = [
    { value: '\u6B7B\u4EA1', text: '\u6B7B\u4EA1' },
    { value: '\u8F49\u5916\u9662\u900F\u6790', text: '\u8F49\u5916\u9662\u900F\u6790' },
    { value: '\u8F49PD', text: '\u8F49PD' },
    { value: '\u814E\u81DF\u79FB\u690D', text: '\u814E\u81DF\u79FB\u690D' },
    { value: '\u8F49\u5B89\u5BE7', text: '\u8F49\u5B89\u5BE7' },
    { value: '\u814E\u529F\u80FD\u6062\u5FA9\u4E0D\u9808\u900F\u6790', text: '\u814E\u529F\u80FD\u6062\u5FA9\u4E0D\u9808\u900F\u6790' },
  ];

  get dialogTitle(): string {
    const baseTitle = this.isEditing ? '\u4FEE\u6539\u9810\u7D04\u8B8A\u66F4' : '\u9810\u7D04\u8B8A\u66F4';
    const typeMap: Record<string, string> = {
      UPDATE_STATUS: '\u9810\u7D04\u8EAB\u5206\u8B8A\u66F4',
      UPDATE_MODE: '\u9810\u7D04\u900F\u6790\u6A21\u5F0F\u8B8A\u66F4',
      UPDATE_FREQ: '\u9810\u7D04\u983B\u7387\u8B8A\u66F4',
      UPDATE_BASE_SCHEDULE_RULE: '\u9810\u7D04\u7E3D\u8868\u898F\u5247\u8B8A\u66F4',
      DELETE_PATIENT: '\u9810\u7D04\u522A\u9664\u75C5\u4EBA',
    };
    const typeText = typeMap[this.changeType] ? ` - ${typeMap[this.changeType]}` : '';
    return baseTitle + typeText;
  }

  get selectedPatientDisplay(): string {
    if (!this.patient) return '\u672A\u9078\u64C7\u75C5\u4EBA';
    return `${escapeHtml(this.patient.name)} (${escapeHtml(this.patient.medicalRecordNumber)})`;
  }

  get baseRuleDisplay(): string {
    const { bedNum, shiftIndex, freq } = this.formData.payload;
    if (bedNum !== undefined && shiftIndex !== undefined && freq) {
      const shiftDisplayMap: Record<number, string> = { 0: '\u65E9', 1: '\u5348', 2: '\u665A' };
      const shiftText = shiftDisplayMap[shiftIndex];
      const bedText = String(bedNum).startsWith('peripheral')
        ? `\u5916\u570D ${bedNum.split('-')[1]}`
        : `${bedNum}\u5E8A`;
      return `${bedText} / ${shiftText}\u73ED / ${freq}`;
    }
    return '\u9EDE\u64CA\u4EE5\u8A2D\u5B9A\u65B0\u898F\u5247...';
  }

  get isFormValid(): boolean {
    if (!this.formData.effectiveDate) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const effective = new Date(this.formData.effectiveDate);
    if (effective <= today) return false;

    switch (this.changeType) {
      case 'UPDATE_STATUS': return !!this.formData.payload.status;
      case 'UPDATE_MODE': return !!this.formData.payload.mode;
      case 'UPDATE_FREQ': return !!this.formData.payload.freq;
      case 'UPDATE_BASE_SCHEDULE_RULE':
        return !!this.formData.payload.bedNum && this.formData.payload.shiftIndex !== undefined && !!this.formData.payload.freq;
      case 'DELETE_PATIENT': return !!this.formData.payload.deleteReason;
      case 'RESTORE_PATIENT': return !!this.formData.payload.status;
      default: return false;
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible && this.patient && this.changeType) {
      if (this.isEditing && this.initialData) {
        this.formData.effectiveDate = this.initialData.effectiveDate;
        this.formData.payload = JSON.parse(JSON.stringify(this.initialData.payload));
      } else {
        this.formData.effectiveDate = getTomorrow();
        switch (this.changeType) {
          case 'UPDATE_STATUS':
            this.formData.payload = { status: this.patient.status, wardNumber: this.patient.wardNumber || '' };
            break;
          case 'UPDATE_MODE':
            this.formData.payload = { mode: this.patient.mode || 'HD' };
            break;
          case 'UPDATE_FREQ':
            this.formData.payload = { freq: this.patient.freq || '\u4E00\u4E09\u4E94' };
            break;
          case 'UPDATE_BASE_SCHEDULE_RULE':
            this.formData.payload = {};
            break;
          case 'DELETE_PATIENT':
            this.formData.payload = { deleteReason: '\u8F49\u5916\u9662\u900F\u6790', remarks: '' };
            break;
          case 'RESTORE_PATIENT':
            this.formData.payload = { status: 'opd', wardNumber: '' };
            break;
          default:
            this.formData.payload = {};
        }
      }
    }
  }

  onClose(): void {
    this.close.emit();
  }

  onStatusChange(): void {
    if (this.formData.payload.status === 'opd') {
      this.formData.payload.wardNumber = '';
    }
  }

  async openBedAssignmentDialog(): Promise<void> {
    try {
      const masterScheduleDoc = await this.baseSchedulesApi.fetchById('MASTER_SCHEDULE');
      const scheduleData = masterScheduleDoc ? masterScheduleDoc.schedule : {};
      const weeklyScheduleMap: any = {};
      if (scheduleData) {
        for (const patientId in scheduleData as any) {
          const rule = scheduleData[patientId];
          if (rule.freq && rule.bedNum !== undefined && rule.shiftIndex !== undefined) {
            const dayIndices = this.freqMap[rule.freq] || [];
            dayIndices.forEach((dayIndex: number) => {
              const weeklySlotId = `${rule.bedNum}-${rule.shiftIndex}-${dayIndex}`;
              weeklyScheduleMap[weeklySlotId] = { patientId };
            });
          }
        }
      }
      this.bedAssignmentScheduleData = weeklyScheduleMap;
      this.isBedAssignmentVisible = true;
    } catch (error) {
      console.error('\u958B\u555F\u667A\u6167\u6392\u5E8A\u5931\u6557:', error);
      alert('\u7121\u6CD5\u8F09\u5165\u7E3D\u8868\u8CC7\u6599\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66\u3002');
    }
  }

  handleBedAssigned(event: { bedNum: any; shiftCode: string; newFreq?: string }): void {
    const shiftIndex = this.shifts.indexOf(event.shiftCode);
    this.formData.payload = { bedNum: event.bedNum, shiftIndex, freq: event.newFreq };
    this.isBedAssignmentVisible = false;
  }

  async submitForm(): Promise<void> {
    if (!this.isFormValid) return;
    this.isSubmitting = true;
    const user = this.authService.currentUser();
    const dataToSubmit = {
      patientId: this.patient.id,
      patientName: this.patient.name,
      effectiveDate: this.formData.effectiveDate,
      changeType: this.changeType,
      payload: JSON.parse(JSON.stringify(this.formData.payload)),
      status: 'pending',
      createdBy: { uid: user?.uid, name: (user as any)?.displayName || user?.email },
      createdAt: new Date(),
    };
    try {
      this.submit.emit(dataToSubmit);
    } catch (error) {
      console.error('\u63D0\u4EA4\u9810\u7D04\u5931\u6557:', error);
    } finally {
      this.isSubmitting = false;
    }
  }
}
