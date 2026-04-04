import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-ward-number-badge',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ward-number-badge.component.html',
  styleUrl: './ward-number-badge.component.css'
})
export class WardNumberBadgeComponent implements OnChanges {
  @Input() value = '';
  @Input() placeholder = '床號';
  @Output() update = new EventEmitter<string | null>();

  @ViewChild('inp') inp!: ElementRef<HTMLInputElement>;

  editing = false;
  local = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['value']) {
      this.local = this.value;
    }
  }

  get title(): string {
    return this.value ? `床號：${this.value}（點擊編輯）` : '新增床號';
  }

  startEdit(): void {
    this.editing = true;
    setTimeout(() => this.inp?.nativeElement?.focus(), 0);
  }

  save(): void {
    if (!this.editing) return;
    this.editing = false;

    const ok = /^[-A-Z0-9]+$/i.test(this.local) || this.local === '';
    if (!ok) {
      this.local = this.value;
      return;
    }

    if (this.local !== this.value) {
      this.update.emit(this.local || null);
    }
  }
}
