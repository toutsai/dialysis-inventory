import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '@services/auth.service';
import { formatDateToYYYYMMDD } from '@/utils/dateUtils';

@Component({
  selector: 'app-icu-orders-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './icu-orders-dialog.component.html',
  styleUrl: './icu-orders-dialog.component.css'
})
export class IcuOrdersDialogComponent implements OnChanges {
  private readonly auth = inject(AuthService);

  @Input() isVisible = false;
  @Input() targetDate = '';
  @Input() schedule: Record<string, any> = {};
  @Input() patientMap: Map<string, any> = new Map();
  @Input() isEditable = true;
  @Input() isSaving = false;
  @Output() closeEvent = new EventEmitter<void>();
  @Output() openOrderModal = new EventEmitter<any>();
  @Output() openCrrtOrderModal = new EventEmitter<any>();
  @Output() saveAndPrint = new EventEmitter<{ localNotes: Record<string, string>; crrtEmergencyData: Record<string, any> }>();
  @Output() changeDateEvent = new EventEmitter<string>();
  @Output() saveOnlyEvent = new EventEmitter<{ localNotes: Record<string, string>; crrtEmergencyData: Record<string, any> }>();

  localNotes: Record<string, string> = {};
  crrtEmergencyData: Record<string, { withdraw: string; note: string }> = {};

  get canEdit(): boolean {
    return this.isEditable && this.auth.canEditClinicalNotesAndOrders();
  }

  get allPeripheralPatients(): any[] {
    if (!this.schedule || !this.patientMap) return [];
    return Object.entries(this.schedule)
      .filter(([shiftId, slot]: [string, any]) => shiftId.startsWith('peripheral-') && slot?.patientId)
      .map(([shiftId, slot]: [string, any]) => {
        const patient = this.patientMap.get(slot.patientId);
        if (
          patient &&
          (patient.status === 'ipd' || patient.status === 'er') &&
          patient.mode !== 'CVVHDF'
        ) {
          return {
            ...patient,
            bedNum: `\u5916\u570d ${shiftId.split('-')[1]}`,
            shiftCode: shiftId.split('-')[2],
          };
        }
        return null;
      })
      .filter((p: any) => p !== null);
  }

  get cvvhPatients(): any[] {
    if (!this.patientMap) return [];
    return Array.from(this.patientMap.values()).filter((p: any) => p.mode === 'CVVHDF' && !p.isDeleted);
  }

  get earlyPeripheralPatients(): any[] {
    return this.sortPatients(this.allPeripheralPatients.filter((p: any) => p.shiftCode === 'early'));
  }

  get noonPeripheralPatients(): any[] {
    return this.sortPatients(this.allPeripheralPatients.filter((p: any) => p.shiftCode === 'noon'));
  }

  get latePeripheralPatients(): any[] {
    return this.sortPatients(this.allPeripheralPatients.filter((p: any) => p.shiftCode === 'late'));
  }

  navigateDate(days: number): void {
    if (!this.targetDate) return;
    const d = new Date(this.targetDate);
    d.setDate(d.getDate() + days);
    const newDate = formatDateToYYYYMMDD(d);
    this.changeDateEvent.emit(newDate);
  }

  updateLocalNote(patientId: string, value: string): void {
    this.localNotes[patientId] = value;
  }

  async handleSaveAndPrint(): Promise<void> {
    try {
      this.saveAndPrint.emit({
        localNotes: { ...this.localNotes },
        crrtEmergencyData: { ...this.crrtEmergencyData },
      });

      // Small delay to allow parent to process save before printing
      await new Promise(resolve => setTimeout(resolve, 100));
      this.printContent();
    } catch (error) {
      console.error('儲存列印失敗:', error);
    }
  }

  handleSaveOnly(): void {
    this.saveOnlyEvent.emit({
      localNotes: { ...this.localNotes },
      crrtEmergencyData: { ...this.crrtEmergencyData },
    });
  }

  handlePrintOnly(): void {
    this.printContent();
  }

  printContent(): void {
    const contentToPrint = document.getElementById('icu-orders-printable-area');
    if (!contentToPrint) {
      console.error('找不到列印內容區塊！');
      return;
    }

    const printableContent = contentToPrint.cloneNode(true) as HTMLElement;

    // Remove buttons and non-printable elements from clone
    printableContent.querySelectorAll('.btn-edit-crrt, .btn-print, .btn-close, .header-actions, .modal-footer, .mobile-only').forEach(el => el.remove());

    // Preserve textarea/input values
    const originalTextareas = contentToPrint.querySelectorAll('textarea');
    const clonedTextareas = printableContent.querySelectorAll('textarea');
    clonedTextareas.forEach((ta, i) => {
      if (originalTextareas[i]) {
        ta.textContent = (originalTextareas[i] as HTMLTextAreaElement).value;
      }
    });

    const originalInputs = contentToPrint.querySelectorAll('input');
    const clonedInputs = printableContent.querySelectorAll('input');
    clonedInputs.forEach((inp, i) => {
      if (originalInputs[i]) {
        inp.setAttribute('value', (originalInputs[i] as HTMLInputElement).value);
      }
    });

    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.setAttribute('title', 'Print Frame');

    document.body.appendChild(iframe);
    const iframeDoc = iframe.contentWindow!.document;

    const htmlContent = `
      <html>
      <head>
        <title>${this.targetDate} 外圍病房透析醫囑單</title>
        <style>
          @page { size: A4 portrait; margin: 10mm; }
          body { font-family: 'Microsoft JhengHei', 'Segoe UI', sans-serif; margin: 20px; font-size: 11pt; line-height: 1.4; }
          .printable-header { text-align: center; margin-bottom: 1.5rem; font-size: 1.5em; }
          .section-title { font-size: 1.2em; border-bottom: 2px solid #333; padding-bottom: 5px; margin-top: 1.5rem; margin-bottom: 0.5rem; }
          .shift-group { margin-bottom: 1rem; }
          .shift-group h4 { margin: 10px 0 5px; font-size: 1.1em; }
          .patient-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
          .patient-order-card { border: 1px solid #333; border-radius: 6px; overflow: hidden; page-break-inside: avoid; break-inside: avoid; }
          .patient-header { display: flex; gap: 1rem; font-size: 0.9rem; padding: 0.5rem 0.75rem; background-color: #e9ecef; border-bottom: 1px solid #ccc; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .card-body { padding: 0; }
          .order-details { display: grid; grid-template-columns: 1fr 1fr; gap: 0.3rem 0.75rem; padding: 0.5rem 0.75rem; font-size: 0.85rem; }
          .order-details > div { line-height: 1.5; }
          .highlight-field { background-color: #fff3cd !important; padding: 2px 4px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .notes-section { padding: 0.4rem 0.75rem; border-top: 1px solid #ccc; font-size: 0.85rem; }
          .no-patients-text { color: #6c757d; font-style: italic; }
          .crrt-table { width: 100%; border-collapse: collapse; margin: 10px 0; }
          .crrt-table th, .crrt-table td { border: 1px solid #333; padding: 6px 8px; font-size: 0.85rem; }
          .crrt-table th { background-color: #f0f0f0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .crrt-order-content { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; }
          .crrt-order-item { font-size: 0.8rem; }
          .order-label { font-weight: bold; margin-right: 4px; }
          .emergency-content { display: flex; align-items: center; gap: 1rem; }
          textarea, input[type="text"] { border: 1px solid #999; padding: 2px 4px; font-size: 0.85rem; }
          tr { page-break-inside: avoid; }
        </style>
      </head>
      <body>
        ${printableContent.innerHTML}
      </body>
      </html>
    `;

    iframeDoc.open();
    iframeDoc.write(htmlContent);
    iframeDoc.close();

    iframe.onload = function() {
      try {
        iframe.contentWindow!.focus();
        iframe.contentWindow!.print();
      } catch (e) {
        console.error('列印失敗:', e);
      } finally {
        setTimeout(() => {
          document.body.removeChild(iframe);
        }, 500);
      }
    };
  }

  getCRRTMode(patient: any): string {
    if (patient?.crrtOrders?.mode) {
      return patient.crrtOrders.mode;
    }
    return patient?.mode || 'CVVHDF';
  }

  getDehydrationRateDisplay(crrtOrders: any): string {
    if (!crrtOrders) return '____';
    if (crrtOrders.dehydrationRate !== undefined && crrtOrders.dehydrationRate !== null && crrtOrders.dehydrationRate !== '') {
      return `${crrtOrders.dehydrationRate} ml/hr`;
    }
    return '____';
  }

  formatDateTime(timestamp: any): string {
    if (!timestamp) return '';
    try {
      const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return d.toLocaleString('zh-TW', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  updateEmergencyWithdraw(patientId: string, value: string): void {
    if (!this.crrtEmergencyData[patientId]) {
      this.crrtEmergencyData[patientId] = { withdraw: '', note: '' };
    }
    this.crrtEmergencyData[patientId].withdraw = value;
  }

  updateEmergencyNote(patientId: string, value: string): void {
    if (!this.crrtEmergencyData[patientId]) {
      this.crrtEmergencyData[patientId] = { withdraw: '', note: '' };
    }
    this.crrtEmergencyData[patientId].note = value;
  }

  sortPatients(patients: any[]): any[] {
    return [...patients].sort((a, b) => {
      const unitA = this.getUnitOrder(a.wardNumber);
      const unitB = this.getUnitOrder(b.wardNumber);
      if (unitA !== unitB) return unitA - unitB;
      const nameA = a.name || '';
      const nameB = b.name || '';
      return nameA.localeCompare(nameB, 'zh-TW');
    });
  }

  getUnitOrder(wardNumber: string): number {
    if (!wardNumber) return 999;
    const match = wardNumber.match(/(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
    return 500;
  }

  closeDialog(): void {
    this.closeEvent.emit();
  }

  handleOpenOrderModal(patient: any): void {
    if (this.canEdit) {
      this.openOrderModal.emit(patient);
    }
  }

  handleOpenCrrtOrderModal(patient: any): void {
    if (this.canEdit) {
      this.openCrrtOrderModal.emit(patient);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      // Initialize local notes and crrt emergency data from patients
      this.localNotes = {};
      this.crrtEmergencyData = {};

      this.allPeripheralPatients.forEach((p: any) => {
        this.localNotes[p.id] = p.icuNote || '';
      });

      this.cvvhPatients.forEach((p: any) => {
        this.crrtEmergencyData[p.id] = {
          withdraw: p.crrtEmergencyWithdraw || '',
          note: p.crrtEmergencyNote || '',
        };
      });
    }
  }
}
