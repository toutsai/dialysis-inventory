import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from '@services/auth.service';

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <div class="layout-container">
      <header class="app-header">
        <h1 class="app-title">庫存管理系統</h1>
        <div class="header-right">
          @if (authService.currentUser(); as user) {
            <span class="user-name">{{ user.name }}</span>
          }
          <button class="logout-btn" (click)="handleLogout()">登出</button>
        </div>
      </header>
      <main class="main-content">
        <router-outlet />
      </main>
    </div>
  `,
  styles: [`
    .layout-container {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .app-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1.5rem;
      background: #1a73e8;
      color: white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .app-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0;
    }
    .header-right {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .user-name {
      font-size: 0.9rem;
      opacity: 0.9;
    }
    .logout-btn {
      background: rgba(255,255,255,0.2);
      color: white;
      border: 1px solid rgba(255,255,255,0.3);
      padding: 0.4rem 1rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85rem;
    }
    .logout-btn:hover {
      background: rgba(255,255,255,0.3);
    }
    .main-content {
      flex: 1;
      overflow: hidden;
    }
  `],
})
export class MainLayoutComponent {
  readonly authService = inject(AuthService);

  async handleLogout(): Promise<void> {
    await this.authService.logout();
  }
}
