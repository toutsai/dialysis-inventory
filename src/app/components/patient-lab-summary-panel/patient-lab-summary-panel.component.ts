import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import ApiManager from '@/services/api_manager';
import { where, orderBy } from 'firebase/firestore';

interface LabReport {
  id?: string;
  patientId: string;
  reportDate: string;
  data: Record<string, number>;
}

@Component({
  selector: 'app-patient-lab-summary-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './patient-lab-summary-panel.component.html',
  styleUrl: './patient-lab-summary-panel.component.css'
})
export class PatientLabSummaryPanelComponent implements OnChanges {
  @Input() patient: any = null;
  @Output() saveRecord = new EventEmitter<{ patient: any; content: string }>();

  isLoading = false;
  isSubmitting = false;
  error: string | null = null;
  rawReports: LabReport[] = [];
  dispositionText = '';

  private labReportsApi = ApiManager('lab_reports');

  readonly prioritizedLabItems = [
    'WBC', 'Platelet', 'Hb', 'Ferritin', 'TSAT', 'GlucoseAC',
    'Triglyceride', 'LDL', 'Albumin', 'ALT', 'Na', 'K', 'P', 'Ca',
    'CaXP', 'iPTH', 'BUN', 'PostBUN', 'Creatinine', 'Kt/V', 'URR'
  ];

  readonly labItemDisplayNames: Record<string, string> = {
    BUN: 'BUN', Creatinine: 'Cr', Albumin: 'ALB', P: 'P', Ca: 'Ca',
    Hb: 'Hb', Hct: 'Hct', Platelet: 'PLT', WBC: 'WBC', Na: 'Na',
    K: 'K', eGFR: 'eGFR', GlucoseAC: 'Glucose', TotalProtein: 'Total Protein',
    Iron: 'Fe', TIBC: 'TIBC', Ferritin: 'Ferritin', iPTH: 'iPTH',
    PostBUN: 'Post-BUN', CaXP: 'Ca x P', 'Kt/V': 'Kt/V', 'URR': 'URR (%)',
    TSAT: 'TSAT (%)', Triglyceride: 'TG', LDL: 'LDL', ALT: 'ALT'
  };

  private readonly LAB_REFERENCE_RANGES: Record<string, { min?: number; max?: number }> = {
    WBC: { min: 4.0, max: 10.0 }, Hb: { min: 8, max: 12 }, P: { max: 5.5 },
    ALT: { max: 40 }, Triglyceride: { max: 150 }, LDL: { max: 100 },
    Albumin: { min: 3.5 }, 'Kt/V': { min: 1.2 }, URR: { min: 65 },
    iPTH: { min: 150, max: 300 }, Ca: { min: 8.6, max: 10.3 },
    K: { min: 3.5, max: 5.1 }, Ferritin: { max: 800 }, CaXP: { max: 60 }
  };

  private readonly CONSECUTIVE_ABNORMAL_CRITERIA: Record<string, { min?: number; max?: number }> = {
    Hb: { max: 8.5 }, Albumin: { max: 3.5 }, URR: { max: 65 }, CaXP: { min: 60 }
  };

  get processedReports(): Record<string, Record<string, number>> {
    const data: Record<string, Record<string, number>> = {};
    this.rawReports.forEach(report => {
      const monthKey = report.reportDate.slice(0, 7);
      for (const itemKey in report.data) {
        if (!data[itemKey]) data[itemKey] = {};
        if (!data[itemKey][monthKey]) {
          data[itemKey][monthKey] = report.data[itemKey];
        }
      }
    });
    for (const monthKey of this.reportMonths) {
      const bun = data['BUN']?.[monthKey];
      const postBun = data['PostBUN']?.[monthKey];
      const iron = data['Iron']?.[monthKey];
      const tibc = data['TIBC']?.[monthKey];
      const ca = data['Ca']?.[monthKey];
      const p = data['P']?.[monthKey];
      if (bun !== undefined && postBun !== undefined && postBun > 0 && bun > 0) {
        if (!data['URR']) data['URR'] = {};
        if (!data['Kt/V']) data['Kt/V'] = {};
        data['URR'][monthKey] = parseFloat((((bun - postBun) / bun) * 100).toFixed(1));
        data['Kt/V'][monthKey] = parseFloat(Math.log(bun / postBun).toFixed(2));
      }
      if (iron !== undefined && tibc !== undefined && tibc > 0) {
        if (!data['TSAT']) data['TSAT'] = {};
        data['TSAT'][monthKey] = parseFloat(((iron / tibc) * 100).toFixed(1));
      }
      if (ca !== undefined && p !== undefined) {
        if (!data['CaXP']) data['CaXP'] = {};
        data['CaXP'][monthKey] = parseFloat((ca * p).toFixed(2));
      }
    }
    return data;
  }

  get reportMonths(): string[] {
    const monthSet = new Set<string>();
    this.rawReports.forEach(r => monthSet.add(r.reportDate.slice(0, 7)));
    return Array.from(monthSet).sort().reverse();
  }

  get latestMonth(): string {
    return this.reportMonths[0] || '';
  }

  get analysisResults() {
    const results = {
      highItems: [] as any[], lowItems: [] as any[],
      risingItems: [] as any[], fallingItems: [] as any[],
      consecutiveAbnormalItems: [] as any[]
    };
    if (!this.latestMonth) return results;
    const processed = this.processedReports;
    for (const key in processed) {
      const value = processed[key][this.latestMonth];
      if (value === undefined) continue;
      const range = this.LAB_REFERENCE_RANGES[key];
      if (!range) continue;
      if (range.min !== undefined && value < range.min) {
        results.lowItems.push({ key, value, class: 'value-low' });
      } else if (range.max !== undefined && value > range.max) {
        results.highItems.push({ key, value, class: 'value-high' });
      }
    }
    if (this.reportMonths.length < 3) return results;
    const last3Months = this.reportMonths.slice(0, 3);
    for (const key of this.prioritizedLabItems) {
      const val1 = processed[key]?.[last3Months[0]];
      const val2 = processed[key]?.[last3Months[1]];
      const val3 = processed[key]?.[last3Months[2]];
      if (val1 === undefined || val2 === undefined || val3 === undefined) continue;
      if (val1 > val2 && val2 > val3) results.risingItems.push({ key });
      else if (val1 < val2 && val2 < val3) results.fallingItems.push({ key });
    }
    for (const key in this.CONSECUTIVE_ABNORMAL_CRITERIA) {
      const val1 = processed[key]?.[last3Months[0]];
      const val2 = processed[key]?.[last3Months[1]];
      const val3 = processed[key]?.[last3Months[2]];
      if (val1 === undefined || val2 === undefined || val3 === undefined) continue;
      const rule = this.CONSECUTIVE_ABNORMAL_CRITERIA[key];
      const isAbnormal = (v: number) => {
        if (rule.max !== undefined && v < rule.max) return true;
        if (rule.min !== undefined && v > rule.min) return true;
        return false;
      };
      if (isAbnormal(val1) && isAbnormal(val2) && isAbnormal(val3)) {
        results.consecutiveAbnormalItems.push({ key });
      }
    }
    return results;
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['patient']) {
      const newPatient = changes['patient'].currentValue;
      if (newPatient?.id) {
        this.rawReports = [];
        this.dispositionText = '';
        this.fetchLabData();
      } else {
        this.rawReports = [];
      }
    }
  }

  async fetchLabData() {
    if (!this.patient?.id) return;
    this.isLoading = true;
    this.error = null;
    try {
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const reports = await this.labReportsApi.fetchAll([
        where('patientId', '==', this.patient.id),
        where('reportDate', '>=', oneYearAgo),
        orderBy('reportDate', 'desc')
      ]);
      this.rawReports = reports.map((r: any) => ({
        ...r,
        reportDate: r.reportDate.toDate
          ? r.reportDate.toDate().toISOString().slice(0, 10)
          : r.reportDate
      }));
    } catch (err: any) {
      console.error('Failed to fetch lab reports:', err);
      this.error = err.message;
    } finally {
      this.isLoading = false;
    }
  }

  handleSave() {
    this.isSubmitting = true;
    let autoContent = `【檢驗報告處置 - ${this.latestMonth}】\n\n摘要：\n`;
    const { highItems, lowItems, risingItems, fallingItems, consecutiveAbnormalItems } = this.analysisResults;
    if (highItems.length > 0 || lowItems.length > 0) {
      autoContent += ' • 本月不合格項目:\n';
      highItems.forEach((item: any) => {
        autoContent += `   - ${this.labItemDisplayNames[item.key] || item.key}: ${item.value} (偏高)\n`;
      });
      lowItems.forEach((item: any) => {
        autoContent += `   - ${this.labItemDisplayNames[item.key] || item.key}: ${item.value} (偏低)\n`;
      });
    }
    if (risingItems.length > 0 || fallingItems.length > 0) {
      autoContent += ' • 數據趨勢 (近三個月):\n';
      risingItems.forEach((item: any) => {
        autoContent += `   - ${this.labItemDisplayNames[item.key] || item.key} (連續上升)\n`;
      });
      fallingItems.forEach((item: any) => {
        autoContent += `   - ${this.labItemDisplayNames[item.key] || item.key} (連續下降)\n`;
      });
    }
    if (consecutiveAbnormalItems.length > 0) {
      autoContent += ' • 連續不合格項目 (特定條件):\n';
      consecutiveAbnormalItems.forEach((item: any) => {
        autoContent += `   - ${this.labItemDisplayNames[item.key] || item.key}\n`;
      });
    }
    autoContent += `\n處置與計畫：\n${this.dispositionText.trim()}`;
    this.saveRecord.emit({ patient: this.patient, content: autoContent });
    setTimeout(() => {
      this.isSubmitting = false;
      this.dispositionText = '';
    }, 300);
  }

  getAbnormalClass(itemKey: string, value: number): string {
    const range = this.LAB_REFERENCE_RANGES[itemKey];
    if (!range || value === undefined) return '';
    if (range.min !== undefined && value < range.min) return 'value-low';
    if (range.max !== undefined && value > range.max) return 'value-high';
    return '';
  }

  getTrendArrow(itemKey: string, month: string): { arrow: string; class: string } {
    const currentMonthIndex = this.reportMonths.indexOf(month);
    if (currentMonthIndex >= this.reportMonths.length - 1) return { arrow: '', class: '' };
    const prevMonth = this.reportMonths[currentMonthIndex + 1];
    const currentValue = this.processedReports[itemKey]?.[month];
    const prevValue = this.processedReports[itemKey]?.[prevMonth];
    if (currentValue === undefined || prevValue === undefined) return { arrow: '', class: '' };
    if (currentValue > prevValue) return { arrow: '▲', class: 'value-high' };
    if (currentValue < prevValue) return { arrow: '▼', class: 'value-low' };
    return { arrow: '', class: '' };
  }
}
