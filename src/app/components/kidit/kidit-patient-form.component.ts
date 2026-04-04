import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { KIDIT_OPTIONS } from '@/utils/kiditHelpers';
import { kiditService } from '@/services/kiditService';

@Component({
  selector: 'app-kidit-patient-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './kidit-patient-form.component.html',
  styleUrl: './kidit-patient-form.component.css'
})
export class KiditPatientFormComponent implements OnChanges {
  @Input() date = '';
  @Input() eventId = '';
  @Input() initialData: any = null;
  @Input() masterPatient: any = null;
  @Output() updated = new EventEmitter<any>();

  isSaving = false;
  formData: any = {};

  readonly opts = KIDIT_OPTIONS;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialData'] || changes['masterPatient']) {
      this.initData();
    }
  }

  private initData(): void {
    if (this.initialData) {
      this.formData = JSON.parse(JSON.stringify(this.initialData));
    } else if (this.masterPatient) {
      const p = this.masterPatient;
      const k = p.kiditProfile || {};
      this.formData = {
        name: p.name || '',
        idNumber: k.idNumber || p.idNumber || '',
        medicalRecordNumber: k.medicalRecordNumber || p.medicalRecordNumber || '',
        patientCategory: k.patientCategory || '00',
        birthDate: k.birthDate || p.birthDate || '',
        gender: k.gender || (p.gender === '男' ? '1' : '2'),
        bloodType: k.bloodType || '',
        isIndigenous: k.isIndigenous || 'N',
        isWelfare: k.isWelfare || 'N',
        catastrophicCardNo: k.catastrophicCardNo || '',
        address: k.address || '',
        phone: k.phone || '',
        maritalStatus: k.maritalStatus || '',
        education: k.education || '',
        occupation: k.occupation || '',
        contactPerson: k.contactPerson || '',
        relationship: k.relationship || '',
        dialysisCode: k.dialysisCode || '',
        status: k.status || '1',
        firstDialysisDate: k.firstDialysisDate || '',
        hospitalStartDate: k.hospitalStartDate || '',
        diagnosisCategory: k.diagnosisCategory || '',
        diagnosisSubcategory: k.diagnosisSubcategory || '',
      };
    } else {
      this.formData = {};
    }
  }

  async saveData(): Promise<void> {
    this.isSaving = true;
    try {
      await kiditService.updateEventKiDitData(this.date, this.eventId, 'kidit_profile', this.formData);
      this.updated.emit(this.formData);
    } catch (error) {
      console.error('儲存失敗:', error);
      alert('儲存失敗');
    } finally {
      this.isSaving = false;
    }
  }
}
