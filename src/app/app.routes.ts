import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./features/login/login.component').then(
        (m) => m.LoginComponent
      ),
  },
  {
    path: '',
    loadComponent: () =>
      import('./layouts/main-layout.component').then(
        (m) => m.MainLayoutComponent
      ),
    canActivate: [authGuard],
    children: [
      { path: '', redirectTo: 'collaboration', pathMatch: 'full' },
      {
        path: 'schedule',
        loadComponent: () =>
          import('./features/schedule/schedule.component').then(
            (m) => m.ScheduleComponent
          ),
        data: { title: '每日排程表' },
      },
      {
        path: 'weekly',
        loadComponent: () =>
          import('./features/weekly/weekly.component').then(
            (m) => m.WeeklyComponent
          ),
        data: { title: '週排班表' },
      },
      {
        path: 'base-schedule',
        loadComponent: () =>
          import('./features/base-schedule/base-schedule.component').then(
            (m) => m.BaseScheduleComponent
          ),
        data: { title: '門急住床位總表' },
      },
      {
        path: 'physician-schedule',
        loadComponent: () =>
          import(
            './features/physician-schedule/physician-schedule.component'
          ).then((m) => m.PhysicianScheduleComponent),
        data: { title: '醫師排班' },
      },
      {
        path: 'exception-manager',
        loadComponent: () =>
          import(
            './features/exception-manager/exception-manager.component'
          ).then((m) => m.ExceptionManagerComponent),
        data: { title: '調班管理' },
      },
      {
        path: 'update-scheduler',
        loadComponent: () =>
          import(
            './features/update-scheduler/update-scheduler.component'
          ).then((m) => m.UpdateSchedulerComponent),
        data: { title: '預約變更總覽' },
      },
      {
        path: 'patients',
        loadComponent: () =>
          import('./features/patients/patients.component').then(
            (m) => m.PatientsComponent
          ),
        data: { title: '病人管理' },
      },
      {
        path: 'stats',
        loadComponent: () =>
          import('./features/stats/stats.component').then(
            (m) => m.StatsComponent
          ),
        data: { title: '護理分組檢視' },
      },
      {
        path: 'reporting',
        loadComponent: () =>
          import('./features/reporting/reporting.component').then(
            (m) => m.ReportingComponent
          ),
        data: { title: '統計報表' },
      },
      {
        path: 'user-management',
        loadComponent: () =>
          import(
            './features/user-management/user-management.component'
          ).then((m) => m.UserManagementComponent),
        canActivate: [adminGuard],
        data: { title: '使用者管理' },
      },
      {
        path: 'lab-reports',
        loadComponent: () =>
          import('./features/lab-reports/lab-reports.component').then(
            (m) => m.LabReportsComponent
          ),
        data: { title: '檢驗報告管理' },
      },
      {
        path: 'inventory',
        loadComponent: () =>
          import('./features/inventory/inventory.component').then(
            (m) => m.InventoryComponent
          ),
        data: { title: '庫存管理' },
      },
      {
        path: 'account-settings',
        loadComponent: () =>
          import(
            './features/account-settings/account-settings.component'
          ).then((m) => m.AccountSettingsComponent),
        data: { title: '帳號設定' },
      },
      {
        path: 'daily-log',
        loadComponent: () =>
          import('./features/daily-log/daily-log.component').then(
            (m) => m.DailyLogComponent
          ),
        data: { title: '工作日誌' },
      },
      {
        path: 'collaboration',
        loadComponent: () =>
          import('./features/collaboration/collaboration.component').then(
            (m) => m.CollaborationComponent
          ),
        data: { title: '協作訊息中心' },
      },
      {
        path: 'orders',
        loadComponent: () =>
          import('./features/orders/orders.component').then(
            (m) => m.OrdersComponent
          ),
        data: { title: '藥囑管理' },
      },
      {
        path: 'my-patients',
        loadComponent: () =>
          import('./features/my-patients/my-patients.component').then(
            (m) => m.MyPatientsComponent
          ),
        data: { title: '我的今日病人' },
      },
      {
        path: 'nursing-schedule',
        loadComponent: () =>
          import(
            './features/nursing-schedule/nursing-schedule.component'
          ).then((m) => m.NursingScheduleComponent),
        data: { title: '護理班表與職責' },
      },
      {
        path: 'kidit-report',
        loadComponent: () =>
          import('./features/kidit-report/kidit-report.component').then(
            (m) => m.KiditReportComponent
          ),
        data: { title: 'KiDit 申報工作站' },
      },
      {
        path: 'usage-guide',
        loadComponent: () =>
          import('./features/usage-guide/usage-guide.component').then(
            (m) => m.UsageGuideComponent
          ),
        data: { title: '平台使用說明' },
      },
      {
        path: 'consumables',
        loadComponent: () =>
          import('./features/consumables/consumables.component').then(
            (m) => m.ConsumablesComponent
          ),
        data: { title: '每月耗材總表' },
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
