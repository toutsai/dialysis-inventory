import {
  Component,
  inject,
  signal,
  computed,
  OnInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import { httpsCallable } from 'firebase/functions';
import { where } from 'firebase/firestore';
import { FirebaseService } from '@services/firebase.service';
import {
  ApiManagerService,
  type ApiManager,
  type FirestoreRecord,
} from '@services/api-manager.service';
import { PatientStoreService } from '@services/patient-store.service';
import { MedicationStoreService } from '@services/medication-store.service';
import { queryWithInChunks } from '@/utils/firestoreUtils';
import { formatDateToYYYYMM } from '@/utils/dateUtils';

interface MedicationMaster {
  code: string;
  tradeName: string;
  unit: string;
}

interface OrderRecord extends FirestoreRecord {
  patientId: string;
  orderCode: string;
  orderType?: string;
  dose?: string;
  note?: string;
  frequency?: string;
  changeDate?: string;
  uploadTimestamp?: { toDate: () => Date };
}

interface GroupSearchResult {
  patientId: string;
  patientName: string;
  bedNum: string;
  freq: string;
  shiftIndex: number;
  orders: Record<string, OrderRecord>;
}

interface IndividualSearchResult {
  month: string;
  orders: Record<string, OrderRecord>;
}

interface UploadResult {
  message: string;
  errorCount: number;
  errors?: { rowNumber: number; reason: string }[];
  success?: boolean;
  processedCount?: number;
}

@Component({
  selector: 'app-orders',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './orders.component.html',
  styleUrl: './orders.component.css',
})
export class OrdersComponent implements OnInit {
  private readonly firebaseService = inject(FirebaseService);
  private readonly apiManagerService = inject(ApiManagerService);
  private readonly patientStore = inject(PatientStoreService);
  private readonly medicationStore = inject(MedicationStoreService);

  private readonly baseSchedulesApi: ApiManager<FirestoreRecord>;
  private readonly ordersApi: ApiManager<OrderRecord>;

  // --- Component State ---
  readonly activeTab = signal<'query' | 'upload'>('query');
  readonly isLoading = signal(false);
  readonly searchPerformed = signal(false);
  readonly searchType = signal<'group' | 'individual'>('group');

  groupSearchParams = {
    freq: '一三五',
    shift: 'early',
    month: formatDateToYYYYMM(new Date()),
  };

  readonly individualSearchTerm = signal('');
  readonly individualSearchYear = signal(new Date().getFullYear());
  readonly searchResult = signal<(GroupSearchResult | IndividualSearchResult)[]>([]);

  // --- Medication Master Data ---
  readonly INJECTION_MEDS_MASTER: MedicationMaster[] = [
    { code: 'INES2', tradeName: 'NESP', unit: 'mcg' },
    { code: 'IREC1', tradeName: 'Recormon', unit: 'KIU' },
    { code: 'IFER2', tradeName: 'Fe-back', unit: 'mg' },
    { code: 'ICAC', tradeName: 'Cacare', unit: 'amp' },
    { code: 'IPAR1', tradeName: 'Parsabiv', unit: 'mg' },
  ];

  readonly ORAL_MEDS_MASTER: MedicationMaster[] = [
    { code: 'OCAL1', tradeName: 'A-Cal', unit: '顆' },
    { code: 'OCAA', tradeName: 'Pro-Cal', unit: '顆' },
    { code: 'OFOS4', tradeName: 'Lanclean', unit: '顆' },
    { code: 'OALK1', tradeName: 'Alkantin', unit: '顆' },
    { code: 'OVAF', tradeName: 'Vafseo', unit: '顆' },
    { code: 'OORK', tradeName: 'Orkedia', unit: '顆' },
    { code: 'OUCA1', tradeName: 'U-Ca', unit: '顆' },
  ];

  readonly allMedications = computed(() => [
    ...this.INJECTION_MEDS_MASTER,
    ...this.ORAL_MEDS_MASTER,
  ]);

  // --- Upload Tab State ---
  readonly selectedFile = signal<File | null>(null);
  readonly isUploading = signal(false);
  readonly uploadResult = signal<UploadResult | null>(null);
  readonly isDragOver = signal(false);
  readonly uploadTargetMonth = signal(formatDateToYYYYMM(new Date()));

  // --- Helper Maps ---
  private readonly SHIFT_MAP: Record<string, number> = {
    early: 0,
    noon: 1,
    late: 2,
  };
  private readonly SHIFT_INDEX_MAP: Record<number, string> = {
    0: '早班',
    1: '午班',
    2: '晚班',
  };

  constructor() {
    this.baseSchedulesApi =
      this.apiManagerService.create<FirestoreRecord>('base_schedules');
    this.ordersApi =
      this.apiManagerService.create<OrderRecord>('medication_orders');
  }

  ngOnInit(): void {
    this.patientStore.fetchPatientsIfNeeded();
  }

  // --- Helper Functions ---
  formatShift(shiftIndex: number): string {
    return this.SHIFT_INDEX_MAP[shiftIndex] ?? 'N/A';
  }

  formatOrderCell(order: OrderRecord | undefined): string {
    if (!order) return '-';
    const dose = order.dose || '';
    if (!dose) return '-';
    const masterMed = this.allMedications().find(
      (med) => med.code === order.orderCode
    );
    const unit = masterMed?.unit ? ` ${masterMed.unit}` : '';
    let details = '';
    if (order.orderType === 'injection') {
      details = order.note || '';
    } else if (order.orderType === 'oral') {
      details = order.frequency || '';
    }
    if (details) {
      return `${dose}${unit} (${details})`;
    }
    return `${dose}${unit}`;
  }

  // --- Core Search Logic ---
  async handleSearch(): Promise<void> {
    this.isLoading.set(true);
    this.searchPerformed.set(true);
    this.searchResult.set([]);
    try {
      if (this.searchType() === 'group') {
        await this.searchGroupOrders();
      } else {
        await this.searchIndividualOrders();
      }
    } catch (error) {
      console.error('查詢藥囑失敗:', error);
      alert('查詢藥囑時發生錯誤，請稍後再試。');
    } finally {
      this.isLoading.set(false);
    }
  }

  private async searchGroupOrders(): Promise<void> {
    const masterScheduleDoc = await this.baseSchedulesApi.fetchById(
      'MASTER_SCHEDULE'
    );
    const masterRules: Record<string, any> =
      (masterScheduleDoc as any)?.schedule || {};
    const shiftIndex = this.SHIFT_MAP[this.groupSearchParams.shift];
    const regularFreqs = ['一三五', '二四六'];
    const opdPatients = this.patientStore.opdPatients();

    const patientList = opdPatients
      .filter((p: any) => {
        const rule = masterRules[p.id!];
        if (!rule) return false;
        const isOtherFreqSelected = this.groupSearchParams.freq === 'other';
        const shiftCondition =
          isOtherFreqSelected || rule.shiftIndex === shiftIndex;
        const freqCondition = isOtherFreqSelected
          ? !regularFreqs.includes(rule.freq)
          : rule.freq === this.groupSearchParams.freq;
        return shiftCondition && freqCondition;
      })
      .map((p: any) => ({
        patientId: p.id!,
        patientName: p.name,
        bedNum: masterRules[p.id!]?.bedNum,
        freq: masterRules[p.id!]?.freq,
        shiftIndex: masterRules[p.id!]?.shiftIndex,
      }));

    // Build patient map first -- always show the patient list
    const patientOrdersMap = new Map<string, GroupSearchResult>();
    patientList.forEach((p: any) =>
      patientOrdersMap.set(p.patientId, { ...p, orders: {} })
    );

    // Try to query medication orders and merge into patient map
    if (patientList.length > 0) {
      const [year, month] = this.groupSearchParams.month
        .split('-')
        .map(Number);
      const uploadMonthStr = `${year}-${String(month).padStart(2, '0')}`;
      const patientIds = patientList.map((p: any) => p.patientId);

      try {
        const allOrders: any[] = await queryWithInChunks(
          'medication_orders',
          'patientId',
          patientIds,
          [
            where('uploadMonth', '==', uploadMonthStr),
          ]
        );

        allOrders.forEach((order: any) => {
          const patientData = patientOrdersMap.get(order.patientId);
          if (patientData) {
            const existingOrder = patientData.orders[order.orderCode];
            if (
              !existingOrder ||
              new Date(order.changeDate) > new Date(existingOrder.changeDate!)
            ) {
              patientData.orders[order.orderCode] = order;
            }
          }
        });
      } catch (orderError) {
        console.warn('查詢藥囑資料時發生錯誤 (可能需要建立 Firestore 索引):', orderError);
      }
    }

    this.searchResult.set(
      Array.from(patientOrdersMap.values()).sort((a, b) =>
        String(a.bedNum).localeCompare(String(b.bedNum), undefined, {
          numeric: true,
        })
      )
    );
  }

  private async searchIndividualOrders(): Promise<void> {
    const term = this.individualSearchTerm().trim().toLowerCase();
    if (!term) {
      alert('請輸入姓名或病歷號');
      return;
    }

    const opdPatients = this.patientStore.opdPatients();
    const foundPatient = opdPatients.find(
      (p: any) =>
        p.name.toLowerCase().includes(term) ||
        p.medicalRecordNumber.includes(term)
    );

    if (!foundPatient) {
      this.searchResult.set([]);
      return;
    }

    const year = this.individualSearchYear();

    const allYearlyOrders = await this.ordersApi.fetchAll([
      where('patientId', '==', foundPatient.id),
      where('uploadMonth', '>=', `${year}-01`),
      where('uploadMonth', '<=', `${year}-12`),
    ]);

    const monthlyOrdersMap = new Map<string, IndividualSearchResult>();
    for (let i = 1; i <= 12; i++) {
      const monthKey = `${year}-${String(i).padStart(2, '0')}`;
      monthlyOrdersMap.set(monthKey, { month: monthKey, orders: {} });
    }

    allYearlyOrders.forEach((order: any) => {
      const monthKey = order.uploadMonth;

      const monthData = monthlyOrdersMap.get(monthKey);
      if (monthData) {
        const existingOrder = monthData.orders[order.orderCode];
        if (
          !existingOrder ||
          new Date(order.changeDate) > new Date(existingOrder.changeDate!)
        ) {
          monthData.orders[order.orderCode] = order;
        }
      }
    });

    this.searchResult.set(
      Array.from(monthlyOrdersMap.values()).sort((a, b) =>
        b.month.localeCompare(a.month)
      )
    );
  }

  changeYear(offset: number): void {
    this.individualSearchYear.update((y) => y + offset);
    if (this.individualSearchTerm().trim()) {
      this.handleSearch();
    }
  }

  // --- Excel Export ---
  exportOrdersToExcel(): void {
    const results = this.searchResult();
    if (!results || results.length === 0) {
      alert('沒有可匯出的資料。');
      return;
    }

    try {
      let title = '藥囑查詢結果';
      let headers: string[] = [];
      let dataRows: string[][] = [];
      let sheetData: string[][] = [];
      let fileName = '藥囑查詢結果.xlsx';

      const medHeaders = this.allMedications().map((med) => med.tradeName);

      if (this.searchType() === 'group') {
        const { freq, shift, month } = this.groupSearchParams;
        const shiftNameMap: Record<string, string> = {
          early: '早班',
          noon: '午班',
          late: '晚班',
        };
        const shiftName = shiftNameMap[shift] || shift;

        title = `藥囑查詢結果：群組 ${freq} / ${shiftName} / ${month}`;
        fileName = `藥囑查詢_群組_${freq}_${shiftName}_${month}.xlsx`;

        headers = ['頻率', '班別', '床號', '姓名', ...medHeaders];
        dataRows = (results as GroupSearchResult[]).map((patientRow) => {
          const row = [
            patientRow.freq,
            this.formatShift(patientRow.shiftIndex),
            patientRow.bedNum,
            patientRow.patientName,
          ];
          this.allMedications().forEach((med) => {
            const order = patientRow.orders[med.code];
            row.push(this.formatOrderCell(order));
          });
          return row;
        });
      } else {
        const patientName = this.individualSearchTerm().trim();
        const year = this.individualSearchYear();

        title = `藥囑查詢結果：個人 ${patientName} / ${year} 年`;
        fileName = `藥囑查詢_個人_${patientName}_${year}.xlsx`;

        headers = ['月份', ...medHeaders];
        dataRows = (results as IndividualSearchResult[]).map((monthRow) => {
          const row = [monthRow.month];
          this.allMedications().forEach((med) => {
            const order = monthRow.orders[med.code];
            row.push(this.formatOrderCell(order));
          });
          return row;
        });
      }

      sheetData = [[title], [], headers, ...dataRows];

      const ws = XLSX.utils.aoa_to_sheet(sheetData);

      if (!ws['!merges']) ws['!merges'] = [];
      ws['!merges'].push({
        s: { r: 0, c: 0 },
        e: { r: 0, c: headers.length - 1 },
      });

      const colWidths = headers.map((_h, index) => {
        if (index < 4 && this.searchType() === 'group') return { wch: 12 };
        if (index === 0 && this.searchType() === 'individual')
          return { wch: 15 };
        return { wch: 20 };
      });
      ws['!cols'] = colWidths;

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '藥囑查詢結果');

      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], {
        type: 'application/octet-stream',
      });

      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch (error) {
      console.error('匯出 Excel 失敗:', error);
      alert('匯出 Excel 時發生錯誤，請檢查主控台。');
    }
  }

  // --- Upload Tab Methods ---
  handleFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.selectedFile.set(input.files[0]);
      this.uploadResult.set(null);
    }
  }

  handleFileDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(false);
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.selectedFile.set(files[0]);
      this.uploadResult.set(null);
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(false);
  }

  private toBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () =>
        resolve(
          (reader.result as string).toString().replace(/^data:(.*,)?/, '')
        );
      reader.onerror = (error) => reject(error);
    });
  }

  async handleUpload(): Promise<void> {
    const file = this.selectedFile();
    if (!file) {
      alert('請先選擇一個檔案！');
      return;
    }
    this.isUploading.set(true);
    this.uploadResult.set(null);
    try {
      const fileContentBase64 = await this.toBase64(file);
      const processOrders = httpsCallable(
        this.firebaseService.functions,
        'processOrders'
      );
      const result = await processOrders({
        fileName: file.name,
        fileContent: fileContentBase64,
        targetMonth: this.uploadTargetMonth(),
      });
      this.uploadResult.set(result.data as UploadResult);

      const data = result.data as UploadResult;
      if (data && data.success && (data.processedCount ?? 0) > 0) {
        console.log('[OrdersComponent] 藥囑上傳成功，正在清除針劑快取...');
        this.medicationStore.clearCache();
      }
    } catch (error: any) {
      console.error('上傳處理失敗:', error);
      this.uploadResult.set({
        message: `上傳失敗: ${error.message}`,
        errorCount: 1,
        errors: [],
      });
    } finally {
      this.isUploading.set(false);
    }
  }
}
