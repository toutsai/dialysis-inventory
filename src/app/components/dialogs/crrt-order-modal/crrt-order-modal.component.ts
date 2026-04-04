import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '@app/core/services/auth.service';

@Component({
  selector: 'app-crrt-order-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './crrt-order-modal.component.html',
  styleUrl: './crrt-order-modal.component.css'
})
export class CrrtOrderModalComponent implements OnChanges {
  private readonly auth = inject(AuthService);

  @Input() isVisible = false;
  @Input() patientData: any = null;
  @Input() orderHistory: any[] = [];
  @Input() physicianList: any[] = [];
  @Output() closeEvent = new EventEmitter<void>();
  @Output() saveEvent = new EventEmitter<any>();

  formData = this.createDefaultFormData();

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      this.initializeForm();
    }
  }

  private createDefaultFormData(): any {
    return {
      mode: '',
      weight: null,
      bloodFlow: null,
      pbp: null,
      dialysateFlowRate: null,
      replacementFlowRate: null,
      dilutionRatio: '',
      heparin: '',
      dehydrationRateLower: null,
      dehydrationRateUpper: null,
      addKCL: false,
      physician: this.auth?.currentUser()?.name || '',
      notes: '',
    };
  }

  get totalFluidRemoval(): number {
    const pbp = this.formData.pbp || 0;
    const dialysate = this.formData.dialysateFlowRate || 0;
    const replacement = this.formData.replacementFlowRate || 0;
    const dehydration = this.formData.dehydrationRateUpper || 0;
    return pbp + dialysate + replacement + dehydration;
  }

  get dosePerKg(): string {
    if (!this.formData.weight || this.formData.weight <= 0) return 'N/A';
    const dose = this.totalFluidRemoval / this.formData.weight;
    return `${dose.toFixed(1)} ml/kg/hr`;
  }

  get isFormValid(): boolean {
    return !!(this.formData.mode && this.formData.weight > 0 && this.formData.physician);
  }

  calculateAge(dateOfBirth: string): string {
    if (!dateOfBirth) return 'N/A';
    const birth = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return String(age);
  }

  formatDateTime(timestamp: any): string {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  closeModal(): void {
    this.closeEvent.emit();
  }

  handleSave(): void {
    if (!this.isFormValid) {
      alert('請填寫必要欄位');
      return;
    }
    const orderData = {
      ...this.formData,
      timestamp: new Date(),
      isModified: !!this.patientData?.crrtOrders,
    };
    this.saveEvent.emit(orderData);
  }

  private initializeForm(): void {
    const defaultValues = this.createDefaultFormData();
    if (this.patientData?.crrtOrders) {
      this.formData = {
        ...defaultValues,
        ...this.patientData.crrtOrders,
        physician: this.auth.currentUser()?.name || '',
      };
    } else {
      this.formData = defaultValues;
    }
  }
}
