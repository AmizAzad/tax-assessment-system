import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { TokenVerifierService } from './token-verifier.service';
import { UserDirectoryService } from './user-directory.service';

/**
 * Authentication.
 *
 * AuthGuard is registered as APP_GUARD, so routes are protected by default and
 * must opt out with @Public(). Opting in per route would mean the first
 * forgotten decorator is an open endpoint.
 */
@Global()
@Module({
  providers: [
    TokenVerifierService,
    UserDirectoryService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [TokenVerifierService, UserDirectoryService],
})
export class AuthModule {}
