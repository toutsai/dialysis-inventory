import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '@services/auth.service';

export const authGuard: CanActivateFn = async (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // Wait until Firebase auth initialization is complete
  if (!authService.isAuthReady()) {
    await authService.waitForAuthInit();
  }

  if (authService.currentUser()) {
    return true;
  }

  // Redirect to login with returnUrl query param
  return router.createUrlTree(['/login'], {
    queryParams: { returnUrl: state.url },
  });
};
