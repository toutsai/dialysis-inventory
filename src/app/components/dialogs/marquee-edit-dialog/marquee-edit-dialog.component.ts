import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { QuillModule } from 'ngx-quill';

@Component({
  selector: 'app-marquee-edit-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, QuillModule],
  templateUrl: './marquee-edit-dialog.component.html',
  styleUrl: './marquee-edit-dialog.component.css'
})
export class MarqueeEditDialogComponent implements OnChanges {
  @Input() isVisible = false;
  @Input() initialContent = '';
  @Output() close = new EventEmitter<void>();
  @Output() save = new EventEmitter<string>();

  editableContent = '';
  isSaving = false;

  toolbarOptions = [
    ['bold', 'italic'],
    [{ size: ['small', false, 'large', 'huge'] }],
    [{ color: [] }],
    ['clean'],
  ];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      this.editableContent = this.initialContent || '';
    }
  }

  handleSave(): void {
    this.save.emit(this.editableContent);
  }

  onClose(): void {
    this.close.emit();
  }
}
