import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

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
      { path: '', redirectTo: 'inventory', pathMatch: 'full' },
      {
        path: 'inventory',
        loadComponent: () =>
          import('./features/inventory/inventory.component').then(
            (m) => m.InventoryComponent
          ),
        data: { title: '庫存管理' },
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
