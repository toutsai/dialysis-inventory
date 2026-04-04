// src/app/features/login/login.component.ts
import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '@app/core/services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css',
})
export class LoginComponent {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  username = signal('');
  password = signal('');
  errorMessage = signal('');
  isLoading = signal(false);
  isPasswordVisible = signal(false);

  togglePasswordVisibility(): void {
    this.isPasswordVisible.update((v) => !v);
  }

  async handleLogin(): Promise<void> {
    if (this.isLoading()) return;

    this.isLoading.set(true);
    this.errorMessage.set('');

    try {
      // Add a timeout to prevent infinite spinning if API or Firebase hangs
      const loginPromise = this.authService.login(this.username(), this.password());
      const timeoutPromise = new Promise<{ success: boolean; error?: string }>((resolve) => {
        setTimeout(() => resolve({ success: false, error: '登入請求逾時，請確認網路連線或伺服器狀態' }), 10000);
      });

      const result = await Promise.race([loginPromise, timeoutPromise]);

      if (result.success) {
        // Navigate to main app after successful login
        const navPromise = this.router.navigate(['/']);
        const navTimeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000));
        const navResult = await Promise.race([navPromise, navTimeout]);
        
        if (!navResult) {
          this.errorMessage.set('導覽至主頁發生錯誤 (可能卡在授權檢查)');
          this.isLoading.set(false);
        }
      } else {
        this.errorMessage.set(result.error || '登入發生錯誤');
        this.isLoading.set(false);
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : '登入發生錯誤';
      this.errorMessage.set(message);
      this.isLoading.set(false);
    }
  }

  onUsernameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.username.set(target.value);
  }

  onPasswordInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.password.set(target.value);
  }
}
