import { Injectable, computed, signal } from '@angular/core';
import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { APP_CONFIG } from './config';

export interface Caller {
  readonly username?: string;
  readonly userId?: number;
  readonly roleCodes: readonly string[];
  readonly jurisdictionCode: string;
  /** Routes this caller may invoke, from GET /api/v1/me. */
  readonly permissions: readonly string[];
}

/**
 * Authentication against Keycloak, and the caller's effective permissions.
 *
 * Plan reference: V2 sections 2.5, 6.1; ADR-003.
 *
 * ## Authorisation code with PKCE, not a password grant
 *
 * The password grant is convenient in a terminal and wrong in a browser: it
 * puts the user's credentials through our origin. PKCE keeps them at the IdP.
 *
 * ## Permissions are advisory here, authoritative on the server
 *
 * `permissions` exists so the UI can hide a button the caller cannot use.
 * It is *not* a security control — the API decides, and denies with 403
 * regardless of what this SPA believes. Treating a client-held permission list
 * as the control would mean anyone with developer tools has admin rights.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly manager: UserManager;

  private readonly userSignal = signal<User | null>(null);
  private readonly callerSignal = signal<Caller | null>(null);

  readonly caller = this.callerSignal.asReadonly();
  readonly isAuthenticated = computed(() => this.userSignal() !== null);
  readonly username = computed(() => this.callerSignal()?.username ?? null);
  readonly roleCodes = computed(() => this.callerSignal()?.roleCodes ?? []);

  constructor() {
    this.manager = new UserManager({
      authority: APP_CONFIG.oidc.authority,
      client_id: APP_CONFIG.oidc.clientId,
      redirect_uri: APP_CONFIG.oidc.redirectUri,
      post_logout_redirect_uri: APP_CONFIG.oidc.postLogoutRedirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      // sessionStorage rather than localStorage: a token that survives the tab
      // outlives the reason the user opened it.
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      automaticSilentRenew: true,
      monitorSession: false,
    });

    this.manager.events.addUserLoaded((user) => this.userSignal.set(user));
    this.manager.events.addUserUnloaded(() => {
      this.userSignal.set(null);
      this.callerSignal.set(null);
    });
    this.manager.events.addAccessTokenExpired(() => void this.logout());
  }

  /** Restore a session from storage, if one is still valid. */
  async restore(): Promise<boolean> {
    const user = await this.manager.getUser();
    if (user === null || user.expired === true) {
      return false;
    }
    this.userSignal.set(user);
    return true;
  }

  async login(): Promise<void> {
    await this.manager.signinRedirect();
  }

  /**
   * Complete the redirect back from the IdP.
   *
   * The caller is loaded here rather than left to the shell. Returning from
   * Keycloak is a full page load, so the shell's own initialisation has
   * already run and found nobody signed in; without this the application
   * showed an empty navigation and no username until the user happened to
   * reload the page, which looked exactly like a failed sign-in.
   */
  async completeLogin(): Promise<void> {
    const user = await this.manager.signinRedirectCallback();
    this.userSignal.set(user);
    await this.loadCaller();
  }

  /**
   * Ask the server who this caller is and what they may invoke.
   *
   * One implementation, used by the shell on a returning session and by the
   * sign-in callback on a new one. Two copies would drift, and the drift
   * would show as a menu that is right in one case and empty in the other.
   */
  async loadCaller(): Promise<Caller | null> {
    if (!this.isAuthenticated()) {
      return null;
    }

    const response = await fetch(`${APP_CONFIG.apiBaseUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${this.accessToken() ?? ''}` },
    });
    if (!response.ok) {
      // Authenticated but unknown to the API. Left to the shell to report:
      // clearing the session here would send the user round the login loop
      // again with no explanation.
      return null;
    }

    const caller = (await response.json()) as Caller;
    this.callerSignal.set(caller);
    return caller;
  }

  async logout(): Promise<void> {
    this.userSignal.set(null);
    this.callerSignal.set(null);
    await this.manager.signoutRedirect();
  }

  accessToken(): string | null {
    return this.userSignal()?.access_token ?? null;
  }

  setCaller(caller: Caller): void {
    this.callerSignal.set(caller);
  }

  /**
   * Whether the UI should offer a route.
   *
   * A hint for rendering, never a gate. The API is the gate.
   */
  canInvoke(method: string, path: string): boolean {
    const permissions = this.callerSignal()?.permissions ?? [];
    return permissions.includes(`${method.toUpperCase()} ${path}`);
  }

  hasRole(...roleCodes: readonly string[]): boolean {
    const held = this.callerSignal()?.roleCodes ?? [];
    return roleCodes.some((role) => held.includes(role));
  }
}
