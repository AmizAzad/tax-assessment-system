/**
 * Role codes.
 *
 * Plan reference: V2 section 9.2.
 *
 * Role codes are the currency of the whole authorisation model: they appear on
 * BPMN user tasks (`flowable:candidateGroups`), on permission mappings, and in
 * record-level scope predicates.
 *
 * The codes below are the reference set. A deployment may add its own — roles
 * are rows in `platform.role`, not a closed enum in code — but these are the
 * ones the shipped process definitions and permission seeds reference, so
 * renaming one is a breaking change to configuration.
 */
export const RoleCode = {
  TAXPAYER: 'TA_TAXPAYER',
  ASSESSOR: 'TA_ASSESSOR',
  SPECIALIST: 'TA_SPECIALIST',
  REVIEWER: 'TA_REVIEWER',
  APPROVER_L1: 'TA_APPROVER_L1',
  APPROVER_L2: 'TA_APPROVER_L2',
  APPROVER_L3: 'TA_APPROVER_L3',
  SUPERVISOR: 'TA_SUPERVISOR',
  OBJECTION_OFFICER: 'TA_OBJECTION_OFFICER',
  COMMITTEE_MEMBER: 'TA_COMMITTEE_MEMBER',
  APPEALS_OFFICER: 'TA_APPEALS_OFFICER',
  NOTICE_ISSUER: 'TA_NOTICE_ISSUER',
  AUDITOR_READONLY: 'TA_AUDITOR_READONLY',
  ADMIN: 'TA_ADMIN',
  SYSTEM: 'SYSTEM',
} as const;

export type RoleCode = (typeof RoleCode)[keyof typeof RoleCode];

export const ALL_ROLE_CODES: readonly RoleCode[] = Object.freeze(Object.values(RoleCode));

/** Approval levels, in ascending authority. Threshold routing picks one. */
export const APPROVER_LEVELS: readonly RoleCode[] = Object.freeze([
  RoleCode.APPROVER_L1,
  RoleCode.APPROVER_L2,
  RoleCode.APPROVER_L3,
]);

/**
 * Permission action levels.
 *
 * Hierarchical: FULL implies EDIT implies VIEW. A route requiring VIEW is
 * satisfied by a role holding EDIT on the same menu.
 */
export enum PermissionLevel {
  VIEW = 10,
  EDIT = 20,
  FULL = 30,
}

export function satisfiesPermission(held: PermissionLevel, required: PermissionLevel): boolean {
  return held >= required;
}

/**
 * Segregation-of-duties pairs.
 *
 * Each entry means: the same human may not perform both roles on the same
 * case. Enforced at transition time, not by convention. Plan section 9.3.
 */
export const SEGREGATION_OF_DUTIES: readonly (readonly [RoleCode, RoleCode])[] = Object.freeze([
  [RoleCode.ASSESSOR, RoleCode.REVIEWER],
  [RoleCode.REVIEWER, RoleCode.APPROVER_L1],
  [RoleCode.REVIEWER, RoleCode.APPROVER_L2],
  [RoleCode.REVIEWER, RoleCode.APPROVER_L3],
]);
