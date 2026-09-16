import { join } from 'node:path';

export { PASSWORD, ROLES, OFFICERS, NAVIGATION } from '../roles';
export type { Role } from '../roles';

/** Where a signed-in session is kept between the setup project and the tests. */
export function sessionFile(role: string): string {
  return join(__dirname, '..', '.auth', `${role}.json`);
}
