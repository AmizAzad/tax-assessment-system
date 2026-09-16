import { RoleCode } from '@tas/contracts';

/**
 * Who sees which cases.
 *
 * Plan reference: V2 section 20 ("mandatory scope predicate in the service
 * layer, never the controller"), section 9.1.
 *
 * ## Why this is one function and not a clause in each query
 *
 * The register, the dashboard and the export all answer "which cases may this
 * officer see", and they must answer it identically. Three copies of the
 * predicate is three chances for one of them to drift, and the drift would
 * not look like a bug — it would look like a slightly different total on a
 * screen nobody cross-checks. A dashboard that counts cases an officer cannot
 * open is a disclosure, however small.
 */

/**
 * Roles that see the whole register.
 *
 * Oversight rather than casework: an administrator configuring the system, an
 * auditor reading it, a supervisor accountable for the queue. Everybody else
 * sees the cases they are assigned to.
 */
export const UNSCOPED_ROLES: readonly string[] = [
  RoleCode.ADMIN,
  RoleCode.AUDITOR_READONLY,
  RoleCode.SUPERVISOR,
  /**
   * The notice issuer serves notices for the office, not for a caseload.
   *
   * Work reaches them because an assessment was finalised, never because it
   * was assigned to them — they are never in `tax_assessment_assignment`. A
   * scoped register would therefore always be empty, and the role could not
   * do the one thing it exists for.
   *
   * The committee member is deliberately **not** here: they are convened for
   * a particular objection and reach it by link, so they can open a case they
   * already know about and cannot browse the register.
   */
  RoleCode.NOTICE_ISSUER,
];

export function seesWholeRegister(roleCodes: readonly string[]): boolean {
  return roleCodes.some((role) => UNSCOPED_ROLES.includes(role));
}

/**
 * The SQL predicate, for a query that aliases `tax.tax_assessment_case` as `c`.
 *
 * Takes a bound `:callerId`. The unassigned caller is handled by the caller
 * passing -1, which matches no assignment row, so an unidentified request
 * sees an empty register rather than the whole one.
 */
export function registerScopeClause(roleCodes: readonly string[]): string {
  return seesWholeRegister(roleCodes)
    ? 'TRUE'
    : `EXISTS (SELECT 1 FROM tax.tax_assessment_assignment a
                WHERE a.case_id = c.id AND a.user_id = :callerId)`;
}
