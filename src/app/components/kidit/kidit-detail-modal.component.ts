import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { kiditService } from '@/services/kiditService';
import { KiditPatientFormComponent } from './kidit-patient-form.component';
import { KiditHistoryFormComponent } from './kidit-history-form.component';
import { KiditVascularFormComponent } from './kidit-vascular-form.component';

type TabKey = 'movement' | 'vascular' | 'profile' | 'history';

interface Tab {
  key: TabKey;
  label: string;
  requiresSelection: boolean;
}

@Component({
  selector: 'app-kidit-detail-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, KiditPatientFormComponent, KiditHistoryFormComponent, KiditVascularFormComponent],
  templateUrl: './kidit-detail-modal.component.html',
  styleUrl: './kidit-detail-modal.component.css',
})
export class KiditDetailModalComponent implements OnChanges {
  @Input() date = '';
  @Input() events: any[] = [];
  @Output() closeEvent = new EventEmitter<void>();
  @Output() refreshEvent = new EventEmitter<void>();

  activeTab: TabKey = 'movement';
  subTab: 'current' | 'unused' = 'current';
  localEvents: any[] = [];
  selectedPatientId: string | null = null;
  selectedPatientName = '';
  selectedPatientData: any = null;

  // Confirm delete
  pendingDeleteIndex = -1;
  showConfirmDelete = false;
  confirmMessage = '';

  readonly tabs: Tab[] = [
    { key: 'movement', label: '當日病患動態', requiresSelection: false },
    { key: 'vascular', label: '血管通路處置', requiresSelection: true },
    { key: 'profile', label: 'KiDit 病患資料', requiresSelection: true },
    { key: 'history', label: 'KiDit 病史原發病', requiresSelection: true },
  ];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['events']) {
      this.localEvents = JSON.parse(JSON.stringify(this.events || []));
    }
  }

  get selectedPatient() {
    if (!this.selectedPatientId) return null;
    return { id: this.selectedPatientId, name: this.selectedPatientName };
  }

  get selectedEvent() {
    return this.localEvents.find(e => e.patientId === this.selectedPatientId) || {};
  }

  getEventData(key: string) {
    return this.selectedEvent[key] || null;
  }

  translateType(type: string): string {
    const map: Record<string, string> = { MOVEMENT: '動態', ACCESS: '通路', TRANSFER: '轉移', CREATE: '新收', DELETE: '結案' };
    return map[type] || type;
  }

  getBadgeClass(type: string): string {
    const map: Record<string, string> = {
      MOVEMENT: 'badge-blue',
      ACCESS: 'badge-purple',
      TRANSFER: 'badge-yellow',
      CREATE: 'badge-green',
      DELETE: 'badge-red',
    };
    return map[type] || 'badge-gray';
  }

  selectPatient(event: any): void {
    this.selectedPatientId = event.patientId;
    this.selectedPatientName = event.patientName;
    this.loadPatientMasterData();
  }

  async loadPatientMasterData(): Promise<void> {
    if (this.selectedPatientId) {
      this.selectedPatientData = await kiditService.fetchPatientMasterRecord(this.selectedPatientId);
    } else {
      this.selectedPatientData = null;
    }
  }

  handleTabClick(key: TabKey): void {
    const tab = this.tabs.find(t => t.key === key);
    if (tab?.requiresSelection && !this.selectedPatientId) {
      alert('請先在列表中點選一位病人');
      return;
    }
    this.activeTab = key;
  }

  handleDataUpdated(key: string, newData: any): void {
    const targetEvent = this.localEvents.find(e => e.patientId === this.selectedPatientId);
    if (targetEvent && key) {
      targetEvent[key] = JSON.parse(JSON.stringify(newData));
    }
    alert('資料已儲存！');
    this.refreshEvent.emit();
  }

  handleIncompleteClick(event: any): void {
    this.selectPatient(event);
    this.handleTabClick('profile');
  }

  isKiDitDataComplete(event: any): boolean {
    const hasProfile = event.kidit_profile && event.kidit_profile.idNumber;
    const hasHistory = event.kidit_history && event.kidit_history.diagnosisCategory;
    return !!hasProfile && !!hasHistory;
  }

  // Delete flow
  deleteEvent(index: number): void {
    const event = this.localEvents[index];
    this.pendingDeleteIndex = index;
    this.confirmMessage = `確定要移除 ${event.patientName} 的這筆紀錄嗎？`;
    this.showConfirmDelete = true;
  }

  executeDelete(): void {
    if (this.pendingDeleteIndex !== -1) {
      const deletedEvent = this.localEvents[this.pendingDeleteIndex];
      this.localEvents.splice(this.pendingDeleteIndex, 1);
      if (deletedEvent.patientId === this.selectedPatientId) {
        this.selectedPatientId = null;
        this.selectedPatientName = '';
      }
      this.pendingDeleteIndex = -1;
    }
    this.showConfirmDelete = false;
  }

  cancelDelete(): void {
    this.showConfirmDelete = false;
    this.pendingDeleteIndex = -1;
  }

  async saveAllEvents(): Promise<void> {
    try {
      await kiditService.updateLogEvents(this.date, this.localEvents);
      alert('動態列表儲存成功！');
      this.refreshEvent.emit();
    } catch (e) {
      console.error(e);
      alert('儲存失敗，請稍後再試。');
    }
  }

  close(): void {
    this.closeEvent.emit();
    this.activeTab = 'movement';
    this.selectedPatientId = null;
  }
}
