import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { VerifiedToken } from './token-verifier.service';

export interface LocalUser {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
}

/**
 * Mirrors identity-provider subjects into the local user table.
 *
 * Plan reference: V2 section 6.1; ADR-003.
 *
 * Audit rows reference `platform.app_user.id`, and an assessment must remain
 * attributable years later even if the IdP is replaced or a user is deleted
 * there. So the first time a valid token arrives for an unknown subject, the
 * user is provisioned locally.
 *
 * What is deliberately NOT mirrored: roles. Role membership is read from the
 * token on every request, so a role revoked in the IdP takes effect at the
 * next token refresh rather than persisting in a stale local copy.
 */
@Injectable()
export class UserDirectoryService {
  private readonly logger = new Logger(UserDirectoryService.name);

  /** Subject -> local user. Bounded, because subjects are stable and few. */
  private readonly cache = new Map<string, LocalUser>();

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async resolve(token: VerifiedToken): Promise<LocalUser> {
    const cached = this.cache.get(token.subject);
    if (cached !== undefined) {
      return cached;
    }

    const existing = await this.sequelize.query<{
      id: string;
      username: string;
      display_name: string;
    }>(
      `SELECT id, username, display_name
         FROM platform.app_user
        WHERE external_subject = :subject`,
      { type: QueryTypes.SELECT, replacements: { subject: token.subject } },
    );

    const found = existing[0];
    if (found !== undefined) {
      const user: LocalUser = {
        id: Number(found.id),
        username: found.username,
        displayName: found.display_name,
      };
      this.cache.set(token.subject, user);
      return user;
    }

    return this.provision(token);
  }

  private async provision(token: VerifiedToken): Promise<LocalUser> {
    // ON CONFLICT rather than check-then-insert: two concurrent first requests
    // for the same new user would otherwise race, and one would fail on the
    // unique constraint.
    const inserted = await this.sequelize.query<{
      id: string;
      username: string;
      display_name: string;
    }>(
      `INSERT INTO platform.app_user (external_subject, username, display_name, email)
            VALUES (:subject, :username, :displayName, :email)
       ON CONFLICT (external_subject) DO UPDATE
               SET username     = EXCLUDED.username,
                   display_name = EXCLUDED.display_name,
                   email        = EXCLUDED.email,
                   updated_at   = CURRENT_TIMESTAMP
         RETURNING id, username, display_name`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          subject: token.subject,
          username: token.username,
          displayName: token.username,
          email: token.email ?? null,
        },
      },
    );

    const row = inserted[0];
    if (row === undefined) {
      throw new Error(`Failed to provision local user for subject ${token.subject}`);
    }

    this.logger.log(`Provisioned local user for ${token.username}`);
    const user: LocalUser = {
      id: Number(row.id),
      username: row.username,
      displayName: row.display_name,
    };
    this.cache.set(token.subject, user);
    return user;
  }

  /** Drop the cache. Used after an administrative change to a user record. */
  invalidate(subject?: string): void {
    if (subject === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(subject);
    }
  }
}
