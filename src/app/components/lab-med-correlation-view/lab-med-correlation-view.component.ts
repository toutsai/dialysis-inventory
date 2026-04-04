import { Component, Input, OnChanges, SimpleChanges, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { where, orderBy, writeBatch, query, collection, getDocs, doc } from 'firebase/firestore';
import { AuthService } from '@services/auth.service';
import { FirebaseService } from '@services/firebase.service';
import { ApiManagerService, type FirestoreRecord } from '@services/api-manager.service';

interface MedDef {
  code: string;
  tradeName: string;
  type: string;
  unit: string;
}

interface CorrelationGroup {
  title: string;
  labKeys: string[];
  meds: MedDef[];
}

@Component({
  selector: 'app-lab-med-correlation-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './lab-med-correlation-view.component.html',
  styleUrl: './lab-med-correlation-view.component.css'
})
export class LabMedCorrelationViewComponent implements OnChanges {
  @Input() patient: any = null;

  private authService = inject(AuthService);
  private firebaseService = inject(FirebaseService);
  private apiManagerService = inject(ApiManagerService);
  private cdr = inject(ChangeDetectorRef);

  readonly correlationGroups: CorrelationGroup[] = [
    {
      title: '貧血管理 (Anemia)',
      labKeys: ['Hb', 'Ferritin', 'TSAT'],
      meds: [
        { code: 'INES2', tradeName: 'NESP', type: 'injection', unit: 'mcg' },
        { code: 'IREC1', tradeName: 'Recormon', type: 'injection', unit: 'KIU' },
        { code: 'OVAF', tradeName: 'Vafseo', type: 'oral', unit: '顆' },
        { code: 'IFER2', tradeName: 'Fe-back', type: 'injection', unit: 'mg' },
      ]
    },
    {
      title: '鈣磷代謝 (Mineral Metabolism)',
      labKeys: ['Ca', 'P', 'iPTH'],
      meds: [
        { code: 'OCAL1', tradeName: 'A-Cal', type: 'oral', unit: '顆' },
        { code: 'OCAA', tradeName: 'Pro-Ca', type: 'oral', unit: '顆' },
        { code: 'OFOS4', tradeName: 'Lanclean', type: 'oral', unit: '顆' },
        { code: 'OALK1', tradeName: 'Alkantin', type: 'oral', unit: '顆' },
        { code: 'ICAC', tradeName: 'Cacare', type: 'injection', unit: 'amp' },
        { code: 'OUCA1', tradeName: 'U-Ca', type: 'oral', unit: '顆' },
        { code: 'IPAR1', tradeName: 'Parsabiv', type: 'injection', unit: 'mg' },
        { code: 'OORK', tradeName: 'Orkedia', type: 'oral', unit: '顆' },
      ]
    }
  ];

  readonly labItemDisplayNames: Record<string, string> = {
    Hb: 'Hb', Ferritin: 'Ferritin', TSAT: 'TSAT', Ca: 'Ca', P: 'P', iPTH: 'iPTH'
  };

  private readonly LAB_REFERENCE_RANGES: Record<string, { min?: number; max?: number }> = {
    Hb: { min: 8, max: 12 }, P: { max: 5.5 }, iPTH: { min: 150, max: 300 },
    Ca: { min: 8.6, max: 10.3 }, Ferritin: { max: 800 }
  };

  isLoading = true;
  isSubmitting = false;
  error: string | null = null;
  rawLabReports: any[] = [];
  rawMedOrders: any[] = [];
  rawMedDrafts: any[] = [];
  orderDraft: Record<string, { dose: string; frequency: string }> = {};
  initialDraftState: Record<string, { dose: string; frequency: string }> = {};
  isDraftPanelVisible = false;

  get anemiaGroup(): CorrelationGroup {
    return this.correlationGroups.find(g => g.title.includes('貧血'))!;
  }

  get mineralGroup(): CorrelationGroup {
    return this.correlationGroups.find(g => g.title.includes('鈣磷'))!;
  }

  get allMedsMaster(): MedDef[] {
    return this.correlationGroups.flatMap(g => g.meds);
  }

  get currentTargetMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
  }

  get draftTargetMonth(): string {
    return this.labReportMonths[0] || this.currentTargetMonth;
  }

  get labReportMonths(): string[] {
    if (!this.rawLabReports.length && !this.rawMedOrders.length && !this.rawMedDrafts.length) return [];
    const monthSet = new Set<string>();
    monthSet.add(this.currentTargetMonth);
    monthSet.add('2025-08');
    const addMonthIfValid = (month: string) => {
      if (!month) return;
      if (month <= this.currentTargetMonth) monthSet.add(month);
    };
    this.rawLabReports.forEach(r => addMonthIfValid(r.reportDate.slice(0, 7)));
    this.rawMedOrders.forEach(order => addMonthIfValid(order.uploadMonth || order.changeDate?.slice(0, 7)));
    this.rawMedDrafts.forEach(draft => addMonthIfValid(draft.targetMonth));
    return Array.from(monthSet).sort().reverse().slice(0, 12);
  }

  get latestLabMonth(): string {
    return this.labReportMonths[0] || '';
  }

  get processedLabs(): Record<string, Record<string, number>> {
    const data: Record<string, Record<string, number>> = {};
    this.rawLabReports.forEach(report => {
      const monthKey = report.reportDate.slice(0, 7);
      for (const itemKey in report.data) {
        if (!data[itemKey]) data[itemKey] = {};
        if (!data[itemKey][monthKey]) data[itemKey][monthKey] = report.data[itemKey];
      }
    });
    return data;
  }

  get processedOrders(): Record<string, Record<string, any>> {
    const data: Record<string, Record<string, any>> = {};
    const sortedOrders = [...this.rawMedOrders].sort((a, b) => {
      const dateA = a.uploadTimestamp?.toDate ? a.uploadTimestamp.toDate() : new Date(a.uploadTimestamp || 0);
      const dateB = b.uploadTimestamp?.toDate ? b.uploadTimestamp.toDate() : new Date(b.uploadTimestamp || 0);
      return dateA - dateB;
    });
    sortedOrders.forEach(order => {
      const monthKey = order.uploadMonth;
      if (!monthKey || !order.orderCode) return;
      if (!data[order.orderCode]) data[order.orderCode] = {};
      const medInfo = this.allMedsMaster.find(m => m.code === order.orderCode);
      data[order.orderCode][monthKey] = {
        dose: order.dose,
        unit: medInfo ? medInfo.unit : '',
        frequency: order.frequency || order.note,
        isDraft: false
      };
    });
    this.rawMedDrafts.forEach(draft => {
      const monthKey = draft.targetMonth;
      if (!data[draft.orderCode]) data[draft.orderCode] = {};
      data[draft.orderCode][monthKey] = {
        dose: draft.dose,
        unit: draft.unit,
        frequency: draft.frequency || draft.note,
        isDraft: true
      };
    });
    return data;
  }

  get isDraftChanged(): boolean {
    if (Object.keys(this.orderDraft).length === 0) return false;
    return JSON.stringify(this.orderDraft) !== JSON.stringify(this.initialDraftState);
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['patient']) {
      this.rawLabReports = [];
      this.rawMedOrders = [];
      this.rawMedDrafts = [];
      this.orderDraft = {};
      this.initialDraftState = {};
      this.isDraftPanelVisible = false;
      const newPatient = changes['patient'].currentValue;
      if (newPatient?.id) {
        this.fetchData();
      } else {
        this.isLoading = false;
      }
    }
  }

  toggleDraftPanel() {
    if (!this.isDraftPanelVisible) this.initializeDraft();
    this.isDraftPanelVisible = !this.isDraftPanelVisible;
  }

  initializeDraft() {
    const newDraft: Record<string, { dose: string; frequency: string }> = {};
    const targetMonth = this.draftTargetMonth;
    this.allMedsMaster.forEach(med => {
      const orderForTargetMonth = this.processedOrders[med.code]?.[targetMonth];
      let lastOrder: any = null;
      if (!orderForTargetMonth) {
        const historicalOrdersForMed = this.processedOrders[med.code];
        if (historicalOrdersForMed) {
          const sortedMonths = Object.keys(historicalOrdersForMed)
            .filter(m => !historicalOrdersForMed[m].isDraft && m < targetMonth)
            .sort().reverse();
          if (sortedMonths[0]) lastOrder = historicalOrdersForMed[sortedMonths[0]];
        }
      }
      newDraft[med.code] = {
        dose: orderForTargetMonth?.dose || lastOrder?.dose || '',
        frequency: orderForTargetMonth?.frequency || lastOrder?.frequency || ''
      };
    });
    this.orderDraft = { ...newDraft };
    this.initialDraftState = JSON.parse(JSON.stringify(newDraft));
  }

  private formatDateFromTimestamp(timestamp: any): string {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
  }

  async fetchData() {
    if (!this.patient?.id) { this.isLoading = false; return; }
    this.isLoading = true;
    this.error = null;
    try {
      const labReportsApi = this.apiManagerService.create<FirestoreRecord>('lab_reports');
      const ordersApi = this.apiManagerService.create<FirestoreRecord>('medication_orders');
      const draftOrdersApi = this.apiManagerService.create<FirestoreRecord>('medication_drafts');

      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      const twoYearsAgoStr = twoYearsAgo.toISOString().split('T')[0];

      const [allReports, allOrders, allDrafts] = await Promise.all([
        labReportsApi.fetchAll([where('patientId', '==', this.patient.id)]),
        ordersApi.fetchAll([where('patientId', '==', this.patient.id)]),
        draftOrdersApi.fetchAll([where('patientId', '==', this.patient.id)]),
      ]);

      // Client-side date filtering + sorting for lab reports
      const reports = allReports
        .filter((r: any) => {
          const reportDate = r.reportDate;
          if (typeof reportDate === 'string') return reportDate >= twoYearsAgoStr;
          return true;
        })
        .sort((a: any, b: any) => {
          const dateA = typeof a.reportDate === 'string' ? a.reportDate : '';
          const dateB = typeof b.reportDate === 'string' ? b.reportDate : '';
          return dateB.localeCompare(dateA);
        });

      this.rawLabReports = reports.map((r: any) => ({
        ...r,
        reportDate: this.formatDateFromTimestamp(r.reportDate)
      }));

      // Client-side date filtering + sorting for medication orders
      const orders = allOrders
        .filter((o: any) => {
          const ts = o.uploadTimestamp;
          if (!ts) return false;
          const uploadDate = ts.toDate ? ts.toDate() : new Date(ts);
          return uploadDate >= twoYearsAgo;
        })
        .sort((a: any, b: any) => {
          const dateA = a.uploadTimestamp ? (a.uploadTimestamp.toDate ? a.uploadTimestamp.toDate() : new Date(a.uploadTimestamp)) : new Date(0);
          const dateB = b.uploadTimestamp ? (b.uploadTimestamp.toDate ? b.uploadTimestamp.toDate() : new Date(b.uploadTimestamp)) : new Date(0);
          return dateB - dateA;
        });

      this.rawMedOrders = orders.map((order: any) => {
        const uploadDate = order.uploadTimestamp?.toDate ? order.uploadTimestamp.toDate() : (order.uploadTimestamp ? new Date(order.uploadTimestamp) : null);
        if (uploadDate) {
          return { ...order, uploadMonth: `${uploadDate.getFullYear()}-${(uploadDate.getMonth() + 1).toString().padStart(2, '0')}` };
        }
        return order;
      });

      // Client-side status filtering for drafts
      this.rawMedDrafts = allDrafts.filter((d: any) => d.status === 'pending');
    } catch (err: any) {
      console.error('Failed to fetch data:', err);
      this.error = err.message;
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  async saveDraftOrders() {
    if (!this.isDraftChanged) { alert('藥囑草稿未變更，無需儲存。'); return; }
    this.isSubmitting = true;
    const db = this.firebaseService.db;
    const batch = writeBatch(db);
    try {
      const oldDraftsQuery = query(
        collection(db, 'medication_drafts'),
        where('patientId', '==', this.patient.id),
        where('targetMonth', '==', this.draftTargetMonth)
      );
      const oldDraftsSnapshot = await getDocs(oldDraftsQuery);
      oldDraftsSnapshot.forEach(d => batch.delete(d.ref));

      for (const medCode in this.orderDraft) {
        const draft = this.orderDraft[medCode];
        if (draft.dose || draft.frequency) {
          const medInfo = this.allMedsMaster.find(m => m.code === medCode);
          if (!medInfo) continue;
          const currentUser = this.authService.currentUser();
          const newDraftRef = doc(collection(db, 'medication_drafts'));
          batch.set(newDraftRef, {
            patientId: this.patient.id,
            patientName: this.patient.name,
            medicalRecordNumber: this.patient.medicalRecordNumber,
            targetMonth: this.draftTargetMonth,
            status: 'pending',
            createdAt: new Date(),
            authorId: currentUser?.uid,
            authorName: currentUser?.name,
            orderCode: medInfo.code,
            orderName: medInfo.tradeName,
            orderType: medInfo.type,
            dose: draft.dose,
            unit: medInfo.unit,
            frequency: medInfo.type === 'oral' ? draft.frequency : '',
            note: medInfo.type === 'injection' ? draft.frequency : ''
          });
        }
      }
      await batch.commit();
      alert('藥囑草稿儲存成功！');
      await this.fetchData();
    } catch (err: any) {
      console.error('Failed to save draft orders:', err);
      alert(`儲存藥囑草稿時發生錯誤: ${err.message}`);
    } finally {
      this.isSubmitting = false;
    }
  }

  getAbnormalClass(itemKey: string, value: number): string {
    const range = this.LAB_REFERENCE_RANGES[itemKey];
    if (!range || value === undefined) return '';
    if (range.min !== undefined && value < range.min) return 'value-low';
    if (range.max !== undefined && value > range.max) return 'value-high';
    return '';
  }
}
