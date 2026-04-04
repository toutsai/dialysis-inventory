import {
  Component,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  inject,
  signal,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FullCalendarModule } from '@fullcalendar/angular';
import { CalendarOptions, CalendarApi } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import zhTwLocale from '@fullcalendar/core/locales/zh-tw';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  deleteDoc,
  doc,
  addDoc,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { AuthService } from '@app/core/services/auth.service';
import { FirebaseService } from '@app/core/services/firebase.service';
import { PatientStoreService } from '@app/core/services/patient-store.service';
import { NotificationService } from '@app/core/services/notification.service';
import { ConfirmDialogComponent } from '@app/components/dialogs/confirm-dialog/confirm-dialog.component';
import { NewUpdateTypeDialogComponent } from '@app/components/dialogs/new-update-type-dialog/new-update-type-dialog.component';
import { PatientUpdateSchedulerDialogComponent } from '@app/components/dialogs/patient-update-scheduler-dialog/patient-update-scheduler-dialog.component';

@Component({
  selector: 'app-update-scheduler',
  standalone: true,
  imports: [
    CommonModule,
    FullCalendarModule,
    ConfirmDialogComponent,
    NewUpdateTypeDialogComponent,
    PatientUpdateSchedulerDialogComponent,
  ],
  templateUrl: './update-scheduler.component.html',
  styleUrl: './update-scheduler.component.css',
})
export class UpdateSchedulerComponent implements OnInit, OnDestroy {
  private readonly authService = inject(AuthService);
  private readonly firebase = inject(FirebaseService);
  private readonly patientStore = inject(PatientStoreService);
  private readonly notificationService = inject(NotificationService);

  readonly allPatients = this.patientStore.allPatients;
  isPageLocked = computed(() => !this.authService.canEditSchedules());

  scheduledUpdates = signal<any[]>([]);
  isLoading = signal(true);

  isConfirmDialogVisible = signal(false);
  confirmDialogTitle = signal('');
  confirmDialogMessage = signal('');
  currentUpdateForAction = signal<any>(null);

  isNewTypeDialogVisible = signal(false);
  isSchedulerDialogVisible = signal(false);
  patientForScheduler = signal<any>(null);
  changeTypeForScheduler = signal('');
  isEditingUpdate = signal(false);

  calendarTitle = signal('');

  private unsubscribe: Unsubscribe | null = null;
  private calendarApi: CalendarApi | null = null;
  @ViewChild('fullCalendar') fullCalendarRef!: ElementRef;

  TYPE_MAP: Record<string, string> = {
    UPDATE_STATUS: '身分變更',
    UPDATE_MODE: '模式變更',
    UPDATE_FREQ: '頻率變更',
    UPDATE_BASE_SCHEDULE_RULE: '總表規則變更',
    DELETE_PATIENT: '刪除病人',
    RESTORE_PATIENT: '復原病人',
  };

  STATUS_MAP: Record<string, { text: string; color: string; prefix: string }> = {
    pending: { text: '待執行', color: '#ffc107', prefix: '[待]' },
    completed: { text: '已完成', color: '#198754', prefix: '[✓]' },
    error: { text: '執行失敗', color: '#dc3545', prefix: '[!]' },
  };

  calendarEvents = computed(() => {
    return this.scheduledUpdates().map((update: any) => {
      const statusInfo = this.STATUS_MAP[update.status] || {
        text: '未知',
        color: '#6c757d',
        prefix: '[?]',
      };
      const typeText = this.TYPE_MAP[update.changeType] || '未知變更';
      const title = `${statusInfo.prefix} ${update.patientName} - ${typeText}`;
      return {
        id: update.id,
        title: title,
        start: update.effectiveDate,
        allDay: true,
        backgroundColor: statusInfo.color,
        borderColor: statusInfo.color,
        extendedProps: update,
      };
    });
  });

  calendarOptions = computed<CalendarOptions>(() => ({
    plugins: [dayGridPlugin, interactionPlugin],
    initialView: 'dayGridMonth',
    locale: zhTwLocale,
    headerToolbar: false,
    dayMaxEvents: true,
    events: this.calendarEvents(),
    datesSet: (arg) => {
      this.calendarTitle.set(arg.view.title);
    },
    eventClick: (info) => {
      this.handleEventClick(info.event.extendedProps);
    },
  }));

  ngOnInit(): void {
    this.patientStore.fetchPatientsIfNeeded().then(() => {
      this.initializeListener();
    });
  }

  ngOnDestroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  }

  // --- Calendar Navigation ---
  handlePrev(): void {
    this.calendarApi?.prev();
  }

  handleNext(): void {
    this.calendarApi?.next();
  }

  handleToday(): void {
    this.calendarApi?.today();
  }

  // --- Format ---
  formatPayload(update: any): string {
    const { changeType, payload } = update;
    switch (changeType) {
      case 'UPDATE_STATUS':
        return `新身分: ${payload.status.toUpperCase()}${payload.wardNumber ? ` (${payload.wardNumber})` : ''}`;
      case 'UPDATE_MODE':
        return `新模式: ${payload.mode}`;
      case 'UPDATE_FREQ':
        return `新頻率: ${payload.freq}`;
      case 'UPDATE_BASE_SCHEDULE_RULE': {
        const shiftMap: Record<number, string> = { 0: '早', 1: '午', 2: '晚' };
        const bed = String(payload.bedNum).startsWith('p')
          ? `外圍${String(payload.bedNum).slice(-1)}`
          : `${payload.bedNum}床`;
        return `新規則: ${bed} / ${shiftMap[payload.shiftIndex]}班 / ${payload.freq}`;
      }
      case 'DELETE_PATIENT':
        return `原因: ${payload.deleteReason}${payload.remarks ? ` (${payload.remarks})` : ''}`;
      case 'RESTORE_PATIENT': {
        const statusMap: Record<string, string> = { opd: '門診', ipd: '住院', er: '急診' };
        return `復原至: ${statusMap[payload.status] || payload.status.toUpperCase()}${payload.wardNumber ? ` (${payload.wardNumber})` : ''}`;
      }
      default:
        return JSON.stringify(payload);
    }
  }

  // --- Event Handling ---
  handleEventClick(update: any): void {
    this.currentUpdateForAction.set(update);
    const statusInfo = this.STATUS_MAP[update.status] || { text: '未知' };
    this.confirmDialogTitle.set('預約變更詳情');
    this.confirmDialogMessage.set(
      `病人: ${update.patientName}\n` +
        `類型: ${this.TYPE_MAP[update.changeType] || '未知'}\n` +
        `生效日: ${update.effectiveDate}\n` +
        `狀態: ${statusInfo.text}\n` +
        `詳情: ${this.formatPayload(update)}\n`,
    );
    if (update.status === 'error' && update.errorMessage) {
      this.confirmDialogMessage.update((msg) => msg + `\n錯誤訊息: ${update.errorMessage}`);
    }
    this.isConfirmDialogVisible.set(true);
  }

  handleEdit(): void {
    const update = this.currentUpdateForAction();
    if (!update) return;
    this.patientForScheduler.set({
      id: update.patientId,
      name: update.patientName,
    });
    this.changeTypeForScheduler.set(update.changeType);
    this.isEditingUpdate.set(true);
    this.isConfirmDialogVisible.set(false);
    setTimeout(() => {
      this.isSchedulerDialogVisible.set(true);
    }, 150);
  }

  async handleDelete(): Promise<void> {
    const update = this.currentUpdateForAction();
    if (!update?.id) return;
    this.isConfirmDialogVisible.set(false);
    try {
      await deleteDoc(doc(this.firebase.db, 'scheduled_patient_updates', update.id));
      const typeText = this.TYPE_MAP[update.changeType] || '預約';
      this.notificationService.createGlobalNotification(
        `成功撤銷 ${update.patientName} 的 ${typeText}`,
        'success',
      );
    } catch (error: any) {
      console.error('撤銷預約失敗:', error);
      this.notificationService.createGlobalNotification(`撤銷失敗: ${error.message}`, 'error');
    } finally {
      this.currentUpdateForAction.set(null);
    }
  }

  canDeleteUpdate(update: any): boolean {
    if (!update || update.status !== 'pending') return false;
    return new Date(update.effectiveDate) >= new Date(new Date().toISOString().split('T')[0]);
  }

  // --- Dialog Functions ---
  openNewUpdateDialog(): void {
    if (this.isPageLocked()) return;
    this.isNewTypeDialogVisible.set(true);
  }

  handleNewTypeSelected(event: any): void {
    this.patientForScheduler.set(event.patient);
    this.changeTypeForScheduler.set(event.changeType);
    this.isNewTypeDialogVisible.set(false);
    setTimeout(() => {
      this.isSchedulerDialogVisible.set(true);
    }, 150);
  }

  closeSchedulerDialogs(): void {
    this.isSchedulerDialogVisible.set(false);
    this.isEditingUpdate.set(false);
  }

  async handleScheduledUpdate(dataToSubmit: any): Promise<void> {
    this.isSchedulerDialogVisible.set(false);
    try {
      if (this.isEditingUpdate() && this.currentUpdateForAction()?.id) {
        const docRef = doc(
          this.firebase.db,
          'scheduled_patient_updates',
          this.currentUpdateForAction().id,
        );
        await setDoc(docRef, dataToSubmit, { merge: true });
        this.notificationService.createGlobalNotification('預約變更已成功更新', 'success');
      } else {
        await addDoc(collection(this.firebase.db, 'scheduled_patient_updates'), dataToSubmit);
        this.notificationService.createGlobalNotification(
          '預約成功！變更將在指定日期自動生效。',
          'success',
        );
      }
    } catch (error: any) {
      console.error('提交預約失敗:', error);
      this.notificationService.createGlobalNotification(`操作失敗: ${error.message}`, 'error');
    } finally {
      this.isEditingUpdate.set(false);
      this.currentUpdateForAction.set(null);
    }
  }

  closeConfirmDialog(): void {
    this.isConfirmDialogVisible.set(false);
  }

  private initializeListener(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.isLoading.set(true);
    const q = query(
      collection(this.firebase.db, 'scheduled_patient_updates'),
      orderBy('createdAt', 'desc'),
    );
    this.unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        this.scheduledUpdates.set(
          snapshot.docs.map((d) => ({ id: d.id, ...d.data() })),
        );
        this.isLoading.set(false);
      },
      (error) => {
        console.error('監聽預約變更時發生錯誤:', error);
        this.isLoading.set(false);
      },
    );
  }
}
