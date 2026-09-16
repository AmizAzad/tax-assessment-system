import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The authenticated caller and per-request metadata.
 *
 * Plan reference: V2 sections 6.1, 14.5.
 *
 * Held in AsyncLocalStorage rather than passed down every call chain, because
 * the things that need it -- the audit hook, the entity-history writer, the
 * scope predicate, the logger -- sit at depths that would otherwise require
 * threading a context parameter through every service signature.
 *
 * The trade-off is that it is implicit. The rule that keeps it honest: a
 * service that makes an *authorisation* decision must take the caller
 * explicitly as an argument. This store is for audit attribution and
 * correlation, not for deciding who may do what.
 */
export interface RequestContext {
  /** Local `platform.app_user.id`. Absent for a public (unauthenticated) route. */
  readonly userId?: number;
  /** The IdP subject claim. The stable join key to Keycloak. */
  readonly subject?: string;
  readonly username?: string;
  readonly roleCodes: readonly string[];
  /** Correlates logs, API traces, domain events and outbound calls. */
  readonly correlationId: string;
  readonly jurisdictionCode: string;
  readonly requestedAt: Date;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current context, or undefined outside a request (a scheduler, a test). */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The current context, or throw.
 *
 * Use where a caller is genuinely required -- writing an audit row that must
 * be attributable. Prefer `getContext()` where absence is legitimate.
 */
export function requireContext(): RequestContext {
  const context = storage.getStore();
  if (context === undefined) {
    throw new Error(
      'No request context is active. This code path requires an authenticated caller; ' +
        'if it runs from a scheduler, establish a SYSTEM context explicitly.',
    );
  }
  return context;
}

/** The caller's user id, or undefined. For audit columns. */
export function currentUserId(): number | undefined {
  return storage.getStore()?.userId;
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * A context for background work.
 *
 * Scheduled jobs and queue consumers have no HTTP request but still write
 * audited rows, so they run as SYSTEM rather than as nobody.
 */
export function systemContext(correlationId: string, jurisdictionCode: string): RequestContext {
  return {
    username: 'SYSTEM',
    roleCodes: ['SYSTEM'],
    correlationId,
    jurisdictionCode,
    requestedAt: new Date(),
  };
}
