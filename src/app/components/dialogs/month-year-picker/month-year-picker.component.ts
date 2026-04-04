import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-month-year-picker',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './month-year-picker.component.html',
  styleUrl: './month-year-picker.component.css'
})
export class MonthYearPickerComponent implements OnChanges {
  @Input() isVisible = false;
  @Input() currentYear = new Date().getFullYear();
  @Input() currentMonth = new Date().getMonth() + 1;
  @Input() set initialDate(val: any) {
    if (val instanceof Date) {
      this.currentYear = val.getFullYear();
      this.currentMonth = val.getMonth() + 1;
    }
  }
  @Output() select = new EventEmitter<{ year: number; month: number }>();
  @Output() cancel = new EventEmitter<void>();
  @Output() close = new EventEmitter<void>();
  @Output() dateSelected = new EventEmitter<{ year: number; month: number }>();

  selectedYear = new Date().getFullYear();
  selectedMonth = new Date().getMonth() + 1;
  months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      this.selectedYear = this.currentYear;
      this.selectedMonth = this.currentMonth;
    }
  }

  prevYear(): void {
    this.selectedYear--;
  }

  nextYear(): void {
    this.selectedYear++;
  }

  selectMonth(month: number): void {
    this.selectedMonth = month;
    const payload = { year: this.selectedYear, month: this.selectedMonth };
    this.select.emit(payload);
    this.dateSelected.emit(payload);
  }

  onCancel(): void {
    this.cancel.emit();
    this.close.emit();
  }

  onOverlayClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('picker-overlay')) {
      this.onCancel();
    }
  }
}
