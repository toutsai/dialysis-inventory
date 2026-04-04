import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-daily-injection-list-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './daily-injection-list-dialog.component.html',
  styleUrl: './daily-injection-list-dialog.component.css'
})
export class DailyInjectionListDialogComponent {
  @Input() isVisible = false;
  @Input() injections: any[] = [];
  @Input() isLoading = false;
  @Input() targetDate = '';
  @Input() filterActive = false;
  @Input() showFilter = false;
  @Output() closeEvent = new EventEmitter<void>();
  @Output() filterActiveChange = new EventEmitter<boolean>();

  get titleDate(): string {
    if (!this.targetDate) return '';
    try {
      const date = new Date(this.targetDate + 'T00:00:00');
      return date.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' });
    } catch {
      return this.targetDate;
    }
  }

  formatShift(shiftCode: string): string {
    const shiftMap: Record<string, string> = { early: '早', noon: '午', late: '晚' };
    return shiftMap[shiftCode] || '未知';
  }

  getMedicationUnit(injection: any): string {
    return injection.unit || '';
  }

  closeDialog(): void {
    this.closeEvent.emit();
  }

  onFilterChange(checked: boolean): void {
    this.filterActiveChange.emit(checked);
  }

  handlePrint(): void {
    const contentToPrint = document.getElementById('injection-list-content');
    if (!contentToPrint) {
      console.error('找不到列印內容區塊！');
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.setAttribute('title', 'Print Frame');

    document.body.appendChild(iframe);
    const iframeDoc = iframe.contentWindow!.document;

    const htmlContent = `
      <html>
        <head>
          <title>本日應打針劑清單</title>
          <style>
            body { font-family: 'Microsoft JhengHei', 'Segoe UI', sans-serif; margin: 20px; font-size: 12pt; }
            .print-header { text-align: center; margin-bottom: 1.5rem; }
            .print-header h4 { font-size: 1.5rem; margin: 0; }
            .injection-table { width: 100%; border-collapse: collapse; font-size: 1em; }
            .injection-table th, .injection-table td { border: 1px solid #aaa; padding: 8px; text-align: center; vertical-align: middle; }
            .injection-table th { background-color: #f2f2f2; font-weight: bold; }
            tr { page-break-inside: avoid; }
          </style>
        </head>
        <body>
          ${contentToPrint.innerHTML}
        </body>
      </html>
    `;

    iframeDoc.open();
    iframeDoc.write(htmlContent);
    iframeDoc.close();

    iframe.onload = function() {
      try {
        iframe.contentWindow!.focus();
        iframe.contentWindow!.print();
      } catch (e) {
        console.error('列印失敗:', e);
      } finally {
        setTimeout(() => {
          document.body.removeChild(iframe);
        }, 500);
      }
    };
  }
}
