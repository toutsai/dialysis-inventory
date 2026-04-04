import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-user-form-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './user-form-modal.component.html',
  styleUrl: './user-form-modal.component.css'
})
export class UserFormModalComponent implements OnChanges {
  @Input() isVisible = false;
  @Input() isEditing = false;
  @Input() user: any = null;
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<any>();

  readonly titles = ['主治醫師', '護理長', '護理師', '專科護理師', '管理員', '書記'];
  readonly roles = [
    { value: 'admin', text: 'Admin (主任/護理長/管理員)' },
    { value: 'contributor', text: 'Contributor (醫師/專師)' },
    { value: 'editor', text: 'Editor (護理師)' },
    { value: 'viewer', text: 'Viewer (書記/白板)' },
  ];

  form: any = this.getDefaultForm();

  private getDefaultForm(): any {
    return {
      id: '',
      name: '',
      username: '',
      password: '',
      title: '護理師',
      role: 'viewer',
      email: '',
      staffId: '',
      phone: '',
      clinicHours: [],
      defaultSchedules: [],
      defaultConsultationSchedules: [],
    };
  }

  get scheduleOptions(): { value: string; label: string }[] {
    const days = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
    const shifts: Record<string, string> = { early: '早', noon: '午', late: '夜' };
    const options: { value: string; label: string }[] = [];
    for (let i = 0; i < days.length; i++) {
      const dayOfWeek = (i + 1) % 7;
      for (const shiftCode in shifts) {
        options.push({
          value: `${dayOfWeek}-${shiftCode}`,
          label: `${days[i]}${shifts[shiftCode]}`,
        });
      }
    }
    return options;
  }

  get consultationScheduleOptions(): { value: string; label: string }[] {
    const days = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
    const shifts: Record<string, string> = { morning: '上午', afternoon: '下午', night: '夜間' };
    const options: { value: string; label: string }[] = [];
    for (let i = 0; i < days.length; i++) {
      const dayOfWeek = (i + 1) % 7;
      for (const shiftCode in shifts) {
        options.push({
          value: `${dayOfWeek}-${shiftCode}`,
          label: `${days[i]}${shifts[shiftCode]}`,
        });
      }
    }
    return options;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      if (this.isEditing && this.user) {
        this.form = {
          ...this.getDefaultForm(),
          ...this.user,
          staffId: this.user.staffId || '',
          phone: this.user.phone || '',
          clinicHours: this.user.clinicHours || [],
          defaultSchedules: this.user.defaultSchedules || [],
          defaultConsultationSchedules: this.user.defaultConsultationSchedules || [],
        };
        this.form.password = '';
      } else {
        this.form = this.getDefaultForm();
      }
    }

    // When title changes, clear physician-specific fields
    if (changes['isVisible']) {
      // Watch will be handled in template via (ngModelChange)
    }
  }

  onTitleChange(): void {
    if (this.form.title !== '主治醫師') {
      this.form.staffId = '';
      this.form.phone = '';
      this.form.clinicHours = [];
      this.form.defaultSchedules = [];
      this.form.defaultConsultationSchedules = [];
    }
  }

  handleSubmit(): void {
    const dataToSave = { ...this.form };
    if (this.isEditing && !dataToSave.password) {
      delete dataToSave.password;
    }
    if (dataToSave.title !== '主治醫師') {
      delete dataToSave.staffId;
      delete dataToSave.phone;
      delete dataToSave.clinicHours;
      delete dataToSave.defaultSchedules;
      delete dataToSave.defaultConsultationSchedules;
    }
    this.saved.emit(dataToSave);
  }

  closeModal(): void {
    this.closed.emit();
  }

  isScheduleChecked(scheduleList: string[], value: string): boolean {
    return scheduleList?.includes(value) || false;
  }

  toggleSchedule(scheduleList: string[], value: string): void {
    const index = scheduleList.indexOf(value);
    if (index > -1) {
      scheduleList.splice(index, 1);
    } else {
      scheduleList.push(value);
    }
  }
}
