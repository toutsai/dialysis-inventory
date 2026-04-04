import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PatientSelectDialogComponent } from '../patient-select-dialog/patient-select-dialog.component';

@Component({
  selector: 'app-new-update-type-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, PatientSelectDialogComponent],
  templateUrl: './new-update-type-dialog.component.html',
  styleUrl: './new-update-type-dialog.component.css'
})
export class NewUpdateTypeDialogComponent implements OnChanges {
  @Input() isVisible = false;
  @Input() allPatients: any[] = [];
  @Output() close = new EventEmitter<void>();
  @Output('continue') continueEvent = new EventEmitter<{ patient: any; changeType: string }>();

  isPatientDialogVisible = false;
  selectedPatient: any = null;
  selectedChangeType = '';

  get patientDialogFilter(): string {
    return this.selectedChangeType === 'RESTORE_PATIENT' ? 'deleted' : 'active';
  }

  get patientDialogTitle(): string {
    return this.selectedChangeType === 'RESTORE_PATIENT' ? '選擇要復原的病人' : '選擇病人';
  }

  get isValid(): boolean {
    return !!(this.selectedPatient && this.selectedChangeType);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      this.selectedPatient = null;
      this.selectedChangeType = '';
    }
  }

  onChangeTypeChange(): void {
    this.selectedPatient = null;
  }

  onClose(): void {
    this.close.emit();
  }

  handlePatientSelected(event: { patientId: string }): void {
    this.selectedPatient = this.allPatients.find(p => p.id === event.patientId) || null;
    this.isPatientDialogVisible = false;
  }

  handleContinue(): void {
    if (this.isValid) {
      this.continueEvent.emit({
        patient: this.selectedPatient,
        changeType: this.selectedChangeType,
      });
    }
  }
}
