import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-daily-staff-display',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './daily-staff-display.component.html',
  styleUrl: './daily-staff-display.component.css'
})
export class DailyStaffDisplayComponent implements OnInit, OnDestroy {
  // Support either an array of all doctors, or the computed daily mapping object
  @Input() physicians: any[] | { early: any; noon: any; late: any } = { early: null, noon: null, late: null };
  @Input() consultants: any[] | { morning: any; afternoon: any; night: any } = { morning: null, afternoon: null, night: null };
  @Input() scheduleData: any = null;
  @Input() targetDate = '';

  currentTime = new Date();
  private intervalId: any = null;

  ngOnInit(): void {
    this.intervalId = setInterval(() => {
      this.currentTime = new Date();
    }, 60000);
  }

  ngOnDestroy(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  get dailyPhysicians(): any {
    // If it's already a mapped object (from stats.component), return it directly
    if (this.physicians && !Array.isArray(this.physicians) && ('early' in this.physicians || 'noon' in this.physicians)) {
      return this.physicians;
    }
    
    const result: any = { early: null, noon: null, late: null };
    if (!this.physicians || !Array.isArray(this.physicians)) return result;
    
    for (const p of this.physicians) {
      const schedules = p.defaultSchedules || [];
      if (schedules.some((s: string) => s.includes('early')) && !result.early) result.early = p;
      if (schedules.some((s: string) => s.includes('noon')) && !result.noon) result.noon = p;
      if (schedules.some((s: string) => s.includes('late')) && !result.late) result.late = p;
    }
    return result;
  }

  get displayedConsultPhysician(): any {
    // Check if it's already a mapped object (from stats.component)
    if (this.consultants && !Array.isArray(this.consultants) && ('morning' in this.consultants || 'afternoon' in this.consultants)) {
      const currentHour = this.currentTime.getHours();
      let shiftKey = 'night';
      let shiftLabel = '晚班'; // default
      let data = null;
      
      if (currentHour >= 8 && currentHour < 12) {
        shiftKey = 'morning'; shiftLabel = '上午'; data = this.consultants.morning;
      } else if (currentHour >= 12 && currentHour < 17) {
        shiftKey = 'afternoon'; shiftLabel = '下午'; data = this.consultants.afternoon;
      } else {
        shiftKey = 'night'; shiftLabel = '夜間'; data = this.consultants.night;
      }
      
      return { key: shiftKey, shiftLabel, data };
    }

    // Default array-based processing (fallback for empty arrays)
    const shift = this.currentShift;
    const shiftLabels: Record<string, string> = { early: '早班', noon: '午班', late: '晚班' };
    const consultant = this.currentConsultants?.[0] || null;
    return {
      key: shift,
      shiftLabel: shiftLabels[shift] || shift,
      data: consultant,
    };
  }

  get currentShift(): string {
    const hour = this.currentTime.getHours();
    if (hour < 12) return 'early';
    if (hour < 18) return 'noon';
    return 'late';
  }

  get currentPhysicians(): any[] {
    if (!this.scheduleData || !this.physicians || !Array.isArray(this.physicians)) return [];
    return this.physicians.filter(p => {
      const schedules = p.defaultSchedules || [];
      return schedules.some((s: string) => s.includes(this.currentShift));
    });
  }

  get currentConsultants(): any[] {
    if (!this.scheduleData || !this.consultants || !Array.isArray(this.consultants)) return [];
    return this.consultants.filter(c => {
      const schedules = c.defaultConsultationSchedules || [];
      return schedules.some((s: string) => s.includes(this.currentShift));
    });
  }

  getShiftDisplayName(shift: string): string {
    const map: Record<string, string> = { early: '早班', noon: '午班', late: '晚班' };
    return map[shift] || shift;
  }
}
