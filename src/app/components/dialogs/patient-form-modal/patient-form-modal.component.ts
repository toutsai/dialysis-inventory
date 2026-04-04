import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-patient-form-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './patient-form-modal.component.html',
  styleUrl: './patient-form-modal.component.css'
})
export class PatientFormModalComponent implements OnInit {
  @Input() patientData: any = {};
  @Input() patientType = '';
  @Output() close = new EventEmitter<void>();
  @Output() save = new EventEmitter<any>();

  form: any = {};

  readonly PHYSICIANS = ['廖丁瑩', '蔡宜潔', '蘇哲弘', '蔡亨政'];
  readonly FREQ_OPTIONS = [
    '一三五', '二四六', '一四', '二五', '三六',
    '一五', '二六', '每日',
    '每周一', '每周二', '每周三', '每周四', '每周五', '每周六',
    '臨時',
  ];
  readonly MODES = ['HD', 'SLED', 'CVVHDF', 'PP', 'DFPP', 'Lipid'];
  readonly VASC_ACCESSES = ['Double lumen', 'PERM', '左臂AVF', '右臂AVF', '左臂AVG', '右臂AVG'];
  readonly DISEASES = ['HIV', 'RPR', 'BC肝?', 'HBV', 'HCV', 'C肝治癒', 'COVID', '隔離'];

  get isEditing(): boolean {
    return !!(this.form && this.form.id);
  }

  get patientTypeText(): string {
    const map: Record<string, string> = { ipd: '住院', opd: '門診', er: '急診' };
    return map[this.patientType] || '';
  }

  ngOnInit(): void {
    document.body.classList.add('modal-open');
    const data = JSON.parse(JSON.stringify(this.patientData || {}));
    if (!data.id) {
      data.status = this.patientType;
      data.patientCategory = this.patientType === 'opd' ? 'opd_regular' : 'non_regular';
    }
    if (!data.patientCategory) data.patientCategory = 'opd_regular';
    data.diseases = data.diseases || [];
    data.patientStatus = data.patientStatus || {
      isFirstDialysis: { active: false, date: null },
      isPaused: { active: false, date: null },
      hasBloodDraw: { active: false, date: null },
    };
    data.hospitalInfo = data.hospitalInfo || { source: '', transferOut: '' };
    this.form = data;
  }

  toggleDisease(disease: string): void {
    const index = (this.form.diseases || []).indexOf(disease);
    if (index > -1) {
      this.form.diseases.splice(index, 1);
    } else {
      this.form.diseases.push(disease);
    }
  }

  isDiseaseSelected(disease: string): boolean {
    return (this.form.diseases || []).includes(disease);
  }

  toggleStatus(key: string): void {
    if (this.form.patientStatus && this.form.patientStatus[key]) {
      const status = this.form.patientStatus[key];
      status.active = !status.active;
      if (!status.active) status.date = null;
    }
  }

  closeModal(): void {
    document.body.classList.remove('modal-open');
    this.close.emit();
  }

  handleSave(): void {
    if (!this.form.name || !this.form.medicalRecordNumber) {
      alert('姓名和病歷號為必填項！');
      return;
    }
    this.save.emit(this.form);
  }
}
