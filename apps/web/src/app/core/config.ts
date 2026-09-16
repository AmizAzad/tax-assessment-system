/**
 * Runtime configuration for the SPA.
 *
 * Plan reference: V2 sections 2.5, 27.2.
 *
 * A browser bundle cannot read environment variables, and baking the IdP URL
 * into the build would mean a separate build per environment. So these are the
 * development defaults, overridable at runtime by a `window.__TAS_CONFIG__`
 * object that a deployed environment injects into index.html.
 */

export interface WebConfig {
  /** Empty in development: the dev server proxies /api to the API. */
  readonly apiBaseUrl: string;
  readonly oidc: {
    readonly authority: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly postLogoutRedirectUri: string;
  };
  readonly defaultLanguage: string;
}

declare global {
  interface Window {
    __TAS_CONFIG__?: Partial<WebConfig>;
  }
}

const DEVELOPMENT_DEFAULTS: WebConfig = {
  apiBaseUrl: '',
  oidc: {
    // Port 8085, not 8081: a local Tomcat commonly holds 8081 and silently
    // shadows Keycloak, which surfaces as a Tomcat 404 from the token endpoint.
    authority: 'http://localhost:8085/realms/tax-assessment',
    clientId: 'tas-web',
    redirectUri: 'http://localhost:4200/auth/callback',
    postLogoutRedirectUri: 'http://localhost:4200/',
  },
  defaultLanguage: 'en',
};

export function loadConfig(): WebConfig {
  const injected = window.__TAS_CONFIG__;
  if (injected === undefined) {
    return DEVELOPMENT_DEFAULTS;
  }
  return {
    apiBaseUrl: injected.apiBaseUrl ?? DEVELOPMENT_DEFAULTS.apiBaseUrl,
    oidc: { ...DEVELOPMENT_DEFAULTS.oidc, ...injected.oidc },
    defaultLanguage: injected.defaultLanguage ?? DEVELOPMENT_DEFAULTS.defaultLanguage,
  };
}

export const APP_CONFIG = loadConfig();
