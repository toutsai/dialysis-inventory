import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { serverTimestamp } from 'firebase/firestore';
import { AuthService } from '@services/auth.service';
import { NotificationService, type NotificationType } from '@services/notification.service';
import { UserDirectoryService, DirectoryUser } from '@services/user-directory.service';
import ApiManager from '@/services/api_manager';
import { getToday } from '@/utils/dateUtils';
import { PatientSelectDialogComponent } from '../patient-select-dialog/patient-select-dialog.component';

interface SupplyItem {
  id: number;
  type: string;
  spec: string;
  quantity: number;
}

@Component({
  selector: 'app-task-create-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, PatientSelectDialogComponent],
  templateUrl: './task-create-dialog.component.html',
  styleUrl: './task-create-dialog.component.css'
})
export class TaskCreateDialogComponent implements OnChanges, OnInit {
  @Input() isVisible = false;
  @Input() preselectedPatient: any = null;
  @Input() allPatients: any[] = [];
  @Input() initialData: any = null;
  @Output() close = new EventEmitter<void>();
  @Output() submit = new EventEmitter<any>();

  private authService = inject(AuthService);
  private notificationService = inject(NotificationService);
  private userDirectoryService = inject(UserDirectoryService);
  private tasksApi = ApiManager('tasks');

  isSubmitting = false;
  isPatientDialogVisible = false;
  selectedPatient: any = null;

  formData = {
    id: null as string | null,
    category: 'message',
    assigneeRole: '',
    assigneeUserId: '',
    targetDate: getToday(),
    content: '',
    messageType: '常規'
  };

  readonly messageTypeOptions = [
    { value: '常規', label: '一般交班', icon: '📝' },
    { value: '抽血', label: '抽血提醒', icon: '🩸' },
    { value: '衛教', label: '衛教事項', icon: '📢' },
  ];

  readonly assigneeOptions = [
    { value: 'clerk', label: '書記' },
    { value: 'doctor', label: '醫師' },
    { value: 'np', label: '專科護理師' },
    { value: 'nurse_individual', label: '護理師 (指定)' },
    { value: 'nurse_leader', label: '護理師組長' },
  ];

  private readonly titleToRoleValue: Record<string, string> = {
    '書記': 'clerk',
    '主治醫師': 'doctor',
    '專科護理師': 'np',
    '護理師': 'nurse_individual',
    '護理長': 'nurse_individual',
  };

  readonly akOptions = ['13M', '15S', '17UX', '17HX', 'FX80', 'BG-1.8U', 'Pro-19H', '21S', 'Hi23', '25S', 'CTA2000'];
  readonly aLiquidOptions = ['2.5', '3.0', '3.5'];
  readonly bLiquidOptions = ['5L B液', '罐裝B粉', '袋裝B粉'];
  readonly medicalSuppliesOptions = ['傷口照護包', '住院包', 'EKG貼片', 'OP site(每周)', 'OP site(每三天)', '鼻導管'];

  supplyTypeOptions = [
    { value: 'AK', label: 'AK' },
    { value: 'A液', label: 'A液' },
    { value: 'B液', label: 'B液' },
    { value: 'Tubing', label: 'Tubing' },
    { value: 'NS500', label: 'NS (500cc)' },
    { value: 'NS1000', label: 'NS (1000cc)' },
    { value: '耗衛材', label: '耗衛材' },
  ];

  dynamicSupplyItems: SupplyItem[] = [];
  otherSupplyInfo = '';

  get isEditMode(): boolean {
    return !!this.initialData;
  }

  get isClerkSupplyTask(): boolean {
    return this.formData.category === 'task' && this.formData.assigneeRole === 'clerk' && !this.isEditMode;
  }

  get filteredAssigneeUsers(): DirectoryUser[] {
    if (!this.formData.assigneeRole || this.formData.assigneeRole === 'nurse_leader') return [];
    return this.userDirectoryService.users()
      .filter((user: DirectoryUser) => this.titleToRoleValue[user.title] === this.formData.assigneeRole)
      .sort((a: DirectoryUser, b: DirectoryUser) => (a.name || '').localeCompare(b.name || ''));
  }

  get selectedAssigneeLabel(): string {
    const matched = this.assigneeOptions.find(opt => opt.value === this.formData.assigneeRole);
    return matched?.label || '指定職務';
  }

  get selectedAssigneeUser(): DirectoryUser | null {
    return this.userDirectoryService.users().find((user: DirectoryUser) => user.uid === this.formData.assigneeUserId) || null;
  }

  get isFormValid(): boolean {
    if (this.isEditMode) return true;
    if (this.isClerkSupplyTask) {
      const allItemsValid = this.dynamicSupplyItems.every(item => {
        if (['AK', 'A液', 'B液', '耗衛材'].includes(item.type)) {
          return item.type && item.spec && item.quantity > 0;
        }
        return item.type && item.quantity > 0;
      });
      if (this.dynamicSupplyItems.length === 0) return this.otherSupplyInfo.trim() !== '';
      return allItemsValid;
    }
    if (this.formData.category === 'task') {
      if (this.formData.assigneeRole === 'nurse_leader') return true;
      if (!this.formData.assigneeRole || !this.formData.assigneeUserId) return false;
    }
    return true;
  }

  ngOnInit() {
    this.userDirectoryService.ensureUsersLoaded().catch(err => console.error('Failed to load user directory', err));
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['isVisible'] && this.isVisible) {
      this.userDirectoryService.ensureUsersLoaded().catch(err => console.error('Failed to load user directory', err));
      if (this.isEditMode) {
        const item = this.initialData;
        this.formData.id = item.id;
        this.formData.category = item.assignee ? 'task' : 'message';
        if (item.assignee) {
          if (item.assignee.type === 'role' && item.assignee.role === 'editor') {
            this.formData.assigneeRole = 'nurse_leader';
            this.formData.assigneeUserId = '';
          } else if (item.assignee.type === 'user' && item.assignee.role === 'editor') {
            this.formData.assigneeRole = 'nurse_individual';
            this.formData.assigneeUserId = item.assignee.value;
          } else {
            this.formData.assigneeRole = item.assignee.role || item.assignee.value || '';
            this.formData.assigneeUserId = item.assignee.value;
          }
        }
        this.formData.targetDate = item.targetDate || getToday();
        this.formData.content = item.content;
        this.formData.messageType = item.type || '常規';
        if (item.patientId) {
          this.selectedPatient = this.allPatients.find(p => p.id === item.patientId) || null;
        } else {
          this.selectedPatient = null;
        }
      } else {
        this.resetForm();
      }
    }
  }

  addSupplyItem() {
    this.dynamicSupplyItems.push({ id: Date.now(), type: '', spec: '', quantity: 1 });
  }

  removeSupplyItem(index: number) {
    this.dynamicSupplyItems.splice(index, 1);
  }

  onItemTypeChange(item: SupplyItem) {
    item.spec = '';
  }

  selectAssigneeRole(role: string) {
    this.formData.assigneeRole = role;
    this.formData.assigneeUserId = '';
    const candidates = this.filteredAssigneeUsers;
    if (candidates.length === 1) {
      this.formData.assigneeUserId = candidates[0].uid;
    }
  }

  resetForm() {
    this.formData = {
      id: null,
      category: 'message',
      assigneeRole: '',
      assigneeUserId: '',
      targetDate: getToday(),
      content: '',
      messageType: '常規'
    };
    this.selectedPatient = this.preselectedPatient || null;
    this.dynamicSupplyItems = [];
    this.otherSupplyInfo = '';
  }

  handlePatientSelected(event: any) {
    const patientId = event.patientId || event;
    this.selectedPatient = this.allPatients.find(p => p.id === patientId) || null;
    this.isPatientDialogVisible = false;
  }

  clearPatient() {
    this.selectedPatient = null;
  }

  decrementQuantity(item: SupplyItem) {
    if (item.quantity > 0) item.quantity--;
  }

  incrementQuantity(item: SupplyItem) {
    item.quantity++;
  }

  async handleSubmit() {
    if (this.isClerkSupplyTask) {
      const parts = this.dynamicSupplyItems
        .filter(item => item.type && item.quantity > 0)
        .map(item => {
          let itemName = this.supplyTypeOptions.find(opt => opt.value === item.type)?.label || item.type;
          if (item.spec) itemName += ` (${item.spec})`;
          return `${itemName} x${item.quantity}`;
        });
      let generatedContent = parts.length > 0 ? `補帳：${parts.join('、')}` : '';
      if (this.otherSupplyInfo.trim()) {
        generatedContent += `${generatedContent ? '。' : ''}其他：${this.otherSupplyInfo.trim()}`;
      }
      this.formData.content = generatedContent;
    }

    if (!this.isFormValid) return;
    this.isSubmitting = true;
    const currentUser = this.authService.currentUser();

    if (!this.isEditMode) {
      const expireAtDate = new Date();
      expireAtDate.setMonth(expireAtDate.getMonth() + 2);

      const dataToSave: any = {
        category: this.formData.category,
        content: this.formData.content.trim(),
        status: 'pending',
        creator: {
          uid: currentUser?.uid,
          name: currentUser?.name,
          title: currentUser?.title,
        },
        patientId: this.selectedPatient?.id || null,
        patientName: this.selectedPatient?.name || null,
        createdAt: serverTimestamp(),
        expireAt: expireAtDate,
      };

      if (dataToSave.category === 'task') {
        if (this.formData.assigneeRole === 'nurse_leader') {
          dataToSave.assignee = { type: 'role', role: 'editor', value: 'editor', name: '護理師組長', title: '職務指派' };
        } else if (this.formData.assigneeRole === 'nurse_individual') {
          dataToSave.assignee = { type: 'user', role: 'editor', value: this.formData.assigneeUserId, name: this.selectedAssigneeUser?.name || '', title: this.selectedAssigneeUser?.title || '' };
        } else {
          dataToSave.assignee = { type: 'user', role: this.formData.assigneeRole, value: this.formData.assigneeUserId, name: this.selectedAssigneeUser?.name || '', title: this.selectedAssigneeUser?.title || '' };
        }
        dataToSave.targetDate = getToday();
      } else {
        dataToSave.type = this.formData.messageType;
        dataToSave.targetDate = this.formData.targetDate;
        dataToSave.assignee = null;
      }

      try {
        const savedDoc = await this.tasksApi.save(dataToSave);
        let notifMessage = '';
        let notifType: NotificationType = 'info';
        if (dataToSave.category === 'message') {
          const typeLabel = this.messageTypeOptions.find(opt => opt.value === dataToSave.type)?.label || '新留言';
          const patientPart = dataToSave.patientName ? `給 ${dataToSave.patientName}` : '';
          const contentPart = dataToSave.content.substring(0, 15) + (dataToSave.content.length > 15 ? '...' : '');
          notifMessage = `${typeLabel}: ${patientPart} - ${contentPart}`;
          notifType = 'message';
        } else {
          const assigneeLabel = dataToSave.assignee.name || '指定人員';
          notifMessage = `新交辦: 給 ${assigneeLabel} - ${dataToSave.content.substring(0, 20)}...`;
          notifType = 'task';
        }
        this.notificationService.createGlobalNotification(notifMessage, notifType, { documentId: savedDoc.id } as any);
        this.submit.emit({ ...dataToSave, id: savedDoc.id });
        this.handleClose();
      } catch (error) {
        console.error('Failed to create:', error);
      } finally {
        this.isSubmitting = false;
      }
    } else {
      const dataToUpdate: any = {
        content: this.formData.content.trim(),
        lastEditedBy: { uid: currentUser?.uid, name: currentUser?.name },
        lastEditedAt: serverTimestamp(),
      };
      if (this.formData.category === 'message') {
        dataToUpdate.type = this.formData.messageType;
        dataToUpdate.targetDate = this.formData.targetDate;
      }
      this.submit.emit({ id: this.formData.id, ...dataToUpdate });
      this.isSubmitting = false;
    }
  }

  handleClose(): void {
    this.close.emit();
  }
}
