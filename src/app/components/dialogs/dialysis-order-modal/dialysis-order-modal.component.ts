import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FirebaseService } from '@services/firebase.service';
import { ConfirmDialogComponent } from '../confirm-dialog/confirm-dialog.component';
import { collection, query, where, orderBy, limit, getDocs, deleteDoc, doc } from 'firebase/firestore';

@Component({
  selector: 'app-dialysis-order-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent],
  templateUrl: './dialysis-order-modal.component.html',
  styleUrl: './dialysis-order-modal.component.css'
})
export class DialysisOrderModalComponent implements OnInit, OnDestroy {
  private readonly firebase = inject(FirebaseService);

  @Input() patient: any = null;
  @Input() patientData: any = null;
  @Output() close = new EventEmitter<void>();
  @Output() save = new EventEmitter<any>();

  orderHistory: any[] = [];
  isLoadingHistory = false;
  isConfirmDeleteVisible = false;
  orderToDelete: any = null;

  readonly akOptions = ['13M', '15S', '17UX', '17HX', 'FX80', 'BG-1.8U', 'Pro-19H', '21S', 'Hi23', '25H', '25S', 'CTA2000'];
  readonly caOptions = ['2.5', '3.0', '3.5'];
  readonly vascAccessOptions = ['D/L', 'Perm', 'AVF', 'AVG'];
  readonly needleSizeOptions = ['15G', '16G', '17G'];

  localOrderData: any = this.createFormState();

  private createFormState(): any {
    return {
      effectiveDate: new Date().toISOString().split('T')[0],
      aks: [''],
      dialysateCa: '',
      dryWeight: '',
      bloodFlow: '',
      vascAccess: '',
      arterialNeedle: '',
      venousNeedle: '',
      heparinInitial: '',
      heparinMaintenance: '',
      heparinRinse: '不可',
      physician: '',
      mode: '',
      freq: '',
      dialysisHours: null,
      dialysateFlow: null,
      replacementFlow: null,
      dehydration: '',
      mannitol: '不用',
    };
  }

  ngOnInit(): void {
    document.body.classList.add('modal-open');

    // Parent passes [patient], map to patientData for internal use
    if (this.patient && !this.patientData) {
      this.patientData = this.patient;
    }

    if (this.patientData) {
      const orders = this.patientData.dialysisOrders || {};
      const patient = this.patientData;

      const akValue = orders.ak || '';
      this.localOrderData.aks = akValue && typeof akValue === 'string' ? akValue.split('/') : [''];

      const heparinLM = orders.heparinLM
        ? String(orders.heparinLM).split('/')
        : [orders.heparinInitial || '', orders.heparinMaintenance || ''];

      Object.assign(this.localOrderData, {
        effectiveDate: orders.effectiveDate || new Date().toISOString().split('T')[0],
        vascAccess: orders.vascAccess || '',
        arterialNeedle: orders.arterialNeedle || '',
        venousNeedle: orders.venousNeedle || '',
        dialysateCa: orders.dialysateCa || orders.dialysate || '',
        dryWeight: orders.dryWeight || '',
        bloodFlow: orders.bloodFlow || '',
        heparinInitial: heparinLM[0] || '',
        heparinMaintenance: heparinLM[1] || '',
        physician: orders.physician || patient.physician || '',
        mode: orders.mode || patient.mode || '',
        freq: orders.freq || patient.freq || '',
        dialysisHours: orders.dialysisHours || null,
        dialysateFlow: orders.dialysateFlow || null,
        replacementFlow: orders.replacementFlow || null,
        dehydration: orders.dehydration || '',
        heparinRinse: orders.heparinRinse || '不可',
        mannitol: orders.mannitol || '不用',
      });

      this.fetchOrderHistory(this.patientData.id);
    }
  }

  ngOnDestroy(): void {
    document.body.classList.remove('modal-open');
  }

  get shouldShowNeedleSize(): boolean {
    return this.localOrderData.vascAccess === 'AVF' || this.localOrderData.vascAccess === 'AVG';
  }

  get todayStr(): string {
    return new Date().toISOString().split('T')[0];
  }

  get activeOrder(): any {
    const effectiveOrders = this.orderHistory
      .filter((o: any) => o.orders?.effectiveDate <= this.todayStr)
      .sort((a: any, b: any) => {
        const dateA = this.getDate(b.updatedAt);
        const dateB = this.getDate(a.updatedAt);
        return (dateA?.getTime() || 0) - (dateB?.getTime() || 0);
      });
    return effectiveOrders.length > 0 ? effectiveOrders[0] : null;
  }

  get pendingOrders(): any[] {
    return this.orderHistory
      .filter((o: any) => o.orders?.effectiveDate > this.todayStr)
      .sort((a: any, b: any) => {
        const dateA = this.getDate(a.orders?.effectiveDate);
        const dateB = this.getDate(b.orders?.effectiveDate);
        return (dateA?.getTime() || 0) - (dateB?.getTime() || 0);
      });
  }

  get archivedOrders(): any[] {
    const activeId = this.activeOrder?.id;
    const pendingIds = new Set(this.pendingOrders.map((p: any) => p.id));
    return this.orderHistory
      .filter((o: any) => o.id !== activeId && !pendingIds.has(o.id))
      .sort((a: any, b: any) => {
        const dateA = this.getDate(b.updatedAt);
        const dateB = this.getDate(a.updatedAt);
        return (dateA?.getTime() || 0) - (dateB?.getTime() || 0);
      });
  }

  addAkSelect(): void {
    if (this.localOrderData.aks.length < 3) {
      this.localOrderData.aks.push('');
    }
  }

  removeAkSelect(index: number): void {
    if (this.localOrderData.aks.length > 1) {
      this.localOrderData.aks.splice(index, 1);
    }
  }

  onVascAccessChange(): void {
    if (this.localOrderData.vascAccess !== 'AVF' && this.localOrderData.vascAccess !== 'AVG') {
      this.localOrderData.arterialNeedle = '';
      this.localOrderData.venousNeedle = '';
    }
  }

  handleSave(): void {
    const formattedAk = this.localOrderData.aks.filter((ak: string) => ak).join('/');
    const formattedHeparinLM = `${this.localOrderData.heparinInitial || '0'}/${this.localOrderData.heparinMaintenance || '0'}`;

    const dataToSave: any = {
      effectiveDate: this.localOrderData.effectiveDate,
      ak: formattedAk,
      artificialKidney: formattedAk,
      dialysateCa: this.localOrderData.dialysateCa,
      dialysate: this.localOrderData.dialysateCa,
      dryWeight: this.localOrderData.dryWeight,
      bloodFlow: this.localOrderData.bloodFlow,
      vascAccess: this.localOrderData.vascAccess,
      arterialNeedle: this.localOrderData.arterialNeedle,
      venousNeedle: this.localOrderData.venousNeedle,
      heparinLM: formattedHeparinLM,
      heparinInitial: this.localOrderData.heparinInitial,
      heparinMaintenance: this.localOrderData.heparinMaintenance,
      heparinRinse: this.localOrderData.heparinRinse,
      physician: this.localOrderData.physician,
      mode: this.localOrderData.mode,
      freq: this.localOrderData.freq,
      dialysisHours: this.localOrderData.dialysisHours,
      dialysateFlow: this.localOrderData.dialysateFlow,
      replacementFlow: this.localOrderData.replacementFlow,
      dehydration: this.localOrderData.dehydration,
      mannitol: this.localOrderData.mannitol,
    };

    Object.keys(dataToSave).forEach((key) => {
      if (dataToSave[key] === null || dataToSave[key] === undefined || dataToSave[key] === '') {
        delete dataToSave[key];
      }
    });

    this.save.emit(dataToSave);
  }

  handleClose(): void {
    document.body.classList.remove('modal-open');
    this.close.emit();
  }

  requestDeleteOrder(record: any): void {
    if (!record || !record.id) {
      alert('錯誤：無法識別要刪除的記錄');
      return;
    }
    this.orderToDelete = record;
    this.isConfirmDeleteVisible = true;
  }

  async confirmDelete(): Promise<void> {
    if (!this.orderToDelete?.id) return;
    const recordId = this.orderToDelete.id;
    try {
      await deleteDoc(doc(this.firebase.db, 'dialysis_orders_history', recordId));
      this.orderHistory = this.orderHistory.filter((item: any) => item.id !== recordId);
      alert('刪除成功');
    } catch (error) {
      console.error('刪除醫囑歷史失敗:', error);
      alert(`刪除失敗`);
    } finally {
      this.isConfirmDeleteVisible = false;
      this.orderToDelete = null;
    }
  }

  formatDate(isoString: any): string {
    if (!isoString) return 'N/A';
    const date = this.getDate(isoString);
    if (!date) return 'N/A';
    return date.toISOString().split('T')[0];
  }

  private getDate(dateValue: any): Date | null {
    if (!dateValue) return null;
    if (dateValue.toDate) return dateValue.toDate();
    if (typeof dateValue === 'string') return new Date(dateValue);
    return new Date(dateValue);
  }

  private async fetchOrderHistory(patientId: string): Promise<void> {
    if (!patientId) return;
    this.isLoadingHistory = true;
    this.orderHistory = [];
    try {
      const q = query(
        collection(this.firebase.db, 'dialysis_orders_history'),
        where('patientId', '==', patientId),
        orderBy('updatedAt', 'desc'),
        limit(20)
      );
      const snapshot = await getDocs(q);
      this.orderHistory = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (error) {
      console.error('讀取醫囑歷史失敗:', error);
    } finally {
      this.isLoadingHistory = false;
    }
  }
}
