import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FirebaseService } from '@services/firebase.service';
import { collection, query, where, orderBy, getDocs } from 'firebase/firestore';

@Component({
  selector: 'app-condition-record-display-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './condition-record-display-dialog.component.html',
  styleUrl: './condition-record-display-dialog.component.css'
})
export class ConditionRecordDisplayDialogComponent implements OnChanges {
  private readonly firebase = inject(FirebaseService);

  @Input() isVisible = false;
  @Input() patientId = '';
  @Input() patientName = '';
  @Input() targetDate = '';
  @Output() closeEvent = new EventEmitter<void>();

  records: any[] = [];
  isLoading = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      this.fetchRecords();
    }
    if (changes['patientId'] && this.isVisible) {
      this.fetchRecords();
    }
  }

  async fetchRecords(): Promise<void> {
    if (!this.patientId) {
      this.records = [];
      return;
    }

    this.isLoading = true;
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const q = query(
        collection(this.firebase.db, 'condition_records'),
        where('patientId', '==', this.patientId),
        where('createdAt', '>=', sevenDaysAgo),
        orderBy('createdAt', 'desc')
      );

      const snapshot = await getDocs(q);
      this.records = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err) {
      console.error('讀取病情紀錄失敗:', err);
      this.records = [];
    } finally {
      this.isLoading = false;
    }
  }

  formatTimestamp(ts: any): string {
    if (!ts) return '未知時間';
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    return date.toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  close(): void {
    this.closeEvent.emit();
  }
}
