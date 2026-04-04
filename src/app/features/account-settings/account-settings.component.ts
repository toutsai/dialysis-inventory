import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '@app/core/services/auth.service';

@Component({
  selector: 'app-account-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './account-settings.component.html',
  styleUrl: './account-settings.component.css',
})
export class AccountSettingsComponent {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  readonly currentUser = this.authService.currentUser;

  oldPassword = signal('');
  newPassword = signal('');
  confirmPassword = signal('');
  message = signal('');
  messageType = signal(''); // 'success' or 'error'
  isLoading = signal(false);

  isOldPasswordVisible = signal(false);
  isNewPasswordVisible = signal(false);
  isConfirmPasswordVisible = signal(false);

  togglePasswordVisibility(field: string): void {
    if (field === 'old') {
      this.isOldPasswordVisible.update((v) => !v);
    } else if (field === 'new') {
      this.isNewPasswordVisible.update((v) => !v);
    } else if (field === 'confirm') {
      this.isConfirmPasswordVisible.update((v) => !v);
    }
  }

  async handleChangePassword(): Promise<void> {
    this.message.set('');
    this.isLoading.set(true);

    if (this.newPassword() !== this.confirmPassword()) {
      this.message.set('新密碼與確認密碼不相符。');
      this.messageType.set('error');
      this.isLoading.set(false);
      return;
    }

    // 強化密碼複雜度驗證：至少 8 字元，包含大小寫和數字
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(this.newPassword())) {
      this.message.set('新密碼需至少 8 個字元，並包含大寫字母、小寫字母和數字。');
      this.messageType.set('error');
      this.isLoading.set(false);
      return;
    }

    try {
      const result = await this.authService.updatePassword(
        this.oldPassword(),
        this.newPassword(),
      );
      if (result.success) {
        this.message.set('密碼已成功更新！');
        this.messageType.set('success');
        this.oldPassword.set('');
        this.newPassword.set('');
        this.confirmPassword.set('');
      } else {
        throw { code: 'functions/unknown', message: result.error };
      }
    } catch (error: any) {
      // 檢查從 Cloud Function 回傳的正確錯誤代碼
      if (error.code === 'functions/unauthenticated') {
        this.message.set('舊密碼不正確，請重新輸入。');
      } else {
        this.message.set(error.message || '發生未知錯誤，請稍後再試。');
      }
      this.messageType.set('error');
    } finally {
      this.isLoading.set(false);
    }
  }

  handleCancel(): void {
    this.router.navigate(['/']);
  }
}
