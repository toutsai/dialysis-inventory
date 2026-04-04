import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

interface ShiftInfo {
  code: string;
  display: string;
}

interface PatientCountPart {
  text: string;
  type: string;
}

@Component({
  selector: 'app-stats-toolbar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './stats-toolbar.component.html',
  styleUrl: './stats-toolbar.component.css'
})
export class StatsToolbarComponent {
  @Input() statsData: any[] = [];
  @Input() weekdays: string[] = [];
  @Input() columnWidths: number[] = [];
  @Input() showPatientNumbers = false;
  @Input() size = 'normal';

  readonly shiftOrder: ShiftInfo[] = [
    { code: 'early', display: '早' },
    { code: 'noon', display: '午' },
    { code: 'late', display: '晚' },
  ];

  getBarStyles(shiftCount: any): { opdStyle: any; ipdStyle: any; erStyle: any } {
    const defaultStyles = {
      opdStyle: { width: '0%' },
      ipdStyle: { width: '0%' },
      erStyle: { width: '0%' },
    };

    if (!shiftCount || shiftCount.total === 0) {
      return defaultStyles;
    }

    const opdPercent = ((shiftCount.opd || 0) / shiftCount.total) * 100;
    const ipdPercent = ((shiftCount.ipd || 0) / shiftCount.total) * 100;
    const erPercent = ((shiftCount.er || 0) / shiftCount.total) * 100;

    return {
      opdStyle: { width: `${opdPercent}%` },
      ipdStyle: { width: `${ipdPercent}%` },
      erStyle: { width: `${erPercent}%` },
    };
  }

  formatPatientCounts(shiftCount: any): PatientCountPart[] {
    if (!shiftCount || shiftCount.total === 0) {
      return [];
    }

    const parts: PatientCountPart[] = [];
    if (shiftCount.er > 0) parts.push({ text: `急${shiftCount.er}`, type: 'er' });
    if (shiftCount.ipd > 0) parts.push({ text: `住${shiftCount.ipd}`, type: 'ipd' });
    if (shiftCount.opd > 0) parts.push({ text: `門${shiftCount.opd}`, type: 'opd' });

    return parts;
  }
}
