import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FirebaseService } from '@services/firebase.service';
import { AuthService } from '@services/auth.service';
import { DailyConsumptionService } from '@services/daily-consumption.service';
import { AlertDialogComponent } from '@app/components/dialogs/alert-dialog/alert-dialog.component';
import {
  collection, query, where, orderBy, getDocs, addDoc, updateDoc, deleteDoc,
  doc, Timestamp, setDoc, getDoc,
} from 'firebase/firestore';
import * as XLSX from 'xlsx';

const CATEGORY_NAMES: Record<string, string> = {
  artificialKidney: '人工腎臟',
  dialysateCa: '透析藥水CA',
  bicarbonateType: 'B液種類',
};

const DEFAULT_ITEMS: Record<string, string[]> = {
  artificialKidney: ['15S', '17UX', '25H', '34', 'APS21S', 'BG1.8', 'CAT/2000', 'FX80', 'HI:23'],
  dialysateCa: ['2.5', '3.0', '3.5'],
  bicarbonateType: ['0_袋裝Bicarbonate 500mg', '1_瓶裝Bicarbonate 500mg', '2_Hemodialysis 5L B液'],
};

@Component({
  selector: 'app-inventory',
  standalone: true,
  imports: [CommonModule, FormsModule, AlertDialogComponent],
  templateUrl: './inventory.component.html',
  styleUrl: './inventory.component.css',
})
export class InventoryComponent implements OnInit {
  private readonly firebaseService = inject(FirebaseService);
  protected readonly authService = inject(AuthService);
  private readonly dailyConsumption = inject(DailyConsumptionService);

  readonly CATEGORY_NAMES = CATEGORY_NAMES;
  readonly categoryKeys = Object.keys(CATEGORY_NAMES);

  activeTab = signal('dashboard');

  // ==================== Dashboard ====================
  dashboardLoading = signal(false);
  dashboardLoaded = signal(false);
  dashboardItems = signal<{ category: string; itemName: string; estimatedStock: number; safeLevel: number; autoSafeLevel: number; dailyUsage: number; todayConsumption: number; remainingAfterToday: number; status: 'safe' | 'warning' | 'danger' | 'critical' }[]>([]);
  dashboardLastCountDate = signal('');
  yesterdayConsumption = signal<Record<string, Record<string, number>>>({});

  // Alert dialog
  isAlertDialogVisible = signal(false);
  alertDialogTitle = signal('');
  alertDialogMessage = signal('');
  alertDialogShowCancel = signal(false);
  private alertDialogOnConfirm: (() => void) | null = null;
  private alertDialogOnCancel: (() => void) | null = null;

  // ==================== Tab 0: 品項設定 ====================
  inventoryItems = signal<any[]>([]);
  filteredInventoryItems = signal<any[]>([]);
  itemsLoading = signal(false);
  itemFilter = { category: '', search: '' };
  showItemModal = signal(false);
  editingItem = signal<any>(null);
  itemForm = {
    category: '',
    name: '',
    unitsPerBox: null as number | null,
    safeInventoryLevel: 0 as number,
    hospitalCode: '',
    brand: '',
    vendorPhone: '',
  };

  get isItemFormValid(): boolean {
    return !!(this.itemForm.category && this.itemForm.name);
  }

  // ==================== Tab 1: 進貨紀錄 ====================
  purchases = signal<any[]>([]);
  purchaseLoading = signal(false);
  purchaseFilter = {
    month: new Date().toISOString().slice(0, 7),
    category: '',
  };
  showPurchaseModal = signal(false);
  showPurchaseInlineAdd = signal(false);
  editingPurchase = signal<any>(null);
  purchaseForm = {
    date: '',
    category: '',
    item: '',
    boxQuantity: 1,
  };

  get isPurchaseFormValid(): boolean {
    return !!(
      this.purchaseForm.date &&
      this.purchaseForm.category &&
      this.purchaseForm.item &&
      this.purchaseForm.boxQuantity > 0
    );
  }

  // ==================== Tab 2: 消耗紀錄 ====================
  selectedFile = signal<File | null>(null);
  isUploading = signal(false);
  uploadResult = signal<any>(null);
  isDragOver = signal(false);

  summaryMonth = new Date().toISOString().slice(0, 7);
  summaryLoading = signal(false);
  summaryLoaded = signal(false);
  monthlySummaryData: Record<string, Record<string, number>> = {
    artificialKidney: {},
    dialysateCa: {},
    bicarbonateType: {},
  };

  // ==================== Tab 3: 每月盤點 ====================
  monthlyLoading = signal(false);
  monthlyCalculated = signal(false);
  monthlyFilter: { countDate: string; startDate: string; endDate: string };
  monthlyInventory: Record<string, Record<string, any>> = {
    artificialKidney: {},
    dialysateCa: {},
    bicarbonateType: {},
  };

  // ==================== Tab 4: 每週訂單 ====================
  weeklyLoading = signal(false);
  weeklyDataLoaded = signal(false);
  weeklyFilter: { countDate: string; week: string };
  weeklyCount: Record<string, Record<string, number>> = {
    artificialKidney: {},
    dialysateCa: {},
    bicarbonateType: {},
  };
  weeklyCountBoxes: Record<string, Record<string, number>> = {
    artificialKidney: {},
    dialysateCa: {},
    bicarbonateType: {},
  };
  monthlyConsumptionForWeekly: Record<string, Record<string, number>> = {
    artificialKidney: {},
    dialysateCa: {},
    bicarbonateType: {},
  };
  weeklyPendingPurchases: Record<string, Record<string, number>> = {
    artificialKidney: {},
    dialysateCa: {},
    bicarbonateType: {},
  };

  // Order preview modal
  showOrderPreview = signal(false);
  orderDate = '';
  orderPreviewDates: string[] = []; // 6 dates: Mon-Sat
  orderPreviewDayLabels: string[] = [];
  orderPreviewItems: { category: string; item: string; label: string; hospitalCode: string }[] = [];
  orderPreviewGrid: Record<string, number[]> = {}; // key = "category|item", value = [mon,tue,wed,thu,fri,sat]

  get hasOrderData(): boolean {
    return Object.keys(this.weeklyCount).some(
      (category) => Object.keys(this.weeklyCount[category]).length > 0
    );
  }

  knownItems: Record<string, string[]> = {
    artificialKidney: [],
    dialysateCa: [],
    bicarbonateType: [],
  };

  constructor() {
    const defaults = this.getDefaultMonthlyDates();
    this.monthlyFilter = {
      countDate: defaults.countDate,
      startDate: defaults.firstDay,
      endDate: defaults.lastDay,
    };
    this.weeklyFilter = {
      countDate: this.getDefaultCountDate(),
      week: this.getISOWeek(new Date()),
    };
  }

  async ngOnInit(): Promise<void> {
    await this.initializeDefaultItems();
    await this.fetchInventoryItems();
    await this.fetchPurchases();
    await this.loadKnownItems();
    this.loadDashboard();
  }

  // ==================== Tab 0 Methods ====================

  async fetchInventoryItems(): Promise<void> {
    this.itemsLoading.set(true);
    try {
      const db = this.firebaseService.db;
      const q = query(collection(db, 'inventory_items'), orderBy('category'), orderBy('name'));
      const snapshot = await getDocs(q);
      let results = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

      if (this.itemFilter.category) {
        results = results.filter((item: any) => item.category === this.itemFilter.category);
      }

      this.inventoryItems.set(results);
      this.filteredInventoryItems.set(results);

      results.forEach((item: any) => {
        if (!this.knownItems[item.category].includes(item.name)) {
          this.knownItems[item.category].push(item.name);
        }
      });
    } catch (error) {
      console.error('載入品項設定失敗:', error);
      this.useDefaultItemsAsFallback();
    } finally {
      this.itemsLoading.set(false);
    }
  }

  private useDefaultItemsAsFallback(): void {
    const fallbackItems: any[] = [];
    let id = 1;
    for (const [category, items] of Object.entries(DEFAULT_ITEMS)) {
      for (const itemName of items) {
        fallbackItems.push({
          id: `default-${id++}`,
          category,
          name: itemName,
          unitsPerBox: null,
          safeInventoryLevel: 0,
          hospitalCode: null,
          vendorPhone: null,
          createdBy: '系統預設',
        });
        if (!this.knownItems[category].includes(itemName)) {
          this.knownItems[category].push(itemName);
        }
      }
    }
    this.inventoryItems.set(fallbackItems);
    this.filteredInventoryItems.set(fallbackItems);
  }

  filterItems(): void {
    const search = this.itemFilter.search.toLowerCase();
    if (!search) {
      this.filteredInventoryItems.set(this.inventoryItems());
    } else {
      this.filteredInventoryItems.set(
        this.inventoryItems().filter(
          (item: any) =>
            item.name.toLowerCase().includes(search) ||
            (item.hospitalCode && item.hospitalCode.toLowerCase().includes(search))
        )
      );
    }
  }

  openItemModal(item: any = null): void {
    if (item) {
      this.editingItem.set(item);
      this.itemForm.category = item.category;
      this.itemForm.name = item.name;
      this.itemForm.unitsPerBox = item.unitsPerBox || null;
      this.itemForm.safeInventoryLevel = item.safeInventoryLevel || 0;
      this.itemForm.hospitalCode = item.hospitalCode || '';
      this.itemForm.brand = item.brand || '';
      this.itemForm.vendorPhone = item.vendorPhone || '';
    } else {
      this.editingItem.set(null);
      this.itemForm.category = '';
      this.itemForm.name = '';
      this.itemForm.unitsPerBox = null;
      this.itemForm.safeInventoryLevel = 0;
      this.itemForm.hospitalCode = '';
      this.itemForm.brand = '';
      this.itemForm.vendorPhone = '';
    }
    this.showItemModal.set(true);
  }

  closeItemModal(): void {
    this.showItemModal.set(false);
    this.editingItem.set(null);
  }

  async saveInventoryItem(): Promise<void> {
    if (!this.isItemFormValid) return;

    try {
      const db = this.firebaseService.db;
      const currentUser = this.authService.currentUser();
      const data: any = {
        category: this.itemForm.category,
        name: this.itemForm.name,
        unitsPerBox: this.itemForm.unitsPerBox || null,
        safeInventoryLevel: this.itemForm.safeInventoryLevel || 0,
        hospitalCode: this.itemForm.hospitalCode || null,
        brand: this.itemForm.brand || null,
        vendorPhone: this.itemForm.vendorPhone || null,
        updatedAt: Timestamp.now(),
        updatedBy: currentUser?.name || '未知',
      };

      const editing = this.editingItem();
      if (editing) {
        await updateDoc(doc(db, 'inventory_items', editing.id), data);
      } else {
        data.createdAt = Timestamp.now();
        data.createdBy = currentUser?.name || '未知';
        await addDoc(collection(db, 'inventory_items'), data);
      }

      if (!this.knownItems[this.itemForm.category].includes(this.itemForm.name)) {
        this.knownItems[this.itemForm.category].push(this.itemForm.name);
      }

      this.closeItemModal();
      await this.fetchInventoryItems();
      this.showAlert('操作成功', editing ? '更新成功' : '新增成功');
    } catch (error: any) {
      console.error('儲存品項失敗:', error);
      this.showAlert('儲存失敗', error.message);
    }
  }

  async deleteInventoryItem(id: string): Promise<void> {
    if (!confirm('確定要刪除此品項嗎？此操作不會影響已有的進貨和消耗紀錄。')) return;

    try {
      const db = this.firebaseService.db;
      await deleteDoc(doc(db, 'inventory_items', id));
      await this.fetchInventoryItems();
      this.showAlert('操作成功', '刪除成功');
    } catch (error: any) {
      console.error('刪除品項失敗:', error);
      this.showAlert('刪除失敗', error.message);
    }
  }

  private async initializeDefaultItems(): Promise<void> {
    try {
      const db = this.firebaseService.db;
      const snapshot = await getDocs(collection(db, 'inventory_items'));
      if (snapshot.docs.length > 0) {
        console.log('品項已存在，跳過初始化');
        return;
      }

      console.log('初始化預設品項...');
      const batch: Promise<any>[] = [];

      for (const [category, items] of Object.entries(DEFAULT_ITEMS)) {
        for (const itemName of items) {
          batch.push(
            addDoc(collection(db, 'inventory_items'), {
              category,
              name: itemName,
              unitsPerBox: null,
              safeInventoryLevel: 0,
              hospitalCode: null,
              vendorPhone: null,
              createdAt: Timestamp.now(),
              createdBy: '系統預設',
              updatedAt: Timestamp.now(),
              updatedBy: '系統預設',
            })
          );
        }
      }

      await Promise.all(batch);
      console.log('預設品項初始化完成');
    } catch (error) {
      console.error('初始化預設品項失敗（可能是權限問題，將使用備援品項）:', error);
      for (const [category, items] of Object.entries(DEFAULT_ITEMS)) {
        items.forEach((itemName) => {
          if (!this.knownItems[category].includes(itemName)) {
            this.knownItems[category].push(itemName);
          }
        });
      }
    }
  }

  // ==================== Tab 1 Methods ====================

  getUnitsPerBox(category: string, itemName: string): number {
    const item = this.inventoryItems().find(
      (i: any) => i.category === category && i.name === itemName
    );
    return item?.unitsPerBox || 1;
  }

  calculateUnits(category: string, itemName: string, boxQty: number): number {
    return boxQty * this.getUnitsPerBox(category, itemName);
  }

  calculateBoxes(category: string, itemName: string, units: number): string | number {
    const unitsPerBox = this.getUnitsPerBox(category, itemName);
    if (unitsPerBox <= 1) return units;
    return (units / unitsPerBox).toFixed(1);
  }

  calculateBoxesRounded(category: string, itemName: string, units: number): number {
    const unitsPerBox = this.getUnitsPerBox(category, itemName);
    if (unitsPerBox <= 1) return units;
    return Math.round(units / unitsPerBox);
  }

  async fetchPurchases(): Promise<void> {
    this.purchaseLoading.set(true);
    try {
      const db = this.firebaseService.db;
      const startDate = new Date(`${this.purchaseFilter.month}-01`);
      const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0, 23, 59, 59);

      const q = query(
        collection(db, 'inventory_purchases'),
        where('date', '>=', Timestamp.fromDate(startDate)),
        where('date', '<=', Timestamp.fromDate(endDate)),
        orderBy('date', 'desc')
      );

      const snapshot = await getDocs(q);
      let results = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

      if (this.purchaseFilter.category) {
        results = results.filter((item: any) => item.category === this.purchaseFilter.category);
      }

      this.purchases.set(results);

      results.forEach((p: any) => {
        if (!this.knownItems[p.category].includes(p.item)) {
          this.knownItems[p.category].push(p.item);
        }
      });
    } catch (error) {
      console.error('載入進貨紀錄失敗:', error);
      this.showAlert('載入失敗', '載入進貨紀錄失敗');
    } finally {
      this.purchaseLoading.set(false);
    }
  }

  openPurchaseModal(item: any = null): void {
    if (item) {
      this.editingPurchase.set(item);
      this.purchaseForm.date = this.formatDateTimeForInput(item.date);
      this.purchaseForm.category = item.category;
      this.purchaseForm.item = item.item;
      this.purchaseForm.boxQuantity = item.boxQuantity || 1;
    } else {
      this.editingPurchase.set(null);
      this.purchaseForm.date = this.getNowLocalDatetime();
      this.purchaseForm.category = '';
      this.purchaseForm.item = '';
      this.purchaseForm.boxQuantity = 1;
    }
    this.showPurchaseModal.set(true);
  }

  closePurchaseModal(): void {
    this.showPurchaseModal.set(false);
    this.editingPurchase.set(null);
  }

  async savePurchase(): Promise<void> {
    if (!this.isPurchaseFormValid) return;

    try {
      const db = this.firebaseService.db;
      const currentUser = this.authService.currentUser();
      const unitsPerBox = this.getUnitsPerBox(this.purchaseForm.category, this.purchaseForm.item);
      const quantity = this.purchaseForm.boxQuantity * unitsPerBox;

      const data: any = {
        date: Timestamp.fromDate(new Date(this.purchaseForm.date)),
        category: this.purchaseForm.category,
        item: this.purchaseForm.item,
        boxQuantity: this.purchaseForm.boxQuantity,
        quantity,
        unitsPerBox,
        createdBy: currentUser?.name || '未知',
        updatedAt: Timestamp.now(),
      };

      const editing = this.editingPurchase();
      if (editing) {
        await updateDoc(doc(db, 'inventory_purchases', editing.id), data);
      } else {
        data.createdAt = Timestamp.now();
        await addDoc(collection(db, 'inventory_purchases'), data);
      }

      if (!this.knownItems[this.purchaseForm.category].includes(this.purchaseForm.item)) {
        this.knownItems[this.purchaseForm.category].push(this.purchaseForm.item);
      }

      this.closePurchaseModal();
      await this.fetchPurchases();
      this.showAlert('操作成功', editing ? '更新成功' : '新增成功');
    } catch (error: any) {
      console.error('儲存進貨紀錄失敗:', error);
      this.showAlert('儲存失敗', error.message);
    }
  }

  async deletePurchase(id: string): Promise<void> {
    if (!confirm('確定要刪除此筆進貨紀錄嗎？')) return;

    try {
      const db = this.firebaseService.db;
      await deleteDoc(doc(db, 'inventory_purchases', id));
      await this.fetchPurchases();
      this.showAlert('操作成功', '刪除成功');
    } catch (error: any) {
      console.error('刪除進貨紀錄失敗:', error);
      this.showAlert('刪除失敗', error.message);
    }
  }

  async saveInlinePurchase(): Promise<void> {
    if (!this.isPurchaseFormValid) return;
    try {
      const db = this.firebaseService.db;
      const currentUser = this.authService.currentUser();
      const unitsPerBox = this.getUnitsPerBox(this.purchaseForm.category, this.purchaseForm.item);
      const quantity = this.purchaseForm.boxQuantity * unitsPerBox;

      await addDoc(collection(db, 'inventory_purchases'), {
        date: Timestamp.fromDate(new Date(this.purchaseForm.date)),
        category: this.purchaseForm.category,
        item: this.purchaseForm.item,
        boxQuantity: this.purchaseForm.boxQuantity,
        quantity,
        createdBy: currentUser?.name || '未知',
        createdAt: Timestamp.now(),
      });

      this.purchaseForm.category = '';
      this.purchaseForm.item = '';
      this.purchaseForm.boxQuantity = 1;
      this.showPurchaseInlineAdd.set(false);
      await this.fetchPurchases();
      this.showAlert('操作成功', '新增成功');
    } catch (error: any) {
      this.showAlert('儲存失敗', error.message);
    }
  }

  toggleInlineAdd(): void {
    this.showPurchaseInlineAdd.update((v) => !v);
    if (this.showPurchaseInlineAdd()) {
      this.purchaseForm.date = this.getNowLocalDatetime();
      this.purchaseForm.category = '';
      this.purchaseForm.item = '';
      this.purchaseForm.boxQuantity = 1;
    }
  }

  getItemSuggestions(category: string): string[] {
    return category ? this.knownItems[category] || [] : [];
  }

  // ==================== Tab 2 Methods ====================

  onFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.selectedFile.set(input.files[0]);
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

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(false);
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.selectedFile.set(files[0]);
      this.uploadResult.set(null);
    }
  }

  async handleUpload(): Promise<void> {
    const file = this.selectedFile();
    if (!file) {
      this.showAlert('提示', '請先選擇一個檔案！');
      return;
    }
    this.isUploading.set(true);
    this.uploadResult.set(null);
    try {
      const currentUser = this.authService.currentUser();
      const result = await this.dailyConsumption.parseExcelAndSave(
        file,
        currentUser?.name || '未知',
      );
      this.uploadResult.set(result);
    } catch (error: any) {
      console.error('上傳處理失敗:', error);
      this.uploadResult.set({ message: `上傳失敗: ${error.message}`, errorCount: 1 });
    } finally {
      this.isUploading.set(false);
    }
  }

  // ==================== Dashboard ====================

  async loadDashboard(): Promise<void> {
    this.dashboardLoading.set(true);
    this.dashboardLoaded.set(false);
    try {
      const db = this.firebaseService.db;

      // 1. Find the latest inventory_counts document
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const prevMonth = now.getMonth() === 0
        ? `${now.getFullYear() - 1}-12`
        : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, '0')}`;

      let lastCountDoc = await getDoc(doc(db, 'inventory_counts', currentMonth));
      let countDateStr = currentMonth;
      if (!lastCountDoc.exists()) {
        lastCountDoc = await getDoc(doc(db, 'inventory_counts', prevMonth));
        countDateStr = prevMonth;
      }

      const baseCounts: Record<string, Record<string, number>> = lastCountDoc.exists()
        ? (lastCountDoc.data() as any).counts || {}
        : {};
      const countDate = lastCountDoc.exists()
        ? (lastCountDoc.data() as any).countDate || `${countDateStr}-01`
        : '';
      this.dashboardLastCountDate.set(countDate);

      // 2. Sum purchases since the count date
      const purchases: Record<string, Record<string, number>> = {};
      if (countDate) {
        const startTs = Timestamp.fromDate(new Date(countDate + 'T00:00:00'));
        const purchaseQuery = query(
          collection(db, 'inventory_purchases'),
          where('date', '>=', startTs),
        );
        const pSnap = await getDocs(purchaseQuery);
        pSnap.docs.forEach((d) => {
          const p = d.data() as any;
          if (!purchases[p.category]) purchases[p.category] = {};
          purchases[p.category][p.item] = (purchases[p.category][p.item] || 0) + p.quantity;
        });
      }

      // 3. Consumption since count date
      const todayStr = now.toISOString().split('T')[0];
      let consumption: Record<string, Record<string, number>> = {};
      if (countDate && countDate < todayStr) {
        const result = await this.dailyConsumption.getConsumptionByRange(countDate, todayStr);
        consumption = result.grouped;
      }

      // 4. Build safety level map from inventory_items
      const safetyMap = new Map<string, number>();
      const items = this.inventoryItems();
      if (items.length === 0) {
        await this.fetchInventoryItems();
      }
      for (const item of this.inventoryItems()) {
        safetyMap.set(`${item.category}:${item.name}`, item.safeInventoryLevel || 0);
      }

      // 5. Calculate last week's consumption (上週一~上週六, 6天)
      const lastWeekConsumption: Record<string, Record<string, number>> = {};
      const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
      const lastMonday = new Date(now);
      lastMonday.setDate(now.getDate() - dayOfWeek - 6); // Last Monday
      const lastSaturday = new Date(lastMonday);
      lastSaturday.setDate(lastMonday.getDate() + 5); // Last Saturday
      const lastMondayStr = lastMonday.toISOString().split('T')[0];
      const lastSaturdayStr = lastSaturday.toISOString().split('T')[0];

      try {
        const weekResult = await this.dailyConsumption.getConsumptionByRange(lastMondayStr, lastSaturdayStr);
        for (const cat of Object.keys(weekResult.grouped)) {
          lastWeekConsumption[cat] = { ...weekResult.grouped[cat] };
        }
      } catch (e) {
        console.warn('上週消耗載入失敗，將使用手動安全庫存:', e);
      }

      // 6. Load yesterday's actual consumption
      let yesterdayData: Record<string, Record<string, number>> = {};
      try {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];
        const yesterdayResult = await this.dailyConsumption.getDailyConsumption(yesterdayStr);
        if (yesterdayResult) {
          yesterdayData = yesterdayResult;
          this.yesterdayConsumption.set(yesterdayResult);
        }
      } catch (e) {
        console.warn('昨日消耗載入失敗:', e);
      }

      // 7. Merge all item keys
      const allKeys = new Set<string>();
      for (const cat of Object.keys(CATEGORY_NAMES)) {
        for (const item of Object.keys(baseCounts[cat] || {})) allKeys.add(`${cat}:${item}`);
        for (const item of Object.keys(purchases[cat] || {})) allKeys.add(`${cat}:${item}`);
        for (const item of Object.keys(consumption[cat] || {})) allKeys.add(`${cat}:${item}`);
        for (const item of Object.keys(lastWeekConsumption[cat] || {})) allKeys.add(`${cat}:${item}`);
      }

      // 8. Calculate estimated stock + 4-tier status per item
      const dashItems: typeof this.dashboardItems extends () => infer T ? T : never = [];
      allKeys.forEach((key) => {
        const [category, itemName] = key.split(':');
        const base = baseCounts[category]?.[itemName] || 0;
        const bought = purchases[category]?.[itemName] || 0;
        const consumed = consumption[category]?.[itemName] || 0;
        const estimatedStock = base + bought - consumed;

        // 上週消耗 → 日均用量 → 自動安全庫存
        const weeklyUsage = lastWeekConsumption[category]?.[itemName] || 0;
        const dailyUsage = weeklyUsage > 0 ? +(weeklyUsage / 6).toFixed(1) : 0;
        const manualSafeLevel = safetyMap.get(key) || 0;
        const autoSafeLevel = dailyUsage > 0 ? +(dailyUsage * 8).toFixed(0) : 0;
        const safeLevel = autoSafeLevel > 0 ? autoSafeLevel : manualSafeLevel;

        // 今日預估消耗
        const todayConsumption = yesterdayData[category]?.[itemName] || 0;
        const remainingAfterToday = estimatedStock - todayConsumption;

        // 4 階狀態判定
        let status: 'safe' | 'warning' | 'danger' | 'critical' = 'safe';
        if (dailyUsage > 0) {
          if (remainingAfterToday < 0) status = 'critical';
          else if (remainingAfterToday < dailyUsage) status = 'danger';
          else if (remainingAfterToday < dailyUsage * 2) status = 'warning';
        } else if (manualSafeLevel > 0) {
          // 沒有上週數據時，回退到手動安全庫存
          if (estimatedStock < 0) status = 'critical';
          else if (estimatedStock <= 0) status = 'danger';
          else if (estimatedStock <= manualSafeLevel) status = 'warning';
        }

        dashItems.push({ category, itemName, estimatedStock, safeLevel, autoSafeLevel, dailyUsage, todayConsumption, remainingAfterToday, status });
      });

      const statusOrder: Record<string, number> = { critical: 0, danger: 1, warning: 2, safe: 3 };
      dashItems.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

      this.dashboardItems.set(dashItems);
      this.dashboardLoaded.set(true);

    } catch (error: any) {
      console.error('Dashboard 載入失敗:', error);
    } finally {
      this.dashboardLoading.set(false);
    }
  }

  isConsumptionEmpty(data: Record<string, Record<string, number>>): boolean {
    return Object.values(data).every((cat) => Object.keys(cat).length === 0);
  }

  getDashboardItemsByCategory(category: string) {
    return this.dashboardItems().filter((i) => i.category === category);
  }

  showAlert(title: string, message: string): void {
    this.alertDialogTitle.set(title);
    this.alertDialogMessage.set(message);
    this.alertDialogShowCancel.set(false);
    this.alertDialogOnConfirm = null;
    this.alertDialogOnCancel = null;
    this.isAlertDialogVisible.set(true);
  }

  showConfirm(title: string, message: string, onConfirm: () => void, onCancel?: () => void): void {
    this.alertDialogTitle.set(title);
    this.alertDialogMessage.set(message);
    this.alertDialogShowCancel.set(true);
    this.alertDialogOnConfirm = onConfirm;
    this.alertDialogOnCancel = onCancel || null;
    this.isAlertDialogVisible.set(true);
  }

  onAlertConfirm(): void {
    this.isAlertDialogVisible.set(false);
    if (this.alertDialogOnConfirm) {
      this.alertDialogOnConfirm();
    }
  }

  onAlertCancel(): void {
    this.isAlertDialogVisible.set(false);
    if (this.alertDialogOnCancel) {
      this.alertDialogOnCancel();
    }
  }

  async loadMonthlySummary(): Promise<void> {
    this.summaryLoading.set(true);
    this.summaryLoaded.set(false);

    for (const category of Object.keys(this.monthlySummaryData)) {
      this.monthlySummaryData[category] = {};
    }

    try {
      const consumption = await this.getMonthlyConsumption(this.summaryMonth);
      for (const category of Object.keys(this.monthlySummaryData)) {
        this.monthlySummaryData[category] = consumption[category] || {};
      }
      this.summaryLoaded.set(true);
    } catch (error: any) {
      console.error('載入當月總量失敗:', error);
      this.showAlert('載入失敗', error.message);
    } finally {
      this.summaryLoading.set(false);
    }
  }

  getCategoryTotal(category: string): number {
    const data = this.monthlySummaryData[category] || {};
    return Object.values(data).reduce((sum, count) => sum + (count || 0), 0);
  }

  exportMonthlySummary(): void {
    const rows: any[][] = [['類別', '品項', '每箱數量', '當月消耗(個)', '當月消耗(箱)']];

    for (const category of Object.keys(CATEGORY_NAMES)) {
      const items = this.monthlySummaryData[category] || {};
      for (const [item, count] of Object.entries(items)) {
        rows.push([
          CATEGORY_NAMES[category],
          item,
          this.getUnitsPerBox(category, item),
          count,
          this.calculateBoxes(category, item, count),
        ]);
      }
    }

    rows.push([]);
    rows.push(['類別小計', '', '', '', '']);
    for (const category of Object.keys(CATEGORY_NAMES)) {
      rows.push([CATEGORY_NAMES[category], '合計', '', this.getCategoryTotal(category), '']);
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '當月消耗總量');

    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `當月消耗總量_${this.summaryMonth}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  getSummaryItemKeys(category: string): string[] {
    return Object.keys(this.monthlySummaryData[category] || {});
  }

  // ==================== Tab 3 Methods ====================

  private getDefaultMonthlyDates(): { firstDay: string; lastDay: string; countDate: string } {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const firstDay = new Date(year, month, 1).toISOString().slice(0, 10);
    const lastDay = new Date(year, month + 1, 0).toISOString().slice(0, 10);
    const countDate = today.toISOString().slice(0, 10);
    return { firstDay, lastDay, countDate };
  }

  async calculateMonthlyInventory(): Promise<void> {
    this.monthlyLoading.set(true);
    this.monthlyCalculated.set(false);

    for (const category of Object.keys(this.monthlyInventory)) {
      this.monthlyInventory[category] = {};
    }

    try {
      const db = this.firebaseService.db;
      const startDate = new Date(this.monthlyFilter.startDate);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(this.monthlyFilter.endDate);
      endDate.setHours(23, 59, 59, 999);

      const prevDate = new Date(startDate);
      prevDate.setDate(prevDate.getDate() - 1);
      const prevCountKey = prevDate.toISOString().slice(0, 7);

      const prevCountDoc = await getDoc(doc(db, 'inventory_counts', prevCountKey));
      const prevCounts = prevCountDoc.exists() ? (prevCountDoc.data() as any).counts || {} : {};

      const purchaseQuery = query(
        collection(db, 'inventory_purchases'),
        where('date', '>=', Timestamp.fromDate(startDate)),
        where('date', '<=', Timestamp.fromDate(endDate))
      );
      const purchaseSnapshot = await getDocs(purchaseQuery);
      const purchaseData: Record<string, Record<string, number>> = {};
      purchaseSnapshot.docs.forEach((docSnap) => {
        const p = docSnap.data() as any;
        if (!purchaseData[p.category]) purchaseData[p.category] = {};
        purchaseData[p.category][p.item] = (purchaseData[p.category][p.item] || 0) + p.quantity;
      });

      const consumptionData = await this.getConsumptionByDateRange(startDate, endDate);

      const allItems = new Set<string>();
      for (const category of Object.keys(CATEGORY_NAMES)) {
        const sources = [
          Object.keys(prevCounts[category] || {}),
          Object.keys(purchaseData[category] || {}),
          Object.keys(consumptionData[category] || {}),
          this.knownItems[category],
        ];
        sources.forEach((items) => items.forEach((item) => allItems.add(`${category}:${item}`)));
      }

      allItems.forEach((key) => {
        const [category, item] = key.split(':');
        const previousStock = prevCounts[category]?.[item] || 0;
        const purchased = purchaseData[category]?.[item] || 0;
        const consumed = consumptionData[category]?.[item] || 0;
        const currentStock = previousStock + purchased - consumed;

        if (!this.monthlyInventory[category]) this.monthlyInventory[category] = {};
        this.monthlyInventory[category][item] = {
          previousStock,
          purchased,
          consumed,
          currentStock,
          adjustment: 0,
        };
      });

      this.monthlyCalculated.set(true);
    } catch (error: any) {
      console.error('計算庫存失敗:', error);
      this.showAlert('計算失敗', error.message);
    } finally {
      this.monthlyLoading.set(false);
    }
  }

  monthlySavedInfo = signal<{ createdBy: string; createdAt: string } | null>(null);

  async loadSavedMonthlyCount(): Promise<void> {
    this.monthlyLoading.set(true);
    this.monthlyCalculated.set(false);
    this.monthlySavedInfo.set(null);

    for (const category of Object.keys(this.monthlyInventory)) {
      this.monthlyInventory[category] = {};
    }

    try {
      const db = this.firebaseService.db;
      const countKey = this.monthlyFilter.countDate.slice(0, 7);
      const countDoc = await getDoc(doc(db, 'inventory_counts', countKey));

      if (!countDoc.exists()) {
        this.showAlert('提示', `找不到 ${countKey} 的盤點紀錄。`);
        return;
      }

      const data = countDoc.data() as any;
      const counts = data.counts || {};

      // Restore filter dates from saved record
      if (data.countDate) this.monthlyFilter.countDate = data.countDate;
      if (data.startDate) this.monthlyFilter.startDate = data.startDate;
      if (data.endDate) this.monthlyFilter.endDate = data.endDate;

      // Populate monthlyInventory with saved counts
      for (const category of Object.keys(CATEGORY_NAMES)) {
        if (!this.monthlyInventory[category]) this.monthlyInventory[category] = {};
        for (const [item, qty] of Object.entries(counts[category] || {})) {
          this.monthlyInventory[category][item] = {
            previousStock: 0,
            purchased: 0,
            consumed: 0,
            currentStock: qty as number,
            adjustment: 0,
          };
        }
      }

      // Show saved info
      const createdAt = data.createdAt?.toDate
        ? data.createdAt.toDate().toLocaleString('zh-TW')
        : '未知';
      this.monthlySavedInfo.set({
        createdBy: data.createdBy || '未知',
        createdAt,
      });

      this.monthlyCalculated.set(true);
    } catch (error: any) {
      console.error('載入盤點紀錄失敗:', error);
      this.showAlert('載入失敗', error.message);
    } finally {
      this.monthlyLoading.set(false);
    }
  }

  private async getMonthlyConsumption(month: string): Promise<Record<string, Record<string, number>>> {
    return this.dailyConsumption.getMonthlyConsumption(month);
  }

  private async getConsumptionByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, Record<string, number>>> {
    const pad = (n: number) => String(n).padStart(2, '0');
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const result = await this.dailyConsumption.getConsumptionByRange(fmt(startDate), fmt(endDate));
    return result.grouped;
  }

  async saveMonthlyCount(): Promise<void> {
    if (!this.monthlyCalculated()) return;

    try {
      const db = this.firebaseService.db;
      const currentUser = this.authService.currentUser();
      const counts: Record<string, Record<string, number>> = {};

      for (const category of Object.keys(this.monthlyInventory)) {
        counts[category] = {};
        for (const [item, data] of Object.entries(this.monthlyInventory[category])) {
          counts[category][item] = data.currentStock + (data.adjustment || 0);
        }
      }

      const countKey = this.monthlyFilter.countDate.slice(0, 7);

      await setDoc(doc(db, 'inventory_counts', countKey), {
        type: 'monthly',
        countDate: this.monthlyFilter.countDate,
        startDate: this.monthlyFilter.startDate,
        endDate: this.monthlyFilter.endDate,
        counts,
        createdBy: currentUser?.name || '未知',
        createdAt: Timestamp.now(),
      });

      this.showAlert('操作成功', '盤點結果已儲存');
    } catch (error: any) {
      console.error('儲存盤點結果失敗:', error);
      this.showAlert('儲存失敗', error.message);
    }
  }

  getMonthlyInventoryEntries(category: string): { item: string; data: any }[] {
    const catData = this.monthlyInventory[category] || {};
    return Object.entries(catData).map(([item, data]) => ({ item, data }));
  }

  // ==================== Tab 4 Methods ====================

  private getDefaultCountDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private getISOWeek(date: Date): string {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  getItemsForCategory(category: string): string[] {
    return this.knownItems[category] || [];
  }

  calculateWeeklyUnits(category: string, item: string): number {
    const boxes = this.weeklyCountBoxes[category]?.[item] || 0;
    return boxes * this.getUnitsPerBox(category, item);
  }

  syncWeeklyCount(): void {
    for (const category of Object.keys(this.weeklyCountBoxes)) {
      for (const [item, boxes] of Object.entries(this.weeklyCountBoxes[category])) {
        const unitsPerBox = this.getUnitsPerBox(category, item);
        this.weeklyCount[category][item] = (boxes || 0) * unitsPerBox;
      }
    }
  }

  async loadWeeklyData(): Promise<void> {
    this.weeklyLoading.set(true);
    this.weeklyDataLoaded.set(false);

    for (const category of Object.keys(this.weeklyCount)) {
      this.weeklyCount[category] = {};
      this.weeklyCountBoxes[category] = {};
      this.monthlyConsumptionForWeekly[category] = {};
      this.weeklyPendingPurchases[category] = {};
    }

    try {
      const db = this.firebaseService.db;

      // Load saved weekly count if exists
      const weeklyCountDoc = await getDoc(doc(db, 'inventory_counts', this.weeklyFilter.week));
      if (weeklyCountDoc.exists()) {
        const docData = weeklyCountDoc.data() as any;
        const data = docData.counts || {};
        const boxData = docData.countBoxes || {};

        for (const category of Object.keys(this.weeklyCount)) {
          this.weeklyCount[category] = { ...data[category] };
          if (boxData[category]) {
            this.weeklyCountBoxes[category] = { ...boxData[category] };
          } else {
            for (const [item, units] of Object.entries(data[category] || {}) as [string, number][]) {
              const unitsPerBox = this.getUnitsPerBox(category, item);
              this.weeklyCountBoxes[category][item] = unitsPerBox > 1 ? Math.round(units / unitsPerBox) : units;
            }
          }
        }
      }

      // Use consumption engine for LAST week (Mon-Sat) to calculate daily average
      const { start: weekStart } = this.getWeekDateRange(this.weeklyFilter.week);
      // Last week = selected week - 7 days
      const lastMonday = new Date(weekStart);
      lastMonday.setDate(lastMonday.getDate() - 7);
      const lastSaturday = new Date(lastMonday);
      lastSaturday.setDate(lastMonday.getDate() + 5); // Mon to Sat = 6 days

      const pad = (n: number) => String(n).padStart(2, '0');
      const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const lastWeekStart = fmt(lastMonday);
      const lastWeekEnd = fmt(lastSaturday);

      const result = await this.dailyConsumption.getConsumptionByRange(lastWeekStart, lastWeekEnd);
      for (const category of Object.keys(this.monthlyConsumptionForWeekly)) {
        this.monthlyConsumptionForWeekly[category] = result.grouped[category] || {};
      }

      // Query pending purchases: after countDate to end of week (Saturday)
      const countDate = this.weeklyFilter.countDate;
      const countDateObj = new Date(countDate);
      const saturday = new Date(weekStart);
      saturday.setDate(saturday.getDate() + 5); // Saturday of selected week

      if (countDateObj < saturday) {
        const nextDay = new Date(countDateObj);
        nextDay.setDate(nextDay.getDate() + 1);
        const pendingQuery = query(
          collection(db, 'inventory_purchases'),
          where('date', '>=', Timestamp.fromDate(new Date(fmt(nextDay) + 'T00:00:00'))),
          where('date', '<=', Timestamp.fromDate(new Date(fmt(saturday) + 'T23:59:59')))
        );
        const pendingSnap = await getDocs(pendingQuery);
        pendingSnap.forEach((d) => {
          const p = d.data() as any;
          if (p.category && p.item && p.quantity) {
            if (!this.weeklyPendingPurchases[p.category]) {
              this.weeklyPendingPurchases[p.category] = {};
            }
            this.weeklyPendingPurchases[p.category][p.item] =
              (this.weeklyPendingPurchases[p.category][p.item] || 0) + p.quantity;
          }
        });
      }

      // Check delivery days (Mon=1, Wed=3) for missing purchase records
      await this.checkDeliveryDayPurchases(db, countDateObj, weekStart, fmt);

      // Ensure all known items have entries
      for (const category of Object.keys(this.knownItems)) {
        this.knownItems[category].forEach((item) => {
          if (this.weeklyCount[category][item] === undefined) {
            this.weeklyCount[category][item] = 0;
          }
          if (this.weeklyCountBoxes[category][item] === undefined) {
            this.weeklyCountBoxes[category][item] = 0;
          }
        });
      }

      this.weeklyDataLoaded.set(true);
    } catch (error: any) {
      console.error('載入週資料失敗:', error);
      this.showAlert('載入失敗', error.message);
    } finally {
      this.weeklyLoading.set(false);
    }
  }

  private async checkDeliveryDayPurchases(
    db: any,
    countDateObj: Date,
    weekStart: string,
    fmt: (d: Date) => string
  ): Promise<void> {
    const monday = new Date(weekStart);
    const wednesday = new Date(weekStart);
    wednesday.setDate(monday.getDate() + 2);
    const deliveryDays = [
      { date: monday, label: '週一' },
      { date: wednesday, label: '週三' },
    ];
    const dayNames = ['日', '一', '二', '三', '四', '五', '六'];

    const countDay = countDateObj.getTime();
    const missingBefore: string[] = [];
    let sameDayMissing: { date: Date; label: string } | null = null;

    for (const dd of deliveryDays) {
      const ddTime = dd.date.getTime();
      if (ddTime > countDay) continue; // Scenario C: after count date, handled by pending query

      // Check if there are any purchases on this delivery day
      const dayStart = new Date(fmt(dd.date) + 'T00:00:00');
      const dayEnd = new Date(fmt(dd.date) + 'T23:59:59');
      const dayQuery = query(
        collection(db, 'inventory_purchases'),
        where('date', '>=', Timestamp.fromDate(dayStart)),
        where('date', '<=', Timestamp.fromDate(dayEnd))
      );
      const daySnap = await getDocs(dayQuery);

      if (daySnap.empty) {
        if (ddTime === countDay) {
          // Scenario B: count date IS the delivery day
          sameDayMissing = dd;
        } else {
          // Scenario A: delivery day before count date
          missingBefore.push(dd.label);
        }
      }
    }

    // Show alerts after data is loaded
    if (missingBefore.length > 0) {
      this.showAlert('進貨提醒', `本周 ${missingBefore.join('、')} 無進貨紀錄，是否忘記輸入？`);
    }

    if (sameDayMissing) {
      const todayLabel = `週${dayNames[sameDayMissing.date.getDay()]}`;
      // Use setTimeout so it shows after the first alert (if any)
      const showSameDayAlert = () => {
        this.showConfirm(
          '進貨提醒',
          `今天（${todayLabel}）是進貨日但無進貨紀錄，是否現在輸入？`,
          () => { this.activeTab.set('purchase'); },
        );
      };
      if (missingBefore.length > 0) {
        setTimeout(showSameDayAlert, 300);
      } else {
        showSameDayAlert();
      }
    }
  }

  /**
   * Convert ISO week string (e.g. "2026-W12") to start/end date strings.
   */
  private getWeekDateRange(isoWeek: string): { start: string; end: string } {
    const [yearStr, weekStr] = isoWeek.split('-W');
    const year = parseInt(yearStr, 10);
    const week = parseInt(weekStr, 10);

    // ISO 8601: Week 1 contains Jan 4th. Monday is day 1.
    const jan4 = new Date(year, 0, 4);
    const dayOfWeek = jan4.getDay() || 7; // Mon=1..Sun=7
    const monday = new Date(jan4);
    monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const pad = (n: number) => String(n).padStart(2, '0');
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return { start: fmt(monday), end: fmt(sunday) };
  }

  async saveWeeklyCount(): Promise<void> {
    this.syncWeeklyCount();

    try {
      const db = this.firebaseService.db;
      const currentUser = this.authService.currentUser();

      await setDoc(doc(db, 'inventory_counts', this.weeklyFilter.week), {
        type: 'weekly',
        week: this.weeklyFilter.week,
        countDate: this.weeklyFilter.countDate,
        counts: {
          artificialKidney: { ...this.weeklyCount.artificialKidney },
          dialysateCa: { ...this.weeklyCount.dialysateCa },
          bicarbonateType: { ...this.weeklyCount.bicarbonateType },
        },
        countBoxes: {
          artificialKidney: { ...this.weeklyCountBoxes.artificialKidney },
          dialysateCa: { ...this.weeklyCountBoxes.dialysateCa },
          bicarbonateType: { ...this.weeklyCountBoxes.bicarbonateType },
        },
        createdBy: currentUser?.name || '未知',
        createdAt: Timestamp.now(),
      });
      this.showAlert('操作成功', '週盤點已儲存');
    } catch (error: any) {
      console.error('儲存週盤點失敗:', error);
      this.showAlert('儲存失敗', error.message);
    }
  }

  getWeeklyConsumption(category: string, item: string): number {
    return this.monthlyConsumptionForWeekly[category]?.[item] || 0;
  }

  getSafetyStock(category: string, item: string): number {
    // 上週消耗(週一~週六) / 6 = 日均消耗, * 9 = 安全庫存(9天)
    const lastWeekConsumption = this.getWeeklyConsumption(category, item);
    const dailyAvg = lastWeekConsumption / 6;
    return Math.ceil(dailyAvg * 9);
  }

  getDailyAvg(category: string, item: string): string {
    const lastWeekConsumption = this.getWeeklyConsumption(category, item);
    return (lastWeekConsumption / 6).toFixed(1);
  }

  getOrderQuantity(category: string, item: string): number {
    const safetyStock = this.getSafetyStock(category, item);
    const currentStock = this.weeklyCount[category]?.[item] || 0;
    const pending = this.weeklyPendingPurchases[category]?.[item] || 0;
    return Math.max(0, safetyStock - currentStock - pending);
  }

  getPendingPurchase(category: string, item: string): number {
    return this.weeklyPendingPurchases[category]?.[item] || 0;
  }

  exportWeeklyOrder(): void {
    this.openOrderPreview();
  }

  openOrderPreview(): void {
    const pad = (n: number) => String(n).padStart(2, '0');
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const fmtLabel = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
    const dayNames = ['一', '二', '三', '四', '五', '六'];

    // Today as order date
    this.orderDate = fmt(new Date());

    // Next week = selected week + 7 days (order is for NEXT week)
    const { start: weekStart } = this.getWeekDateRange(this.weeklyFilter.week);
    const monday = new Date(weekStart);
    monday.setDate(monday.getDate() + 7);
    this.orderPreviewDates = [];
    this.orderPreviewDayLabels = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      this.orderPreviewDates.push(fmt(d));
      this.orderPreviewDayLabels.push(`週${dayNames[i]}(${fmtLabel(d)})`);
    }

    // Only dialysateCa and bicarbonateType
    const orderCategories = ['dialysateCa', 'bicarbonateType'];
    this.orderPreviewItems = [];
    this.orderPreviewGrid = {};

    for (const category of orderCategories) {
      for (const item of this.getItemsForCategory(category)) {
        const orderQty = this.getOrderQuantity(category, item);
        if (orderQty <= 0) continue;

        const key = `${category}|${item}`;
        const label = `${CATEGORY_NAMES[category]} - ${item}`;
        const hospitalCode = this.getHospitalCode(category, item);
        this.orderPreviewItems.push({ category, item, label, hospitalCode });

        // Split order qty evenly between Mon(index 0) and Wed(index 2)
        const half1 = Math.ceil(orderQty / 2);
        const half2 = orderQty - half1;
        this.orderPreviewGrid[key] = [half1, 0, half2, 0, 0, 0];
      }
    }

    this.showOrderPreview.set(true);
  }

  confirmExportOrder(): void {
    const rows: any[][] = [];

    // Row 1: Order date
    rows.push(['訂購日期', this.orderDate]);
    // Row 2: Usage date range (simple)
    const firstDate = this.orderPreviewDates[0]?.replace(/^\d{4}-/, '').replace('-', '/');
    const lastDate = this.orderPreviewDates[5]?.replace(/^\d{4}-/, '').replace('-', '/');
    rows.push(['訂單使用日期', `${firstDate}-${lastDate}`]);
    // Row 3: Delivery days
    rows.push(['到貨日', '★', '', '★', '', '', '']);
    // Empty row
    rows.push([]);
    // Header row
    rows.push(['院內代碼', '品項', ...this.orderPreviewDayLabels]);

    // Data rows
    for (const entry of this.orderPreviewItems) {
      const key = `${entry.category}|${entry.item}`;
      const grid = this.orderPreviewGrid[key] || [0, 0, 0, 0, 0, 0];
      rows.push([entry.hospitalCode || '', entry.label, ...grid]);
    }

    // Signature rows
    rows.push([]);
    rows.push([]);
    const currentUser = this.authService.currentUser();
    rows.push([`製表人：${currentUser?.name || ''}`]);
    rows.push(['洗腎室護理長：']);

    const ws = XLSX.utils.aoa_to_sheet(rows);

    // Set column widths
    ws['!cols'] = [
      { wch: 14 },
      { wch: 30 },
      { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '訂單');

    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `每週訂單_${this.weeklyFilter.week}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);

    this.showOrderPreview.set(false);
    this.showAlert('匯出成功', '訂單已下載');
  }

  getOrderRowTotal(category: string, item: string): number {
    const grid = this.orderPreviewGrid[`${category}|${item}`] || [];
    return grid.reduce((sum: number, v: number) => sum + (v || 0), 0);
  }

  getHospitalCode(category: string, itemName: string): string {
    const items = this.inventoryItems();
    const found = items.find((i: any) => i.category === category && i.name === itemName);
    return found?.hospitalCode || '';
  }

  // ==================== Utility Methods ====================

  formatDate(timestamp: any): string {
    if (!timestamp) return '-';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('zh-TW');
  }

  formatDateTime(timestamp: any): string {
    if (!timestamp) return '-';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('zh-TW') + ' ' + date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  }

  private formatDateForInput(timestamp: any): string {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toISOString().slice(0, 10);
  }

  private formatDateTimeForInput(timestamp: any): string {
    if (!timestamp) return '';
    const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private getNowLocalDatetime(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private async loadKnownItems(): Promise<void> {
    for (const category of Object.keys(this.knownItems)) {
      this.knownItems[category].sort();
    }
  }

  onModalOverlayClick(event: MouseEvent, modal: 'purchase' | 'item'): void {
    if (event.target === event.currentTarget) {
      if (modal === 'purchase') this.closePurchaseModal();
      else this.closeItemModal();
    }
  }
}
