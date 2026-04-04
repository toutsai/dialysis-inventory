import {
  Component, Input, Output, EventEmitter,
  ViewChild, ElementRef, AfterViewInit, OnDestroy, NgZone
} from '@angular/core';
import { CommonModule } from '@angular/common';

interface PatientDetails {
  name: string;
  medicalRecordNumber: string;
  diseases: string[];
  patient: any;
}

@Component({
  selector: 'app-schedule-table',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './schedule-table.component.html',
  styleUrl: './schedule-table.component.css'
})
export class ScheduleTableComponent implements AfterViewInit, OnDestroy {
  @ViewChild('theadRef') theadRef!: ElementRef<HTMLTableSectionElement>;

  // --- Inputs (matching Vue props) ---
  @Input() layout: any[] = [];
  @Input() scheduleData: Record<string, any> = {};
  @Input() patientMap: Map<string, any> = new Map();
  @Input() shifts: string[] = [];
  @Input() weekdays: string[] = [];
  @Input() weekDates: string[] = [];
  @Input() hepatitisBeds: any[] = [];
  @Input() getStyleFunc: (slotId: string) => any = () => ({});
  @Input() isDateInPast: (dayIndex: number) => boolean = () => false;
  @Input() typesMap: Map<string, any> = new Map();
  @Input() isPageLocked = false;

  // --- Outputs (matching Vue emits) ---
  @Output() gridClick = new EventEmitter<string>();
  @Output() drop = new EventEmitter<{ event: DragEvent; slotId: string }>();
  @Output() dragStart = new EventEmitter<{ event: DragEvent; slotId: string }>();
  @Output() dragOver = new EventEmitter<DragEvent>();
  @Output() dragLeave = new EventEmitter<DragEvent>();
  @Output() showMemos = new EventEmitter<string>();
  @Output() columnWidthsChange = new EventEmitter<number[]>();
  @Output() leftOffsetChange = new EventEmitter<number>();

  // --- Internal ---
  readonly shiftDisplayNames: Record<string, string> = {
    early: '早班',
    noon: '午班',
    late: '晚班'
  };

  private resizeObserver: ResizeObserver | null = null;
  private isMounted = false;

  constructor(private ngZone: NgZone) {}

  /** Generate array [1, 2, ..., n-1] for iterating remaining shifts after the first */
  get remainingShiftIndices(): number[] {
    return Array.from({ length: this.shifts.length - 1 }, (_, i) => i + 1);
  }

  // --- Lifecycle ---

  ngAfterViewInit(): void {
    this.isMounted = true;
    setTimeout(() => this.measureAndEmitWidths(), 100);

    const tableContainer = this.theadRef?.nativeElement?.closest('.schedule-table-container');
    if (tableContainer) {
      this.ngZone.runOutsideAngular(() => {
        this.resizeObserver = new ResizeObserver(() => {
          this.ngZone.run(() => this.measureAndEmitWidths());
        });
        this.resizeObserver.observe(tableContainer);
      });
    }
    window.addEventListener('resize', this.onWindowResize);
  }

  ngOnDestroy(): void {
    this.isMounted = false;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    window.removeEventListener('resize', this.onWindowResize);
  }

  // --- Methods (ported from Vue ScheduleTable.vue) ---

  isSlotInteractive(dayIndex: number): boolean {
    return !this.isPageLocked && !this.isDateInPast(dayIndex);
  }

  getPatientDetails(slotId: string): PatientDetails | null {
    const slotData = this.scheduleData?.[slotId];
    if (!slotData || !slotData.patientId) return null;
    const patient = this.patientMap?.get(slotData.patientId);
    if (!patient) return null;
    return {
      name: patient.name,
      medicalRecordNumber: patient.medicalRecordNumber,
      diseases: patient.diseases || [],
      patient: patient,
    };
  }

  getBedDisplayName(bedNum: any): string {
    if (typeof bedNum === 'string' && bedNum.startsWith('peripheral-')) {
      const numberPart = bedNum.split('-')[1];
      return `外圍床位 ${numberPart}`;
    }
    return `${bedNum}号床`;
  }

  getShiftDisplayName(shiftCode: string): string {
    return this.shiftDisplayNames[shiftCode] || shiftCode;
  }

  getSlotClasses(slotId: string, dayIndex: number): Record<string, boolean> {
    const styleResult = this.getStyleFunc(slotId);
    const isPast = !this.isSlotInteractive(dayIndex) && this.isDateInPast(dayIndex);
    // Merge string class or object class from getStyleFunc
    if (typeof styleResult === 'string') {
      return { [styleResult]: true, 'is-past': isPast };
    }
    return { ...styleResult, 'is-past': isPast };
  }

  isDraggable(slotId: string, dayIndex: number): string {
    return this.getPatientDetails(slotId) && this.isSlotInteractive(dayIndex) ? 'true' : 'false';
  }

  // --- Event handlers ---

  onGridClick(slotId: string, dayIndex: number): void {
    if (this.isSlotInteractive(dayIndex)) {
      this.gridClick.emit(slotId);
    }
  }

  onDrop(event: DragEvent, slotId: string, dayIndex: number): void {
    if (this.isSlotInteractive(dayIndex)) {
      this.drop.emit({ event, slotId });
    }
  }

  onDragStart(event: DragEvent, slotId: string, dayIndex: number): void {
    if (this.isSlotInteractive(dayIndex)) {
      this.dragStart.emit({ event, slotId });
    }
  }

  onDragOver(event: DragEvent, dayIndex: number): void {
    if (this.isSlotInteractive(dayIndex)) {
      event.preventDefault();
      this.dragOver.emit(event);
    }
  }

  onDragLeave(event: DragEvent): void {
    this.dragLeave.emit(event);
  }

  // --- Column width measurement (ResizeObserver) ---

  private onWindowResize = (): void => {
    this.measureAndEmitWidths();
  };

  private measureAndEmitWidths(): void {
    if (!this.isMounted) return;
    setTimeout(() => {
      const thead = this.theadRef?.nativeElement;
      if (!thead || !thead.isConnected) return;
      const ths = Array.from(thead.querySelectorAll('th'));
      if (ths.length < 3) return;
      try {
        const bedHeaderWidth = ths[0].getBoundingClientRect().width;
        const shiftHeaderWidth = ths[1].getBoundingClientRect().width;
        const leftOffset = bedHeaderWidth + shiftHeaderWidth;
        const dayColumnWidths = ths.slice(2).map(th => th.getBoundingClientRect().width);
        this.leftOffsetChange.emit(leftOffset);
        this.columnWidthsChange.emit(dayColumnWidths);
      } catch (e) {
        console.warn('Could not measure table widths, element might be detached.', e);
      }
    });
  }
}
