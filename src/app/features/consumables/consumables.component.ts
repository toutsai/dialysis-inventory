import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FirebaseService } from '@services/firebase.service';
import { PatientStoreService } from '@services/patient-store.service';
import { documentId } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import * as XLSX from 'xlsx';
import { queryWithInChunks } from '@/utils/firestoreUtils';
import { formatDateToYYYYMM } from '@/utils/dateUtils';

const SHIFT_MAP: Record<string, number> = { early: 0, noon: 1, late: 2 };
const SHIFT_INDEX_MAP: Record<number, string> = { 0: '早班', 1: '午班', 2: '晚班' };

@Component({
  selector: 'app-consumables',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './consumables.component.html',
  styleUrl: './consumables.component.css',
})
export class ConsumablesComponent implements OnInit {
  private firebaseService = inject(FirebaseService);
  private patientStore = inject(PatientStoreService);

  // --- Tab state ---
  activeTab = signal<string>('query');

  // --- Query tab state ---
  isLoading = signal(false);
  searchPerformed = signal(false);
  rawConsumablesData = signal<any[]>([]);
  processedData = signal<any[]>([]);

  groupSearchParams = {
    freq: 'other',
    shift: 'early',
    month: formatDateToYYYYMM(new Date()),
  };

  dynamicHeaders = signal<{
    artificialKidney: string[];
    dialysateCa: string[];
    bicarbonateType: string[];
  }>({
    artificialKidney: [],
    dialysateCa: [],
    bicarbonateType: [],
  });

  readonly flattenedHeaders = computed(() => {
    const h = this.dynamicHeaders();
    return [
      ...h.artificialKidney,
      ...h.dialysateCa,
      ...h.bicarbonateType,
    ];
  });

  // --- Upload tab state ---
  selectedFile = signal<File | null>(null);
  isUploading = signal(false);
  uploadResult = signal<{ message: string; errorCount: number } | null>(null);
  isDragOver = signal(false);

  ngOnInit(): void {
    this.patientStore.fetchPatientsIfNeeded();
  }

  formatShift(shiftIndex: number | undefined): string {
    if (shiftIndex === undefined || shiftIndex === null) return '-';
    return SHIFT_INDEX_MAP[shiftIndex] ?? '-';
  }

  async handleSearch(): Promise<void> {
    this.isLoading.set(true);
    this.searchPerformed.set(true);
    this.rawConsumablesData.set([]);
    this.processedData.set([]);
    this.dynamicHeaders.set({ artificialKidney: [], dialysateCa: [], bicarbonateType: [] });

    try {
      const shiftIndex = SHIFT_MAP[this.groupSearchParams.shift];
      const regularFreqs = ['一三五', '二四六'];

      const opdPatients = this.patientStore.opdPatients();
      const patientsInGroup = opdPatients.filter((p: any) => {
        const rule = p.scheduleRule;
        if (!rule) return false;
        const matchesShift = rule.shiftIndex === shiftIndex;
        if (!matchesShift) return false;
        if (this.groupSearchParams.freq === 'other') {
          return !regularFreqs.includes(rule.freq);
        } else {
          return rule.freq === this.groupSearchParams.freq;
        }
      });

      const allPatientIdsInGroup = patientsInGroup.map((p: any) => p.id);

      if (allPatientIdsInGroup.length === 0) {
        this.isLoading.set(false);
        return;
      }

      // Fetch raw consumables data
      const reportMonth = this.groupSearchParams.month;
      const reportIdsForMonth = allPatientIdsInGroup.map((id: string) => `${reportMonth}_${id}`);
      const monthlyReports: any[] = await queryWithInChunks(
        'consumables_reports',
        documentId() as any,
        reportIdsForMonth,
      );
      this.rawConsumablesData.set(monthlyReports);

      // Data preprocessing
      const reportsMap = new Map(monthlyReports.map((r: any) => [r.patientId, r]));
      const headers: Record<string, Set<string>> = {
        artificialKidney: new Set(),
        dialysateCa: new Set(),
        bicarbonateType: new Set(),
      };
      for (const report of reportsMap.values()) {
        const data = report.data || {};
        for (const category in headers) {
          if (data[category] && Array.isArray(data[category])) {
            data[category].forEach((item: any) => headers[category].add(item.item));
          }
        }
      }
      this.dynamicHeaders.set({
        artificialKidney: [...headers.artificialKidney].sort(),
        dialysateCa: [...headers.dialysateCa].sort(),
        bicarbonateType: [...headers.bicarbonateType].sort(),
      });

      // Combine data
      const patientMap = this.patientStore.patientMap();
      const currentFlattenedHeaders = this.flattenedHeaders();
      const currentDynamicHeaders = this.dynamicHeaders();

      const processed = allPatientIdsInGroup
        .map((patientId: string) => {
          const patient = patientMap.get(patientId);
          const report = reportsMap.get(patientId);
          const consumables = report?.data || {};

          const consumableCounts: Record<string, number> = {};
          for (const header of currentFlattenedHeaders) {
            for (const category in currentDynamicHeaders) {
              const catKey = category as keyof typeof currentDynamicHeaders;
              if (consumables[category] && Array.isArray(consumables[category])) {
                const foundItem = consumables[category].find((c: any) => c.item === header);
                if (foundItem) {
                  consumableCounts[header] = foundItem.count;
                  break;
                }
              }
            }
          }

          return {
            patientId,
            patientName: patient?.name || report?.patientName || '未知病人',
            medicalRecordNumber: patient?.medicalRecordNumber || report?.medicalRecordNumber || 'N/A',
            bedNum: patient?.scheduleRule?.bedNum || 'N/A',
            freq: patient?.scheduleRule?.freq || 'N/A',
            shiftIndex: patient?.scheduleRule?.shiftIndex,
            consumableCounts,
          };
        })
        .sort((a: any, b: any) =>
          String(a.bedNum).localeCompare(String(b.bedNum), undefined, { numeric: true }),
        );

      this.processedData.set(processed);
    } catch (error) {
      console.error('查詢耗材資料失敗:', error);
      alert('查詢耗材資料時發生錯誤，請檢查主控台。');
    } finally {
      this.isLoading.set(false);
    }
  }

  exportConsumablesToExcel(): void {
    const data = this.processedData();
    if (!data || data.length === 0) {
      alert('沒有可匯出的資料。');
      return;
    }

    try {
      const { freq, shift, month } = this.groupSearchParams;
      const shiftNameMap: Record<string, string> = { early: '早班', noon: '午班', late: '晚班' };
      const shiftName = shiftNameMap[shift] || shift;
      const title = `每月耗材總表: ${freq} / ${shiftName} / ${month}`;

      // Step 1: Build complex headers with freq and shift columns
      const headerRow1: string[] = ['頻率', '班別', '床號', '病歷號', '姓名'];
      const headerRow2: string[] = ['', '', '', '', ''];

      const dh = this.dynamicHeaders();
      const categoryNames: Record<string, string> = {
        artificialKidney: '人工腎臟',
        dialysateCa: '透析藥水CA',
        bicarbonateType: 'B液種類',
      };

      for (const category in dh) {
        const items = dh[category as keyof typeof dh];
        if (items && Array.isArray(items) && items.length > 0) {
          const categoryName = categoryNames[category] || category;
          headerRow1.push(categoryName);
          for (let i = 1; i < items.length; i++) {
            headerRow1.push('');
          }
          items.forEach((item: string) => headerRow2.push(String(item || '')));
        }
      }

      // Step 2: Build data rows
      const flatHeaders = this.flattenedHeaders();
      const dataRows = data.map((row: any) => {
        const dataRow: (string | number)[] = [
          row.freq || '-',
          this.formatShift(row.shiftIndex),
          row.bedNum || '',
          row.medicalRecordNumber || '',
          row.patientName || '',
        ];
        flatHeaders.forEach((header: string) => {
          const count = row.consumableCounts[header];
          dataRow.push(count !== undefined && count !== null ? count : '');
        });
        return dataRow;
      });

      // Step 3: Combine all data
      const sheetData = [[title], [], headerRow1, headerRow2, ...dataRows];
      const ws = XLSX.utils.aoa_to_sheet(sheetData, { skipHidden: true } as any);

      // Step 4: Set merged cells
      ws['!merges'] = [];
      const totalColumnCount = flatHeaders.length + 5;
      ws['!merges'].push({ s: { r: 0, c: 0 }, e: { r: 0, c: totalColumnCount - 1 } });

      // Merge 5 fixed column headers
      for (let i = 0; i < 5; i++) {
        ws['!merges'].push({ s: { r: 2, c: i }, e: { r: 3, c: i } });
      }

      // Dynamically merge category headers
      let currentCol = 5;
      for (const category in dh) {
        const items = dh[category as keyof typeof dh];
        if (items && Array.isArray(items) && items.length > 0) {
          ws['!merges'].push({
            s: { r: 2, c: currentCol },
            e: { r: 2, c: currentCol + items.length - 1 },
          });
          currentCol += items.length;
        }
      }

      // Step 5: Trigger browser download
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '耗材總表');

      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/octet-stream' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const fileName = `耗材總表_${freq}_${shiftName}_${month}.xlsx`;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch (error) {
      console.error('匯出 Excel 失敗:', error);
      alert('匯出 Excel 時發生嚴重錯誤，請檢查主控台以獲取詳細資訊。');
    }
  }

  handleFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
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
      reader.onload = () => resolve((reader.result as string).replace(/^data:(.*,)?/, ''));
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
      const processConsumables = httpsCallable(this.firebaseService.functions, 'processConsumables');
      const result = await processConsumables({
        fileName: file.name,
        fileContent: fileContentBase64,
      });
      this.uploadResult.set(result.data as { message: string; errorCount: number });
    } catch (error: any) {
      console.error('上傳處理失敗:', error);
      this.uploadResult.set({ message: `上傳失敗: ${error.message}`, errorCount: 1 });
    } finally {
      this.isUploading.set(false);
    }
  }
}
