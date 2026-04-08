import { Injectable, inject } from '@angular/core';
import { FirebaseService } from '@services/firebase.service';
import { DailyConsumptionService } from '@services/daily-consumption.service';
import {
  collection, query, where, orderBy, getDocs, addDoc, updateDoc,
  doc, Timestamp, limit,
} from 'firebase/firestore';

// ─── Types ───

export interface OrderDeliverySchedule {
  date: string;     // YYYY-MM-DD
  quantity: number;  // units for this delivery date
}

export interface OrderItem {
  category: string;
  item: string;
  hospitalCode: string;
  totalQuantity: number;
  deliveries: OrderDeliverySchedule[];
}

export interface InventoryOrder {
  id?: string;
  orderType: 'weekly' | 'monthly';
  orderDate: string;
  countDate: string;
  countData: Record<string, Record<string, number>>;
  consumptionPeriod: { start: string; end: string };
  consumptionData: Record<string, Record<string, number>>;
  items: OrderItem[];
  status: 'placed' | 'partial' | 'completed' | 'cancelled';
  notes: string;
  createdBy: string;
  createdAt: Timestamp;
}

export interface OrderCalculationResult {
  category: string;
  item: string;
  hospitalCode: string;
  currentStock: number;
  consumption: number;       // reference period total consumption
  dailyAvg: number;
  safetyStock: number;
  pendingDeliveries: number;
  suggestedOrder: number;
}

// ─── Constants ───

const WEEKLY_SAFETY_DAYS = 9;
const MONTHLY_SAFETY_DAYS = 36;

const CATEGORY_NAMES: Record<string, string> = {
  artificialKidney: '人工腎臟',
  dialysateCa: '透析藥水CA',
  bicarbonateType: 'B液種類',
};

@Injectable({ providedIn: 'root' })
export class OrderService {
  private readonly firebase = inject(FirebaseService);
  private readonly dailyConsumption = inject(DailyConsumptionService);

  // ─── Order CRUD ───

  async createOrder(order: Omit<InventoryOrder, 'id'>): Promise<string> {
    const db = this.firebase.db;
    const docRef = await addDoc(collection(db, 'inventory_orders'), order);
    return docRef.id;
  }

  async updateOrderStatus(orderId: string, status: InventoryOrder['status']): Promise<void> {
    const db = this.firebase.db;
    await updateDoc(doc(db, 'inventory_orders', orderId), { status });
  }

  async getLatestOrderCountDate(): Promise<{ countDate: string; countData: Record<string, Record<string, number>> } | null> {
    const db = this.firebase.db;
    const q = query(
      collection(db, 'inventory_orders'),
      orderBy('countDate', 'desc'),
      limit(1),
    );
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const data = snap.docs[0].data() as any;
    return {
      countDate: data.countDate || '',
      countData: data.countData || {},
    };
  }

  async getOrdersByMonth(month: string): Promise<InventoryOrder[]> {
    const db = this.firebase.db;
    const startDate = `${month}-01`;
    const [y, m] = month.split('-').map(Number);
    const endDate = new Date(y, m, 0).toISOString().split('T')[0]; // last day
    const q = query(
      collection(db, 'inventory_orders'),
      where('orderDate', '>=', startDate),
      where('orderDate', '<=', endDate + '\uf8ff'),
      orderBy('orderDate', 'desc'),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as InventoryOrder));
  }

  // ─── Order Calculation ───

  /**
   * Calculate weekly order suggestions for dialysateCa + bicarbonateType.
   * Uses last week (Mon-Sat, 6 days) consumption ÷ 6 × 9 days safety.
   */
  async calculateWeeklyOrder(
    countData: Record<string, Record<string, number>>,
    inventoryItems: any[],
  ): Promise<{ results: OrderCalculationResult[]; consumptionPeriod: { start: string; end: string }; consumptionData: Record<string, Record<string, number>> }> {
    const now = new Date();
    const dayOfWeek = this.getTaiwanDay(now);
    const lastMonday = new Date(now);
    lastMonday.setDate(now.getDate() - dayOfWeek - 6);
    const lastSaturday = new Date(lastMonday);
    lastSaturday.setDate(lastMonday.getDate() + 5);
    const startStr = this.toTaiwanDate(lastMonday);
    const endStr = this.toTaiwanDate(lastSaturday);

    const weekResult = await this.dailyConsumption.getConsumptionByRange(startStr, endStr);
    const consumptionData = weekResult.grouped;

    // Get pending deliveries
    const pendingMap = await this.getPendingDeliveryQuantities();

    const weeklyCategories = ['dialysateCa', 'bicarbonateType'];
    const results: OrderCalculationResult[] = [];

    for (const category of weeklyCategories) {
      const itemNames = this.getItemNamesForCategory(category, inventoryItems, countData, consumptionData);
      for (const item of itemNames) {
        const currentStock = countData[category]?.[item] || 0;
        const consumption = consumptionData[category]?.[item] || 0;
        const dailyAvg = consumption / 6;
        const safetyStock = Math.ceil(dailyAvg * WEEKLY_SAFETY_DAYS);
        const pending = pendingMap[category]?.[item] || 0;
        const suggestedOrder = Math.max(0, safetyStock - currentStock - pending);
        const hospitalCode = this.getHospitalCode(category, item, inventoryItems);

        results.push({ category, item, hospitalCode, currentStock, consumption, dailyAvg, safetyStock, pendingDeliveries: pending, suggestedOrder });
      }
    }

    return { results, consumptionPeriod: { start: startStr, end: endStr }, consumptionData };
  }

  /**
   * Calculate monthly order suggestions for artificialKidney.
   * Uses last month consumption ÷ days × 36 days safety.
   */
  async calculateMonthlyOrder(
    countData: Record<string, Record<string, number>>,
    inventoryItems: any[],
  ): Promise<{ results: OrderCalculationResult[]; consumptionPeriod: { start: string; end: string }; consumptionData: Record<string, Record<string, number>> }> {
    const now = new Date();
    const currentMonth = this.toTaiwanMonth(now);
    const [y, m] = currentMonth.split('-').map(Number);
    const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const prevMonthDays = new Date(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1, 0).getDate();
    const startStr = `${prevMonth}-01`;
    const endStr = `${prevMonth}-${String(prevMonthDays).padStart(2, '0')}`;

    const monthResult = await this.dailyConsumption.getConsumptionByRange(startStr, endStr);
    const consumptionData = monthResult.grouped;

    const pendingMap = await this.getPendingDeliveryQuantities();

    const category = 'artificialKidney';
    const results: OrderCalculationResult[] = [];
    const itemNames = this.getItemNamesForCategory(category, inventoryItems, countData, consumptionData);

    for (const item of itemNames) {
      const currentStock = countData[category]?.[item] || 0;
      const consumption = consumptionData[category]?.[item] || 0;
      const dailyAvg = prevMonthDays > 0 ? consumption / prevMonthDays : 0;
      const safetyStock = Math.ceil(dailyAvg * MONTHLY_SAFETY_DAYS);
      const pending = pendingMap[category]?.[item] || 0;
      const suggestedOrder = Math.max(0, safetyStock - currentStock - pending);
      const hospitalCode = this.getHospitalCode(category, item, inventoryItems);

      results.push({ category, item, hospitalCode, currentStock, consumption, dailyAvg, safetyStock, pendingDeliveries: pending, suggestedOrder });
    }

    return { results, consumptionPeriod: { start: startStr, end: endStr }, consumptionData };
  }

  // ─── Helpers ───

  private async getPendingDeliveryQuantities(): Promise<Record<string, Record<string, number>>> {
    const db = this.firebase.db;
    const result: Record<string, Record<string, number>> = {};
    try {
      const q = query(
        collection(db, 'inventory_deliveries'),
        where('status', '==', 'pending'),
      );
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        const delivery = d.data() as any;
        for (const item of delivery.items || []) {
          if (!result[item.category]) result[item.category] = {};
          result[item.category][item.item] = (result[item.category][item.item] || 0) + item.expectedQuantity;
        }
      }
    } catch (e) {
      console.warn('查詢待到貨失敗:', e);
    }
    return result;
  }

  private getItemNamesForCategory(
    category: string,
    inventoryItems: any[],
    countData: Record<string, Record<string, number>>,
    consumptionData: Record<string, Record<string, number>>,
  ): string[] {
    const names = new Set<string>();
    for (const item of inventoryItems) {
      if (item.category === category) names.add(item.name);
    }
    for (const name of Object.keys(countData[category] || {})) names.add(name);
    for (const name of Object.keys(consumptionData[category] || {})) names.add(name);
    return Array.from(names).sort();
  }

  private getHospitalCode(category: string, itemName: string, inventoryItems: any[]): string {
    const found = inventoryItems.find((i: any) => i.category === category && i.name === itemName);
    return found?.hospitalCode || '';
  }

  private toTaiwanDate(date: Date = new Date()): string {
    return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  }

  private toTaiwanMonth(date: Date = new Date()): string {
    return this.toTaiwanDate(date).slice(0, 7);
  }

  private getTaiwanDay(date: Date = new Date()): number {
    const dayStr = date.toLocaleDateString('en-US', { timeZone: 'Asia/Taipei', weekday: 'short' });
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return dayMap[dayStr] ?? date.getDay();
  }
}
