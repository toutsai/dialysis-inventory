import { Component, Input, Output, EventEmitter, OnInit, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-ward-number-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ward-number-dialog.component.html',
  styleUrl: './ward-number-dialog.component.css'
})
export class WardNumberDialogComponent implements OnInit, AfterViewChecked {
  @Input() title = '';
  @Input() message = '';
  @Input() currentValue = '';
  @Output() confirm = new EventEmitter<string>();
  @Output() cancel = new EventEmitter<void>();

  @ViewChild('inputRef') inputRef!: ElementRef<HTMLInputElement>;

  localValue = '';
  private shouldFocus = false;

  ngOnInit(): void {
    document.body.classList.add('modal-open');
    this.localValue = this.currentValue || '';
    this.shouldFocus = true;
  }

  ngAfterViewChecked(): void {
    if (this.shouldFocus && this.inputRef) {
      this.inputRef.nativeElement.focus();
      this.inputRef.nativeElement.select();
      this.shouldFocus = false;
    }
  }

  onConfirm(): void {
    document.body.classList.remove('modal-open');
    this.confirm.emit(this.localValue.trim());
  }

  onCancel(): void {
    document.body.classList.remove('modal-open');
    this.cancel.emit();
  }
}
