import {
  ActionCode,
  CASE_TRANSITIONS,
  CaseStatus,
  InvalidTransitionError,
  RoleCode,
  TERMINAL_CASE_STATUSES,
  UnauthorisedTransitionError,
  assertTransition,
  availableActions,
  findTransition,
  isTransitionPermitted,
  reachableStatuses,
  statusesWithAction,
} from '../src';

describe('case state machine structure', () => {
  it('has exactly one entry point', () => {
    const entries = CASE_TRANSITIONS.filter((t) => t.from === null);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.to).toBe(CaseStatus.INITIATED);
  });

  it('defines no transition out of a terminal status', () => {
    for (const terminal of TERMINAL_CASE_STATUSES) {
      expect(CASE_TRANSITIONS.filter((t) => t.from === terminal)).toHaveLength(0);
    }
  });

  it('has no duplicate (from, action) pairs', () => {
    // A duplicate would make the transition non-deterministic, and findTransition
    // would silently pick the first. Better to fail here.
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const t of CASE_TRANSITIONS) {
      const key = `${t.from ?? 'START'}::${t.action}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });

  it('gives every transition at least one permitted actor', () => {
    // A transition with no actors is unreachable, which is almost certainly a
    // mistake rather than an intent.
    const orphans = CASE_TRANSITIONS.filter((t) => t.actors.length === 0);
    expect(orphans).toEqual([]);
  });

  it('reaches every non-exception status from the entry point', () => {
    // Exception statuses are entered by compensating actions, not by a normal
    // transition, so they are excluded from reachability.
    const excluded = new Set<CaseStatus>([
      CaseStatus.FINALISATION_FAILED,
      CaseStatus.NOTICE_FAILED,
    ]);

    const reached = new Set<CaseStatus>([CaseStatus.INITIATED]);
    const queue: CaseStatus[] = [CaseStatus.INITIATED];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of reachableStatuses(current)) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }

    const unreachable = Object.values(CaseStatus).filter(
      (status) => !reached.has(status) && !excluded.has(status),
    );
    expect(unreachable).toEqual([]);
  });

  it('lets every non-terminal status reach a terminal status', () => {
    // A status that cannot reach CLOSED is a case that can never be finished.
    const canTerminate = (start: CaseStatus): boolean => {
      const seen = new Set<CaseStatus>([start]);
      const queue: CaseStatus[] = [start];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (TERMINAL_CASE_STATUSES.includes(current)) return true;
        for (const next of reachableStatuses(current)) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return false;
    };

    const stuck = Object.values(CaseStatus).filter(
      (status) =>
        !TERMINAL_CASE_STATUSES.includes(status) &&
        status !== CaseStatus.FINALISATION_FAILED &&
        status !== CaseStatus.NOTICE_FAILED &&
        !canTerminate(status),
    );
    expect(stuck).toEqual([]);
  });
});

describe('transition lookup', () => {
  it('finds a defined transition', () => {
    const transition = findTransition({
      from: CaseStatus.UNDER_REVIEW,
      action: ActionCode.ACCEPT,
    });
    expect(transition?.to).toBe(CaseStatus.REVIEWED);
  });

  it('returns undefined for an undefined transition', () => {
    expect(
      findTransition({ from: CaseStatus.INITIATED, action: ActionCode.APPROVE }),
    ).toBeUndefined();
  });

  it('reports whether a transition is permitted', () => {
    expect(isTransitionPermitted({ from: CaseStatus.DATA_READY, action: ActionCode.ASSIGN })).toBe(
      true,
    );
    expect(isTransitionPermitted({ from: CaseStatus.DATA_READY, action: ActionCode.APPROVE })).toBe(
      false,
    );
  });

  it('lists available actions for a status', () => {
    const actions = availableActions(CaseStatus.UNDER_REVIEW);
    expect(actions).toContain(ActionCode.ACCEPT);
    expect(actions).toContain(ActionCode.RETURN);
    expect(actions).not.toContain(ActionCode.APPROVE);
  });

  it('lists no actions for a terminal status', () => {
    expect(availableActions(CaseStatus.CLOSED)).toEqual([]);
  });

  it('lists every status a settling payment can be recorded against', () => {
    expect([...statusesWithAction('PAYMENT_SETTLED')].sort()).toEqual([
      'APPEAL_UPHELD',
      'AWAITING_TAXPAYER_RESPONSE',
    ]);
  });
});

describe('assertTransition', () => {
  it('returns the transition when status and role both permit it', () => {
    const transition = assertTransition(CaseStatus.UNDER_REVIEW, ActionCode.ACCEPT, [
      RoleCode.REVIEWER,
    ]);
    expect(transition.to).toBe(CaseStatus.REVIEWED);
  });

  it('accepts a caller holding several roles, one of which is sufficient', () => {
    const transition = assertTransition(CaseStatus.DATA_READY, ActionCode.ASSIGN, [
      RoleCode.ASSESSOR,
      RoleCode.SUPERVISOR,
    ]);
    expect(transition.to).toBe(CaseStatus.ASSIGNED);
  });

  it('rejects an action not valid from the current status', () => {
    expect(() =>
      assertTransition(CaseStatus.INITIATED, ActionCode.APPROVE, [RoleCode.APPROVER_L1]),
    ).toThrow(InvalidTransitionError);
  });

  it('rejects a caller without a permitted role', () => {
    expect(() =>
      assertTransition(CaseStatus.UNDER_REVIEW, ActionCode.ACCEPT, [RoleCode.ASSESSOR]),
    ).toThrow(UnauthorisedTransitionError);
  });

  it('rejects any transition out of a terminal status', () => {
    // Reopening a closed case is not permitted: reassessment creates a
    // successor case, it never reopens the predecessor.
    expect(() => assertTransition(CaseStatus.CLOSED, 'START', [RoleCode.ADMIN])).toThrow(
      InvalidTransitionError,
    );
  });

  it('permits the entry transition from a null status', () => {
    const transition = assertTransition(null, 'INITIATE', [RoleCode.SUPERVISOR]);
    expect(transition.to).toBe(CaseStatus.INITIATED);
  });

  it('names the permitted actions in the error message', () => {
    expect(() =>
      assertTransition(CaseStatus.INITIATED, ActionCode.APPROVE, [RoleCode.ADMIN]),
    ).toThrow(/RETRIEVE_DATA/);
  });

  it('lets an officer record a response the taxpayer made off the portal', () => {
    for (const role of ['TA_TAXPAYER', 'TA_ASSESSOR', 'TA_SUPERVISOR']) {
      expect(assertTransition(CaseStatus.AWAITING_TAXPAYER, ActionCode.RESPOND, [role]).to).toBe(
        CaseStatus.IN_PREPARATION,
      );
    }
  });

  it('refuses a response recorded by a role with no part in the request', () => {
    expect(() =>
      assertTransition(CaseStatus.AWAITING_TAXPAYER, ActionCode.RESPOND, ['TA_REVIEWER']),
    ).toThrow(UnauthorisedTransitionError);
  });

  it('names the required roles in the authorisation error', () => {
    expect(() =>
      assertTransition(CaseStatus.UNDER_REVIEW, ActionCode.ACCEPT, [RoleCode.ASSESSOR]),
    ).toThrow(/TA_REVIEWER/);
  });
});

describe('lifecycle walkthrough', () => {
  it('walks the happy path from initiation to closure', () => {
    const path: Array<[CaseStatus | null, string, RoleCode]> = [
      [null, 'INITIATE', RoleCode.SUPERVISOR],
      [CaseStatus.INITIATED, 'RETRIEVE_DATA', RoleCode.SYSTEM],
      [CaseStatus.DATA_READY, ActionCode.ASSIGN, RoleCode.SUPERVISOR],
      [CaseStatus.ASSIGNED, 'START', RoleCode.ASSESSOR],
      [CaseStatus.IN_PREPARATION, 'CALCULATE', RoleCode.ASSESSOR],
      [CaseStatus.CALCULATED, ActionCode.SUBMIT, RoleCode.ASSESSOR],
      [CaseStatus.UNDER_REVIEW, ActionCode.ACCEPT, RoleCode.REVIEWER],
      [CaseStatus.REVIEWED, 'ROUTE_APPROVAL', RoleCode.SYSTEM],
      [CaseStatus.PENDING_APPROVAL, ActionCode.APPROVE, RoleCode.APPROVER_L1],
      [CaseStatus.APPROVED, 'FINALISE', RoleCode.SYSTEM],
      [CaseStatus.FINALISED, 'GENERATE_NOTICE', RoleCode.SYSTEM],
      [CaseStatus.NOTICE_GENERATED, ActionCode.SERVED, RoleCode.SYSTEM],
      [CaseStatus.NOTICE_SERVED, 'START_RESPONSE_WINDOW', RoleCode.SYSTEM],
      [CaseStatus.AWAITING_TAXPAYER_RESPONSE, 'PAYMENT_SETTLED', RoleCode.SYSTEM],
      [CaseStatus.SETTLED, ActionCode.CLOSE, RoleCode.SUPERVISOR],
    ];

    let current: CaseStatus | null = null;
    for (const [from, action, role] of path) {
      expect(current).toBe(from);
      current = assertTransition(current, action, [role]).to;
    }
    expect(current).toBe(CaseStatus.CLOSED);
  });

  it('walks the dispute path through objection and appeal to reassessment', () => {
    let current: CaseStatus = CaseStatus.AWAITING_TAXPAYER_RESPONSE;
    current = assertTransition(current, 'FILE_OBJECTION', [RoleCode.TAXPAYER]).to;
    expect(current).toBe(CaseStatus.UNDER_OBJECTION);

    current = assertTransition(current, 'DECIDE_REJECTED', [RoleCode.OBJECTION_OFFICER]).to;
    expect(current).toBe(CaseStatus.OBJECTION_REJECTED);

    current = assertTransition(current, 'FILE_APPEAL', [RoleCode.TAXPAYER]).to;
    expect(current).toBe(CaseStatus.UNDER_APPEAL);

    current = assertTransition(current, 'RECORD_VARIED', [RoleCode.APPEALS_OFFICER]).to;
    expect(current).toBe(CaseStatus.APPEAL_VARIED);

    current = assertTransition(current, 'REASSESS', [RoleCode.SYSTEM]).to;
    expect(current).toBe(CaseStatus.REASSESSMENT_INITIATED);

    current = assertTransition(current, 'START', [RoleCode.ASSESSOR]).to;
    expect(current).toBe(CaseStatus.IN_PREPARATION);
  });

  it('walks the rework loop from review back to preparation', () => {
    let current = assertTransition(CaseStatus.UNDER_REVIEW, ActionCode.RETURN, [
      RoleCode.REVIEWER,
    ]).to;
    expect(current).toBe(CaseStatus.REVIEW_RETURNED);

    current = assertTransition(current, 'START', [RoleCode.ASSESSOR]).to;
    expect(current).toBe(CaseStatus.IN_PREPARATION);
  });
});
