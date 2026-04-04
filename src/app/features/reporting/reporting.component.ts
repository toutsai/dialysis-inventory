import { Component, inject, signal, computed, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { where } from 'firebase/firestore';
import { ApiManagerService, type ApiManager, type FirestoreRecord } from '@services/api-manager.service';
import { SHIFT_CODES, getShiftDisplayName } from '@/constants/scheduleConstants';
import * as XLSX from 'xlsx';
import { formatDateToYYYYMMDD, formatDateToYYYYMM } from '@/utils/dateUtils';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

@Component({
  selector: 'app-reporting',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './reporting.component.html',
  styleUrl: './reporting.component.css'
})
export class ReportingComponent implements AfterViewInit {
  @ViewChild('chartCanvas') chartCanvas!: ElementRef<HTMLCanvasElement>;

  private readonly apiManagerService = inject(ApiManagerService);
  private readonly schedulesApi: ApiManager<FirestoreRecord>;
  private readonly expiredSchedulesApi: ApiManager<FirestoreRecord>;
  private readonly patientsApi: ApiManager<FirestoreRecord>;
  private readonly dailyLogsApi: ApiManager<FirestoreRecord>;

  private chartInstance: Chart | null = null;

  readonly reportTypes = [
    { value: 'daily', label: '日報表', icon: '📋' },
    { value: 'monthly', label: '月報表', icon: '📅' },
    { value: 'yearly', label: '年度報表', icon: '📊' },
    { value: 'staffing_monthly', label: '護病比', icon: '👩‍⚕️' },
  ];

  reportType = signal<string>('');
  selectedDate = signal<string>(formatDateToYYYYMMDD(new Date()));
  selectedMonth = signal<string>(formatDateToYYYYMM(new Date()));
  selectedYear = signal<number>(new Date().getFullYear());

  isLoading = signal<boolean>(false);
  hasGenerated = signal<boolean>(false);
  showTable = signal<boolean>(false);
  chartMode = signal<'absolute' | 'percent'>('absolute');
  reportDateRange = signal<{ start: string; end: string }>({ start: '', end: '' });

  dailyTableHeaders = signal<string[]>([]);
  dailyTableRows = signal<any[]>([]);
  monthlyTableHeaders = signal<number[]>([]);
  monthlyTableRows = signal<any[]>([]);
  yearlyTableHeaders = signal<string[]>([]);
  yearlyTableRows = signal<any[]>([]);
  staffingTableRows = signal<any[]>([]);

  reportTitle = computed(() => {
    if (!this.hasGenerated()) return '';
    if (this.reportType() === 'daily') return `${this.reportDateRange().start} 人次日報表`;
    if (this.reportType() === 'monthly') return `${this.selectedMonth()} 人次月報表`;
    if (this.reportType() === 'yearly') return `${this.selectedYear()} 人次年度報表`;
    if (this.reportType() === 'staffing_monthly') return `${this.selectedMonth()} 護理人力月報表`;
    return '統計報表';
  });

  noData = computed(() => {
    if (!this.hasGenerated()) return true;
    if (this.reportType() === 'daily') return this.dailyTableRows().length === 0;
    if (this.reportType() === 'monthly') return this.monthlyTableRows().length === 0;
    if (this.reportType() === 'yearly') return this.yearlyTableRows().length === 0;
    if (this.reportType() === 'staffing_monthly') return this.staffingTableRows().length === 0;
    return true;
  });

  constructor() {
    this.schedulesApi = this.apiManagerService.create<FirestoreRecord>('schedules');
    this.expiredSchedulesApi = this.apiManagerService.create<FirestoreRecord>('expired_schedules');
    this.patientsApi = this.apiManagerService.create<FirestoreRecord>('patients');
    this.dailyLogsApi = this.apiManagerService.create<FirestoreRecord>('daily_logs');
  }

  ngAfterViewInit(): void {}

  // --- UI Actions ---

  selectReportType(type: string): void {
    this.reportType.set(type);
    this.generateReport();
  }

  onDateChange(date: string): void {
    this.selectedDate.set(date);
    if (this.reportType() === 'daily') this.generateReport();
  }

  onMonthChange(month: string): void {
    this.selectedMonth.set(month);
    if (this.reportType() === 'monthly' || this.reportType() === 'staffing_monthly') {
      this.generateReport();
    }
  }

  shiftDate(delta: number): void {
    const d = new Date(this.selectedDate() + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    this.selectedDate.set(formatDateToYYYYMMDD(d));
    this.generateReport();
  }

  shiftMonth(delta: number): void {
    const [y, m] = this.selectedMonth().split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    this.selectedMonth.set(formatDateToYYYYMM(d));
    this.generateReport();
  }

  shiftYear(delta: number): void {
    this.selectedYear.set(this.selectedYear() + delta);
    this.generateReport();
  }

  toggleTable(): void {
    this.showTable.set(!this.showTable());
  }

  toggleChartMode(): void {
    this.chartMode.set(this.chartMode() === 'absolute' ? 'percent' : 'absolute');
    setTimeout(() => this.renderChart(), 50);
  }

  // --- Chart Rendering ---

  private renderChart(): void {
    if (!this.chartCanvas) return;

    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }

    const ctx = this.chartCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    const type = this.reportType();

    if (type === 'daily') {
      this.renderDailyBarChart(ctx);
    } else if (type === 'monthly') {
      this.renderMonthlyBarChart(ctx);
    } else if (type === 'yearly') {
      this.renderYearlyBarChart(ctx);
    } else if (type === 'staffing_monthly') {
      this.renderStaffingLineChart(ctx);
    }
  }

  /** Fixed color mapping so same category always gets the same color. */
  private readonly CATEGORY_COLORS: Record<string, string> = {
    'HD-門診': '#e67e22',
    'HD-住院': '#4a90d9',
    'HD-急診': '#27ae60',
    'HD-未知': '#95a5a6',
    'SLED-門診': '#9b59b6',
    'SLED-住院': '#e74c3c',
    'SLED-急診': '#1abc9c',
    'SLED-未知': '#7f8c8d',
    'CVVH-門診': '#f39c12',
    'CVVH-住院': '#34495e',
    'PE-門診': '#d35400',
    'PE-住院': '#2c3e50',
  };

  private getCategoryColor(label: string): string {
    const key = label.replace(/[()（）\s]/g, '').replace(' ', '-');
    if (this.CATEGORY_COLORS[key]) return this.CATEGORY_COLORS[key];
    // Try matching "MODE-STATUS" from "MODE (STATUS)" format
    const match = label.match(/^(.+?)\s*[（(](.+?)[）)]$/);
    if (match) {
      const normalizedKey = `${match[1]}-${match[2]}`;
      if (this.CATEGORY_COLORS[normalizedKey]) return this.CATEGORY_COLORS[normalizedKey];
    }
    // Fallback
    const fallbackColors = ['#3498db', '#e67e22', '#2ecc71', '#e74c3c', '#9b59b6', '#1abc9c', '#f1c40f', '#34495e'];
    let hash = 0;
    for (let i = 0; i < label.length; i++) hash = label.charCodeAt(i) + ((hash << 5) - hash);
    return fallbackColors[Math.abs(hash) % fallbackColors.length];
  }

  private renderStackedBarChart(
    ctx: CanvasRenderingContext2D,
    rows: any[],
    labels: string[],
    dataKey: string,
  ): void {
    if (rows.length === 0 || labels.length === 0) return;

    const isPercent = this.chartMode() === 'percent';

    // 計算每個類別的總數，用於排序
    const rowsWithTotal = rows.map((row) => ({
      ...row,
      _total: (row[dataKey] as number[]).reduce((sum: number, v: number) => sum + v, 0),
    }));

    // 排序：數量最大的放最底下（先被繪製），最小的放上面
    rowsWithTotal.sort((a, b) => b._total - a._total);

    const datasets = rowsWithTotal.map((row) => {
      const label = `${row.mode} (${row.status})`;
      const color = this.getCategoryColor(label);
      return {
        label,
        data: [...row[dataKey]],
        backgroundColor: color + 'CC',
        borderColor: color,
        borderWidth: 1,
        borderRadius: 2,
      };
    });

    if (isPercent) {
      const numLabels = labels.length;
      for (let col = 0; col < numLabels; col++) {
        const total = datasets.reduce((sum, ds) => sum + (ds.data[col] || 0), 0);
        if (total > 0) {
          for (const ds of datasets) {
            ds.data[col] = +((ds.data[col] / total) * 100).toFixed(1);
          }
        }
      }
    }

    // 內聯插件：在每個堆疊段上畫數字標注
    const dataLabelPlugin = {
      id: 'stackedDataLabels',
      afterDatasetsDraw(chart: any) {
        if (isPercent) return; // 百分比模式不標數字
        const { ctx: c } = chart;
        c.save();
        c.font = 'bold 10px sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';

        chart.data.datasets.forEach((dataset: any, dsIndex: number) => {
          const meta = chart.getDatasetMeta(dsIndex);
          meta.data.forEach((bar: any, index: number) => {
            const value = dataset.data[index];
            if (!value || value === 0) return;
            const barHeight = Math.abs(bar.base - bar.y);
            // 只在段落夠高時顯示數字（避免擠在一起）
            if (barHeight < 14) return;
            c.fillStyle = '#fff';
            c.strokeStyle = 'rgba(0,0,0,0.3)';
            c.lineWidth = 2;
            const x = bar.x;
            const y = (bar.y + bar.base) / 2;
            c.strokeText(value.toString(), x, y);
            c.fillText(value.toString(), x, y);
          });
        });
        c.restore();
      },
    };

    this.chartInstance = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (context) => {
                const val = context.parsed.y;
                return isPercent
                  ? `${context.dataset.label}: ${val}%`
                  : `${context.dataset.label}: ${val}`;
              },
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            stacked: true,
            max: isPercent ? 100 : undefined,
            ticks: isPercent ? { callback: (v) => `${v}%` } : {},
          },
          x: { stacked: true },
        },
      },
      plugins: [dataLabelPlugin],
    });
  }

  private renderDailyBarChart(ctx: CanvasRenderingContext2D): void {
    const rows = this.dailyTableRows().filter(r => r.mode !== '每班總計');
    const headers = this.dailyTableHeaders();
    this.renderStackedBarChart(ctx, rows, headers, 'shiftCounts');
  }

  private renderMonthlyBarChart(ctx: CanvasRenderingContext2D): void {
    const rows = this.monthlyTableRows().filter(r => r.mode !== '每日總計');
    const headers = this.monthlyTableHeaders().map(String);
    this.renderStackedBarChart(ctx, rows, headers, 'dailyCounts');
  }

  private renderYearlyBarChart(ctx: CanvasRenderingContext2D): void {
    const rows = this.yearlyTableRows().filter(r => r.mode !== '每月總計');
    const headers = this.yearlyTableHeaders();
    this.renderStackedBarChart(ctx, rows, headers, 'monthlyCounts');
  }

  private renderStaffingLineChart(ctx: CanvasRenderingContext2D): void {
    const rows = this.staffingTableRows();
    if (rows.length === 0) return;

    const labels = rows.map((r: any) => {
      const parts = r.date.split('-');
      return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
    });

    const parseNum = (v: string) => (v === 'N/A' || !v ? null : parseFloat(v));

    this.chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '早班護病比',
            data: rows.map((r: any) => parseNum(r.earlyRatio)),
            borderColor: '#4a90d9',
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 3,
            spanGaps: true,
          },
          {
            label: '午班護病比',
            data: rows.map((r: any) => parseNum(r.noonRatio)),
            borderColor: '#e67e22',
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 3,
            spanGaps: true,
          },
          {
            label: '晚班護病比',
            data: rows.map((r: any) => parseNum(r.lateRatio)),
            borderColor: '#27ae60',
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 3,
            spanGaps: true,
          },
          {
            label: '整日護病比',
            data: rows.map((r: any) => parseNum(r.totalRatio)),
            borderColor: '#e74c3c',
            borderWidth: 2.5,
            borderDash: [6, 3],
            tension: 0.3,
            pointRadius: 3,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { font: { size: 12 } } },
        },
        scales: {
          y: { beginAtZero: true, title: { display: true, text: '護病比' } },
        },
      },
    });
  }

  // --- Data Generation ---

  private getTaipeiTodayString(): string {
    const today = new Date();
    const options: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' };
    const formatter = new Intl.DateTimeFormat('fr-CA', options);
    return formatter.format(today);
  }

  async generateReport(): Promise<void> {
    this.isLoading.set(true);
    this.hasGenerated.set(true);
    [this.dailyTableRows, this.monthlyTableRows, this.yearlyTableRows,
     this.staffingTableRows, this.dailyTableHeaders, this.monthlyTableHeaders,
     this.yearlyTableHeaders].forEach(arr => arr.set([] as any));

    try {
      let startDate: string | null = null;
      let endDate: string | null = null;

      if (this.reportType() === 'daily') {
        if (!this.selectedDate()) throw new Error('請選擇一個有效的日期。');
        startDate = this.selectedDate();
        endDate = this.selectedDate();
      } else if (this.reportType() === 'monthly' || this.reportType() === 'staffing_monthly') {
        if (!this.selectedMonth() || this.selectedMonth().indexOf('-') === -1) {
          throw new Error('請選擇一個有效的月份。');
        }
        const [year, month] = this.selectedMonth().split('-').map(Number);
        if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
          throw new Error('您選擇的月份格式不正確。');
        }
        const firstDay = new Date(year, month - 1, 1);
        const lastDay = new Date(year, month, 0);
        startDate = formatDateToYYYYMMDD(firstDay);
        endDate = formatDateToYYYYMMDD(lastDay);
      } else if (this.reportType() === 'yearly') {
        const year = Number(this.selectedYear());
        if (!year || isNaN(year) || year < 1900 || year > 2100) {
          throw new Error('請選擇一個有效的年份。');
        }
        startDate = formatDateToYYYYMMDD(new Date(year, 0, 1));
        endDate = formatDateToYYYYMMDD(new Date(year, 11, 31));
      }

      if (!startDate || !endDate) {
        throw new Error('無法計算出有效的開始或結束日期。');
      }

      this.reportDateRange.set({ start: startDate, end: endDate });

      if (this.reportType() === 'staffing_monthly') {
        const dailyLogsData = await this.dailyLogsApi.fetchAll([
          where('date', '>=', startDate),
          where('date', '<=', endDate),
        ]);
        this.processStaffingReport(dailyLogsData);
      } else {
        const todayStr = this.getTaipeiTodayString();
        let schedulesData: any[] = [];
        let expiredSchedulesData: any[] = [];
        const fetchPromises: Promise<void>[] = [];

        if (endDate < todayStr) {
          fetchPromises.push(
            this.expiredSchedulesApi.fetchAll([
              where('date', '>=', startDate),
              where('date', '<=', endDate),
            ]).then(data => { expiredSchedulesData = data; })
          );
        } else if (startDate >= todayStr) {
          fetchPromises.push(
            this.schedulesApi.fetchAll([
              where('date', '>=', startDate),
              where('date', '<=', endDate),
            ]).then(data => { schedulesData = data; })
          );
        } else {
          fetchPromises.push(
            this.expiredSchedulesApi.fetchAll([
              where('date', '>=', startDate),
              where('date', '<', todayStr),
            ]).then(data => { expiredSchedulesData = data; })
          );
          fetchPromises.push(
            this.schedulesApi.fetchAll([
              where('date', '>=', todayStr),
              where('date', '<=', endDate),
            ]).then(data => { schedulesData = data; })
          );
        }

        const patientsData = await this.patientsApi.fetchAll();
        const patientMap = new Map(patientsData.map((p: any) => [p.id, p]));
        await Promise.all(fetchPromises);
        const allSchedules = [...schedulesData, ...expiredSchedulesData];

        if (this.reportType() === 'daily') {
          this.processDailyReport(allSchedules, patientMap);
        } else if (this.reportType() === 'monthly') {
          this.processMonthlyReport(allSchedules, patientMap, startDate);
        } else if (this.reportType() === 'yearly') {
          this.processYearlyReport(allSchedules, patientMap);
        }
      }

      // Render chart after data is ready (use setTimeout to ensure canvas is visible)
      setTimeout(() => this.renderChart(), 50);
    } catch (error: any) {
      console.error('生成報表失敗:', error);
    } finally {
      this.isLoading.set(false);
    }
  }

  // --- Excel Export ---

  exportToExcel(): void {
    if (this.noData()) return;
    let headers!: string[];
    let dataRows!: any[][];
    let filename!: string;
    const excelTitle = this.reportTitle();

    if (this.reportType() === 'daily') {
      headers = ['透析模式', '類別', ...this.dailyTableHeaders(), '當日總計'];
      dataRows = this.dailyTableRows().map((row: any) => [
        row.mode, row.status, ...row.shiftCounts, row.dailyTotal,
      ]);
      filename = `日報表_${this.selectedDate()}.xlsx`;
    } else if (this.reportType() === 'monthly') {
      headers = ['透析模式', '類別', ...this.monthlyTableHeaders().map(String), '月總計'];
      dataRows = this.monthlyTableRows().map((row: any) => [
        row.mode, row.status, ...row.dailyCounts, row.monthlyTotal,
      ]);
      filename = `月報表_${this.selectedMonth()}.xlsx`;
    } else if (this.reportType() === 'yearly') {
      headers = ['透析模式', '類別', ...this.yearlyTableHeaders(), '年總計'];
      dataRows = this.yearlyTableRows().map((row: any) => [
        row.mode, row.status, ...row.monthlyCounts, row.yearlyTotal,
      ]);
      filename = `年度報表_${this.selectedYear()}.xlsx`;
    } else if (this.reportType() === 'staffing_monthly') {
      headers = ['日期', '第一班人力', '第一班護病比', '第二班人力', '第二班護病比', '第三班人力', '第三班護病比', '整日人力', '整日護病比'];
      dataRows = this.staffingTableRows().map((row: any) => [
        row.date, row.earlyStaff, row.earlyRatio, row.noonStaff, row.noonRatio, row.lateStaff, row.lateRatio, row.totalStaff, row.totalRatio,
      ]);
      filename = `護理人力月報表_${this.selectedMonth()}.xlsx`;
    } else {
      return;
    }

    const titleRow = [excelTitle];
    const emptyRow: string[] = [];
    const data = [titleRow, emptyRow, headers, ...dataRows];
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet(data);
    const merge = { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } };
    if (!worksheet['!merges']) worksheet['!merges'] = [];
    worksheet['!merges'].push(merge);
    XLSX.utils.book_append_sheet(workbook, worksheet, '報表');
    XLSX.writeFile(workbook, filename);
  }

  // --- Data Processing (unchanged) ---

  private processStaffingReport(dailyLogsData: any[]): void {
    const calcRatio = (patients: number, staff: number): string => {
      if (!staff || staff === 0) return 'N/A';
      return (patients / staff).toFixed(2);
    };

    const reportData = dailyLogsData
      .map(log => {
        const staffing = log.stats?.staffing;
        const mainBeds = log.stats?.main_beds || {};
        const periBeds = log.stats?.peripheral_beds || {};

        // Patient counts per shift (same logic as daily log component)
        const earlyPatients = (mainBeds.early?.total || 0) + (periBeds.early?.total || 0);
        const noonPatients = (mainBeds.noon?.total || 0) + (periBeds.noon?.total || 0);
        const latePatients = (mainBeds.late?.total || 0) + (periBeds.late?.total || 0);
        const totalPatients = earlyPatients + noonPatients + latePatients;

        // Nurse staffing per shift (saved as computed totals)
        const earlyStaff = staffing?.early || 0;
        const noonStaff = staffing?.noon || 0;
        const lateStaff = staffing?.late || 0;
        const totalStaff = earlyStaff + noonStaff + lateStaff;

        return {
          date: log.date,
          earlyStaff: earlyStaff ? earlyStaff.toFixed(3) : 'N/A',
          noonStaff: noonStaff ? noonStaff.toFixed(3) : 'N/A',
          lateStaff: lateStaff ? lateStaff.toFixed(3) : 'N/A',
          totalStaff: totalStaff ? totalStaff.toFixed(3) : 'N/A',
          earlyRatio: calcRatio(earlyPatients, earlyStaff),
          noonRatio: calcRatio(noonPatients, noonStaff),
          lateRatio: calcRatio(latePatients, lateStaff),
          totalRatio: calcRatio(totalPatients, totalStaff),
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    this.staffingTableRows.set(reportData);
  }

  private processDailyReport(allSchedules: any[], patientMap: Map<string, any>): void {
    const shiftBreakdown: Record<string, Record<string, number>> = {};
    const dailyRecord = allSchedules[0];
    if (dailyRecord && dailyRecord.schedule) {
      for (const [shiftKey, slotData] of Object.entries<any>(dailyRecord.schedule)) {
        if (!slotData?.patientId) continue;
        let patientStatus: string, patientMode: string;
        if (slotData.archivedPatientInfo) {
          patientStatus = slotData.archivedPatientInfo.status || 'unknown';
          patientMode = slotData.archivedPatientInfo.mode || 'HD';
        } else {
          const patient = patientMap.get(slotData.patientId);
          patientStatus = patient ? patient.status || 'unknown' : 'unknown';
          patientMode = slotData.modeOverride || (patient ? patient.mode || 'HD' : 'HD');
        }
        const shiftCode = shiftKey.split('-').pop();
        if (!shiftCode) continue;
        if (!shiftBreakdown[shiftCode]) shiftBreakdown[shiftCode] = {};
        const comboKey = `${patientMode}-${patientStatus}`;
        if (!shiftBreakdown[shiftCode][comboKey]) shiftBreakdown[shiftCode][comboKey] = 0;
        shiftBreakdown[shiftCode][comboKey]++;
      }
    }
    const shiftOrder = [SHIFT_CODES.EARLY, SHIFT_CODES.NOON, SHIFT_CODES.LATE];
    this.dailyTableHeaders.set(shiftOrder.map((code: string) => getShiftDisplayName(code)));
    const reportMatrix: Record<string, any> = {};
    const statusDisplay: Record<string, string> = { opd: '門診', ipd: '住院', er: '急診', unknown: '未知' };
    shiftOrder.forEach((shiftCode: string, shiftIndex: number) => {
      const shiftData = shiftBreakdown[shiftCode] || {};
      for (const comboKey in shiftData) {
        if (!reportMatrix[comboKey]) {
          const [mode, status] = comboKey.split('-');
          reportMatrix[comboKey] = {
            mode, status: statusDisplay[status] || status,
            shiftCounts: Array(shiftOrder.length).fill(0), dailyTotal: 0,
          };
        }
        const count = shiftData[comboKey];
        reportMatrix[comboKey].shiftCounts[shiftIndex] = count;
        reportMatrix[comboKey].dailyTotal += count;
      }
    });
    const shiftTotalsRow = {
      mode: '每班總計', status: '',
      shiftCounts: Array(shiftOrder.length).fill(0), dailyTotal: 0,
    };
    const sortedRows = Object.values(reportMatrix).sort(
      (a: any, b: any) => a.mode.localeCompare(b.mode) || a.status.localeCompare(b.status)
    );
    sortedRows.forEach((row: any) => {
      row.shiftCounts.forEach((count: number, index: number) => {
        shiftTotalsRow.shiftCounts[index] += count;
      });
    });
    shiftTotalsRow.dailyTotal = shiftTotalsRow.shiftCounts.reduce((sum: number, count: number) => sum + count, 0);
    this.dailyTableRows.set([...sortedRows, shiftTotalsRow]);
  }

  private processMonthlyReport(allSchedules: any[], patientMap: Map<string, any>, monthStartDate: string): void {
    const dailyBreakdown: Record<string, Record<string, number>> = {};
    for (const dailyRecord of allSchedules) {
      if (!dailyRecord.schedule) continue;
      const dateKey = dailyRecord.date;
      if (!dailyBreakdown[dateKey]) dailyBreakdown[dateKey] = {};
      for (const slotData of Object.values<any>(dailyRecord.schedule)) {
        if (!slotData?.patientId) continue;
        let patientStatus: string, patientMode: string;
        if (slotData.archivedPatientInfo) {
          patientStatus = slotData.archivedPatientInfo.status || 'unknown';
          patientMode = slotData.archivedPatientInfo.mode || 'HD';
        } else {
          const patient = patientMap.get(slotData.patientId);
          patientStatus = patient ? patient.status || 'unknown' : 'unknown';
          patientMode = slotData.modeOverride || (patient ? patient.mode || 'HD' : 'HD');
        }
        const comboKey = `${patientMode}-${patientStatus}`;
        if (!dailyBreakdown[dateKey][comboKey]) dailyBreakdown[dateKey][comboKey] = 0;
        dailyBreakdown[dateKey][comboKey]++;
      }
    }
    const month = new Date(monthStartDate).getMonth();
    const year = new Date(monthStartDate).getFullYear();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    this.monthlyTableHeaders.set(Array.from({ length: daysInMonth }, (_, i) => i + 1));
    const reportMatrix: Record<string, any> = {};
    const statusDisplay: Record<string, string> = { opd: '門診', ipd: '住院', er: '急診', unknown: '未知' };
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = formatDateToYYYYMMDD(new Date(year, month, day));
      const dayData = dailyBreakdown[dateStr] || {};
      for (const comboKey in dayData) {
        if (!reportMatrix[comboKey]) {
          const [mode, status] = comboKey.split('-');
          reportMatrix[comboKey] = {
            mode, status: statusDisplay[status] || status,
            dailyCounts: Array(daysInMonth).fill(0), monthlyTotal: 0,
          };
        }
        const count = dayData[comboKey];
        reportMatrix[comboKey].dailyCounts[day - 1] = count;
        reportMatrix[comboKey].monthlyTotal += count;
      }
    }
    const dailyTotalsRow = {
      mode: '每日總計', status: '',
      dailyCounts: Array(daysInMonth).fill(0), monthlyTotal: 0,
    };
    const sortedRows = Object.values(reportMatrix).sort(
      (a: any, b: any) => a.mode.localeCompare(b.mode) || a.status.localeCompare(b.status)
    );
    sortedRows.forEach((row: any) => {
      row.dailyCounts.forEach((count: number, index: number) => {
        dailyTotalsRow.dailyCounts[index] += count;
      });
    });
    dailyTotalsRow.monthlyTotal = dailyTotalsRow.dailyCounts.reduce((sum: number, count: number) => sum + count, 0);
    this.monthlyTableRows.set([...sortedRows, dailyTotalsRow]);
  }

  private processYearlyReport(allSchedules: any[], patientMap: Map<string, any>): void {
    const monthlyBreakdown: Record<string, number[]> = {};
    for (const dailyRecord of allSchedules) {
      if (!dailyRecord.schedule) continue;
      const recordDate = new Date(dailyRecord.date + 'T00:00:00');
      const monthIndex = recordDate.getMonth();
      for (const slotData of Object.values<any>(dailyRecord.schedule)) {
        if (!slotData?.patientId) continue;
        let patientStatus: string, patientMode: string;
        if (slotData.archivedPatientInfo) {
          patientStatus = slotData.archivedPatientInfo.status || 'unknown';
          patientMode = slotData.archivedPatientInfo.mode || 'HD';
        } else {
          const patient = patientMap.get(slotData.patientId);
          patientStatus = patient ? patient.status || 'unknown' : 'unknown';
          patientMode = slotData.modeOverride || (patient ? patient.mode || 'HD' : 'HD');
        }
        const comboKey = `${patientMode}-${patientStatus}`;
        if (!monthlyBreakdown[comboKey]) monthlyBreakdown[comboKey] = Array(12).fill(0);
        monthlyBreakdown[comboKey][monthIndex]++;
      }
    }
    this.yearlyTableHeaders.set(Array.from({ length: 12 }, (_, i) => `${i + 1}月`));
    const reportMatrix: Record<string, any> = {};
    const statusDisplay: Record<string, string> = { opd: '門診', ipd: '住院', er: '急診', unknown: '未知' };
    for (const comboKey in monthlyBreakdown) {
      const [mode, status] = comboKey.split('-');
      const monthlyCounts = monthlyBreakdown[comboKey];
      reportMatrix[comboKey] = {
        mode, status: statusDisplay[status] || status,
        monthlyCounts, yearlyTotal: monthlyCounts.reduce((sum: number, count: number) => sum + count, 0),
      };
    }
    const monthlyTotalsRow = {
      mode: '每月總計', status: '',
      monthlyCounts: Array(12).fill(0), yearlyTotal: 0,
    };
    const sortedRows = Object.values(reportMatrix).sort(
      (a: any, b: any) => a.mode.localeCompare(b.mode) || a.status.localeCompare(b.status)
    );
    sortedRows.forEach((row: any) => {
      row.monthlyCounts.forEach((count: number, index: number) => {
        monthlyTotalsRow.monthlyCounts[index] += count;
      });
    });
    monthlyTotalsRow.yearlyTotal = monthlyTotalsRow.monthlyCounts.reduce(
      (sum: number, count: number) => sum + count, 0
    );
    this.yearlyTableRows.set([...sortedRows, monthlyTotalsRow]);
  }
}
