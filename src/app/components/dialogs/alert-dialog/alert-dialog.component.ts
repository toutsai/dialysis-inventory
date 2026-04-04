import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-alert-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './alert-dialog.component.html',
  styleUrl: './alert-dialog.component.css'
})
export class AlertDialogComponent {
  @Input() isVisible = false;
  @Input() title = '';
  @Input() message = '';
  @Output() confirm = new EventEmitter<void>();

  handleConfirm(): void {
    this.confirm.emit();
  }
}
