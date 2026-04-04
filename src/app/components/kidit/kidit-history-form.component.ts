import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { KIDIT_HISTORY_OPTIONS } from '@/utils/kiditHelpers';
import { kiditService } from '@/services/kiditService';

@Component({
  selector: 'app-kidit-history-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './kidit-history-form.component.html',
  styleUrl: './kidit-history-form.component.css'
})
export class KiditHistoryFormComponent implements OnChanges {
  @Input() date = '';
  @Input() eventId = '';
  @Input() initialData: any = null;
  @Input() masterPatient: any = null;
  @Output() updated = new EventEmitter<any>();

  isSaving = false;
  formData: any = {};

  readonly opts = KIDIT_HISTORY_OPTIONS;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialData'] || changes['masterPatient']) {
      this.initData();
    }
  }

  private initData(): void {
    if (this.initialData) {
      this.formData = JSON.parse(JSON.stringify(this.initialData));
    } else if (this.masterPatient) {
      const h = this.masterPatient.kiditProfile?.history || {};
      this.formData = {
        transferFromName: h.transferFromName || '',
        transferFromCode: h.transferFromCode || '',
        startHDDate: h.startHDDate || '',
        isStartHDHere: h.isStartHDHere || 'N',
        startHDHospital: h.startHDHospital || '',
        startPDDate: h.startPDDate || '',
        isStartPDHere: h.isStartPDHere || 'N',
        startPDHospital: h.startPDHospital || '',
        transplantDate: h.transplantDate || '',
        isTransplantHere: h.isTransplantHere || 'N',
        transplantHospital: h.transplantHospital || '',
        isKnownCKD: h.isKnownCKD || 'N',
        isBUNCreatAbnormal: h.isBUNCreatAbnormal || 'N',
        abnormalLabDate: h.abnormalLabDate || '',
        initialBUN: h.initialBUN || '',
        initialCr: h.initialCr || '',
        selectedSystemicDiseases: h.selectedSystemicDiseases || [],
        otherSystemicDescription: h.otherSystemicDescription || '',
        dmType: h.dmType || '3',
        initialLabDate: h.initialLabDate || '',
        initialHct: h.initialHct || '',
        initialHb: h.initialHb || '',
        initialK: h.initialK || '',
        initialAlb: h.initialAlb || '',
        initialWeight: h.initialWeight || '',
        initialHeight: h.initialHeight || '',
        initialEGFR: h.initialEGFR || '',
        hbsag: h.hbsag || 'O',
        antihcv: h.antihcv || 'O',
        indicationType: h.indicationType || '1',
        selectedSymptoms: h.selectedSymptoms || [],
        selectedEmergencyReasons: h.selectedEmergencyReasons || [],
        emergencyLabDate: h.emergencyLabDate || '',
        isFirstCatastrophic: h.isFirstCatastrophic || 'N',
      };
    } else {
      this.formData = {};
    }
  }

  // Checkbox array toggle helpers
  isSystemicDiseaseChecked(idx: number): boolean {
    return (this.formData.selectedSystemicDiseases || []).includes(idx);
  }
  toggleSystemicDisease(idx: number): void {
    const arr = this.formData.selectedSystemicDiseases || [];
    const i = arr.indexOf(idx);
    if (i > -1) arr.splice(i, 1); else arr.push(idx);
    this.formData.selectedSystemicDiseases = [...arr];
  }

  isSymptomChecked(idx: number): boolean {
    return (this.formData.selectedSymptoms || []).includes(idx);
  }
  toggleSymptom(idx: number): void {
    const arr = this.formData.selectedSymptoms || [];
    const i = arr.indexOf(idx);
    if (i > -1) arr.splice(i, 1); else arr.push(idx);
    this.formData.selectedSymptoms = [...arr];
  }

  isEmergencyReasonChecked(idx: number): boolean {
    return (this.formData.selectedEmergencyReasons || []).includes(idx);
  }
  toggleEmergencyReason(idx: number): void {
    const arr = this.formData.selectedEmergencyReasons || [];
    const i = arr.indexOf(idx);
    if (i > -1) arr.splice(i, 1); else arr.push(idx);
    this.formData.selectedEmergencyReasons = [...arr];
  }

  async saveData(): Promise<void> {
    this.isSaving = true;
    try {
      await kiditService.updateEventKiDitData(this.date, this.eventId, 'kidit_history', this.formData);
      this.updated.emit(this.formData);
    } catch (error) {
      console.error('儲存失敗:', error);
      alert('儲存失敗');
    } finally {
      this.isSaving = false;
    }
  }
}
