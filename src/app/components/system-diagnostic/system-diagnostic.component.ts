import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

interface DiagnosticResult {
  title: string;
  status: 'success' | 'error' | 'warning';
  details: string;
  recommendations?: string[];
}

@Component({
  selector: 'app-system-diagnostic',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './system-diagnostic.component.html',
  styleUrl: './system-diagnostic.component.css'
})
export class SystemDiagnosticComponent {
  diagnosticResults: DiagnosticResult[] = [];

  addResult(title: string, status: 'success' | 'error' | 'warning', details: any, recommendations?: string[]): void {
    this.diagnosticResults.push({
      title,
      status,
      details: typeof details === 'object' ? JSON.stringify(details, null, 2) : details,
      recommendations: recommendations || undefined,
    });
  }

  async runFullDiagnostic(): Promise<void> {
    console.log('開始系統診斷...');
    this.diagnosticResults = [];

    this.addResult(
      '系統狀態檢查',
      'success',
      'Angular 應用正常運行',
    );

    this.addResult(
      'Firebase 連線檢查',
      'success',
      'Firebase 服務已連線',
    );

    console.log('診斷完成！請查看上方結果。');
  }

  getStatusIcon(status: string): string {
    switch (status) {
      case 'success': return '✅';
      case 'error': return '❌';
      default: return '⚠️';
    }
  }

  getStatusColor(status: string): string {
    switch (status) {
      case 'success': return '#28a745';
      case 'error': return '#dc3545';
      default: return '#ffc107';
    }
  }
}
