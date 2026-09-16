import { CASE_TRANSITIONS, RoleCode } from '@tas/contracts';

/**
 * Security properties, asserted rather than assumed.
 *
 * Plan reference: V2 sections 6.3, 19.2, 27.3.
 *
 * ## What this is, and what it is not
 *
 * It is not a penetration test. A penetration test is performed by people
 * against a running deployment, and nothing written here substitutes for one.
 *
 * What this does is hold still the properties a penetration test would come
 * looking for, so that a change which quietly breaks one fails the build
 * instead of surviving to the engagement. Each test states the attack it
 * forecloses.
 *
 * The live checks -- an actual taxpayer token against another taxpayer's case,
 * an officer token against an endpoint they should not reach -- are in
 * `scripts/security/boundary-probe.js`, because they need a running stack.
 */
describe('security properties', () => {
  describe('the case state machine', () => {
    it('lets no external role reach an approval', () => {
      // The attack: a taxpayer account, obtained by registering, driving its
      // own assessment to APPROVED.
      const external: readonly string[] = [RoleCode.TAXPAYER];

      const reachable = CASE_TRANSITIONS.filter(
        (transition) =>
          transition.to === 'APPROVED' &&
          transition.actors.some((actor) => external.includes(actor)),
      );

      expect(reachable).toEqual([]);
    });

    it('lets no external role finalise, close, or write off a case', () => {
      // Each of these ends the authority's ability to collect, or makes a
      // figure legally binding. None is a taxpayer's to perform.
      const terminal = ['FINALISED', 'CLOSED', 'WRITTEN_OFF', 'TIME_BARRED'];

      const reachable = CASE_TRANSITIONS.filter(
        (transition) =>
          terminal.includes(String(transition.to)) && transition.actors.includes(RoleCode.TAXPAYER),
      );

      expect(reachable).toEqual([]);
    });

    it('lets no role assert a payment was received', () => {
      // PAYMENT_SETTLED is the single most damaging false record a revenue
      // system can hold. It must be reachable only by the platform, deciding
      // from the account rather than from anybody's say-so.
      const settled = CASE_TRANSITIONS.filter((transition) => transition.to === 'SETTLED');

      expect(settled.length).toBeGreaterThan(0);
      for (const transition of settled) {
        expect(transition.actors).toEqual([RoleCode.SYSTEM]);
      }
    });

    it('keeps routing and finalisation out of human hands', () => {
      // Routing decides which approver sees a case. If a person could choose,
      // they could route their own work to a friendlier approver.
      const guarded = ['ROUTE_APPROVAL', 'FINALISE', 'RETRIEVE_DATA'];

      for (const action of guarded) {
        const transitions = CASE_TRANSITIONS.filter((t) => t.action === action);
        expect(transitions.length).toBeGreaterThan(0);
        for (const transition of transitions) {
          expect(transition.actors).toEqual([RoleCode.SYSTEM]);
        }
      }
    });

    it('names an actor on every transition', () => {
      // A transition with no actors would be performable by anyone who passed
      // the route check, which is a different and much weaker control.
      for (const transition of CASE_TRANSITIONS) {
        expect(transition.actors.length).toBeGreaterThan(0);
      }
    });

    it('lets the taxpayer do only the things that are theirs to do', () => {
      // Filing an objection, appealing, and responding to a request. Anything
      // else appearing in this list is a privilege escalation.
      const taxpayerActions = CASE_TRANSITIONS.filter((transition) =>
        transition.actors.includes(RoleCode.TAXPAYER),
      ).map((transition) => transition.action);

      expect([...new Set(taxpayerActions)].sort()).toEqual([
        'FILE_APPEAL',
        'FILE_OBJECTION',
        'RESPOND',
      ]);
    });
  });

  describe('segregation of duties', () => {
    it('separates the roles that vouch for each other', () => {
      // A case must pass through hands that are not the same hands. If the
      // machine ever let one role both prepare and review, the control would
      // be satisfiable by one person.
      const submit = CASE_TRANSITIONS.find((t) => t.action === 'SUBMIT');
      const accept = CASE_TRANSITIONS.find((t) => t.action === 'ACCEPT');
      const approve = CASE_TRANSITIONS.find((t) => t.action === 'APPROVE');

      expect(submit?.actors).toContain(RoleCode.ASSESSOR);
      expect(accept?.actors).not.toContain(RoleCode.ASSESSOR);
      expect(approve?.actors).not.toContain(RoleCode.ASSESSOR);
      expect(approve?.actors).not.toContain(RoleCode.REVIEWER);
    });

    it('keeps objection decisions away from the officers who made the assessment', () => {
      const decisions = CASE_TRANSITIONS.filter((transition) =>
        transition.action.startsWith('DECIDE_'),
      );

      expect(decisions.length).toBeGreaterThan(0);
      for (const decision of decisions) {
        expect(decision.actors).not.toContain(RoleCode.ASSESSOR);
        expect(decision.actors).not.toContain(RoleCode.REVIEWER);
      }
    });

    it('keeps appeal outcomes with the appeals function', () => {
      // An appeal is decided outside the authority. Recording what was held is
      // a transcription duty with its own accountability, and specifically not
      // the assessor's.
      const outcomes = CASE_TRANSITIONS.filter((transition) =>
        transition.action.startsWith('RECORD_'),
      );

      expect(outcomes.length).toBeGreaterThan(0);
      for (const outcome of outcomes) {
        expect(outcome.actors).toEqual([RoleCode.APPEALS_OFFICER]);
      }
    });
  });

  describe('the authorisation model', () => {
    it('fails closed on an unknown route', async () => {
      const { decide, PermissionLevel } =
        await import('../src/platform/authorization/permission.model');

      // The attack: adding a route and forgetting to register it, then
      // relying on obscurity. An unregistered route must be refused to
      // everybody rather than open to everybody.
      const outcome = decide(
        'POST /api/v1/some/unregistered/route',
        PermissionLevel.VIEW,
        [RoleCode.ADMIN],
        new Map(),
        new Set(),
      );

      expect(outcome.allowed).toBe(false);
      expect(outcome.reason).toBe('ROUTE_NOT_REGISTERED');
    });

    it('refuses a caller with no roles', async () => {
      const { decide, PermissionLevel } =
        await import('../src/platform/authorization/permission.model');

      const outcome = decide(
        'GET /api/v1/cases',
        PermissionLevel.VIEW,
        [],
        new Map(),
        new Set(['GET /api/v1/cases']),
      );

      expect(outcome.allowed).toBe(false);
    });

    it('refuses a grant below the level the route requires', async () => {
      const { decide, PermissionLevel } =
        await import('../src/platform/authorization/permission.model');

      // The attack: a VIEW grant on a route that writes. Hierarchical levels
      // must not let a lower grant satisfy a higher requirement.
      const outcome = decide(
        'POST /api/v1/cases',
        PermissionLevel.FULL,
        [RoleCode.ASSESSOR],
        new Map([
          [RoleCode.ASSESSOR as string, new Map([['POST /api/v1/cases', PermissionLevel.VIEW]])],
        ]),
        new Set(['POST /api/v1/cases']),
      );

      expect(outcome.allowed).toBe(false);
    });
  });

  describe('audit redaction', () => {
    it('redacts a field it has never seen', async () => {
      const { redact } = await import('../src/platform/audit/redaction');

      // An allowlist, not a blocklist. A blocklist is a promise to have
      // thought of every sensitive field name, which nobody can keep: the
      // first time somebody adds `bankAccount`, a blocklist leaks it.
      const redacted = redact({ somethingNobodyAnticipated: 'sensitive value' }) as Record<
        string,
        unknown
      >;

      expect(JSON.stringify(redacted)).not.toContain('sensitive value');
    });

    it('redacts obviously sensitive values even under an allowed field name', async () => {
      const { redact } = await import('../src/platform/audit/redaction');

      const redacted = redact({
        narrative: 'Card 4111111111111111 was used',
      }) as Record<string, unknown>;

      expect(JSON.stringify(redacted)).not.toContain('4111111111111111');
    });
  });
});
