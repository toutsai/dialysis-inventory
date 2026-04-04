import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import ApiManager from '@/services/api_manager';
import { where, orderBy } from 'firebase/firestore';
import { escapeHtml } from '@/utils/sanitize';

@Component({
  selector: 'app-patient-history-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './patient-history-modal.component.html',
  styleUrl: './patient-history-modal.component.css'
})
export class PatientHistoryModalComponent implements OnInit, OnDestroy {
  @Input() isVisible = true;
  @Input() patientId = '';
  @Input() patientName = '';
  @Output() close = new EventEmitter<void>();

  private historyApi = ApiManager('patient_history');
  history: any[] = [];
  isLoading = false;

  private statusMap: Record<string, string> = {
    ipd: '住院',
    opd: '門診',
    er: '急診',
  };

  get groupedHistory(): any[][] {
    if (!this.history || this.history.length === 0) return [];

    const episodes: any[][] = [];
    let currentEpisode: any[] = [];

    const sortedHistory = [...this.history].sort((a, b) => {
      const timeA = a.timestamp?.toDate
        ? a.timestamp.toDate().getTime()
        : new Date(a.timestamp).getTime();
      const timeB = b.timestamp?.toDate
        ? b.timestamp.toDate().getTime()
        : new Date(b.timestamp).getTime();
      return timeA - timeB;
    });

    sortedHistory.forEach((entry: any) => {
      const isStartEvent = entry.eventType === 'CREATE' || entry.eventType === 'RESTORE_AND_TRANSFER';

      if (isStartEvent && currentEpisode.length > 0) {
        episodes.push(currentEpisode);
        currentEpisode = [];
      }

      currentEpisode.push(entry);

      if (entry.eventType === 'DELETE') {
        episodes.push(currentEpisode);
        currentEpisode = [];
      }
    });

    if (currentEpisode.length > 0) {
      episodes.push(currentEpisode);
    }

    return episodes.reverse();
  }

  ngOnInit(): void {
    document.body.classList.add('modal-open');
    if (this.patientId) {
      this.fetchHistory();
    }
  }

  ngOnDestroy(): void {
    document.body.classList.remove('modal-open');
  }

  async fetchHistory(): Promise<void> {
    this.isLoading = true;
    try {
      const queryConstraints = [
        where('patientId', '==', this.patientId),
        orderBy('timestamp', 'asc'),
      ];
      this.history = await this.historyApi.fetchAll(queryConstraints);
    } catch (error) {
      console.error('讀取歷史紀錄失敗:', error);
      this.history = [];
    } finally {
      this.isLoading = false;
    }
  }

  formatTimestamp(timestampInput: any): string {
    if (!timestampInput) return 'Invalid Date';

    let date: Date;

    if (timestampInput && typeof timestampInput.toDate === 'function') {
      date = timestampInput.toDate();
    } else if (typeof timestampInput === 'string') {
      date = new Date(timestampInput);
    } else {
      date = new Date(timestampInput);
    }

    if (isNaN(date.getTime())) {
      return 'Invalid Date';
    }

    return date.toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  formatEvent(entry: any): string {
    const details = entry.eventDetails;
    const getStatus = (s: string) => `<strong>${escapeHtml(this.statusMap[s] || s)}</strong>`;

    switch (entry.eventType) {
      case 'CREATE':
        return `建立資料 ➝ ${getStatus(details.status)}`;
      case 'TRANSFER':
        if (details.note) {
          return `衝突轉入 ➝ ${getStatus(details.to)}`;
        }
        return `${getStatus(details.from)} ➝ ${getStatus(details.to)}`;
      case 'DELETE':
        return `<strong>結案 (${escapeHtml(details.reason || '未說明')})</strong>`;
      case 'RESTORE_AND_TRANSFER':
        return `資料復原 ➝ ${getStatus(details.restoredTo)}`;
      default:
        return `未知操作: ${escapeHtml(entry.eventType)}`;
    }
  }

  onClose(): void {
    this.close.emit();
  }
}
