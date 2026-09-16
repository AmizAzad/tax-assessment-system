import { Global, Module } from '@nestjs/common';
import { AuthorizationController } from './authorization.controller';
import { PermissionCacheService } from './permission-cache.service';

/**
 * The permission catalogue.
 *
 * Global because the guard is global: every request needs it.
 */
@Global()
@Module({
  controllers: [AuthorizationController],
  providers: [PermissionCacheService],
  exports: [PermissionCacheService],
})
export class AuthorizationModule {}
