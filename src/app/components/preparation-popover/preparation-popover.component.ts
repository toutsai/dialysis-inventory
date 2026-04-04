import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, ElementRef, ViewChild, AfterViewChecked, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-preparation-popover',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './preparation-popover.component.html',
  styleUrl: './preparation-popover.component.css'
})
export class PreparationPopoverComponent implements OnChanges, AfterViewChecked {
  @Input() isVisible = false;
  @Input() patients: any[] = [];
  @Input() targetElement: any = null;
  @Output() closeEvent = new EventEmitter<void>();
  @Output() openOrderModal = new EventEmitter<any>();

  @ViewChild('popoverRef') popoverRef!: ElementRef;

  popoverStyle: Record<string, string> = {};
  private needsPositionUpdate = false;

  get hasPatients(): boolean {
    return this.patients && this.patients.length > 0;
  }

  private skipNextClick = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      this.needsPositionUpdate = true;
      this.skipNextClick = true;
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.isVisible) return;
    if (this.skipNextClick) {
      this.skipNextClick = false;
      return;
    }
    if (this.popoverRef?.nativeElement && !this.popoverRef.nativeElement.contains(event.target)) {
      this.close();
    }
  }

  ngAfterViewChecked(): void {
    if (this.needsPositionUpdate && this.isVisible && this.popoverRef?.nativeElement) {
      this.needsPositionUpdate = false;
      this.updatePosition();
    }
  }

  private updatePosition(): void {
    if (!this.targetElement) {
      this.popoverStyle = { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
      return;
    }

    const trigger = this.targetElement instanceof HTMLElement ? this.targetElement : this.targetElement.nativeElement;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const popover = this.popoverRef.nativeElement;
    const popoverRect = popover.getBoundingClientRect();

    let top = rect.bottom + 4;
    let left = rect.left;

    // Ensure within viewport
    if (top + popoverRect.height > window.innerHeight) {
      top = rect.top - popoverRect.height - 4;
    }
    if (left + popoverRect.width > window.innerWidth) {
      left = window.innerWidth - popoverRect.width - 8;
    }
    if (left < 8) left = 8;

    this.popoverStyle = { position: 'fixed', top: `${top}px`, left: `${left}px` };
  }

  handleNameClick(patient: any): void {
    this.openOrderModal.emit(patient);
  }

  close(): void {
    this.closeEvent.emit();
  }
}
