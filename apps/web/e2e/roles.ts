/**
 * Who the tests sign in as.
 *
 * One list, used by the sign-in setup, the fixtures and the role-separation
 * tests. A role added to the realm and not added here would simply never be
 * exercised, which is the kind of gap that is invisible in a green run.
 */
export const ROLES = [
  'supervisor',
  'assessor',
  'reviewer',
  'approver',
  'notice-issuer',
  'objection-officer',
  'appeals-officer',
  'committee-member',
  'admin-tax',
  'acme-finance',
] as const;

export type Role = (typeof ROLES)[number];

/** Everyone who works inside the authority. `acme-finance` is not one of them. */
export const OFFICERS: readonly Role[] = ROLES.filter((role) => role !== 'acme-finance');

/** Password for every seeded local account. Local development only. */
export const PASSWORD = 'password';

/**
 * What each role should and should not be able to reach.
 *
 * Expressed as navigation labels because that is what a person sees. The
 * server is the control — these assertions check that the UI agrees with it,
 * which is a usability property rather than a security one, and is worth
 * having because a menu that offers what the API refuses trains officers to
 * expect errors.
 */
export const NAVIGATION: Readonly<Record<Role, { visible: string[]; hidden: string[] }>> = {
  supervisor: {
    visible: ['Dashboard', 'Cases', 'My Queues', 'Disputes', 'Selection', 'Reports'],
    hidden: ['My Tax Affairs'],
  },
  assessor: {
    visible: ['Dashboard', 'Cases', 'My Queues'],
    hidden: ['Administration', 'Selection', 'My Tax Affairs'],
  },
  reviewer: {
    visible: ['Dashboard', 'Cases', 'My Queues'],
    hidden: ['Administration', 'My Tax Affairs'],
  },
  approver: {
    visible: ['Dashboard', 'Cases', 'My Queues'],
    hidden: ['Administration', 'My Tax Affairs'],
  },
  'notice-issuer': {
    // Reads the whole register: notices are served for the office rather than
    // for a caseload, so this role is never assigned a case.
    visible: ['Dashboard', 'Cases'],
    hidden: ['Administration', 'My Tax Affairs', 'Selection'],
  },
  'objection-officer': {
    visible: ['Dashboard', 'Disputes'],
    hidden: ['Administration', 'My Tax Affairs'],
  },
  'appeals-officer': {
    visible: ['Dashboard', 'Disputes'],
    hidden: ['Administration', 'My Tax Affairs'],
  },
  'committee-member': {
    // Convened for a particular objection, so they reach a case by link from
    // the disputes list and cannot browse the register at all.
    visible: ['Dashboard', 'Disputes'],
    hidden: ['Administration', 'My Tax Affairs', 'Cases'],
  },
  'admin-tax': {
    visible: ['Dashboard', 'Cases', 'Reports', 'Administration', 'Process Modeller'],
    hidden: ['My Tax Affairs'],
  },
  'acme-finance': {
    // A taxpayer sees one thing. Everything else is somebody else's work.
    visible: ['My Tax Affairs'],
    hidden: ['Cases', 'Disputes', 'Reports', 'Administration', 'Dashboard', 'My Queues'],
  },
};
