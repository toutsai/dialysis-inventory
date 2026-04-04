import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-patient-action-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './patient-action-modal.component.html',
  styleUrl: './patient-action-modal.component.css'
})
export class PatientActionModalComponent {
  @Input() isVisible = false;
  @Input() patient: any = null;
  @Input() hasMemo = false;
  @Output() selectEvent = new EventEmitter<string>();
  @Output() closeEvent = new EventEmitter<void>();

  closeModal(): void {
    this.closeEvent.emit();
  }

  emitAction(actionType: string): void {
    this.selectEvent.emit(actionType);
  }
}
