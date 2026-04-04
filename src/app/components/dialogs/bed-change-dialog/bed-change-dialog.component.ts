import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-bed-change-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './bed-change-dialog.component.html',
  styleUrl: './bed-change-dialog.component.css'
})
export class BedChangeDialogComponent implements OnChanges {
  @Input() isVisible = false;
  @Input() patientInfo: any = null;
  @Input() currentSchedule: any = null;
  @Input() targetShiftFilter: string | null = null;
  @Output() confirmEvent = new EventEmitter<any>();
  @Output() cancelEvent = new EventEmitter<void>();

  selectedNewBedId: string | null = null;
  private readonly hepatitisBedNumbers = [31, 32, 33, 35, 36];
  readonly SHIFT_CODES = { EARLY: 'early', NOON: 'noon', LATE: 'late' };

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      this.selectedNewBedId = null;
    }
  }

  get dialogTitle(): string {
    if (this.targetShiftFilter && this.patientInfo) {
      return `為【${this.patientInfo.name}】選擇新的空床位`;
    }
    return '更換床位';
  }

  get patientInfoDisplay(): any {
    if (this.targetShiftFilter && this.patientInfo) {
      return {
        ...this.patientInfo,
        targetShift: this.getShiftDisplayName(this.targetShiftFilter),
      };
    }
    return this.patientInfo;
  }

  get availableBedsByShift(): Record<string, any[]> {
    if (!this.isVisible || !this.currentSchedule) return {};

    const allPossibleBeds: (number | string)[] = [
      ...Array.from({ length: 65 }, (_, i) => i + 1).filter(
        (i) => ![4, 10, 14, 20, 24, 30, 34, 40, 50, 54, 60, 64].includes(i),
      ),
      ...Array.from({ length: 6 }, (_, i) => `peripheral-${i + 1}`),
    ];

    const occupiedBedShiftIds = new Set(Object.keys(this.currentSchedule));
    const allShifts = Object.values(this.SHIFT_CODES);

    const available: Record<string, any[]> = {};
    allShifts.forEach((s) => (available[s] = []));

    allPossibleBeds.forEach((bedNum) => {
      allShifts.forEach((shiftCode) => {
        const bedIdPart = typeof bedNum === 'string' ? bedNum : `bed-${bedNum}`;
        const shiftId = `${bedIdPart}-${shiftCode}`;
        if (!occupiedBedShiftIds.has(shiftId)) {
          available[shiftCode].push(bedNum);
        }
      });
    });

    Object.values(available).forEach((beds) => {
      beds.sort((a: any, b: any) => {
        const numA = typeof a === 'number' ? a : Infinity;
        const numB = typeof b === 'number' ? b : Infinity;
        if (numA !== Infinity || numB !== Infinity) return numA - numB;
        return String(a).localeCompare(String(b));
      });
    });

    if (this.targetShiftFilter && available[this.targetShiftFilter]) {
      return { [this.targetShiftFilter]: available[this.targetShiftFilter] };
    }

    return available;
  }

  isHepatitisBed(bedNum: any): boolean {
    return typeof bedNum === 'number' && this.hepatitisBedNumbers.includes(bedNum);
  }

  getShiftDisplayName(shiftCode: string): string {
    const names: Record<string, string> = { early: '早班', noon: '午班', late: '晚班' };
    return names[shiftCode] || shiftCode;
  }

  handleBedClick(bedNum: any, shiftCode: string): void {
    const bedIdPart = typeof bedNum === 'string' ? bedNum : `bed-${bedNum}`;
    this.selectedNewBedId = `${bedIdPart}-${shiftCode}`;
  }

  confirmChange(): void {
    if (!this.selectedNewBedId) {
      alert('請選擇一個新的床位！');
      return;
    }
    this.confirmEvent.emit({
      oldShiftId: this.patientInfo?.shiftId,
      newShiftId: this.selectedNewBedId,
    });
  }

  cancelDialog(): void {
    this.cancelEvent.emit();
  }

  getBedDisplay(bed: any): string {
    if (typeof bed === 'string' && bed.startsWith('peripheral-')) {
      return `外圍 ${bed.split('-')[1]}`;
    }
    return String(bed);
  }

  getShiftEntries(): { key: string; value: any[] }[] {
    return Object.entries(this.availableBedsByShift).map(([key, value]) => ({ key, value }));
  }

  isSelectedBed(bed: any, shiftCode: string): boolean {
    const bedIdPart = typeof bed === 'string' ? bed : `bed-${bed}`;
    return `${bedIdPart}-${shiftCode}` === this.selectedNewBedId;
  }
}
