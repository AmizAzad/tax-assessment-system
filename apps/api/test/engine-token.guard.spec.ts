import { UnauthorizedException } from '@nestjs/common';
import { EngineTokenGuard } from '../src/workflow/engine-token.guard';
import type { AppConfig } from '../src/config/configuration';

/**
 * The webhook service-token control.
 *
 * Plan reference: V2 sections 5.1, 20.
 *
 * The engine webhook bypasses the user guard because the caller is a service,
 * not a person. This guard is therefore the only thing standing between the
 * open internet and the ability to inject workflow events into the read model.
 */

const config = (env: string, token: string): AppConfig =>
  ({
    env,
    bpmnServiceToken: token,
  }) as AppConfig;

const contextWith = (authorization?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: authorization === undefined ? {} : { authorization } }),
    }),
  }) as never;

describe('EngineTokenGuard', () => {
  it('accepts a matching bearer token', () => {
    const guard = new EngineTokenGuard(config('production', 'shared-secret'));
    expect(guard.canActivate(contextWith('Bearer shared-secret'))).toBe(true);
  });

  it('rejects a wrong token', () => {
    const guard = new EngineTokenGuard(config('production', 'shared-secret'));
    expect(() => guard.canActivate(contextWith('Bearer wrong'))).toThrow(UnauthorizedException);
  });

  it('rejects a missing header', () => {
    const guard = new EngineTokenGuard(config('production', 'shared-secret'));
    expect(() => guard.canActivate(contextWith())).toThrow(UnauthorizedException);
  });

  it('rejects a non-bearer scheme', () => {
    const guard = new EngineTokenGuard(config('production', 'shared-secret'));
    expect(() => guard.canActivate(contextWith('Basic shared-secret'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token that is a prefix of the real one', () => {
    // Guards against a length-based oracle.
    const guard = new EngineTokenGuard(config('production', 'shared-secret'));
    expect(() => guard.canActivate(contextWith('Bearer shared'))).toThrow(UnauthorizedException);
  });

  it('FAILS CLOSED when no token is configured outside development', () => {
    // A misconfigured deployment that silently accepted unauthenticated engine
    // events would be worse than one whose webhooks visibly fail.
    const guard = new EngineTokenGuard(config('production', ''));
    expect(() => guard.canActivate(contextWith('Bearer anything'))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(contextWith())).toThrow(UnauthorizedException);
  });

  it('allows an unauthenticated event in development only', () => {
    // Local development runs the engine without a credential.
    const guard = new EngineTokenGuard(config('development', ''));
    expect(guard.canActivate(contextWith())).toBe(true);
  });

  it('still enforces a configured token in development', () => {
    const guard = new EngineTokenGuard(config('development', 'local-token'));
    expect(() => guard.canActivate(contextWith('Bearer wrong'))).toThrow(UnauthorizedException);
    expect(guard.canActivate(contextWith('Bearer local-token'))).toBe(true);
  });
});
