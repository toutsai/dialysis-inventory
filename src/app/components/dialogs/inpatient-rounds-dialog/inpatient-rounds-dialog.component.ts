import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-inpatient-rounds-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './inpatient-rounds-dialog.component.html',
  styleUrl: './inpatient-rounds-dialog.component.css'
})
export class InpatientRoundsDialogComponent implements OnChanges {
  @Input() isVisible = false;
  @Input() patientsOnSchedule: any[] = [];
  @Input() targetDate = '';
  @Output() closeEvent = new EventEmitter<void>();
  @Output() saveEvent = new EventEmitter<any[]>();

  isSaving = false;
  localPatients: any[] = [];

  get todayDate(): string {
    if (!this.targetDate) return '';
    try {
      return this.targetDate.replace(/-/g, '/');
    } catch {
      return this.targetDate;
    }
  }

  get earlyShiftPatients(): any[] {
    return this.localPatients.filter((p: any) => p.shift === 'early');
  }

  get noonShiftPatients(): any[] {
    return this.localPatients.filter((p: any) => p.shift === 'noon');
  }

  get lateShiftPatients(): any[] {
    return this.localPatients.filter((p: any) => p.shift === 'late');
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible']) {
      const prev = changes['isVisible'].previousValue;
      const curr = changes['isVisible'].currentValue;
      if (curr && !prev) {
        this.localPatients = JSON.parse(JSON.stringify(this.patientsOnSchedule)).map((p: any) => ({
          ...p,
          transportMethod: ['推床', '輪椅'].includes(p.transportMethod)
            ? p.transportMethod
            : 'unconfirmed',
        }));
      }
    }
  }

  closeDialog(): void {
    this.closeEvent.emit();
  }

  toggleTransportMethod(patient: any): void {
    const currentMethod = patient.transportMethod;
    if (currentMethod === 'unconfirmed' || currentMethod === '輪椅') {
      patient.transportMethod = '推床';
    } else if (currentMethod === '推床') {
      patient.transportMethod = '輪椅';
    }
  }

  async handleSaveAndPrint(): Promise<void> {
    if (this.isSaving) return;
    this.isSaving = true;
    try {
      const patientsToSave = this.localPatients.map((p: any) => ({
        ...p,
        transportMethod: p.transportMethod === 'unconfirmed' ? '推床' : p.transportMethod,
      }));

      this.saveEvent.emit(patientsToSave);

      // Small delay to allow parent to process save before printing
      await new Promise(resolve => setTimeout(resolve, 100));
      this.printContent();
    } catch (error) {
      console.error('Save operation failed, printing is cancelled.', error);
    } finally {
      this.isSaving = false;
    }
  }

  printContent(): void {
    const contentToPrint = document.getElementById('inpatient-rounds-content');
    if (!contentToPrint) {
      console.error('找不到列印內容區塊！');
      return;
    }

    const printableContent = contentToPrint.cloneNode(true) as HTMLElement;
    const selectsInClone = printableContent.querySelectorAll('select.transport-select');
    const originalSelects = contentToPrint.querySelectorAll('select.transport-select');

    selectsInClone.forEach((selectNode, index) => {
      if (originalSelects[index]) {
        const currentValue = (originalSelects[index] as HTMLSelectElement).value;
        const optionToSelect = selectNode.querySelector(`option[value="${currentValue}"]`);
        if (optionToSelect) {
          selectNode.querySelectorAll('option').forEach(opt => opt.removeAttribute('selected'));
          optionToSelect.setAttribute('selected', 'selected');
        }
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
          <title>住院病人趴趴走總覽</title>
          <style>
          body { font-family: 'Microsoft JhengHei', 'Segoe UI', sans-serif; margin: 20px; font-size: 14pt; line-height: 1.5; }
          .shift-section { margin-bottom: 2rem; page-break-inside: avoid; }
          .shift-title { font-size: 1.5em; margin-bottom: 0.75rem; color: #0056b3; padding-bottom: 0.5rem; border-bottom: 2px solid #007bff; }
          .rounds-table { width: 100%; border-collapse: collapse; font-size: 1em; }
          .rounds-table th, .rounds-table td { border: 1px solid #ddd; padding: 10px; text-align: center; vertical-align: middle; }
          .rounds-table th { background-color: #f2f2f2; font-weight: bold; font-size: 1.1em; }
          .print-header { text-align: center; margin-bottom: 1.5rem; }
          .print-header h4 { font-size: 1.8em; margin: 0; }
          .transport-display { border: none; background: none; }
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

    iframe.onload = function () {
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
}
