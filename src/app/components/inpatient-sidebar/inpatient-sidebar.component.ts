import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-inpatient-sidebar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './inpatient-sidebar.component.html',
  styleUrl: './inpatient-sidebar.component.css'
})
export class InpatientSidebarComponent {
  @Input() patients: any[] = [];
  @Input() scheduledIds: Set<string> = new Set();
  /** true = daily schedule mode (today/other_day), false = weekly mode (135/246/other) */
  @Input() useDailyFilter = false;
  /** Day of week index used for daily filter (0=Mon, 5=Sat) */
  @Input() dayOfWeek = 0;
  @Output() dragStart = new EventEmitter<{ event: DragEvent; patient: any }>();

  inpatientFilter = 'all';

  private readonly FREQ_MAP: Record<string, number[]> = {
    '一三五': [1, 3, 5],
    '二四六': [2, 4, 6],
    '一四':   [1, 4],
    '二五':   [2, 5],
    '三六':   [3, 6],
    '一五':   [1, 5],
    '二六':   [2, 6],
    '每日':   [1, 2, 3, 4, 5, 6],
    '每周一': [1],
    '每周二': [2],
    '每周三': [3],
    '每周四': [4],
    '每周五': [5],
    '每周六': [6],
  };

  get inpatientList(): any[] {
    if (!this.patients) return [];

    // Step 1: filter to ipd + er only, exclude deleted/discontinued
    const targetStatuses = ['ipd', 'er'];
    let inpatients = this.patients.filter(
      p => targetStatuses.includes(p.status) && !p.isDeleted && !p.isDiscontinued
    );

    // Step 2: apply filter based on mode
    if (this.useDailyFilter) {
      // Daily schedule mode: today / other_day
      if (this.inpatientFilter === 'today') {
        inpatients = inpatients.filter(p => this.shouldPatientBeScheduled(p, this.dayOfWeek));
      } else if (this.inpatientFilter === 'other_day') {
        inpatients = inpatients.filter(p => !this.shouldPatientBeScheduled(p, this.dayOfWeek));
      }
    } else {
      // Weekly mode: 135 / 246 / other
      const regularFreqs = ['一三五', '二四六'];
      const freq = this.inpatientFilter;
      if (freq === '135') {
        inpatients = inpatients.filter(p => (p.freq ?? p.frequency) === '一三五');
      } else if (freq === '246') {
        inpatients = inpatients.filter(p => (p.freq ?? p.frequency) === '二四六');
      } else if (freq === 'other') {
        inpatients = inpatients.filter(p => !regularFreqs.includes(p.freq ?? p.frequency));
      }
    }

    return inpatients;
  }

  onDragStart(event: DragEvent, patient: any): void {
    this.dragStart.emit({ event, patient });
  }

  getStatusLabel(status: string): string {
    return status === 'er' ? '急診' : '住院';
  }

  private shouldPatientBeScheduled(patient: any, dayOfWeek: number): boolean {
    const freq = patient.freq ?? patient.frequency;
    if (freq === '臨時') return true;
    if (!freq) return false;
    const scheduledDays = this.FREQ_MAP[freq];
    return scheduledDays ? scheduledDays.includes(dayOfWeek) : false;
  }
}
