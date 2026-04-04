import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FirebaseService } from '@services/firebase.service';
import { AuthService } from '@app/core/services/auth.service';
import { doc, setDoc } from 'firebase/firestore';

@Component({
  selector: 'app-handover-notes-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './handover-notes-dialog.component.html',
  styleUrl: './handover-notes-dialog.component.css'
})
export class HandoverNotesDialogComponent implements OnChanges {
  private readonly firebase = inject(FirebaseService);
  private readonly auth = inject(AuthService);

  @Input() isVisible = false;
  @Input() initialNotes = '';
  @Input() targetDate = '';
  @Output() closeEvent = new EventEmitter<void>();
  @Output() notesUpdated = new EventEmitter<string>();

  editableNotes = '';
  isSaving = false;
  saveStatus = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      this.editableNotes = this.initialNotes || '';
      this.saveStatus = '';
    }
  }

  async handleSave(): Promise<void> {
    const currentUser = this.auth.currentUser();
    if (!currentUser) {
      alert('您必須登入才能儲存。');
      return;
    }
    this.isSaving = true;
    this.saveStatus = '儲存中...';

    const handoverContent = this.editableNotes.trim();

    try {
      const handoverLogRef = doc(this.firebase.db, 'handover_logs', 'latest');
      await setDoc(handoverLogRef, {
        content: handoverContent,
        updatedBy: {
          uid: currentUser.uid,
          name: currentUser.name,
        },
        updatedAt: new Date(),
        sourceDate: this.targetDate,
      });

      this.notesUpdated.emit(handoverContent);
      this.saveStatus = `儲存成功！ (${new Date().toLocaleTimeString()})`;

      setTimeout(() => {
        this.close();
      }, 1000);
    } catch (error) {
      console.error('儲存交班事項失敗:', error);
      this.saveStatus = '儲存失敗，請重試。';
    } finally {
      this.isSaving = false;
    }
  }

  close(): void {
    this.closeEvent.emit();
  }
}
