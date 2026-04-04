import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { kiditService } from '@/services/kiditService';

@Component({
  selector: 'app-kidit-vascular-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './kidit-vascular-form.component.html',
  styleUrl: './kidit-vascular-form.component.css',
})
export class KiditVascularFormComponent implements OnChanges {
  @Input() type: 'current' | 'unused' = 'current';
  @Input() date = '';
  @Input() eventId = '';
  @Input() initialData: any = null;
  @Input() masterPatient: any = null;
  @Output() updated = new EventEmitter<any>();

  isSaving = false;
  localData: any = {};

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialData'] || changes['masterPatient'] || changes['type']) {
      this.initData();
    }
  }

  private initData(): void {
    if (this.initialData && this.initialData[this.type]) {
      this.localData = JSON.parse(JSON.stringify(this.initialData[this.type]));
    } else if (this.masterPatient?.vascularAccessInfo?.[this.type]) {
      this.localData = JSON.parse(JSON.stringify(this.masterPatient.vascularAccessInfo[this.type]));
    } else {
      this.localData = {
        isAutoCap: false, autoCapSide: '', autoCapSite: '',
        isManuCap: false, manuCapSide: '', manuCapSite: '',
        isPermCath: false, permCathSide: '', permCathSite: '',
        isDoubleLumen: false, dlSide: '', dlSite: '',
      };
    }
  }

  async saveData(): Promise<void> {
    this.isSaving = true;
    try {
      const currentCompleteData = this.initialData || {};
      const newData = { ...currentCompleteData, [this.type]: this.localData };
      await kiditService.updateEventKiDitData(this.date, this.eventId, 'kidit_vascular', newData);
      this.updated.emit(newData);
    } catch (error) {
      console.error('儲存血管通路資料失敗:', error);
      alert('儲存失敗，請稍後再試');
    } finally {
      this.isSaving = false;
    }
  }
}
