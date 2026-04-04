import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FirebaseService } from '@services/firebase.service';
import { PatientStoreService } from '@services/patient-store.service';
import { kiditService } from '@/services/kiditService';
import { exportKiDitExcel } from '@/services/kiditExportService';
import { KiditDetailModalComponent } from '@app/components/kidit/kidit-detail-modal.component';

interface DayData {
  dateStr: string;
  dayNum: number;
  events: any[];
  unregistered: number;
}

@Component({
  selector: 'app-kidit-report',
  standalone: true,
  imports: [CommonModule, FormsModule, KiditDetailModalComponent],
  templateUrl: './kidit-report.component.html',
  styleUrl: './kidit-report.component.css',
})
export class KiditReportComponent implements OnInit {
  private readonly patientStore = inject(PatientStoreService);

  readonly currentYear = signal(new Date().getFullYear());
  readonly currentMonth = signal(new Date().getMonth() + 1);
  readonly daysData = signal<DayData[]>([]);
  readonly isLoading = signal(false);
  readonly weekDays = ['日', '一', '二', '三', '四', '五', '六'];

  // Modal state
  readonly showModal = signal(false);
  readonly selectedDate = signal('');
  readonly selectedEvents = signal<any[]>([]);

  readonly firstDayOffset = computed(() =>
    new Date(this.currentYear(), this.currentMonth() - 1, 1).getDay()
  );

  readonly emptySlots = computed(() => Array(this.firstDayOffset()));

  ngOnInit(): void {
    this.fetchData();
  }

  isToday(dateStr: string): boolean {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    return dateStr === `${y}-${m}-${d}`;
  }

  async fetchData(): Promise<void> {
    this.isLoading.set(true);
    try {
      await this.patientStore.fetchPatientsIfNeeded();

      const logs = await kiditService.fetchMonthLogs(this.currentYear(), this.currentMonth());
      const daysInMonth = new Date(this.currentYear(), this.currentMonth(), 0).getDate();
      const logMap: Record<string, any[]> = {};
      logs.forEach((l: any) => (logMap[l.date] = l.events || []));

      const tempDays: DayData[] = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${this.currentYear()}-${String(this.currentMonth()).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const events = logMap[dateStr] || [];
        tempDays.push({
          dateStr,
          dayNum: d,
          events,
          unregistered: events.filter((e: any) => !e.isRegistered).length,
        });
      }
      this.daysData.set(tempDays);
    } catch (e) {
      console.error('載入 KiDit 資料失敗:', e);
    } finally {
      this.isLoading.set(false);
    }
  }

  changeMonth(offset: number): void {
    let m = this.currentMonth() + offset;
    let y = this.currentYear();
    if (m > 12) { m = 1; y++; }
    else if (m < 1) { m = 12; y--; }
    this.currentMonth.set(m);
    this.currentYear.set(y);
    this.fetchData();
  }

  openModal(day: DayData): void {
    this.selectedDate.set(day.dateStr);
    this.selectedEvents.set(day.events);
    this.showModal.set(true);
  }

  closeModal(): void {
    this.showModal.set(false);
  }

  onModalRefresh(): void {
    this.fetchData();
  }

  exportToExcel(): void {
    const days = this.daysData();
    if (!days.length) { alert('目前無資料可匯出'); return; }

    const allEvents = days.flatMap(day => day.events);
    if (allEvents.length === 0) { alert('本月份尚無任何事件紀錄。'); return; }

    const filename = `KiDit_Export_${this.currentYear()}_${String(this.currentMonth()).padStart(2, '0')}.xlsx`;
    try {
      exportKiDitExcel(allEvents, filename);
    } catch (error) {
      console.error('匯出失敗:', error);
      alert('匯出失敗，請檢查資料格式');
    }
  }
}
