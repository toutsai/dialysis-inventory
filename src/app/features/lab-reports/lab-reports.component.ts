import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiManagerService, FirestoreRecord } from '@services/api-manager.service';
import { FirebaseService } from '@services/firebase.service';
import { PatientStoreService } from '@services/patient-store.service';
import { LabAlertDetailModalComponent } from '@app/components/dialogs/lab-alert-detail-modal/lab-alert-detail-modal.component';
import { queryWithInChunks } from '@/utils/firestoreUtils';
import { LAB_ITEM_DISPLAY_NAMES } from '@/constants/labAlertConstants';
import { formatDateToYYYYMM, formatDateToYYYYMMDD } from '@/utils/dateUtils';
import { escapeHtml } from '@/utils/sanitize';
import {
  where,
  orderBy,
  documentId,
  collection,
  getDocs,
  query as firestoreQuery,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import * as XLSX from 'xlsx';

@Component({
  selector: 'app-lab-reports',
  standalone: true,
  imports: [CommonModule, FormsModule, LabAlertDetailModalComponent],
  templateUrl: './lab-reports.component.html',
  styleUrl: './lab-reports.component.css'
})
export class LabReportsComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly apiManagerService = inject(ApiManagerService);
  private readonly firebaseService = inject(FirebaseService);
  private readonly patientStore = inject(PatientStoreService);

  private readonly labReportsApi = this.apiManagerService.create<FirestoreRecord>('lab_reports');
  private readonly baseSchedulesApi = this.apiManagerService.create<FirestoreRecord>('base_schedules');
  private readonly labAnalysesApi = this.apiManagerService.create<FirestoreRecord>('lab_alert_analyses');

  // Page state
  showBackButton = signal(false);
  activeTab = signal<string>('query');
  isSearchVisible = signal(true);

  // Upload state
  selectedFile = signal<File | null>(null);
  isUploading = signal(false);
  uploadResult = signal<any>(null);
  isDragOver = signal(false);

  // Manual entry state
  isFindingMissing = signal(false);
  manualEntryFreq = signal('一三五');
  manualEntryShift = signal('early');
  manualEntryMonth = signal(formatDateToYYYYMM(new Date()));
  missingPatients = signal<any[]>([]);
  searchedForMissing = signal(false);
  manualReportDate = signal(formatDateToYYYYMMDD(new Date()));

  // Query state
  searchType = signal<string>('group');
  groupFreq = signal('一三五');
  groupShift = signal('early');
  groupMonth = signal(formatDateToYYYYMM(new Date()));
  individualSearchQuery = signal('');
  individualSearchYear = signal(new Date().getFullYear());
  isLoadingReports = signal(false);
  searchPerformed = signal(false);
  reportData = signal<any>([]);
  reportColumns = signal<string[]>([]);

  // Alert state
  isLoadingAlerts = signal(false);
  alertList = signal<any[]>([]);
  alertCurrentMonth = signal(new Date());

  // Alert detail modal
  isAlertDetailModalVisible = signal(false);
  selectedAlertItem = signal<any>(null);

  // Constants
  readonly SHIFT_MAP: Record<string, number> = { early: 0, noon: 1, late: 2 };
  readonly SHIFT_INDEX_MAP: Record<number, string> = { 0: '早班', 1: '午班', 2: '晚班' };
  readonly FREQ_CUSTOM_ORDER: Record<string, number> = {
    '一四': 10, '二五': 11, '三六': 12, '一五': 13, '二六': 14,
    '一': 20, '二': 21, '三': 22, '四': 23, '五': 24, '六': 25, '日': 26, '每日': 30,
  };
  readonly FREQ_ORDER: Record<string, number> = {
    '一三五': 1, '二四六': 2, '一四': 3, '二五': 4, '三六': 5, '一五': 6, '二六': 7,
  };
  readonly CONSECUTIVE_ABNORMAL_CRITERIA: Record<string, any> = {
    Hb: { max: 8.5 },
    Albumin: { max: 3.5 },
    URR: { max: 65 },
    CaXP: { min: 60 },
  };

  readonly prioritizedLabItems = [
    'WBC', 'Platelet', 'Hb', 'Ferritin', 'TSAT', 'GlucoseAC', 'Triglyceride',
    'LDL', 'Albumin', 'ALT', 'Na', 'K', 'P', 'Ca', 'CaXP', 'iPTH',
    'BUN', 'PostBUN', 'Creatinine', 'Kt/V', 'URR',
  ];
  readonly labItemDisplayNames: Record<string, string> = LAB_ITEM_DISPLAY_NAMES;

  readonly manualEntryItems = [
    { key: 'WBC', label: '白血球' },
    { key: 'Hb', label: '血色素' },
    { key: 'Platelet', label: '血小板' },
    { key: 'BUN', label: 'BUN(Blood)' },
    { key: 'Creatinine', label: '肌酐、血(洗腎專用)' },
    { key: 'Albumin', label: '白蛋白(BCG法)' },
    { key: 'Na', label: '血中鈉' },
    { key: 'K', label: '血中鉀' },
    { key: 'Ca', label: 'Calcium(Blood)' },
    { key: 'P', label: '磷' },
    { key: 'Iron', label: 'Iron' },
    { key: 'TIBC', label: '總鐵結合能力TIBC' },
    { key: 'Ferritin', label: '鐵蛋白' },
    { key: 'iPTH', label: '副甲狀腺素' },
    { key: 'PostBUN', label: '血中尿素氮(洗後專用)' },
  ];

  alertMonthRange = computed(() => {
    const end = new Date(this.alertCurrentMonth());
    const start = new Date(this.alertCurrentMonth());
    start.setMonth(start.getMonth() - 2);
    const formatDate = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    return { start: formatDate(start), end: formatDate(end) };
  });

  groupedAlerts = computed(() => {
    const groups: Record<string, any> = {};
    this.alertList().forEach((item: any) => {
      item.abnormalities.forEach((abnormality: any) => {
        const key = abnormality.key;
        if (!groups[key]) {
          groups[key] = { key, items: [] };
        }
        groups[key].items.push({
          patient: item.patient,
          abnormality,
          analysisText: item.analysisTexts?.[key] || '',
          suggestionText: item.suggestionTexts?.[key] || '',
        });
      });
    });
    return Object.values(groups).sort((a: any, b: any) => a.key.localeCompare(b.key));
  });

  private queryParamSub: any;

  ngOnInit(): void {
    this.initFromRoute();
  }

  ngOnDestroy(): void {
    if (this.queryParamSub) {
      this.queryParamSub.unsubscribe();
    }
  }

  private async initFromRoute(): Promise<void> {
    await this.patientStore.fetchPatientsIfNeeded();

    const params = this.route.snapshot.queryParams;
    const patientIdFromQuery = params['patientId'];
    const tabFromQuery = params['tab'];

    if (patientIdFromQuery) {
      this.showBackButton.set(true);
      this.setActiveTab('query');
      this.searchType.set('individual');
      this.isSearchVisible.set(true);
      const patient = this.patientStore.patientMap().get(patientIdFromQuery);
      if (patient) {
        this.individualSearchQuery.set(patient.name);
        this.handleSearch();
      }
    } else if (tabFromQuery === 'alert') {
      this.setActiveTab('alert');
    } else if (window.innerWidth <= 768) {
      this.isSearchVisible.set(false);
    }
  }

  goBack(): void {
    this.router.navigate(['..'], { relativeTo: this.route });
  }

  setActiveTab(tabName: string): void {
    this.activeTab.set(tabName);
    if (tabName === 'alert' && this.alertList().length === 0 && !this.isLoadingAlerts()) {
      this.generateAlertReport();
    }
  }

  onSearchTypeChange(newType: string): void {
    this.searchType.set(newType);
    this.searchPerformed.set(false);
    this.reportColumns.set([]);
    if (newType === 'group') {
      this.reportData.set([]);
    } else {
      this.reportData.set({});
    }
  }

  formatShift(shiftIndex: number): string {
    return this.SHIFT_INDEX_MAP[shiftIndex] ?? 'N/A';
  }

  sortAlertItems(items: any[]): any[] {
    return [...items].sort((a, b) => {
      const freqA = this.FREQ_ORDER[a.patient.freq] || 99;
      const freqB = this.FREQ_ORDER[b.patient.freq] || 99;
      if (freqA !== freqB) return freqA - freqB;
      const shiftA = a.patient.shiftIndex ?? 99;
      const shiftB = b.patient.shiftIndex ?? 99;
      if (shiftA !== shiftB) return shiftA - shiftB;
      return String(a.patient.defaultBed).localeCompare(String(b.patient.defaultBed), undefined, {
        numeric: true,
      });
    });
  }

  formatAbnormalityReason(abnormality: any): string {
    if (!abnormality || !abnormality.values || abnormality.values.length < 3) {
      return escapeHtml(abnormality?.reason || 'N/A');
    }

    const sortedValues = [...abnormality.values].sort((a: any, b: any) => a.month.localeCompare(b.month));

    const monthsHtml = sortedValues
      .map((item: any) => `${parseInt(item.month.split('-')[1], 10)}月`)
      .join(' \u2192 ');

    const valuesHtml = sortedValues.map((item: any) => escapeHtml(String(item.value))).join(' \u2192 ');

    const firstValue = parseFloat(sortedValues[0].value);
    const lastValue = parseFloat(sortedValues[sortedValues.length - 1].value);
    let trendIndicator = '';
    let trendClass = 'trend-stable';

    const worseningIfIncreased = ['CaXP'];
    const worseningIfDecreased = ['Hb', 'Albumin', 'URR'];

    if (lastValue > firstValue) {
      trendIndicator = '\u25B2';
      trendClass = worseningIfIncreased.includes(abnormality.key) ? 'is-worsening' : 'is-improving';
    } else if (lastValue < firstValue) {
      trendIndicator = '\u25BC';
      trendClass = worseningIfDecreased.includes(abnormality.key) ? 'is-worsening' : 'is-improving';
    } else {
      trendIndicator = '\u2015';
    }

    const indicatorHtml = `<span class="trend-indicator ${trendClass}">${trendIndicator}</span>`;

    return `
      <div class="abnormality-details">
        <div class="months-row">${monthsHtml}</div>
        <div class="values-row">${valuesHtml} ${indicatorHtml}</div>
      </div>
    `;
  }

  // ---- Alert Report ----

  changeAlertMonth(monthOffset: number): void {
    const current = this.alertCurrentMonth();
    current.setMonth(current.getMonth() + monthOffset);
    this.alertCurrentMonth.set(new Date(current));
    this.generateAlertReport();
  }

  async generateAlertReport(): Promise<void> {
    this.isLoadingAlerts.set(true);
    this.alertList.set([]);
    try {
      await this.patientStore.fetchPatientsIfNeeded();
      const allOpdPatients = this.patientStore.opdPatients();

      const range = this.alertMonthRange();
      const startDate = new Date(range.start + '-01');
      const endDate = new Date(range.end + '-01');
      endDate.setMonth(endDate.getMonth() + 1);
      const scheduleDoc: any = await this.baseSchedulesApi.fetchById('MASTER_SCHEDULE');
      const scheduleRules = scheduleDoc?.schedule || {};

      const newAlertList: any[] = [];

      for (const patient of allOpdPatients) {
        const reports = await this.labReportsApi.fetchAll([
          where('patientId', '==', patient.id),
          where('reportDate', '>=', startDate),
          where('reportDate', '<', endDate),
          orderBy('reportDate', 'desc'),
        ]);
        if (reports.length < 3) continue;
        const cleanedReports = reports.map((r: any) => ({
          ...r,
          reportDate: r.reportDate?.toDate
            ? r.reportDate.toDate().toISOString().slice(0, 10)
            : r.reportDate,
        }));
        const { processedData, months } = this.processReports(cleanedReports);
        const requiredMonths = [
          this.alertMonthRange().end,
          new Date(
            new Date(this.alertMonthRange().end + '-01').setMonth(
              new Date(this.alertMonthRange().end + '-01').getMonth() - 1,
            ),
          )
            .toISOString()
            .slice(0, 7),
          this.alertMonthRange().start,
        ];
        if (!requiredMonths.every((m) => months.includes(m))) continue;
        const abnormalities = this.findAbnormalities(processedData, requiredMonths);
        if (abnormalities.length > 0) {
          const scheduleInfo = scheduleRules[(patient as any).id];
          const patientDataForReport: any = { ...patient };
          patientDataForReport.shiftIndex = scheduleInfo?.shiftIndex;
          patientDataForReport.defaultShift = ['\u65e9', '\u5348', '\u665a'][scheduleInfo?.shiftIndex] || 'N/A';
          patientDataForReport.defaultBed = scheduleInfo?.bedNum || 'N/A';

          newAlertList.push({
            patient: patientDataForReport,
            abnormalities,
            analysisTexts: {},
            suggestionTexts: {},
          });
        }
      }

      // Read saved analyses and fill back
      const patientIdsInList = newAlertList.map((item) => item.patient.id);
      if (patientIdsInList.length > 0) {
        const monthRangeKey = `${this.alertMonthRange().start}_${this.alertMonthRange().end}`;
        const savedAnalyses: any[] = await queryWithInChunks(
          'lab_alert_analyses',
          'patientId',
          patientIdsInList,
          [where('monthRange', '==', monthRangeKey)],
        );

        savedAnalyses.forEach((analysis: any) => {
          const targetItem = newAlertList.find((item) => item.patient.id === analysis.patientId);
          if (targetItem) {
            targetItem.analysisTexts[analysis.abnormalityKey] = analysis.analysis;
            targetItem.suggestionTexts[analysis.abnormalityKey] = analysis.suggestion;
          }
        });
      }
      this.alertList.set(newAlertList);
    } catch (error) {
      console.error('\u751f\u6210\u8b66\u793a\u5831\u544a\u5931\u6557:', error);
      alert('\u751f\u6210\u8b66\u793a\u5831\u544a\u6642\u767c\u751f\u932f\u8aa4\uff0c\u8acb\u6aa2\u67e5\u4e3b\u63a7\u53f0\u3002');
    } finally {
      this.isLoadingAlerts.set(false);
    }
  }

  processReports(rawReports: any[]): { processedData: any; months: string[] } {
    const data: Record<string, Record<string, any>> = {};
    const monthSet = new Set<string>();
    rawReports.forEach((report) => {
      const monthKey = report.reportDate.slice(0, 7);
      monthSet.add(monthKey);
      for (const itemKey in report.data) {
        if (!data[itemKey]) data[itemKey] = {};
        data[itemKey][monthKey] = report.data[itemKey];
      }
    });
    const reportMonths = Array.from(monthSet).sort().reverse();
    for (const monthKey of reportMonths) {
      const bun = data['BUN']?.[monthKey];
      const postBun = data['PostBUN']?.[monthKey];
      const ca = data['Ca']?.[monthKey];
      const p = data['P']?.[monthKey];
      const iron = data['Iron']?.[monthKey];
      const tibc = data['TIBC']?.[monthKey];
      if (ca && p) {
        if (!data['CaXP']) data['CaXP'] = {};
        data['CaXP'][monthKey] = (ca * p).toFixed(2);
      }
      if (iron && tibc > 0) {
        if (!data['TSAT']) data['TSAT'] = {};
        data['TSAT'][monthKey] = ((iron / tibc) * 100).toFixed(1);
      }
      if (bun && postBun > 0) {
        if (!data['URR']) data['URR'] = {};
        if (!data['Kt/V']) data['Kt/V'] = {};
        data['URR'][monthKey] = (((bun - postBun) / bun) * 100).toFixed(1);
        data['Kt/V'][monthKey] = Math.log(bun / postBun).toFixed(2);
      }
    }
    return { processedData: data, months: reportMonths };
  }

  findAbnormalities(processedData: any, months: string[]): any[] {
    const abnormalities: any[] = [];
    if (months.length < 3) return abnormalities;
    const last3MonthsSorted = [...months.slice(0, 3)].sort();
    for (const key in this.CONSECUTIVE_ABNORMAL_CRITERIA) {
      const valuesWithMonths = last3MonthsSorted.map((month) => ({
        month,
        value: processedData[key]?.[month],
      }));
      if (valuesWithMonths.some((item) => item.value === undefined)) continue;
      const rule = this.CONSECUTIVE_ABNORMAL_CRITERIA[key];
      const isValueAbnormal = (v: number) => {
        if (rule.max !== undefined && v < rule.max) return true;
        if (rule.min !== undefined && v > rule.min) return true;
        return false;
      };
      const allAbnormal = valuesWithMonths.every((item) => isValueAbnormal(item.value));
      if (allAbnormal) {
        abnormalities.push({
          key,
          values: valuesWithMonths.map((item) => ({ month: item.month, value: item.value })),
        });
      }
    }
    return abnormalities;
  }

  openAlertDetailModal(item: any, key: string): void {
    this.selectedAlertItem.set({ ...item, key });
    this.isAlertDetailModalVisible.set(true);
  }

  handleAlertUpdate(event: { analysisText: string; suggestionText: string }): void {
    const selectedItem = this.selectedAlertItem();
    if (!selectedItem) return;

    const { patient, key } = selectedItem;
    const list = this.alertList();
    const targetItem = list.find((item: any) => item.patient.id === patient.id);
    if (targetItem) {
      targetItem.analysisTexts[key] = event.analysisText;
      targetItem.suggestionTexts[key] = event.suggestionText;
      this.alertList.set([...list]);
    }
  }

  async saveAlertAnalyses(): Promise<void> {
    if (!confirm('\u60a8\u78ba\u5b9a\u8981\u5132\u5b58\u76ee\u524d\u6240\u6709\u7684\u75c5\u56e0\u5206\u6790\u8207\u5efa\u8b70\u8655\u7f6e\u55ce\uff1f\u6b64\u64cd\u4f5c\u5c07\u6703\u8986\u84cb\u5148\u524d\u7684\u5132\u5b58\u3002')) {
      return;
    }

    this.isLoadingAlerts.set(true);
    try {
      const promises: Promise<any>[] = [];
      const monthRangeKey = `${this.alertMonthRange().start}_${this.alertMonthRange().end}`;

      this.alertList().forEach((item: any) => {
        const patientId = item.patient.id;
        item.abnormalities.forEach((abnormality: any) => {
          const key = abnormality.key;
          const analysis = item.analysisTexts[key] || '';
          const suggestion = item.suggestionTexts[key] || '';

          if (analysis || suggestion) {
            const docId = `${patientId}_${key}_${monthRangeKey}`;
            const dataToSave: any = {
              patientId,
              patientName: item.patient.name,
              abnormalityKey: key,
              monthRange: monthRangeKey,
              analysis,
              suggestion,
              updatedAt: new Date(),
            };
            promises.push(this.labAnalysesApi.save(docId, dataToSave));
          }
        });
      });

      await Promise.all(promises);
      alert('\u5206\u6790\u5132\u5b58\u6210\u529f\uff01');
    } catch (error: any) {
      console.error('\u5132\u5b58\u5206\u6790\u5931\u6557:', error);
      alert(`\u5132\u5b58\u5931\u6557: ${error.message}`);
    } finally {
      this.isLoadingAlerts.set(false);
    }
  }

  exportAlertToExcel(): void {
    if (this.groupedAlerts().length === 0) {
      alert('\u76ee\u524d\u6c92\u6709\u53ef\u532f\u51fa\u7684\u8b66\u793a\u5831\u544a\u8cc7\u6599\u3002');
      return;
    }
    const wb = XLSX.utils.book_new();
    const { start, end } = this.alertMonthRange();
    this.groupedAlerts().forEach((group: any) => {
      const title = `\u8b66\u793a\u5831\u544a (${this.labItemDisplayNames[group.key] || group.key}) - \u5340\u9593: ${start} ~ ${end}`;
      const headers = [
        '\u983b\u7387', '\u9810\u8a2d\u73ed\u5225', '\u9810\u8a2d\u5e8a\u865f', '\u59d3\u540d',
        '\u4e0d\u5408\u683c\u9805\u76ee\u8a73\u60c5', '\u75c5\u56e0\u5206\u6790', '\u5efa\u8b70\u8655\u7f6e',
      ];
      const sortedItems = this.sortAlertItems(group.items);
      const dataRows = sortedItems.map((item: any) => [
        item.patient.freq || 'N/A',
        item.patient.defaultShift || 'N/A',
        item.patient.defaultBed || 'N/A',
        item.patient.name,
        this.formatAbnormalityReason(item.abnormality),
        item.analysisText,
        item.suggestionText,
      ]);
      const sheetData = [[title], [], headers, ...dataRows];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      const numCols = headers.length;
      if (!ws['!merges']) ws['!merges'] = [];
      ws['!merges'].push({ s: { r: 0, c: 0 }, e: { r: 0, c: numCols - 1 } });
      ws['!cols'] = [
        { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 12 },
        { wch: 30 }, { wch: 40 }, { wch: 40 },
      ];
      const sheetName = (this.labItemDisplayNames[group.key] || group.key).replace(/[%()/]/g, '');
      XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
    });
    const fileName = `\u8b66\u793a\u5831\u544a_${start}_${end}.xlsx`;
    XLSX.writeFile(wb, fileName);
  }

  // ---- Search / Query ----

  async handleSearch(): Promise<void> {
    this.isLoadingReports.set(true);
    this.searchPerformed.set(true);
    if (window.innerWidth <= 768) {
      this.isSearchVisible.set(false);
    }
    try {
      await this.patientStore.fetchPatientsIfNeeded();
      if (this.searchType() === 'group') {
        await this.searchGroupReports();
      } else {
        await this.searchIndividualReports();
      }
    } catch (error: any) {
      console.error('\u67e5\u8a62\u5831\u544a\u5931\u6557:', error);
      if (this.searchType() === 'group') {
        this.reportData.set([]);
      } else {
        this.reportData.set({});
      }
      alert(error.message);
    } finally {
      this.isLoadingReports.set(false);
    }
  }

  private async searchGroupReports(): Promise<void> {
    const masterScheduleDoc: any = await this.baseSchedulesApi.fetchById('MASTER_SCHEDULE');
    const masterRules = masterScheduleDoc?.schedule || {};
    const shiftIndex = this.SHIFT_MAP[this.groupShift()];
    const regularFreqs = ['\u4e00\u4e09\u4e94', '\u4e8c\u56db\u516d'];
    const freq = this.groupFreq();
    const patientIdsInGroup = Object.keys(masterRules).filter((id) => {
      const rule = masterRules[id];
      if (!rule) return false;
      const isOtherFreqSelected = freq === 'other';
      const shiftCondition = isOtherFreqSelected || rule.shiftIndex === shiftIndex;
      const freqCondition = isOtherFreqSelected
        ? !regularFreqs.includes(rule.freq)
        : rule.freq === freq;
      return shiftCondition && freqCondition;
    });

    if (patientIdsInGroup.length === 0) {
      this.reportData.set([]);
      return;
    }

    const patientMap = this.patientStore.patientMap();
    const patientList = patientIdsInGroup
      .map((id) => {
        const info = patientMap.get(id);
        const rule = masterRules[id];
        return info
          ? {
              patientId: id,
              patientName: (info as any).name,
              bedNum: rule.bedNum,
              freq: rule.freq,
              shiftIndex: rule.shiftIndex,
            }
          : null;
      })
      .filter(Boolean);

    if (patientList.length === 0) {
      this.reportData.set([]);
      return;
    }

    const [year, month] = this.groupMonth().split('-').map(Number);
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 1);
    const allReportsInMonth: any[] = await queryWithInChunks('lab_reports', 'patientId', patientIdsInGroup, [
      where('reportDate', '>=', startDate),
      where('reportDate', '<', endDate),
    ]);

    const aggregatedReports = new Map<string, any>();
    allReportsInMonth.forEach((report: any) => {
      const patientId = report.patientId;
      if (!aggregatedReports.has(patientId)) {
        aggregatedReports.set(patientId, {});
      }
      const patientLabData = aggregatedReports.get(patientId);
      Object.assign(patientLabData, report.data);
    });

    this.reportData.set(
      patientList
        .map((p: any) => {
          const labData = aggregatedReports.get(p.patientId) || {};
          if (labData.Ca && labData.P) labData.CaXP = (labData.Ca * labData.P).toFixed(2);
          if (labData.Iron && labData.TIBC > 0)
            labData.TSAT = ((labData.Iron / labData.TIBC) * 100).toFixed(1);
          if (labData.BUN && labData.PostBUN > 0 && labData.BUN > 0) {
            labData.URR = (((labData.BUN - labData.PostBUN) / labData.BUN) * 100).toFixed(1);
            labData['Kt/V'] = Math.log(labData.BUN / labData.PostBUN).toFixed(2);
          }
          return { ...p, labData };
        })
        .sort((a: any, b: any) => {
          if (freq === 'other') {
            const orderA = this.FREQ_CUSTOM_ORDER[a.freq] || 99;
            const orderB = this.FREQ_CUSTOM_ORDER[b.freq] || 99;
            if (orderA !== orderB) return orderA - orderB;
            const shiftA = a.shiftIndex ?? 99;
            const shiftB = b.shiftIndex ?? 99;
            if (shiftA !== shiftB) return shiftA - shiftB;
          }
          return String(a.bedNum).localeCompare(String(b.bedNum), undefined, { numeric: true });
        }),
    );
  }

  private async searchIndividualReports(): Promise<void> {
    if (!this.individualSearchQuery().trim()) return;
    const queryStr = this.individualSearchQuery().trim().toLowerCase();

    const allPatients = this.patientStore.allPatients();
    const foundPatient = allPatients.find(
      (p: any) =>
        p.medicalRecordNumber?.toLowerCase().includes(queryStr) || p.name?.toLowerCase().includes(queryStr),
    );
    if (!foundPatient) throw new Error(`\u627e\u4e0d\u5230\u75c5\u4eba: ${this.individualSearchQuery()}`);

    const year = this.individualSearchYear();
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year + 1, 0, 1);
    const reportsRaw: any[] = [];
    const db = this.firebaseService.db;
    const reportsRef = collection(db, 'lab_reports');
    const q = firestoreQuery(
      reportsRef,
      where('patientId', '==', (foundPatient as any).id),
      where('reportDate', '>=', startDate),
      where('reportDate', '<', endDate),
      orderBy('reportDate', 'desc'),
    );
    const querySnapshot = await getDocs(q);
    querySnapshot.forEach((docSnap) => {
      const data: any = docSnap.data();
      if (data.reportDate?.toDate)
        data.reportDate = data.reportDate.toDate().toISOString().slice(0, 10);
      reportsRaw.push({ id: docSnap.id, ...data });
    });

    const processedData: Record<string, Record<string, any>> = {};
    const monthSet = new Set<string>();
    for (let i = 1; i <= 12; i++) {
      monthSet.add(`${year}-${String(i).padStart(2, '0')}`);
    }

    reportsRaw.forEach((report) => {
      const monthKey = report.reportDate.slice(0, 7);
      const labData = report.data;
      for (const itemKey in labData) {
        if (!processedData[itemKey]) {
          processedData[itemKey] = {};
        }
        if (!processedData[itemKey][monthKey]) {
          processedData[itemKey][monthKey] = labData[itemKey];
        }
      }
    });

    for (const monthKey of monthSet) {
      const bun = processedData['BUN']?.[monthKey];
      const postBun = processedData['PostBUN']?.[monthKey];
      const ca = processedData['Ca']?.[monthKey];
      const p = processedData['P']?.[monthKey];
      const iron = processedData['Iron']?.[monthKey];
      const tibc = processedData['TIBC']?.[monthKey];
      if (ca && p) {
        if (!processedData['CaXP']) processedData['CaXP'] = {};
        processedData['CaXP'][monthKey] = (ca * p).toFixed(2);
      }
      if (iron && tibc > 0) {
        if (!processedData['TSAT']) processedData['TSAT'] = {};
        processedData['TSAT'][monthKey] = ((iron / tibc) * 100).toFixed(1);
      }
      if (bun && postBun > 0) {
        if (!processedData['URR']) processedData['URR'] = {};
        if (!processedData['Kt/V']) processedData['Kt/V'] = {};
        processedData['URR'][monthKey] = (((bun - postBun) / bun) * 100).toFixed(1);
        processedData['Kt/V'][monthKey] = Math.log(bun / postBun).toFixed(2);
      }
    }

    this.reportData.set(processedData);
    this.reportColumns.set(Array.from(monthSet).sort().reverse());
  }

  changeYear(offset: number): void {
    this.individualSearchYear.set(this.individualSearchYear() + offset);
    if (this.individualSearchQuery().trim()) this.handleSearch();
  }

  // ---- Upload ----

  handleFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.selectedFile.set(input.files[0]);
      this.uploadResult.set(null);
    }
  }

  handleFileDrop(event: DragEvent): void {
    this.isDragOver.set(false);
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.selectedFile.set(files[0]);
      this.uploadResult.set(null);
    }
  }

  async handleUpload(): Promise<void> {
    if (!this.selectedFile()) {
      alert('\u8acb\u5148\u9078\u64c7\u4e00\u500b\u6a94\u6848\uff01');
      return;
    }
    this.isUploading.set(true);
    this.uploadResult.set(null);
    this.missingPatients.set([]);
    this.searchedForMissing.set(false);
    try {
      const fileContentBase64 = await this.toBase64(this.selectedFile()!);
      const processLabReport = httpsCallable(this.firebaseService.functions, 'processLabReport');
      const result = await processLabReport({
        fileName: this.selectedFile()!.name,
        fileContent: fileContentBase64,
      });
      this.uploadResult.set(result.data);
    } catch (error: any) {
      console.error('\u4e0a\u50b3\u8655\u7406\u5931\u6557:', error);
      this.uploadResult.set({ message: `\u4e0a\u50b3\u5931\u6557: ${error.message}`, errorCount: 1 });
    } finally {
      this.isUploading.set(false);
    }
  }

  private toBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result!.toString().replace(/^data:(.*,)?/, ''));
      reader.onerror = (error) => reject(error);
    });
  }

  // ---- Manual Entry / Missing Patients ----

  async findMissingPatients(): Promise<void> {
    if (!this.manualEntryMonth()) {
      alert('\u8acb\u5148\u9078\u64c7\u8981\u67e5\u8a62\u7684\u6708\u4efd\u3002');
      return;
    }
    this.isFindingMissing.set(true);
    this.searchedForMissing.set(true);
    this.missingPatients.set([]);
    try {
      const shiftIndex = this.SHIFT_MAP[this.manualEntryShift()];
      const masterScheduleDoc: any = await this.baseSchedulesApi.fetchById('MASTER_SCHEDULE');
      const masterRules = masterScheduleDoc?.schedule || {};

      const regularFreqs = ['\u4e00\u4e09\u4e94', '\u4e8c\u56db\u516d'];
      const freq = this.manualEntryFreq();
      const allPatientIdsInGroup = Object.keys(masterRules).filter((id) => {
        const rule = masterRules[id];
        if (!rule) return false;
        const isOtherFreqSelected = freq === 'other';
        const shiftCondition = isOtherFreqSelected || rule.shiftIndex === shiftIndex;
        const freqCondition = isOtherFreqSelected
          ? !regularFreqs.includes(rule.freq)
          : rule.freq === freq;
        return shiftCondition && freqCondition;
      });

      if (allPatientIdsInGroup.length === 0) {
        return;
      }

      const [year, month] = this.manualEntryMonth().split('-').map(Number);
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 1);
      const reportsInMonth: any[] = await queryWithInChunks(
        'lab_reports',
        'patientId',
        allPatientIdsInGroup,
        [where('reportDate', '>=', startDate), where('reportDate', '<', endDate)],
      );
      const patientIdsWithReport = new Set(reportsInMonth.map((report: any) => report.patientId));
      const missingIds = allPatientIdsInGroup.filter((id) => !patientIdsWithReport.has(id));
      if (missingIds.length === 0) {
        return;
      }
      const missingPatientDetails: any[] = await queryWithInChunks('patients', documentId() as any, missingIds);
      this.missingPatients.set(
        missingPatientDetails.map((patientData) => {
          const labData: Record<string, string> = {};
          this.manualEntryItems.forEach((item) => {
            labData[item.key] = '';
          });
          return {
            id: patientData.id,
            name: patientData.name,
            medicalRecordNumber: patientData.medicalRecordNumber,
            labData,
          };
        }),
      );
    } catch (error) {
      console.error('\u67e5\u627e\u7f3a\u6f0f\u75c5\u4eba\u5931\u6557:', error);
      alert('\u67e5\u627e\u7f3a\u6f0f\u75c5\u4eba\u6642\u767c\u751f\u932f\u8aa4\u3002');
    } finally {
      this.isFindingMissing.set(false);
    }
  }

  async generateAndUploadManualData(): Promise<void> {
    if (!this.manualReportDate()) {
      alert('\u8acb\u9078\u64c7\u6240\u6709\u88dc\u767b\u5831\u544a\u7684\u7d71\u4e00\u5831\u544a\u65e5\u3002');
      return;
    }
    const formattedDate = this.manualReportDate().replace(/-/g, '');
    const dataToUpload: any[] = [];
    this.missingPatients().forEach((patient) => {
      this.manualEntryItems.forEach((item) => {
        const value = patient.labData[item.key];
        if (value !== null && value !== '') {
          dataToUpload.push({
            '\u75c5\u6b77\u865f': patient.medicalRecordNumber,
            '\u5831\u544a\u65e5': formattedDate,
            '\u7d30\u9805\u540d\u7a31': item.label,
            '\u7d50\u679c': value,
          });
        }
      });
    });
    if (dataToUpload.length === 0) {
      alert('\u6c92\u6709\u53ef\u4e0a\u50b3\u7684\u88dc\u767b\u8cc7\u6599\u3002\u8acb\u81f3\u5c11\u70ba\u4e00\u4f4d\u75c5\u4eba\u586b\u5beb\u4e00\u9805\u6578\u64da\u3002');
      return;
    }
    try {
      const ws = XLSX.utils.json_to_sheet(dataToUpload);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'ManualEntry');
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/octet-stream' });
      const fileName = `manual_entry_${formatDateToYYYYMMDD(new Date())}.xlsx`;
      const mockFile = new File([blob], fileName, {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      this.selectedFile.set(mockFile);
      await this.handleUpload();
      this.missingPatients.set([]);
      this.searchedForMissing.set(false);
    } catch (error) {
      console.error('\u751f\u6210\u6216\u4e0a\u50b3\u624b\u52d5\u8cc7\u6599\u5931\u6557:', error);
      alert('\u8655\u7406\u624b\u52d5\u88dc\u767b\u8cc7\u6599\u6642\u767c\u751f\u932f\u8aa4\u3002');
    }
  }

  // ---- Group Report Excel Export ----

  exportGroupReportToExcel(): void {
    if (this.searchType() !== 'group' || this.reportData().length === 0) {
      alert('\u76ee\u524d\u6c92\u6709\u53ef\u532f\u51fa\u7684\u7fa4\u7d44\u5831\u544a\u8cc7\u6599\u3002');
      return;
    }
    const freq = this.groupFreq();
    const shift = this.groupShift();
    const month = this.groupMonth();

    let title = '';
    let fileNameIdentifier = '';

    if (freq === 'other') {
      title = `\u6aa2\u9a57\u5831\u544a\u67e5\u8a62\u7d50\u679c: \u5176\u4ed6\u983b\u7387 (\u6240\u6709\u73ed\u5225) / ${month}`;
      fileNameIdentifier = `\u5176\u4ed6(\u6240\u6709\u73ed\u5225)`;
    } else {
      const shiftName = this.SHIFT_INDEX_MAP[this.SHIFT_MAP[shift]] || shift;
      title = `\u6aa2\u9a57\u5831\u544a\u67e5\u8a62\u7d50\u679c: ${freq} / ${shiftName} / ${month}`;
      fileNameIdentifier = `${freq}_${shiftName}`;
    }

    const headers = [
      '\u983b\u7387', '\u73ed\u5225', '\u5e8a\u865f', '\u59d3\u540d',
      ...this.prioritizedLabItems.map((key) => this.labItemDisplayNames[key] || key),
    ];
    const dataRows = this.reportData().map((row: any) => {
      return [
        row.freq || '-',
        this.formatShift(row.shiftIndex),
        row.bedNum || '-',
        row.patientName,
        ...this.prioritizedLabItems.map((itemKey) => {
          const value = row.labData[itemKey];
          return value !== undefined && value !== null ? value : '-';
        }),
      ];
    });
    const sheetData = [[title], [], headers, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    const numCols = headers.length;
    if (!ws['!merges']) ws['!merges'] = [];
    ws['!merges'].push({ s: { r: 0, c: 0 }, e: { r: 0, c: numCols - 1 } });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '\u5831\u544a\u67e5\u8a62\u7d50\u679c');
    const fileName = `\u6aa2\u9a57\u5831\u544a\u67e5\u8a62_${fileNameIdentifier}_${month}.xlsx`;
    XLSX.writeFile(wb, fileName);
  }
}
