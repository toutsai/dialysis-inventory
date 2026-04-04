import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, OnInit, OnDestroy, ViewChild, ElementRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TaskStoreService } from '@services/task-store.service';

@Component({
  selector: 'app-memo-display-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './memo-display-dialog.component.html',
  styleUrl: './memo-display-dialog.component.css'
})
export class MemoDisplayDialogComponent implements OnChanges, OnInit, OnDestroy {
  readonly taskStore = inject(TaskStoreService);

  @Input() isVisible = false;
  @Input() patientId = '';
  @Input() patientName = '';
  @Output() closeEvent = new EventEmitter<void>();

  @ViewChild('dialogRef') dialogRef!: ElementRef<HTMLDialogElement>;

  private dialogCloseHandler = () => this.closeEvent.emit();

  get pendingMessages(): any[] {
    if (!this.patientId) return [];
    const excludedStatuses = new Set(['completed', 'resolved', 'cancelled']);
    return this.taskStore.sortedFeedMessages().filter(
      (msg: any) => msg.patientId === this.patientId && !(msg.status && excludedStatuses.has(msg.status))
    );
  }

  getMessageTypeIcon(type: string): string {
    switch (type) {
      case '抽血': return '🩸';
      case '衛教': return '🎓';
      case '常規':
      default: return '📝';
    }
  }

  ngOnInit(): void {
    // Event listener will be added after view init
  }

  ngOnDestroy(): void {
    if (this.dialogRef?.nativeElement) {
      this.dialogRef.nativeElement.removeEventListener('close', this.dialogCloseHandler);
    }
  }

  ngAfterViewInit(): void {
    if (this.dialogRef?.nativeElement) {
      this.dialogRef.nativeElement.addEventListener('close', this.dialogCloseHandler);
      // If component was created with isVisible already true (e.g. inside @if),
      // ngOnChanges fires before dialogRef is available, so show here.
      if (this.isVisible) {
        this.dialogRef.nativeElement.showModal();
      }
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.dialogRef?.nativeElement) {
      if (this.isVisible) {
        this.dialogRef.nativeElement.showModal();
      } else {
        this.dialogRef.nativeElement.close();
      }
    }
  }

  onClose(): void {
    this.closeEvent.emit();
  }
}
