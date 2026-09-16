import { Inject, Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AppConfig } from '../../config/configuration';
import { APP_CONFIG } from '../../infrastructure/tokens';

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`Token rejected: ${reason}`);
    this.name = 'InvalidTokenError';
  }
}

/** The claims we rely on. Anything else in the token is ignored. */
export interface VerifiedToken {
  readonly subject: string;
  readonly username: string;
  readonly email?: string;
  readonly roleCodes: readonly string[];
  readonly expiresAt: Date;
}

interface KeycloakClaims extends JWTPayload {
  preferred_username?: string;
  email?: string;
  realm_access?: { roles?: string[] };
}

/**
 * Validates bearer tokens against the identity provider.
 *
 * Plan reference: ADR-003, V2 sections 2.5, 6.1.
 *
 * We validate signature, issuer, audience and expiry. We do not issue tokens,
 * store passwords, or manage sessions -- that is Keycloak's job.
 *
 * Signing keys are fetched from the IdP's JWKS endpoint and cached by `jose`,
 * which handles rotation: an unknown `kid` triggers a refetch. That is why the
 * key set is created once and reused rather than per request.
 */
@Injectable()
export class TokenVerifierService {
  private readonly logger = new Logger(TokenVerifierService.name);
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.issuer = config.oidc.issuerUrl;
    this.audience = config.oidc.audience;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/protocol/openid-connect/certs`), {
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
  }

  /**
   * Verify a bearer token.
   *
   * @throws InvalidTokenError for any failure. The caller translates that into
   *         401 without echoing the reason to the client -- the detail goes to
   *         the log, not to a potential attacker.
   */
  async verify(token: string): Promise<VerifiedToken> {
    let payload: KeycloakClaims;
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        // Tolerate a little clock drift between the IdP and this host, but not
        // enough to meaningfully extend a token's life.
        clockTolerance: 5,
      });
      payload = result.payload as KeycloakClaims;
    } catch (error) {
      throw new InvalidTokenError(describe(error));
    }

    const subject = payload.sub;
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new InvalidTokenError('missing subject claim');
    }

    const username = payload.preferred_username;
    if (typeof username !== 'string' || username.length === 0) {
      throw new InvalidTokenError('missing preferred_username claim');
    }

    if (typeof payload.exp !== 'number') {
      throw new InvalidTokenError('missing expiry claim');
    }

    // Realm roles are the transport for role codes. A token with none is
    // valid but authorises nothing, which the permission check then denies.
    const roleCodes = payload.realm_access?.roles ?? [];

    return {
      subject,
      username,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      roleCodes,
      expiresAt: new Date(payload.exp * 1000),
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown verification failure';
}
