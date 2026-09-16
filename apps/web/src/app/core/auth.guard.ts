import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Sends an unauthenticated visitor to the identity provider.
 *
 * A convenience, not a control. Anyone can bypass a client-side guard; the API
 * fails closed and denies regardless of what the browser believes.
 */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);

  if (auth.isAuthenticated()) {
    return true;
  }

  const restored = await auth.restore();
  if (restored) {
    return true;
  }

  await auth.login();
  return false;
};
