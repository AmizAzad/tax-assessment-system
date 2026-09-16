import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Attaches the bearer token and surfaces authorisation failures honestly.
 *
 * Plan reference: V2 sections 6.1, 20.
 *
 * A 403 is not retried and not swallowed. The API fails closed by design —
 * an unregistered route, a missing grant, or an unreachable authorisation
 * cache all deny — so a 403 is information the user needs, not a transient
 * condition to paper over.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const token = auth.accessToken();

  const authorised =
    token === null ? request : request.clone({ setHeaders: { Authorization: `Bearer ${token}` } });

  return next(authorised).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        // The token expired or was rejected. Sending the user back to the IdP
        // is the only useful response.
        void auth.logout();
      }
      return throwError(() => error);
    }),
  );
};
