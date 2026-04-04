import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-patient-select-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './patient-select-dialog.component.html',
  styleUrl: './patient-select-dialog.component.css'
})
export class PatientSelectDialogComponent implements OnChanges {
  @Input() isVisible = false;
  @Input() title = '選擇項目';
  @Input() patients: any[] = [];
  @Input() showFillOptions = false;
  @Input() patientStatusFilter = 'active';
  @Output() confirm = new EventEmitter<any>();
  @Output() cancel = new EventEmitter<void>();

  searchTerm = '';
  filterFreq = '';
  filterStatus = 'all';
  selectedPatientId: string | null = null;

  readonly FREQ_OPTIONS = [
    '一三五', '二四六', '一四', '二五', '三六',
    '一五', '二六', '每周一次', '臨時',
  ];
  readonly STATUS_OPTIONS = [
    { value: 'all', text: '全部' },
    { value: 'er', text: '急診' },
    { value: 'ipd', text: '住院' },
    { value: 'opd', text: '門診' },
  ];
  readonly statusMap: Record<string, string> = { er: '急', ipd: '住', opd: '門' };

  get filteredPatients(): any[] {
    let result: any[];

    if (this.patientStatusFilter === 'deleted') {
      result = (this.patients || []).filter((p: any) => p.isDeleted);
    } else {
      result = (this.patients || []).filter((p: any) => !p.isDeleted && !p.isDiscontinued);
    }

    if (this.patientStatusFilter === 'active') {
      if (this.filterStatus !== 'all') {
        result = result.filter((p: any) => p.status === this.filterStatus);
      }
      if (this.filterFreq) {
        result = result.filter((p: any) => p.freq === this.filterFreq);
      }
    }

    if (this.searchTerm) {
      const term = this.searchTerm.toLowerCase();
      result = result.filter(
        (p: any) =>
          p.name.toLowerCase().includes(term) ||
          (p.medicalRecordNumber && p.medicalRecordNumber.includes(term))
      );
    }

    if (this.patientStatusFilter === 'deleted') {
      return result.sort((a: any, b: any) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
    } else {
      return result.sort((a: any, b: any) => a.name.localeCompare(b.name, 'zh-Hant'));
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      this.searchTerm = '';
      this.filterFreq = '';
      this.filterStatus = 'all';
      this.selectedPatientId = null;
    }
  }

  selectPatient(patientId: string): void {
    this.selectedPatientId = patientId;
  }

  onConfirm(fillType: string | null = null): void {
    if (this.selectedPatientId) {
      const payload: any = { patientId: this.selectedPatientId };
      if (fillType) {
        payload.fillType = fillType;
      }
      this.confirm.emit(payload);
    }
  }

  onCancel(): void {
    this.cancel.emit();
  }
}
