import {
  Component,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  inject,
  signal,
  computed,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { FullCalendarModule } from '@fullcalendar/angular';
import { CalendarOptions, CalendarApi } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import zhTwLocale from '@fullcalendar/core/locales/zh-tw';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  deleteDoc,
  doc,
  serverTimestamp,
  where,
  getDocs,
  type Unsubscribe,
} from 'firebase/firestore';
import { AuthService } from '@app/core/services/auth.service';
import { FirebaseService } from '@app/core/services/firebase.service';
import { ApiManagerService, type FirestoreRecord } from '@app/core/services/api-manager.service';
import { PatientStoreService } from '@app/core/services/patient-store.service';
import { NotificationService } from '@app/core/services/notification.service';
import { AlertDialogComponent } from '@app/components/dialogs/alert-dialog/alert-dialog.component';
import { ConfirmDialogComponent } from '@app/components/dialogs/confirm-dialog/confirm-dialog.component';
import { ExceptionCreateDialogComponent } from '@app/components/dialogs/exception-create-dialog/exception-create-dialog.component';
import { MonthYearPickerComponent } from '@app/components/dialogs/month-year-picker/month-year-picker.component';
import { formatDateTimeToLocal, parseFirestoreTimestamp } from '@/utils/dateUtils';

@Component({
  selector: 'app-exception-manager',
  standalone: true,
  imports: [
    CommonModule,
    FullCalendarModule,
    AlertDialogComponent,
    ConfirmDialogComponent,
    ExceptionCreateDialogComponent,
    MonthYearPickerComponent,
  ],
  templateUrl: './exception-manager.component.html',
  styleUrl: './exception-manager.component.css',
})
export class ExceptionManagerComponent implements OnInit, OnDestroy {
  private readonly authService = inject(AuthService);
  private readonly firebase = inject(FirebaseService);
  private readonly apiManager = inject(ApiManagerService);
  private readonly patientStore = inject(PatientStoreService);
  private readonly notificationService = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  private readonly exceptionsApi = this.apiManager.create<FirestoreRecord>('schedule_exceptions');
  private readonly tasksApi = this.apiManager.create<FirestoreRecord>('tasks');

  readonly allPatients = this.patientStore.allPatients;
  readonly currentUser = this.authService.currentUser;

  isPageLocked = computed(() => !this.authService.canEditSchedules());

  exceptions = signal<any[]>([]);
  isLoading = signal(true);
  isCreateDialogVisible = signal(false);
  exceptionToReEdit = signal<any>(null);
  isAlertDialogVisible = signal(false);
  alertDialogTitle = signal('');
  alertDialogMessage = signal('');
  calendarTitle = signal('');
  isMonthPickerVisible = signal(false);

  isActionDialogVisible = signal(false);
  actionDialogTitle = signal('');
  actionDialogMessage = signal('');
  currentActionData = signal<any>(null);

  // Merge dialog state
  isMergeDialogVisible = signal(false);
  mergeDialogMessage = signal('');
  pendingFormData = signal<any>(null);
  existingExceptionsToMerge = signal<any[]>([]);

  private unsubscribe: Unsubscribe | null = null;
  private calendarApi: CalendarApi | null = null;
  @ViewChild('fullCalendar') fullCalendarRef!: ElementRef;

  statusMap: Record<string, string> = {
    pending: '待處理',
    processing: '處理中',
    applied: '已生效',
    error: '錯誤',
    expired: '已過期',
    conflict_requires_resolution: '衝突待解決',
    cancelled: '已撤銷',
  };
  typeMap: Record<string, string> = {
    MOVE: '臨時調班',
    SUSPEND: '區間暫停',
    ADD_SESSION: '臨時加洗',
    RANGE_MOVE: '區間調班',
    SWAP: '同日互調',
  };
  shiftMap: Record<string, string> = { early: '早班', noon: '午班', late: '晚班' };

  calendarEvents = computed(() => {
    const exList = this.exceptions();
    if (!exList) return [];
    return exList.flatMap((ex: any) => {
      const statusStyles: Record<string, { color: string; prefix: string }> = {
        pending: { color: '#ffc107', prefix: '[待]' },
        processing: { color: '#0dcaf0', prefix: '[中]' },
        applied: { color: '#198754', prefix: '[✓]' },
        error: { color: '#dc3545', prefix: '[!] ' },
        conflict_requires_resolution: { color: '#fd7e14', prefix: '[衝突]' },
        cancelled: { color: '#6c757d', prefix: '[撤銷]' },
      };
      const baseColorMap: Record<string, string> = {
        MOVE: '#17a2b8',
        SUSPEND: '#6610f2',
        ADD_SESSION: '#20c997',
        RANGE_MOVE: '#e83e8c',
        SWAP: '#fd7e14',
      };
      const style = statusStyles[ex.status] || { color: '#6c757d', prefix: '[?]' };
      let finalColor = style.color;
      if (ex.status === 'applied') {
        finalColor = baseColorMap[ex.type] || '#6c757d';
      }
      let baseTitle = '';
      if (ex.type === 'SWAP') {
        baseTitle = `${ex.patient1?.patientName || ''} <=> ${ex.patient2?.patientName || ''}`;
      } else {
        baseTitle = `${ex.patientName || ''} - ${this.typeMap[ex.type] || '未知'}`;
      }
      const title = `${style.prefix} ${baseTitle}`;
      let description = '';
      if (ex.type === 'MOVE' && ex.from && ex.to) {
        description = `從 ${this.formatShiftInfo({ ...ex.from, date: ex.from.sourceDate })} 移至 ${this.formatShiftInfo({ ...ex.to, date: ex.to.goalDate })}`;
      } else if (ex.type === 'ADD_SESSION' && ex.to) {
        description = `新增於 ${this.formatShiftInfo({ ...ex.to, date: ex.to.goalDate })}`;
      } else if (ex.type === 'RANGE_MOVE' && ex.to) {
        description = `區間內移至: ${this.formatBedAndShift(ex.to)}`;
      } else if (ex.type === 'SWAP' && ex.patient1 && ex.patient2) {
        const from1 = this.formatBedAndShift(ex.patient1);
        const from2 = this.formatBedAndShift(ex.patient2);
        description = `${ex.patient1.patientName} (${from1}) 與 ${ex.patient2.patientName} (${from2}) 互換`;
      } else {
        description = ex.reason;
      }
      if (ex.type === 'MOVE' && ex.from && ex.to) {
        const fromEvent = {
          id: `${ex.id}-from`,
          title: `[原班] ${ex.patientName}`,
          start: ex.from.sourceDate,
          allDay: true,
          backgroundColor: '#adb5bd',
          borderColor: '#adb5bd',
          extendedProps: { ...ex, formattedDetails: description },
        };
        const toEvent = {
          id: ex.id,
          title: title.replace('調班', '[新班]'),
          start: ex.to.goalDate,
          allDay: true,
          backgroundColor: finalColor,
          borderColor: finalColor,
          extendedProps: { ...ex, formattedDetails: description },
        };
        return [fromEvent, toEvent];
      }
      let exclusiveEndDate: string | null = null;
      if (ex.endDate && ex.endDate !== ex.startDate) {
        const endDateObj = new Date(ex.endDate + 'T00:00:00Z');
        endDateObj.setUTCDate(endDateObj.getUTCDate() + 1);
        exclusiveEndDate = endDateObj.toISOString().split('T')[0];
      }
      return [
        {
          id: ex.id,
          title: title,
          start: ex.startDate,
          end: exclusiveEndDate,
          allDay: true,
          backgroundColor: finalColor,
          borderColor: finalColor,
          extendedProps: { ...ex, formattedDetails: description },
        },
      ];
    });
  });

  calendarOptions = computed<CalendarOptions>(() => ({
    plugins: [dayGridPlugin, interactionPlugin, listPlugin],
    initialView: 'dayGridMonth',
    locale: zhTwLocale,
    headerToolbar: false,
    dayMaxEvents: true,
    events: this.calendarEvents(),
    datesSet: (arg) => {
      this.calendarTitle.set(arg.view.title);
    },
    eventClick: (info) => {
      const exData = info.event.extendedProps;
      this.currentActionData.set(exData);

      let patientDisplayName = exData['patientName'];
      if (exData['type'] === 'SWAP') {
        patientDisplayName = `${exData['patient1']?.patientName} & ${exData['patient2']?.patientName}`;
      }

      this.actionDialogTitle.set('調班詳細資訊');
      this.actionDialogMessage.set(
        `病患: ${patientDisplayName}\n` +
          `類型: ${this.typeMap[exData['type']] || '未知'}\n` +
          `狀態: ${this.statusMap[exData['status']] || '未知'}\n` +
          `區間: ${exData['startDate']} ~ ${exData['endDate'] || exData['startDate']}\n` +
          `詳細: ${exData['formattedDetails']}\n` +
          `申請時間: ${this.formatTimestamp(exData['createdAt'])}`,
      );

      if (exData['status'] === 'error' && exData['errorMessage']) {
        this.actionDialogMessage.update(
          (msg) => msg + `\n\n錯誤訊息: ${exData['errorMessage']}`,
        );
      }

      this.isActionDialogVisible.set(true);
    },
  }));

  currentCalendarDate = computed(() =>
    this.calendarApi ? this.calendarApi.getDate() : new Date(),
  );

  ngOnInit(): void {
    const user = this.currentUser();
    if (user) {
      this.initializePageData();
    }

    // Watch for route query param resolveConflict
    this.route.queryParams.subscribe((params) => {
      const conflictId = params['resolveConflict'];
      if (conflictId) {
        const conflictException = this.exceptions().find((ex: any) => ex.id === conflictId);
        if (conflictException) {
          this.exceptionToReEdit.set(conflictException);
          this.isCreateDialogVisible.set(true);
          this.router.navigate([], { queryParams: {} });
        }
      }
    });
  }

  ngOnDestroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  }

  // --- Calendar Navigation ---
  handleCalendarReady(calendarApi: any): void {
    this.calendarApi = calendarApi;
    this.calendarTitle.set(calendarApi.view.title);
  }

  handlePrev(): void {
    this.calendarApi?.prev();
  }

  handleNext(): void {
    this.calendarApi?.next();
  }

  handleToday(): void {
    this.calendarApi?.today();
  }

  handleViewChange(viewName: string): void {
    this.calendarApi?.changeView(viewName);
  }

  openMonthPicker(): void {
    this.isMonthPickerVisible.set(true);
  }

  handleDateSelected(newDate: any): void {
    this.calendarApi?.gotoDate(newDate);
    this.isMonthPickerVisible.set(false);
  }

  // --- Helper Functions ---
  formatTimestamp(ts: any): string {
    if (!ts) return 'N/A';
    return formatDateTimeToLocal(parseFirestoreTimestamp(ts));
  }

  formatShiftInfo(shiftData: any): string {
    if (!shiftData) return '';
    const shiftName = this.shiftMap[shiftData.shiftCode] || shiftData.shiftCode;
    const bedDisplay = String(shiftData.bedNum).startsWith('peripheral-')
      ? `外圍 ${String(shiftData.bedNum).split('-')[1]}`
      : `${shiftData.bedNum}床`;
    return `${shiftData.date || ''} (${shiftName} ${bedDisplay})`;
  }

  formatBedAndShift(targetData: any): string {
    if (!targetData) return 'N/A';
    const bedNum = targetData.fromBedNum || targetData.bedNum;
    const shiftCode = targetData.fromShiftCode || targetData.shiftCode;
    if (!bedNum || !shiftCode) return 'N/A';
    const shiftName = this.shiftMap[shiftCode] || shiftCode;
    const bedDisplay = String(bedNum).startsWith('peripheral-')
      ? `外圍 ${String(bedNum).split('-')[1]}`
      : `${bedNum}床`;
    return `${bedDisplay} / ${shiftName}`;
  }

  isCancellable(exceptionData: any): boolean {
    if (
      !exceptionData ||
      exceptionData.status === 'cancelled' ||
      exceptionData.status === 'expired' ||
      exceptionData.status === 'error'
    ) {
      return false;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let latestDateStr =
      exceptionData.endDate || exceptionData.startDate || exceptionData.date;
    if (exceptionData.type === 'MOVE' && exceptionData.to && exceptionData.from) {
      latestDateStr =
        exceptionData.to.goalDate > exceptionData.from.sourceDate
          ? exceptionData.to.goalDate
          : exceptionData.from.sourceDate;
    }
    if (!latestDateStr) return false;
    const latestDate = new Date(latestDateStr + 'T00:00:00');
    return latestDate >= today;
  }

  // --- Dialog Functions ---
  openCreateDialog(): void {
    if (this.isPageLocked()) return;
    this.exceptionToReEdit.set(null);
    this.isCreateDialogVisible.set(true);
  }

  closeCreateDialog(): void {
    this.isCreateDialogVisible.set(false);
    setTimeout(() => {
      this.exceptionToReEdit.set(null);
    }, 300);
  }

  handleEdit(): void {
    const data = this.currentActionData();
    if (!data) return;
    if (
      this.isCancellable(data) ||
      data.status === 'conflict_requires_resolution'
    ) {
      this.exceptionToReEdit.set({ ...data });
      this.isActionDialogVisible.set(false);
      setTimeout(() => {
        this.isCreateDialogVisible.set(true);
      }, 150);
    }
  }

  async handleDelete(): Promise<void> {
    const data = this.currentActionData();
    if (!data?.id) return;
    const exceptionId = data.id;
    this.isActionDialogVisible.set(false);

    try {
      await this.deleteOldExceptionMessages(data);
      await deleteDoc(doc(this.firebase.db, 'schedule_exceptions', exceptionId));

      let message = '';
      if (data.type === 'SWAP') {
        message = `成功撤銷調班申請: ${data.patient1.patientName}與${data.patient2.patientName}`;
      } else {
        const typeText = this.typeMap[data.type] || '調班';
        message = `成功撤銷調班申請: ${data.patientName} (${typeText})`;
      }
      this.notificationService.createGlobalNotification(message, 'success');
    } catch (error: any) {
      console.error('撤銷失敗:', error);
      this.alertDialogTitle.set('撤銷失敗');
      this.alertDialogMessage.set(`執行撤銷操作時發生錯誤: ${error.message}`);
      this.isAlertDialogVisible.set(true);
    } finally {
      this.currentActionData.set(null);
    }
  }

  handleDeleteFromChild(id: any): void {
    this.notificationService.createGlobalNotification('成功撤銷衝突的調班申請', 'success');
  }

  // --- Merge Logic ---
  findMergeableExceptions(formData: any): any[] {
    if (formData.id) return [];
    let targetDate: string | null = null;
    if (formData.type === 'MOVE') targetDate = formData.to?.goalDate;
    else if (formData.type === 'ADD_SESSION') targetDate = formData.to?.goalDate;
    else if (formData.type === 'SUSPEND') targetDate = formData.startDate;
    else if (formData.type === 'SWAP') targetDate = formData.date;
    if (!targetDate) return [];

    const isNewSameDayMove =
      formData.type === 'MOVE' && formData.from?.sourceDate === formData.to?.goalDate;

    return this.exceptions().filter((ex: any) => {
      if (ex.patientId !== formData.patientId) return false;
      if (ex.type !== formData.type) return false;
      if (!['pending', 'applied'].includes(ex.status)) return false;

      let existingTargetDate: string | null = null;
      if (ex.type === 'MOVE') existingTargetDate = ex.to?.goalDate;
      else if (ex.type === 'ADD_SESSION') existingTargetDate = ex.to?.goalDate;
      else if (ex.type === 'SUSPEND') existingTargetDate = ex.startDate;
      else if (ex.type === 'SWAP') existingTargetDate = ex.date;
      if (existingTargetDate !== targetDate) return false;

      if (formData.type === 'MOVE') {
        const isExistingSameDayMove = ex.from?.sourceDate === ex.to?.goalDate;
        if (!isNewSameDayMove || !isExistingSameDayMove) return false;
      }
      return true;
    });
  }

  findChainHead(existingExceptions: any[], newFormData: any): any {
    const allMoves = [
      ...existingExceptions.map((ex: any) => ({
        fromKey: `${ex.from?.bedNum}-${ex.from?.shiftCode}`,
        toKey: `${ex.to?.bedNum}-${ex.to?.shiftCode}`,
        from: ex.from,
      })),
      {
        fromKey: `${newFormData.from?.bedNum}-${newFormData.from?.shiftCode}`,
        toKey: `${newFormData.to?.bedNum}-${newFormData.to?.shiftCode}`,
        from: newFormData.from,
      },
    ];
    const allToKeys = new Set(allMoves.map((m) => m.toKey));
    const chainHead = allMoves.find((m) => !allToKeys.has(m.fromKey));
    return chainHead?.from || existingExceptions[0]?.from;
  }

  generateMergeMessage(existingExceptions: any[], newFormData: any): string {
    const shiftDisplayMap: Record<string, string> = { early: '早班', noon: '午班', late: '晚班' };
    const formatBed = (bedNum: any, shiftCode: string) => {
      const bedText = String(bedNum).startsWith('peripheral')
        ? `外圍${String(bedNum).split('-')[1]}`
        : `${bedNum}床`;
      const shiftText = shiftDisplayMap[shiftCode] || shiftCode;
      return `${bedText}${shiftText}`;
    };
    const count = existingExceptions.length;
    const firstEx = existingExceptions[0];

    if (firstEx.type === 'MOVE') {
      const existingPaths = existingExceptions
        .map((ex: any) => {
          const from = formatBed(ex.from?.bedNum, ex.from?.shiftCode);
          const to = formatBed(ex.to?.bedNum, ex.to?.shiftCode);
          return `【${from} → ${to}】`;
        })
        .join('\n');
      const chainHeadFrom = this.findChainHead(existingExceptions, newFormData);
      const chainHeadText = formatBed(chainHeadFrom?.bedNum, chainHeadFrom?.shiftCode);
      const newTo = formatBed(newFormData.to?.bedNum, newFormData.to?.shiftCode);
      return (
        `${firstEx.patientName} 在 ${firstEx.to?.goalDate} 已有 ${count} 筆臨時調班申請：\n` +
        `${existingPaths}\n\n` +
        `是否全部整併為：\n` +
        `【${chainHeadText} → ${newTo}】？`
      );
    } else if (firstEx.type === 'ADD_SESSION') {
      const existingBeds = existingExceptions
        .map((ex: any) => `【${formatBed(ex.to?.bedNum, ex.to?.shiftCode)}】`)
        .join('\n');
      const newBed = formatBed(newFormData.to?.bedNum, newFormData.to?.shiftCode);
      return (
        `${firstEx.patientName} 在 ${firstEx.to?.goalDate} 已有 ${count} 筆臨時加洗申請：\n` +
        `${existingBeds}\n\n` +
        `是否全部整併為：\n` +
        `【${newBed}】？`
      );
    } else if (firstEx.type === 'SUSPEND') {
      const existingRanges = existingExceptions
        .map((ex: any) => `【${ex.startDate} ~ ${ex.endDate}】`)
        .join('\n');
      return (
        `${firstEx.patientName} 已有 ${count} 筆區間暫停申請：\n` +
        `${existingRanges}\n\n` +
        `是否全部整併為：\n` +
        `【${newFormData.startDate} ~ ${newFormData.endDate}】？`
      );
    } else if (firstEx.type === 'SWAP') {
      return (
        `${firstEx.patient1?.patientName} 在 ${firstEx.date} 已有 ${count} 筆同日互調申請\n\n` +
        `是否全部整併為新的互調設定？`
      );
    }
    return `發現 ${count} 筆相同類型的調班申請，是否全部整併？`;
  }

  async handleCreateException(formData: any): Promise<void> {
    try {
      const isUpdating = !!formData.id;
      if (!isUpdating) {
        const existing = this.findMergeableExceptions(formData);
        if (existing.length > 0) {
          this.closeCreateDialog();
          this.existingExceptionsToMerge.set(existing);
          this.pendingFormData.set(formData);
          this.mergeDialogMessage.set(this.generateMergeMessage(existing, formData));
          this.isMergeDialogVisible.set(true);
          return;
        }
      }
      await this.processExceptionSubmission(formData, isUpdating);
    } catch (error: any) {
      console.error('提交調班申請失敗:', error);
    }
  }

  async processExceptionSubmission(formData: any, isUpdating: boolean): Promise<void> {
    try {
      if (isUpdating) {
        await deleteDoc(doc(this.firebase.db, 'schedule_exceptions', formData.id));
      }
      const dataToSave: any = {
        patientId: formData.patientId,
        patientName: formData.patientName,
        type: formData.type,
        reason: formData.reason,
        startDate: formData.startDate,
        endDate: formData.endDate,
        from: formData.from,
        to: formData.to,
        status: 'pending',
        createdAt: serverTimestamp(),
      };
      if (formData.type === 'SWAP') {
        dataToSave.date = formData.date;
        dataToSave.patient1 = formData.patient1;
        dataToSave.patient2 = formData.patient2;
      }
      if (formData.mode) {
        dataToSave.mode = formData.mode;
      }
      await this.exceptionsApi.save(dataToSave);
      this.closeCreateDialog();
      const actionText = isUpdating ? '重新提交' : '新增';
      let message = '';
      if (formData.type === 'SWAP') {
        message = `${actionText}申請: ${formData.patient1.patientName} 與 ${formData.patient2.patientName}`;
      } else {
        const typeText = this.typeMap[formData.type] || '調班';
        message = `${actionText}申請: ${formData.patientName} (${typeText})`;
      }
      this.notificationService.createGlobalNotification(message, 'success');

      // Create message tasks
      let messageContent = '';
      const reasonText = `\n原因: ${formData.reason}`;
      switch (formData.type) {
        case 'MOVE':
          messageContent =
            `【${isUpdating ? '更新-臨時調班' : '臨時調班'}】\n原排班: ${formData.from.sourceDate} (${this.formatBedAndShift(formData.from)})\n新排班: ${formData.to.goalDate} (${this.formatBedAndShift(formData.to)})` +
            reasonText;
          break;
        case 'SUSPEND':
          messageContent =
            `【區間暫停】\n從 ${formData.startDate} 至 ${formData.endDate}` + reasonText;
          break;
        case 'ADD_SESSION': {
          const modeText = formData.mode && formData.mode !== 'HD' ? ` [${formData.mode}]` : '';
          messageContent =
            `【臨時加洗${modeText}】\n日期: ${formData.to.goalDate} (${this.formatBedAndShift(formData.to)})` +
            reasonText;
          break;
        }
        case 'SWAP':
          messageContent =
            `【同日互調】\n日期: ${formData.date}\n${formData.patient1.patientName} (${this.formatBedAndShift(formData.patient1)}) <=> ${formData.patient2.patientName} (${this.formatBedAndShift(formData.patient2)})` +
            reasonText;
          break;
      }

      const user = this.currentUser();
      if (messageContent && user) {
        const createMessageTask = (patientInfo: any) => ({
          category: 'message',
          type: '常規',
          content: messageContent,
          patientId: patientInfo.id,
          patientName: patientInfo.name,
          targetDate: formData.date || formData.startDate,
          status: 'pending',
          creator: {
            uid: user.uid,
            name: user.name,
            title: user.title,
          },
          createdAt: serverTimestamp(),
          expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          assignee: null,
        });
        if (formData.type === 'SWAP') {
          const task1 = createMessageTask({
            id: formData.patient1.patientId,
            name: formData.patient1.patientName,
          });
          const task2 = createMessageTask({
            id: formData.patient2.patientId,
            name: formData.patient2.patientName,
          });
          await Promise.all([this.tasksApi.save(task1), this.tasksApi.save(task2)]);
        } else {
          const task = createMessageTask({
            id: formData.patientId,
            name: formData.patientName,
          });
          await this.tasksApi.save(task);
        }
      }
    } catch (error: any) {
      console.error('提交調班申請失敗:', error);
    }
  }

  private async deleteOldExceptionMessages(existingEx: any): Promise<void> {
    try {
      const targetDate = existingEx.date || existingEx.startDate;
      if (!targetDate) return;

      const typeKeywords: Record<string, string> = {
        MOVE: '臨時調班',
        SUSPEND: '區間暫停',
        ADD_SESSION: '臨時加洗',
        SWAP: '同日互調',
      };
      const keyword = typeKeywords[existingEx.type];
      if (!keyword) return;

      // 搜尋 tasks 集合（新版 category=message + 舊版沒有 category）
      const tasksQuery = query(
        collection(this.firebase.db, 'tasks'),
        where('patientId', '==', existingEx.patientId),
        where('targetDate', '==', targetDate),
      );

      // 也搜尋舊的 memos 集合（遷移前建立的訊息）
      const memosQuery = query(
        collection(this.firebase.db, 'memos'),
        where('patientId', '==', existingEx.patientId),
        where('targetDate', '==', targetDate),
      );

      const [tasksSnapshot, memosSnapshot] = await Promise.all([
        getDocs(tasksQuery),
        getDocs(memosQuery).catch(() => null), // memos 集合可能不存在
      ]);

      const deletePromises: Promise<void>[] = [];

      tasksSnapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (data['content'] && data['content'].includes(keyword)) {
          deletePromises.push(deleteDoc(doc(this.firebase.db, 'tasks', docSnap.id)));
        }
      });

      if (memosSnapshot) {
        memosSnapshot.forEach((docSnap) => {
          const data = docSnap.data();
          if (data['content'] && data['content'].includes(keyword)) {
            deletePromises.push(deleteDoc(doc(this.firebase.db, 'memos', docSnap.id)));
          }
        });
      }

      if (deletePromises.length > 0) {
        await Promise.all(deletePromises);
      }
    } catch (error) {
      console.error('刪除舊訊息失敗:', error);
    }
  }

  async handleMergeConfirm(): Promise<void> {
    this.isMergeDialogVisible.set(false);
    const existingExceptions = this.existingExceptionsToMerge();
    const newFormData = this.pendingFormData();
    if (existingExceptions.length === 0 || !newFormData) return;

    try {
      const firstEx = existingExceptions[0];
      for (const ex of existingExceptions) {
        await this.deleteOldExceptionMessages(ex);
      }
      for (let i = 1; i < existingExceptions.length; i++) {
        await deleteDoc(
          doc(this.firebase.db, 'schedule_exceptions', existingExceptions[i].id),
        );
      }
      const mergedData: any = {
        ...newFormData,
        id: firstEx.id,
      };
      if (firstEx.type === 'MOVE') {
        const chainHeadFrom = this.findChainHead(existingExceptions, newFormData);
        if (chainHeadFrom) {
          mergedData.from = { ...chainHeadFrom };
          mergedData.startDate = chainHeadFrom.sourceDate;
        }
      }
      await this.processExceptionSubmission(mergedData, true);
      this.notificationService.createGlobalNotification(
        `已整併 ${existingExceptions.length} 筆調班申請`,
        'success',
      );
    } catch (error: any) {
      console.error('合併調班申請失敗:', error);
    } finally {
      this.existingExceptionsToMerge.set([]);
      this.pendingFormData.set(null);
    }
  }

  handleMergeCancel(): void {
    this.isMergeDialogVisible.set(false);
    this.existingExceptionsToMerge.set([]);
    this.pendingFormData.set(null);
  }

  private async initializePageData(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.isLoading.set(true);
    try {
      await this.patientStore.fetchPatientsIfNeeded();
      const q = query(
        collection(this.firebase.db, 'schedule_exceptions'),
        orderBy('createdAt', 'desc'),
      );
      this.unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          this.exceptions.set(
            snapshot.docs.map((d) => ({ id: d.id, ...d.data() })),
          );
          this.isLoading.set(false);
        },
        (error) => {
          console.error('Firestore 監聯器發生錯誤:', error);
          this.isLoading.set(false);
        },
      );
    } catch (error) {
      console.error('載入資料失敗:', error);
      this.isLoading.set(false);
    }
  }

  closeActionDialog(): void {
    this.isActionDialogVisible.set(false);
  }

  closeAlertDialog(): void {
    this.isAlertDialogVisible.set(false);
  }
}
