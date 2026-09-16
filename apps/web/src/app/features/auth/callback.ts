import { Component, ChangeDetectionStrategy, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

/** Completes the OIDC redirect and returns the user to the app. */
@Component({
  selector: 'tas-auth-callback',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error(); as message) {
      <div class="tas-alert tas-alert--danger" role="alert">
        <strong>Sign-in failed.</strong>
        <p>{{ message }}</p>
      </div>
    } @else {
      <p class="tas-muted">Completing sign-in…</p>
    }
  `,
})
export class AuthCallback implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      await this.auth.completeLogin();
      await this.router.navigate(['/']);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Unknown sign-in error');
    }
  }
}
