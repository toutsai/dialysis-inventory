import { Injectable, inject } from '@angular/core';
import { FirebaseService } from '@services/firebase.service';
import {
  collection, query, where, orderBy, getDocs, addDoc, updateDoc,
  doc, Timestamp,
} from 'firebase/firestore';

// ─── Types ───

export interface DeliveryItem {
  category: string;
  item: string;
  hospitalCode: string;
  expectedQuantity: number;
  receivedQuantity: number | null;
  receivedBoxes: number | null;
  unitsPerBox: number;
}

export interface InventoryDelivery {
  id?: string;
  orderId: string;
  orderType: 'weekly' | 'monthly';
  expectedDate: string;
  items: DeliveryItem[];
  status: 'pending' | 'confirmed' | 'partial';
  confirmedAt: Timestamp | null;
  confirmedBy: string | null;
  purchaseIds: string[];
  notes: string;
}

@Injectable({ providedIn: 'root' })
export class DeliveryService {
  private readonly firebase = inject(FirebaseService);

  // ─── Delivery CRUD ───

  async createDelivery(delivery: Omit<InventoryDelivery, 'id'>): Promise<string> {
    const db = this.firebase.db;
    const docRef = await addDoc(collection(db, 'inventory_deliveries'), delivery);
    return docRef.id;
  }

  /**
   * Create multiple deliveries from an order's item delivery schedules.
   * Groups by date: all items arriving on the same date go into one delivery doc.
   */
  async createDeliveriesFromOrder(
    orderId: string,
    orderType: 'weekly' | 'monthly',
    items: { category: string; item: string; hospitalCode: string; deliveries: { date: string; quantity: number }[]; unitsPerBox: number }[],
  ): Promise<string[]> {
    // Group by delivery date
    const byDate: Record<string, DeliveryItem[]> = {};
    for (const orderItem of items) {
      for (const del of orderItem.deliveries) {
        if (del.quantity <= 0) continue;
        if (!byDate[del.date]) byDate[del.date] = [];
        byDate[del.date].push({
          category: orderItem.category,
          item: orderItem.item,
          hospitalCode: orderItem.hospitalCode,
          expectedQuantity: del.quantity,
          receivedQuantity: null,
          receivedBoxes: null,
          unitsPerBox: orderItem.unitsPerBox,
        });
      }
    }

    const deliveryIds: string[] = [];
    for (const [date, deliveryItems] of Object.entries(byDate)) {
      const id = await this.createDelivery({
        orderId,
        orderType,
        expectedDate: date,
        items: deliveryItems,
        status: 'pending',
        confirmedAt: null,
        confirmedBy: null,
        purchaseIds: [],
        notes: '',
      });
      deliveryIds.push(id);
    }
    return deliveryIds;
  }

  // ─── Query Deliveries ───

  async getDeliveriesByMonth(month: string): Promise<InventoryDelivery[]> {
    const db = this.firebase.db;
    const startDate = `${month}-01`;
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

    const q = query(
      collection(db, 'inventory_deliveries'),
      where('expectedDate', '>=', startDate),
      where('expectedDate', '<=', endDate),
      orderBy('expectedDate', 'asc'),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as InventoryDelivery));
  }

  async getPendingDeliveries(): Promise<InventoryDelivery[]> {
    const db = this.firebase.db;
    const q = query(
      collection(db, 'inventory_deliveries'),
      where('status', '==', 'pending'),
      orderBy('expectedDate', 'asc'),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as InventoryDelivery));
  }

  // ─── Confirm Arrival ───

  /**
   * Confirm a delivery arrival:
   * 1. For each item, create an inventory_purchases record
   * 2. Update the delivery document with received quantities and status
   * 3. Returns the created purchase IDs
   */
  async confirmDeliveryArrival(
    delivery: InventoryDelivery,
    receivedItems: { category: string; item: string; receivedQuantity: number; receivedBoxes: number; unitsPerBox: number }[],
    confirmedBy: string,
  ): Promise<string[]> {
    const db = this.firebase.db;
    const purchaseIds: string[] = [];
    const deliveryDate = delivery.expectedDate;

    // 1. Create purchase records for each received item
    for (const received of receivedItems) {
      if (received.receivedQuantity <= 0) continue;
      const purchaseRef = await addDoc(collection(db, 'inventory_purchases'), {
        date: Timestamp.fromDate(new Date(deliveryDate + 'T08:00:00')),
        category: received.category,
        item: received.item,
        boxQuantity: received.receivedBoxes,
        quantity: received.receivedQuantity,
        unitsPerBox: received.unitsPerBox,
        createdBy: confirmedBy,
        createdAt: Timestamp.now(),
        deliveryId: delivery.id,
        source: 'delivery',
      });
      purchaseIds.push(purchaseRef.id);
    }

    // 2. Update delivery document
    const updatedItems = delivery.items.map(item => {
      const received = receivedItems.find(r => r.category === item.category && r.item === item.item);
      return {
        ...item,
        receivedQuantity: received?.receivedQuantity ?? item.expectedQuantity,
        receivedBoxes: received?.receivedBoxes ?? null,
      };
    });

    // Check if all items match expected
    const hasDiscrepancy = updatedItems.some(
      item => item.receivedQuantity !== null && item.receivedQuantity !== item.expectedQuantity
    );

    // Build notes for discrepancies
    const discrepancyNotes: string[] = [];
    for (const item of updatedItems) {
      if (item.receivedQuantity !== null && item.receivedQuantity !== item.expectedQuantity) {
        const diff = item.receivedQuantity - item.expectedQuantity;
        const sign = diff > 0 ? '+' : '';
        discrepancyNotes.push(`${item.item}: 預期 ${item.expectedQuantity}, 實收 ${item.receivedQuantity} (${sign}${diff})`);
      }
    }

    const status = hasDiscrepancy ? 'partial' : 'confirmed';
    const notes = discrepancyNotes.length > 0 ? discrepancyNotes.join('; ') : '';

    await updateDoc(doc(db, 'inventory_deliveries', delivery.id!), {
      items: updatedItems,
      status,
      confirmedAt: Timestamp.now(),
      confirmedBy,
      purchaseIds,
      notes,
    });

    return purchaseIds;
  }
}
