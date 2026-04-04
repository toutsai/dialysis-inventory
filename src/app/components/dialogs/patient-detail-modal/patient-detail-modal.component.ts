import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '@services/auth.service';
import { FirebaseService } from '@services/firebase.service';
import { TaskStoreService } from '@services/task-store.service';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { getShiftDisplayName } from '@/constants/scheduleConstants';
import { ConditionRecordPanelComponent } from '../../condition-record-panel/condition-record-panel.component';
import { MemoPanelComponent } from '../../memo-panel/memo-panel.component';
import { PatientLabSummaryPanelComponent } from '../../patient-lab-summary-panel/patient-lab-summary-panel.component';
import { LabMedCorrelationViewComponent } from '../../lab-med-correlation-view/lab-med-correlation-view.component';

@Component({
  selector: 'app-patient-detail-modal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ConditionRecordPanelComponent,
    MemoPanelComponent,
    PatientLabSummaryPanelComponent,
    LabMedCorrelationViewComponent,
  ],
  templateUrl: './patient-detail-modal.component.html',
  styleUrl: './patient-detail-modal.component.css'
})
export class PatientDetailModalComponent implements OnChanges, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly firebase = inject(FirebaseService);
  private readonly taskStore = inject(TaskStoreService);

  @Input() isVisible = false;
  @Input() patient: any = null;
  @Input() slotList: any[] = [];
  @Input() currentIndex = 0;
  @Input() currentDate = '';
  @Output() closeEvent = new EventEmitter<void>();
  @Output() recordUpdated = new EventEmitter<void>();
  @Output() switchPatientEvent = new EventEmitter<number>();

  activeTab = 'records';

  get isLockedForThisUser(): boolean {
    return !this.auth.canEditClinicalNotesAndOrders();
  }

  get currentSlotInfo(): { bedNum: string; shift: string } {
    if (!this.slotList || this.slotList.length === 0) {
      return { bedNum: 'N/A', shift: '\u672a\u77e5' };
    }
    const currentSlot = this.slotList[this.currentIndex];
    if (!currentSlot || !currentSlot.shiftId) {
      return { bedNum: 'N/A', shift: '\u672a\u77e5' };
    }
    const shiftId = currentSlot.shiftId;
    const parts = shiftId.split('-');
    const shiftCode = parts[2];
    const bedNum = parts[0] === 'peripheral' ? `\u5916${parts[1]}` : parts[1];
    const shift = getShiftDisplayName(shiftCode);
    return { bedNum, shift };
  }

  get hasPendingMemosForPatient(): boolean {
    if (!this.patient?.id) return false;
    return this.taskStore.sortedFeedMessages().some(
      (msg: any) =>
        msg.patientId === this.patient.id &&
        msg.status === 'pending' &&
        msg.content &&
        !msg.content.startsWith('\u3010'),
    );
  }

  handleClose(): void {
    this.activeTab = 'records';
    this.closeEvent.emit();
  }

  async handleSaveConditionRecord(recordData: any): Promise<void> {
    try {
      const currentUser = this.auth.currentUser();
      if (!currentUser) return;
      await addDoc(collection(this.firebase.db, 'condition_records'), {
        patientId: this.patient.id,
        patientName: this.patient.name,
        content: recordData.content,
        authorName: currentUser.name || (currentUser as any).displayName || '',
        authorId: currentUser.uid,
        recordDate: this.currentDate || new Date().toISOString().split('T')[0],
        createdAt: serverTimestamp(),
      });
      this.recordUpdated.emit();
    } catch (err) {
      console.error('Failed to save condition record:', err);
    }
  }

  async handleSaveLabSummaryAsRecord(data: { patient: any; content: string }): Promise<void> {
    try {
      const currentUser = this.auth.currentUser();
      if (!currentUser) return;
      await addDoc(collection(this.firebase.db, 'condition_records'), {
        patientId: data.patient.id,
        patientName: data.patient.name,
        content: data.content,
        authorName: currentUser.name || (currentUser as any).displayName || '',
        authorId: currentUser.uid,
        recordDate: this.currentDate || new Date().toISOString().split('T')[0],
        createdAt: serverTimestamp(),
      });
      this.recordUpdated.emit();
    } catch (err) {
      console.error('Failed to save lab summary as record:', err);
    }
  }

  switchToPatient(newIndex: number): void {
    if (newIndex < 0 || newIndex >= this.slotList.length) return;
    this.switchPatientEvent.emit(newIndex);
  }

  ngOnChanges(_changes: SimpleChanges): void {}

  ngOnDestroy(): void {}
}
