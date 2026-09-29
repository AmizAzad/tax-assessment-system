import { QueryTypes, Sequelize } from 'sequelize';
import { UserDirectoryService } from '../src/platform/auth/user-directory.service';
import type { VerifiedToken } from '../src/platform/auth/token-verifier.service';

/**
 * Mirroring IdP subjects into the local directory, against a real database.
 *
 * Plan reference: V2 section 6.1; ADR-003.
 *
 * Run with `npm run dev:up`. Database-backed because the defect this guards
 * against was a unique constraint firing on `username`, which a mocked
 * Sequelize cannot raise.
 */

const sequelize = new Sequelize({
  dialect: 'postgres',
  host: process.env['DB_HOST'] ?? 'localhost',
  port: Number(process.env['DB_PORT'] ?? 5433),
  username: process.env['DB_USER'] ?? 'tas',
  password: process.env['DB_PASSWORD'] ?? 'tas_local_dev_only',
  database: process.env['DB_NAME'] ?? 'tax_assessment',
  logging: false,
});

const RUN = Date.now();

function token(subject: string, username: string): VerifiedToken {
  return { subject, username, roleCodes: [], expiresAt: new Date(RUN + 60_000) };
}

async function seed(subject: string, username: string): Promise<number> {
  const rows = await sequelize.query<{ id: string }>(
    `INSERT INTO platform.app_user (external_subject, username, display_name)
          VALUES (:subject, :username, :username)
       RETURNING id`,
    { type: QueryTypes.SELECT, replacements: { subject, username } },
  );
  return Number(rows[0]!.id);
}

async function subjectOf(id: number): Promise<string> {
  const rows = await sequelize.query<{ external_subject: string }>(
    `SELECT external_subject FROM platform.app_user WHERE id = :id`,
    { type: QueryTypes.SELECT, replacements: { id } },
  );
  return rows[0]!.external_subject;
}

beforeAll(async () => {
  await sequelize.authenticate();
});

// Rows seeded here are referenced by nothing, so they can go.
afterAll(async () => {
  await sequelize.query(`DELETE FROM platform.app_user WHERE username LIKE :prefix`, {
    replacements: { prefix: `ud-spec-${RUN}-%` },
  });
  await sequelize.close();
});

describe('UserDirectoryService', () => {
  it('binds a row seeded as pending to the first subject that signs in with its username', async () => {
    const username = `ud-spec-${RUN}-pending`;
    const seededId = await seed(`pending:${username}`, username);

    const user = await new UserDirectoryService(sequelize).resolve(
      token(`sub-${RUN}-pending`, username),
    );

    expect(user.id).toBe(seededId);
    expect(await subjectOf(seededId)).toBe(`sub-${RUN}-pending`);
  });

  it('does not rebind a row already held by another subject', async () => {
    const username = `ud-spec-${RUN}-bound`;
    const seededId = await seed(`sub-${RUN}-original`, username);

    await expect(
      new UserDirectoryService(sequelize).resolve(token(`sub-${RUN}-newcomer`, username)),
    ).rejects.toThrow();

    expect(await subjectOf(seededId)).toBe(`sub-${RUN}-original`);
  });

  it('does not claim a pending marker written for a different username', async () => {
    const username = `ud-spec-${RUN}-owner`;
    const seededId = await seed(`pending:${username}`, username);

    const other = await new UserDirectoryService(sequelize).resolve(
      token(`sub-${RUN}-other`, `ud-spec-${RUN}-other`),
    );

    expect(other.id).not.toBe(seededId);
    expect(await subjectOf(seededId)).toBe(`pending:${username}`);
  });

  it('provisions a user it has never seen', async () => {
    const username = `ud-spec-${RUN}-fresh`;

    const user = await new UserDirectoryService(sequelize).resolve(
      token(`sub-${RUN}-fresh`, username),
    );

    expect(user.username).toBe(username);
    expect(await subjectOf(user.id)).toBe(`sub-${RUN}-fresh`);
  });
});
