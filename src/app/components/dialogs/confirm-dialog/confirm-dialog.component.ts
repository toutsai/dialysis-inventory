import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.css'
})
export class ConfirmDialogComponent {
  @Input() isVisible = true;
  @Input() title = '';
  @Input() message = '';
  @Input() confirmText = '確認';
  @Input() cancelText = '取消';
  @Input() confirmClass = 'btn-primary';
  @Input() cancelClass = 'btn-secondary';
  @Input() hasCustomFooter = false;
  @Output() confirm = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();

  onConfirm(): void {
    this.confirm.emit();
  }

  onCancel(): void {
    this.cancel.emit();
  }
}
