import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '@services/auth.service';

export const adminGuard: CanActivateFn = async (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // Wait until Firebase auth initialization is complete
  if (!authService.isAuthReady()) {
    await authService.waitForAuthInit();
  }

  // Check if user is logged in
  if (!authService.currentUser()) {
    return router.createUrlTree(['/login'], {
      queryParams: { returnUrl: state.url },
    });
  }

  // Check if user has admin role
  if (!authService.isAdmin()) {
    // Redirect non-admin users back to the default route
    return router.createUrlTree(['/']);
  }

  return true;
};
