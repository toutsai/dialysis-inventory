import { Component, Input, Output, EventEmitter, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FullCalendarModule } from '@fullcalendar/angular';
import { CalendarOptions, EventClickArg } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import { DeliveryService, InventoryDelivery, DeliveryItem } from '../../services/delivery.service';

const CATEGORY_NAMES: Record<string, string> = {
  artificialKidney: '人工腎臟',
  dialysateCa: '透析藥水CA',
  bicarbonateType: 'B液種類',
};

@Component({
  selector: 'app-delivery-calendar-tab',
  standalone: true,
  imports: [CommonModule, FormsModule, FullCalendarModule],
  templateUrl: './delivery-calendar-tab.component.html',
  styleUrl: './delivery-calendar-tab.component.css',
})
export class DeliveryCalendarTabComponent implements OnInit {
  private readonly deliveryService = inject(DeliveryService);

  @Input() inventoryItems: any[] = [];
  @Input() userName = '';
  @Output() deliveryConfirmed = new EventEmitter<void>();
  @Output() showAlert = new EventEmitter<{ title: string; message: string }>();

  readonly CATEGORY_NAMES = CATEGORY_NAMES;

  loading = signal(false);
  deliveries = signal<InventoryDelivery[]>([]);
  currentMonth = '';

  // Detail modal
  showDetailModal = signal(false);
  selectedDelivery = signal<InventoryDelivery | null>(null);
  receivedItems: { category: string; item: string; expectedQuantity: number; receivedQuantity: number; receivedBoxes: number; unitsPerBox: number }[] = [];
  confirming = signal(false);

  // Calendar
  calendarOptions: CalendarOptions = {
    plugins: [dayGridPlugin, interactionPlugin],
    initialView: 'dayGridMonth',
    locale: 'zh-tw',
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: '',
    },
    buttonText: {
      today: '今天',
    },
    height: 'auto',
    events: [],
    eventClick: (arg: EventClickArg) => this.onEventClick(arg),
    datesSet: (info) => {
      const mid = new Date((info.start.getTime() + info.end.getTime()) / 2);
      const month = mid.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 7);
      if (month !== this.currentMonth) {
        this.currentMonth = month;
        this.loadDeliveries();
      }
    },
  };

  async ngOnInit(): Promise<void> {
    this.currentMonth = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 7);
    await this.loadDeliveries();
  }

  async loadDeliveries(): Promise<void> {
    this.loading.set(true);
    try {
      const deliveries = await this.deliveryService.getDeliveriesByMonth(this.currentMonth);
      this.deliveries.set(deliveries);
      this.updateCalendarEvents(deliveries);
    } catch (error) {
      console.error('載入到貨資料失敗:', error);
    } finally {
      this.loading.set(false);
    }
  }

  private updateCalendarEvents(deliveries: InventoryDelivery[]): void {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    const events = deliveries.map(d => {
      const itemCount = d.items?.length || 0;
      const categories = [...new Set(d.items?.map(i => CATEGORY_NAMES[i.category] || i.category) || [])];
      const title = categories.join(', ') + ` (${itemCount}品項)`;

      let color = '#ffc107'; // yellow = pending
      if (d.status === 'confirmed') {
        color = '#28a745'; // green
      } else if (d.status === 'partial') {
        color = '#ff9800'; // orange
      } else if (d.expectedDate < today) {
        color = '#dc3545'; // red = overdue
      }

      return {
        id: d.id,
        title,
        date: d.expectedDate,
        backgroundColor: color,
        borderColor: color,
        textColor: '#fff',
        extendedProps: { delivery: d },
      };
    });
    this.calendarOptions = { ...this.calendarOptions, events };
  }

  onEventClick(arg: EventClickArg): void {
    const delivery = arg.event.extendedProps['delivery'] as InventoryDelivery;
    this.openDetailModal(delivery);
  }

  openDetailModal(delivery: InventoryDelivery): void {
    this.selectedDelivery.set(delivery);
    this.receivedItems = (delivery.items || []).map(item => ({
      category: item.category,
      item: item.item,
      expectedQuantity: item.expectedQuantity,
      receivedQuantity: item.receivedQuantity ?? item.expectedQuantity,
      receivedBoxes: item.receivedBoxes ?? (item.unitsPerBox > 1 ? Math.round(item.expectedQuantity / item.unitsPerBox) : item.expectedQuantity),
      unitsPerBox: item.unitsPerBox || 1,
    }));
    this.showDetailModal.set(true);
  }

  closeDetailModal(): void {
    this.showDetailModal.set(false);
    this.selectedDelivery.set(null);
    this.receivedItems = [];
  }

  onReceivedBoxesChange(idx: number): void {
    const item = this.receivedItems[idx];
    item.receivedQuantity = item.receivedBoxes * item.unitsPerBox;
  }

  getStatusLabel(status: string): string {
    switch (status) {
      case 'pending': return '待到貨';
      case 'confirmed': return '已確認';
      case 'partial': return '差異到貨';
      default: return status;
    }
  }

  getStatusClass(delivery: InventoryDelivery): string {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    if (delivery.status === 'confirmed') return 'status-confirmed';
    if (delivery.status === 'partial') return 'status-partial';
    if (delivery.expectedDate < today) return 'status-overdue';
    return 'status-pending';
  }

  isPending(delivery: InventoryDelivery | null): boolean {
    return delivery?.status === 'pending';
  }

  async confirmArrival(): Promise<void> {
    const delivery = this.selectedDelivery();
    if (!delivery) return;

    this.confirming.set(true);
    try {
      await this.deliveryService.confirmDeliveryArrival(delivery, this.receivedItems, this.userName);
      this.showAlert.emit({ title: '成功', message: '到貨確認完成，進貨紀錄已自動建立！' });
      this.closeDetailModal();
      await this.loadDeliveries();
      this.deliveryConfirmed.emit();
    } catch (error: any) {
      console.error('確認到貨失敗:', error);
      this.showAlert.emit({ title: '錯誤', message: '確認到貨失敗: ' + error.message });
    } finally {
      this.confirming.set(false);
    }
  }

  // Deliveries list for non-calendar view / summary
  getDeliveriesByStatus(status: string): InventoryDelivery[] {
    return this.deliveries().filter(d => d.status === status);
  }
}
