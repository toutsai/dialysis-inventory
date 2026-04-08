import { Component, Input, Output, EventEmitter, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { OrderService, OrderCalculationResult, OrderItem } from '../../services/order.service';
import { DeliveryService } from '../../services/delivery.service';
import { Timestamp } from 'firebase/firestore';
import * as XLSX from 'xlsx';

const CATEGORY_NAMES: Record<string, string> = {
  artificialKidney: '人工腎臟',
  dialysateCa: '透析藥水CA',
  bicarbonateType: 'B液種類',
};

@Component({
  selector: 'app-new-order-tab',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './new-order-tab.component.html',
  styleUrl: './new-order-tab.component.css',
})
export class NewOrderTabComponent {
  private readonly orderService = inject(OrderService);
  private readonly deliveryService = inject(DeliveryService);

  @Input() inventoryItems: any[] = [];
  @Input() knownItems: Record<string, string[]> = {};
  @Input() userName = '';
  @Output() orderCreated = new EventEmitter<void>();
  @Output() showAlert = new EventEmitter<{ title: string; message: string }>();

  readonly CATEGORY_NAMES = CATEGORY_NAMES;
  readonly categoryKeys = Object.keys(CATEGORY_NAMES);
  readonly weeklyCategories = ['dialysateCa', 'bicarbonateType'];

  // ─── Mode ───
  orderMode = signal<'weekly' | 'monthly'>('weekly');

  // ─── Current Day Count (shared) ───
  countDate = this.toTaiwanDate();
  countBoxes: Record<string, Record<string, number>> = {
    artificialKidney: {},
    dialysateCa: {},
    bicarbonateType: {},
  };
  countUnits: Record<string, Record<string, number>> = {
    artificialKidney: {},
    dialysateCa: {},
    bicarbonateType: {},
  };

  // ─── Calculation Results ───
  loading = signal(false);
  calculated = signal(false);
  calculationResults = signal<OrderCalculationResult[]>([]);
  consumptionPeriod = signal<{ start: string; end: string }>({ start: '', end: '' });
  consumptionData = signal<Record<string, Record<string, number>>>({});

  // ─── Weekly Order Preview ───
  showOrderPreview = signal(false);
  weeklyDeliveryDates: { date: string; label: string }[] = [];
  weeklyPreviewGrid: Record<string, Record<string, number>> = {}; // key=category:item, val={date: qty}

  // ─── Monthly Order: Delivery Date Picker ───
  monthlyCalendarMonth = ''; // YYYY-MM for the calendar
  monthlyCalendarDays: { date: string; day: number; selected: boolean; isWeekend: boolean }[] = [];
  monthlySelectedDates: string[] = [];
  monthlyDistribution: Record<string, Record<string, number>> = {}; // key=category:item, val={date: qty}

  // ─── Init ───

  ngOnInit(): void {
    this.initCountBoxes();
    this.setDefaultMonthlyCalendar();
  }

  private initCountBoxes(): void {
    for (const category of this.categoryKeys) {
      const items = this.getItemsForCategory(category);
      for (const item of items) {
        if (this.countBoxes[category][item] === undefined) {
          this.countBoxes[category][item] = 0;
        }
      }
    }
  }

  private setDefaultMonthlyCalendar(): void {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    this.monthlyCalendarMonth = this.toTaiwanDate(nextMonth).slice(0, 7);
    this.buildCalendarDays();
  }

  // ─── Count Methods ───

  getItemsForCategory(category: string): string[] {
    return this.knownItems[category] || [];
  }

  getUnitsPerBox(category: string, itemName: string): number {
    const item = this.inventoryItems.find(
      (i: any) => i.category === category && i.name === itemName
    );
    return item?.unitsPerBox || 1;
  }

  syncCount(): void {
    for (const category of this.categoryKeys) {
      for (const [item, boxes] of Object.entries(this.countBoxes[category])) {
        this.countUnits[category][item] = (Number(boxes) || 0) * this.getUnitsPerBox(category, item);
      }
    }
  }

  calculateCountUnits(category: string, item: string): number {
    const boxes = this.countBoxes[category]?.[item] || 0;
    return boxes * this.getUnitsPerBox(category, item);
  }

  clearCount(): void {
    for (const category of this.categoryKeys) {
      for (const item of Object.keys(this.countBoxes[category])) {
        this.countBoxes[category][item] = 0;
        this.countUnits[category][item] = 0;
      }
    }
    this.calculated.set(false);
  }

  // ─── Calculate Order ───

  async calculateOrder(): Promise<void> {
    this.loading.set(true);
    this.syncCount();

    // Build a fresh count snapshot to pass to the service
    const countSnapshot: Record<string, Record<string, number>> = {};
    for (const category of this.categoryKeys) {
      countSnapshot[category] = {};
      for (const [item, boxes] of Object.entries(this.countBoxes[category])) {
        const unitsPerBox = this.getUnitsPerBox(category, item);
        countSnapshot[category][item] = (Number(boxes) || 0) * unitsPerBox;
      }
    }
    // Also update countUnits for the confirm step
    for (const cat of this.categoryKeys) {
      this.countUnits[cat] = { ...countSnapshot[cat] };
    }

    try {
      if (this.orderMode() === 'weekly') {
        const result = await this.orderService.calculateWeeklyOrder(countSnapshot, this.inventoryItems);
        this.calculationResults.set(result.results);
        this.consumptionPeriod.set(result.consumptionPeriod);
        this.consumptionData.set(result.consumptionData);
      } else {
        const result = await this.orderService.calculateMonthlyOrder(countSnapshot, this.inventoryItems);
        this.calculationResults.set(result.results);
        this.consumptionPeriod.set(result.consumptionPeriod);
        this.consumptionData.set(result.consumptionData);
      }
      this.calculated.set(true);
    } catch (error: any) {
      console.error('訂單計算失敗:', error);
      this.showAlert.emit({ title: '錯誤', message: '訂單計算失敗: ' + error.message });
    } finally {
      this.loading.set(false);
    }
  }

  get filteredResults(): OrderCalculationResult[] {
    return this.calculationResults();
  }

  get hasOrderItems(): boolean {
    return this.filteredResults.some(r => r.suggestedOrder > 0);
  }

  calculateBoxesRounded(category: string, item: string, units: number): number {
    const unitsPerBox = this.getUnitsPerBox(category, item);
    return Math.ceil(units / unitsPerBox);
  }

  // ─── Weekly Order Preview ───

  openWeeklyPreview(): void {
    const now = new Date();
    const dayOfWeek = this.getTaiwanDay(now);
    // Next Monday
    const nextMonday = new Date(now);
    nextMonday.setDate(now.getDate() + (8 - dayOfWeek) % 7 || 7);
    // Next Wednesday
    const nextWednesday = new Date(nextMonday);
    nextWednesday.setDate(nextMonday.getDate() + 2);

    this.weeklyDeliveryDates = [
      { date: this.toTaiwanDate(nextMonday), label: `週一 (${this.formatShortDate(nextMonday)})` },
      { date: this.toTaiwanDate(nextWednesday), label: `週三 (${this.formatShortDate(nextWednesday)})` },
    ];

    // Split orders evenly across Mon/Wed
    this.weeklyPreviewGrid = {};
    for (const r of this.filteredResults) {
      if (r.suggestedOrder <= 0) continue;
      const key = `${r.category}:${r.item}`;
      const half1 = Math.ceil(r.suggestedOrder / 2);
      const half2 = r.suggestedOrder - half1;
      this.weeklyPreviewGrid[key] = {};
      this.weeklyPreviewGrid[key][this.weeklyDeliveryDates[0].date] = half1;
      this.weeklyPreviewGrid[key][this.weeklyDeliveryDates[1].date] = half2;
    }

    this.showOrderPreview.set(true);
  }

  getWeeklyPreviewQty(category: string, item: string, date: string): number {
    return this.weeklyPreviewGrid[`${category}:${item}`]?.[date] || 0;
  }

  setWeeklyPreviewQty(category: string, item: string, date: string, value: number): void {
    const key = `${category}:${item}`;
    if (!this.weeklyPreviewGrid[key]) this.weeklyPreviewGrid[key] = {};
    this.weeklyPreviewGrid[key][date] = value || 0;
  }

  // ─── Monthly Calendar ───

  buildCalendarDays(): void {
    const [y, m] = this.monthlyCalendarMonth.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const firstDayOfWeek = new Date(y, m - 1, 1).getDay(); // 0=Sun

    this.monthlyCalendarDays = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${this.monthlyCalendarMonth}-${String(d).padStart(2, '0')}`;
      const dow = (firstDayOfWeek + d - 1) % 7;
      this.monthlyCalendarDays.push({
        date: dateStr,
        day: d,
        selected: this.monthlySelectedDates.includes(dateStr),
        isWeekend: dow === 0 || dow === 6,
      });
    }
  }

  onCalendarMonthChange(): void {
    this.monthlySelectedDates = [];
    this.monthlyDistribution = {};
    this.buildCalendarDays();
  }

  toggleCalendarDate(date: string): void {
    const idx = this.monthlySelectedDates.indexOf(date);
    if (idx >= 0) {
      this.monthlySelectedDates.splice(idx, 1);
    } else {
      this.monthlySelectedDates.push(date);
      this.monthlySelectedDates.sort();
    }
    this.buildCalendarDays();
    this.initMonthlyDistribution();
  }

  private initMonthlyDistribution(): void {
    const dates = this.monthlySelectedDates;
    if (dates.length === 0) {
      this.monthlyDistribution = {};
      return;
    }

    for (const r of this.filteredResults) {
      if (r.suggestedOrder <= 0) continue;
      const key = `${r.category}:${r.item}`;
      if (!this.monthlyDistribution[key]) this.monthlyDistribution[key] = {};

      // Auto-distribute evenly across selected dates
      const perDate = Math.floor(r.suggestedOrder / dates.length);
      const remainder = r.suggestedOrder % dates.length;
      for (let i = 0; i < dates.length; i++) {
        this.monthlyDistribution[key][dates[i]] = perDate + (i < remainder ? 1 : 0);
      }
    }
  }

  getMonthlyDistQty(category: string, item: string, date: string): number {
    return this.monthlyDistribution[`${category}:${item}`]?.[date] || 0;
  }

  setMonthlyDistQty(category: string, item: string, date: string, value: number): void {
    const key = `${category}:${item}`;
    if (!this.monthlyDistribution[key]) this.monthlyDistribution[key] = {};
    this.monthlyDistribution[key][date] = value || 0;
  }

  getMonthlyDistTotal(category: string, item: string): number {
    const key = `${category}:${item}`;
    const dist = this.monthlyDistribution[key];
    if (!dist) return 0;
    return Object.values(dist).reduce((sum, v) => sum + v, 0);
  }

  getCalendarMonthLabel(): string {
    const [y, m] = this.monthlyCalendarMonth.split('-').map(Number);
    return `${y} 年 ${m} 月`;
  }

  // ─── Confirm & Save Order ───

  async confirmWeeklyOrder(): Promise<void> {
    this.loading.set(true);
    try {
      this.syncCount();
      const items: OrderItem[] = [];
      for (const [key, dateQtyMap] of Object.entries(this.weeklyPreviewGrid)) {
        const [category, item] = key.split(':');
        const totalQuantity = Object.values(dateQtyMap).reduce((s, v) => s + v, 0);
        if (totalQuantity <= 0) continue;
        const hospitalCode = this.filteredResults.find(r => r.category === category && r.item === item)?.hospitalCode || '';
        items.push({
          category, item, hospitalCode, totalQuantity,
          deliveries: Object.entries(dateQtyMap).map(([date, quantity]) => ({ date, quantity })),
        });
      }

      if (items.length === 0) {
        this.showAlert.emit({ title: '提示', message: '沒有需要訂購的品項' });
        this.loading.set(false);
        return;
      }

      const orderId = await this.orderService.createOrder({
        orderType: 'weekly',
        orderDate: this.toTaiwanDate(),
        countDate: this.countDate,
        countData: JSON.parse(JSON.stringify(this.countUnits)),
        consumptionPeriod: this.consumptionPeriod(),
        consumptionData: JSON.parse(JSON.stringify(this.consumptionData())),
        items,
        status: 'placed',
        notes: '',
        createdBy: this.userName,
        createdAt: Timestamp.now(),
      });

      // Create deliveries
      const deliveryItems = items.map(oi => ({
        ...oi,
        unitsPerBox: this.getUnitsPerBox(oi.category, oi.item),
      }));
      await this.deliveryService.createDeliveriesFromOrder(orderId, 'weekly', deliveryItems);

      this.showOrderPreview.set(false);
      this.showAlert.emit({ title: '成功', message: '週訂單已建立，到貨行事曆已更新！' });
      this.orderCreated.emit();
    } catch (error: any) {
      console.error('建立訂單失敗:', error);
      this.showAlert.emit({ title: '錯誤', message: '建立訂單失敗: ' + error.message });
    } finally {
      this.loading.set(false);
    }
  }

  async confirmMonthlyOrder(): Promise<void> {
    if (this.monthlySelectedDates.length === 0) {
      this.showAlert.emit({ title: '提示', message: '請在日曆上選擇至少一個到貨日期' });
      return;
    }

    this.loading.set(true);
    try {
      this.syncCount();
      const items: OrderItem[] = [];
      for (const [key, dateQtyMap] of Object.entries(this.monthlyDistribution)) {
        const [category, item] = key.split(':');
        const totalQuantity = Object.values(dateQtyMap).reduce((s, v) => s + v, 0);
        if (totalQuantity <= 0) continue;
        const hospitalCode = this.filteredResults.find(r => r.category === category && r.item === item)?.hospitalCode || '';
        items.push({
          category, item, hospitalCode, totalQuantity,
          deliveries: Object.entries(dateQtyMap)
            .filter(([, qty]) => qty > 0)
            .map(([date, quantity]) => ({ date, quantity })),
        });
      }

      if (items.length === 0) {
        this.showAlert.emit({ title: '提示', message: '沒有需要訂購的品項' });
        this.loading.set(false);
        return;
      }

      const orderId = await this.orderService.createOrder({
        orderType: 'monthly',
        orderDate: this.toTaiwanDate(),
        countDate: this.countDate,
        countData: JSON.parse(JSON.stringify(this.countUnits)),
        consumptionPeriod: this.consumptionPeriod(),
        consumptionData: JSON.parse(JSON.stringify(this.consumptionData())),
        items,
        status: 'placed',
        notes: '',
        createdBy: this.userName,
        createdAt: Timestamp.now(),
      });

      const deliveryItems = items.map(oi => ({
        ...oi,
        unitsPerBox: this.getUnitsPerBox(oi.category, oi.item),
      }));
      await this.deliveryService.createDeliveriesFromOrder(orderId, 'monthly', deliveryItems);

      this.showAlert.emit({ title: '成功', message: '月訂單已建立，到貨行事曆已更新！' });
      this.orderCreated.emit();
    } catch (error: any) {
      console.error('建立訂單失敗:', error);
      this.showAlert.emit({ title: '錯誤', message: '建立訂單失敗: ' + error.message });
    } finally {
      this.loading.set(false);
    }
  }

  // ─── Export ───

  exportOrder(): void {
    const results = this.filteredResults.filter(r => r.suggestedOrder > 0);
    if (results.length === 0) return;

    const mode = this.orderMode();
    const rows: any[][] = [
      [`${mode === 'weekly' ? '週' : '月'}訂單 - 訂購日: ${this.toTaiwanDate()}`],
      ['盤點日', this.countDate],
      [''],
      ['院內代碼', '類別', '品項', '每箱數量', '盤點量', '消耗量', '日均', '安全庫存', '建議訂購(個)', '建議訂購(箱)'],
    ];

    for (const r of results) {
      rows.push([
        r.hospitalCode,
        CATEGORY_NAMES[r.category] || r.category,
        r.item,
        this.getUnitsPerBox(r.category, r.item),
        r.currentStock,
        r.consumption,
        +r.dailyAvg.toFixed(1),
        r.safetyStock,
        r.suggestedOrder,
        this.calculateBoxesRounded(r.category, r.item, r.suggestedOrder),
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '訂單');
    XLSX.writeFile(wb, `${mode === 'weekly' ? '週' : '月'}訂單_${this.toTaiwanDate()}.xlsx`);
  }

  // ─── Helpers ───

  private toTaiwanDate(date: Date = new Date()): string {
    return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  }

  private getTaiwanDay(date: Date = new Date()): number {
    const dayStr = date.toLocaleDateString('en-US', { timeZone: 'Asia/Taipei', weekday: 'short' });
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return dayMap[dayStr] ?? date.getDay();
  }

  private formatShortDate(d: Date): string {
    const s = this.toTaiwanDate(d).split('-');
    return `${parseInt(s[1])}/${parseInt(s[2])}`;
  }

  formatDateShort(dateStr: string): string {
    const parts = dateStr.split('-');
    return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
  }

  getCalendarBlanks(): number[] {
    const [y, m] = this.monthlyCalendarMonth.split('-').map(Number);
    const firstDayOfWeek = new Date(y, m - 1, 1).getDay();
    return new Array(firstDayOfWeek);
  }
}
