import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CORRELATION_GROUPS, ALL_MEDS_MASTER, type MedDef, type MedicationGroup } from '@app/core/constants/medication-constants';

@Component({
  selector: 'app-daily-draft-list-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './daily-draft-list-dialog.component.html',
  styleUrl: './daily-draft-list-dialog.component.css'
})
export class DailyDraftListDialogComponent {
  @Input() isVisible = false;
  @Input() isLoading = false;
  @Input() drafts: any[] = [];
  @Input() patientsInShift: any[] = [];
  @Input() targetDate = '';
  @Output() closeEvent = new EventEmitter<void>();

  readonly medicationGroups: MedicationGroup[] = CORRELATION_GROUPS;
  readonly allMeds: MedDef[] = ALL_MEDS_MASTER;

  get shiftDisplayName(): string {
    if (this.patientsInShift.length === 0) return '全日';
    const shiftCode = this.patientsInShift[0]?.shift;
    const map: Record<string, string> = { early: '早班', noon: '午班', late: '晚班' };
    return map[shiftCode] || '未知班別';
  }

  get checklistData(): any[] {
    if (this.isLoading || this.patientsInShift.length === 0) return [];

    const draftsMap = new Map<string, any>();
    this.drafts.forEach((draft: any) => {
      const key = `${draft.patientId}-${draft.orderCode}`;
      draftsMap.set(key, draft);
    });

    return this.patientsInShift.map((patient: any) => {
      const patientMeds: Record<string, any> = {};
      this.allMeds.forEach((med: MedDef) => {
        const key = `${patient.id}-${med.code}`;
        const draft = draftsMap.get(key);
        if (draft) {
          patientMeds[med.code] = {
            dose: draft.dose,
            unit: draft.unit,
            freqOrNote: draft.orderType === 'injection' ? draft.note : draft.frequency,
          };
        } else {
          patientMeds[med.code] = null;
        }
      });
      return { patient, meds: patientMeds };
    });
  }

  closeDialog(): void {
    this.closeEvent.emit();
  }

  async exportToExcel(): Promise<void> {
    try {
      const XLSX = await import('xlsx');

      const dataToExport: any[][] = [];
      // 表頭
      const headers = ['床號', '姓名', ...this.allMeds.map(med => med.tradeName)];
      dataToExport.push(headers);

      // 資料列
      this.checklistData.forEach(patientRow => {
        const row: any[] = [patientRow.patient.bedNum, patientRow.patient.name];
        this.allMeds.forEach(med => {
          const draftData = patientRow.meds[med.code];
          if (draftData) {
            let cellValue = `${draftData.dose} ${draftData.unit}`;
            if (draftData.freqOrNote) {
              cellValue += ` (${draftData.freqOrNote})`;
            }
            row.push(cellValue);
          } else {
            row.push('');
          }
        });
        dataToExport.push(row);
      });

      const worksheet = XLSX.utils.aoa_to_sheet(dataToExport);
      worksheet['!cols'] = [
        { wch: 8 },
        { wch: 12 },
        ...this.allMeds.map(() => ({ wch: 15 })),
      ];

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, '藥囑草稿查核表');
      XLSX.writeFile(workbook, `${this.targetDate}_${this.shiftDisplayName}_藥囑草稿.xlsx`);
    } catch (err) {
      console.error('Export failed:', err);
      alert('匯出失敗，請確認 xlsx 套件已安裝。');
    }
  }
}
