import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ActionCode,
  CaseEventType,
  CaseStatus,
  RoleCode,
  assertTransition,
  isFrozenStatus,
} from '@tas/contracts';
import { QueryTypes, Transaction, type Sequelize } from 'sequelize';
import { ReferenceNumberService } from '../../forms/reference-number.service';
import { DeadlineService } from '../deadline/deadline.service';
import { SlaService } from '../deadline/sla.service';
import { ProcessOrchestrationService } from '../workflow/process-orchestration.service';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { currentUserId } from '../../platform/auth/request-context';

export interface AssessmentCase {
  readonly id: number;
  readonly uuid: string;
  readonly caseNumber: string;
  readonly taxpayerId: number;
  readonly tin: string;
  readonly taxpayerName: string;
  readonly taxTypeCode: string;
  readonly jurisdictionCode: string;
  readonly assessmentYear: string;
  readonly assessmentType: string;
  readonly triggerPath: string;
  readonly statusCode: CaseStatus;
  readonly liabilityStatus: string;
  readonly version: number;
  readonly currencyCode: string;
  readonly assessedBase: string | null;
  readonly netPayable: string | null;
  readonly limitationDate: string | null;
  readonly openedAt: Date;
}

export interface CreateCaseInput {
  readonly taxpayerId: number;
  readonly taxTypeCode: string;
  readonly assessmentYear: string;
  readonly assessmentType: string;
  readonly triggerPath: string;
  readonly jurisdictionCode?: string;
  readonly currencyCode?: string;
  readonly limitationDate?: string;
}

/**
 * The assessment case lifecycle.
 *
 * Plan reference: V2 sections 8.2, 10.2, 16.2; ADR-009.
 *
 * ## Only this service writes `status_code`
 *
 * And it only does so through `transition`, which validates against the state
 * machine in `@tas/contracts`. A controller setting a status directly would
 * bypass both the permitted-transition check and the event ledger, and the
 * ledger is the audit system of record (plan 19.2).
 *
 * ## Every status change writes exactly one event, in the same transaction
 *
 * If the event write fails, the status change rolls back with it. A case whose
 * status moved without a corresponding ledger entry would be a case whose
 * history has a hole in it, which is precisely what an auditor looks for.
 *
 * ## Segregation of duties is enforced here
 *
 * Reviewer ≠ preparer and approver ≠ reviewer are rules about a *case*, so
 * they belong where the case is in scope — not in the workflow layer, which
 * only knows about tasks (plan 9.3).
 */
@Injectable()
export class CaseService {
  private readonly logger = new Logger(CaseService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly referenceNumbers: ReferenceNumberService,
    private readonly sla: SlaService,
    private readonly processes: ProcessOrchestrationService,
    private readonly deadlines: DeadlineService,
  ) {}

  // ------------------------------------------------------------------ create

  async create(input: CreateCaseInput, caller: RequestContext): Promise<AssessmentCase> {
    assertTransition(null, 'INITIATE', caller.roleCodes);

    const taxpayer = await this.loadTaxpayer(input.taxpayerId);
    const jurisdiction = input.jurisdictionCode ?? taxpayer.jurisdictionCode;

    // The currency the case is assessed in comes from the rule set that will
    // compute it, not from a default. A case opened in the wrong currency
    // either fails at calculation or, worse, mixes currencies in the account.
    const currency =
      input.currencyCode ?? (await this.currencyFor(jurisdiction, input.taxTypeCode));

    // One open case per taxpayer, tax type and year. The database enforces it
    // too; checking here produces a message an officer can act on rather than
    // a constraint violation.
    const existing = await this.sequelize.query<{ case_number: string; status_code: string }>(
      `SELECT case_number, status_code FROM tax.tax_assessment_case
        WHERE taxpayer_id = :taxpayerId
          AND tax_type_code = :taxTypeCode
          AND assessment_year = :assessmentYear
          AND status_code NOT IN ('CLOSED', 'CANCELLED', 'TIME_BARRED', 'WRITTEN_OFF')`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          taxpayerId: input.taxpayerId,
          taxTypeCode: input.taxTypeCode,
          assessmentYear: input.assessmentYear,
        },
      },
    );
    if (existing.length > 0) {
      const clash = existing[0]!;
      // Naming the status matters. A case sitting at FINALISED is not "open"
      // in the everyday sense, but it is still live: the notice may not have
      // been served and the objection window has not run. A second assessment
      // for the same period would compete with it.
      throw new ConflictException(
        `A live assessment already exists for this taxpayer, tax type and year: ` +
          `${clash.case_number}, currently ${clash.status_code}. Only a closed, cancelled, ` +
          `time-barred or written-off case frees the period. Reassess that case rather than ` +
          `opening a second.`,
      );
    }

    const pattern = await this.referencePattern(jurisdiction);
    const caseNumber = await this.referenceNumbers.allocate(pattern);

    const opened = await this.sequelize.transaction(async (transaction) => {
      const rows = await this.sequelize.query<Record<string, unknown>>(
        // `ux_case_scope_version` covers the scope plus the version for every
        // status but CANCELLED, so a second case for a period freed by closure
        // collides unless it is numbered above the case it follows. Derived in
        // the statement rather than read first, because two officers reading
        // the same maximum would both insert the same version.
        `INSERT INTO tax.tax_assessment_case
                (case_number, taxpayer_id, tin, taxpayer_name, tax_type_code,
                 jurisdiction_code, assessment_year, assessment_type, trigger_path,
                 status_code, currency_code, limitation_date, created_by, version)
         VALUES (:caseNumber, :taxpayerId, :tin, :taxpayerName, :taxTypeCode,
                 :jurisdiction, :assessmentYear, :assessmentType, :triggerPath,
                 :status, :currency, :limitationDate, :userId,
                 (SELECT COALESCE(MAX(version), 0) + 1
                    FROM tax.tax_assessment_case
                   WHERE taxpayer_id = :taxpayerId
                     AND tax_type_code = :taxTypeCode
                     AND assessment_year = :assessmentYear))
         RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            caseNumber,
            taxpayerId: input.taxpayerId,
            tin: taxpayer.tin,
            taxpayerName: taxpayer.name,
            taxTypeCode: input.taxTypeCode,
            jurisdiction,
            assessmentYear: input.assessmentYear,
            assessmentType: input.assessmentType,
            triggerPath: input.triggerPath,
            status: CaseStatus.INITIATED,
            currency: currency,
            limitationDate: input.limitationDate ?? null,
            userId: currentUserId() ?? null,
          },
        },
      );

      const created = toCase(rows[0]!);

      await this.writeEvent(
        transaction,
        created.id,
        CaseEventType.CASE_INITIATED,
        null,
        CaseStatus.INITIATED,
        caller,
        { triggerPath: input.triggerPath, assessmentType: input.assessmentType },
      );

      this.logger.log(`Opened case ${caseNumber} for ${taxpayer.tin}`);
      return created;
    });

    // Coordination starts after the case is committed, not inside the
    // transaction. The engine is a separate system: holding a database
    // transaction open across a network call to it would let a slow engine
    // hold locks on the register, and a rolled-back transaction would leave
    // the engine coordinating a case that does not exist.
    //
    // This never throws. An unreachable engine means a case worked by hand,
    // which is a nuisance; a case that could not be opened is a taxpayer who
    // is not assessed.
    await this.processes.onCaseOpened(opened);

    return opened;
  }

  // -------------------------------------------------------------- transition

  /**
   * Move a case to a new status.
   *
   * The only path by which `status_code` changes. Validates the transition,
   * checks segregation of duties, writes the status and the ledger entry in
   * one transaction.
   */
  async transition(
    caseId: number,
    action: ActionCode | string,
    caller: RequestContext,
    payload: Record<string, unknown> = {},
  ): Promise<AssessmentCase> {
    const current = await this.findById(caseId);

    // Throws InvalidTransitionError or UnauthorisedTransitionError, both of
    // which say exactly what was wrong.
    const transition = assertTransition(current.statusCode, action, caller.roleCodes);

    /**
     * The reason is a precondition of the move, not a courtesy on the event.
     *
     * Which moves need one is the transition table's business, so this reads
     * the flag off the row rather than listing the actions again. The screen
     * refuses to submit without a reason; before this check the server took
     * the same call from curl and wrote a cancellation nobody had to justify.
     */
    if (transition.requiresReason) {
      const reason = payload['reason'];
      if (typeof reason !== 'string' || reason.trim() === '') {
        throw new BadRequestException(
          `Action ${action} requires a reason. Moving this case from ${current.statusCode} to ` +
            `${transition.to} is recorded against the officer who did it, and the ledger has to ` +
            `carry why. Blank space is not a reason.`,
        );
      }
    }

    await this.assertSegregationOfDuties(caseId, transition.to, caller);

    const moved = await this.sequelize.transaction(async (t) => {
      const rows = await this.sequelize.query<Record<string, unknown>>(
        `UPDATE tax.tax_assessment_case
            SET status_code = :status,
                finalised_at = CASE WHEN :status = 'FINALISED'
                                    THEN COALESCE(finalised_at, CURRENT_TIMESTAMP)
                                    ELSE finalised_at END,
                closed_at = CASE WHEN :status IN ('CLOSED','CANCELLED','TIME_BARRED','WRITTEN_OFF')
                                 THEN COALESCE(closed_at, CURRENT_TIMESTAMP)
                                 ELSE closed_at END,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = :userId
          WHERE id = :caseId
        RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction: t,
          replacements: {
            caseId,
            status: transition.to,
            userId: currentUserId() ?? null,
          },
        },
      );

      await this.writeEvent(
        t,
        caseId,
        transition.event,
        current.statusCode,
        transition.to,
        caller,
        { action, ...payload },
      );

      // Record who did what, so segregation of duties can be checked on the
      // next transition rather than trusted to memory.
      //
      // The capacity recorded is the one the *caller* acted in, which is not
      // always suggested by the target status. Moving a case to UNDER_REVIEW
      // is the assessor submitting their own work; recording that person as a
      // reviewer would be a false participation record, and would later bar
      // them from work they are entitled to do.
      if (transition.to === CaseStatus.IN_PREPARATION) {
        await this.recordParticipation(t, caseId, RoleCode.ASSESSOR, caller);
      }
      if (transition.to === CaseStatus.REVIEWED) {
        await this.recordParticipation(t, caseId, RoleCode.REVIEWER, caller);
      }
      if (transition.to === CaseStatus.APPROVED || transition.to === CaseStatus.REJECTED) {
        await this.recordParticipation(t, caseId, RoleCode.APPROVER_L1, caller);
      }

      /**
       * Assigning names somebody, or it has not assigned anything.
       *
       * `ASSIGN` moved the case to `ASSIGNED` and wrote an event, and that was
       * all: no assignment row was created unless a separate call was made to
       * `/cases/:id/assign`. The register is scoped to cases the caller is
       * assigned to, so the officer the work was given to could not find it —
       * and could not press Start, which is the transition that would finally
       * have created the row. Through the API it looked fine, because the
       * walkthrough passes an assignee and then uses a supervisor's unscoped
       * view.
       *
       * So the assignee travels with the action and the row is written here,
       * in the same transaction as the status change. An `ASSIGN` naming
       * nobody is refused rather than silently doing half the job.
       */
      if (transition.to === CaseStatus.ASSIGNED) {
        const username = payload['assigneeUsername'];
        if (typeof username !== 'string' || username.trim() === '') {
          throw new BadRequestException(
            'Assigning a case requires the officer it is being assigned to.',
          );
        }
        await this.assignByUsername(t, caseId, username.trim(), caller);
      }

      // Service clocks move with the case, in the same transaction. A stage
      // beginning is something only this method knows: it is the single writer
      // of `status_code`, so anywhere else would be guessing at the moment.
      await this.sla.applyTransition(
        caseId,
        current,
        current.statusCode,
        transition.to,
        caller.userId,
        t,
      );

      this.logger.log(
        `Case ${current.caseNumber}: ${current.statusCode} -> ${transition.to} (${action})`,
      );
      return toCase(rows[0]!);
    });

    // Told to the engine after the commit, for the same reason the process is
    // started after one: the register must not hold locks across a call to a
    // separate system, and the engine must never be told about a movement that
    // was then rolled back.
    const engineVariables =
      moved.statusCode === CaseStatus.AWAITING_TAXPAYER
        ? { ...payload, ...(await this.informationRequestWindow(moved, caller)) }
        : payload;

    await this.processes.onTransition(moved, action, moved.statusCode, engineVariables);

    // A case that ends without completing the flow leaves an instance waiting
    // on a task nobody will do. Those are what fill an engine with ghosts.
    if (isTerminalStatus(moved.statusCode)) {
      await this.processes.onCaseClosed(moved, `Case reached ${moved.statusCode}`);
    }

    return moved;
  }

  /**
   * The date an information request has to be answered by, for the engine.
   *
   * The process waits for the taxpayer on a boundary timer, and the timer
   * needs a date. Taking it from a duration in the diagram would put the
   * United Kingdom's response period into a definition every jurisdiction
   * deploys, so the API reads it out of the `RESPONSE` deadline configured
   * for this case's jurisdiction and tax type.
   *
   * The date is read back out of the row rather than taken from what
   * `materialise` returned. `materialise` recomputes a date on every call and
   * returns it, but leaves a row that is already breached or satisfied alone,
   * so the two can disagree. The row is the record, and the engine has to be
   * told what the record says.
   *
   * Nothing here may fail a transition. The posture of this file is that the
   * register is not held hostage to the engine: a case that cannot be
   * coordinated is worked by hand, and an information request that lost its
   * timer is one an officer chases themselves.
   */
  private async informationRequestWindow(
    movedCase: AssessmentCase,
    caller: RequestContext,
  ): Promise<Record<string, string>> {
    try {
      const requestedOn = caller.requestedAt.toISOString().slice(0, 10);
      await this.deadlines.materialise(movedCase, 'INFO_REQUESTED', requestedOn, caller);

      // `due_at` is the last day the taxpayer may answer, so the period runs
      // to the end of it -- which is how `markBreached` reads the same column,
      // breaching only once `due_at` is behind the current date. Flowable's
      // timeDate wants an instant, and the first instant after that last day
      // is midnight on the day following it. Firing at midnight on `due_at`
      // itself would take a day off every statutory response period, and a
      // deadline this platform moves earlier than the statute allows is time
      // taken from the taxpayer.
      //
      // The day is added in SQL rather than by date arithmetic here, because a
      // date in this domain is a calendar day in the register's terms and not
      // a point on a JavaScript clock.
      const rows = await this.sequelize.query<{ expires_at: string | null }>(
        `SELECT (due_at + INTERVAL '1 day')::date::text AS expires_at
           FROM tax.tax_assessment_deadline
          WHERE case_id = :caseId
            AND deadline_type = 'RESPONSE'
            AND anchor_event = 'INFO_REQUESTED'
            AND is_active
          ORDER BY id DESC
          LIMIT 1`,
        { type: QueryTypes.SELECT, replacements: { caseId: movedCase.id } },
      );

      const expiresAt = rows[0]?.expires_at;
      if (expiresAt === undefined || expiresAt === null) {
        // No RESPONSE deadline is configured for this jurisdiction and tax
        // type. The request is still valid; it just never times out by itself.
        return {};
      }

      return { infoResponseDueAt: `${expiresAt}T00:00:00Z` };
    } catch (error) {
      this.logger.warn(
        `Case ${movedCase.caseNumber}: could not supply the response window to the engine; ` +
          `the information request will not time out by itself. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
  }

  /**
   * Reviewer ≠ preparer, approver ≠ reviewer.
   *
   * Plan section 9.3. Checked against the participation record rather than the
   * current assignment, because the question is "did this person already act
   * in an incompatible capacity on this case", not "are they assigned now".
   */
  private async assertSegregationOfDuties(
    caseId: number,
    targetStatus: CaseStatus,
    caller: RequestContext,
  ): Promise<void> {
    /**
     * Which prior capacities bar a person from reaching each status.
     *
     * UNDER_REVIEW is deliberately absent. Submitting for review is the
     * assessor's own act, so barring the assessor there would mean no case
     * could ever be submitted, and a case returned for rework or reassessed
     * after an appeal could never be resubmitted by the person who knows it.
     *
     * The real control points are the ones where somebody vouches for
     * somebody else's work: accepting a review, and approving.
     */
    const incompatible: Record<string, readonly string[]> = {
      [CaseStatus.REVIEWED]: [RoleCode.ASSESSOR],
      [CaseStatus.APPROVED]: [RoleCode.ASSESSOR, RoleCode.REVIEWER],
      [CaseStatus.REJECTED]: [RoleCode.ASSESSOR, RoleCode.REVIEWER],
    };

    const barred = incompatible[targetStatus];
    // Every other target status is either a system step or one where no prior
    // capacity conflicts, so there is nothing to check.
    if (barred === undefined) return;

    // The caller as an argument, not `currentUserId()` from the ambient store.
    // This is an authorisation decision, and the project's own rule (see
    // request-context.ts) is that those take the caller explicitly: a check
    // that reads identity from AsyncLocalStorage silently stops working the
    // moment it is called from anywhere that has not established a context.
    const userId = caller.userId;

    if (userId === undefined) {
      // Fails closed. The previous behaviour returned early, which meant
      // segregation of duties switched itself off whenever the identity was
      // missing -- exactly the situation where it is most needed. Every one of
      // the four barred statuses is reached by a human action, so an
      // unattributable caller here is a fault, not a system step.
      throw new ForbiddenException(
        `Moving this case to ${targetStatus} requires an identified caller, so that the ` +
          'platform can confirm the same person did not already act in an incompatible ' +
          'capacity. The request carried no user identity.',
      );
    }

    const rows = await this.sequelize.query<{ role_code: string }>(
      `SELECT DISTINCT role_code
         FROM tax.tax_assessment_assignment
        WHERE case_id = :caseId AND user_id = :userId AND role_code IN (:barred)`,
      { type: QueryTypes.SELECT, replacements: { caseId, userId, barred: [...barred] } },
    );

    if (rows.length > 0) {
      throw new ForbiddenException(
        `You already acted on this case as ${rows.map((r) => r.role_code).join(', ')}. ` +
          `Segregation of duties requires a different person at this step.`,
      );
    }
  }

  private async recordParticipation(
    transaction: Transaction,
    caseId: number,
    roleCode: string,
    caller: RequestContext,
  ): Promise<void> {
    // Same source as the check that reads these rows back. If participation
    // were recorded against the ambient identity while segregation of duties
    // tested the explicit one, the two could disagree and the check would pass
    // for a person who had in fact already acted.
    const userId = caller.userId;
    if (userId === undefined) return;

    await this.sequelize.query(
      `INSERT INTO tax.tax_assessment_assignment
              (case_id, user_id, role_code, assigned_by, is_current)
       VALUES (:caseId, :userId, :roleCode, :userId, true)`,
      {
        type: QueryTypes.INSERT,
        transaction,
        replacements: { caseId, userId, roleCode },
      },
    );
  }

  // ------------------------------------------------------------------ assign

  /**
   * Give the case to a named officer, inside the caller's transaction.
   *
   * Separate from `assign` below because that one opens its own transaction
   * and re-reads the case; calling it from inside a transition would deadlock
   * on the row the transition is already holding.
   */
  private async assignByUsername(
    transaction: Transaction,
    caseId: number,
    username: string,
    caller: RequestContext,
  ): Promise<void> {
    const rows = await this.sequelize.query<{ id: string }>(
      `SELECT id FROM platform.app_user WHERE username = :username AND is_active`,
      { type: QueryTypes.SELECT, transaction, replacements: { username } },
    );

    const assignee = rows[0];
    if (assignee === undefined) {
      // Named, but not a person this system knows. Refusing is the only
      // honest answer: the alternative is a case that says it is assigned and
      // appears in nobody's register.
      throw new BadRequestException(
        `'${username}' is not a user of this system, so the case cannot be assigned to them.`,
      );
    }

    const assigneeUserId = Number(assignee.id);

    // One current holder per role; the previous one is released, not deleted.
    await this.sequelize.query(
      `UPDATE tax.tax_assessment_assignment
          SET is_current = false, released_at = CURRENT_TIMESTAMP
        WHERE case_id = :caseId AND role_code = :roleCode AND is_current`,
      {
        type: QueryTypes.UPDATE,
        transaction,
        replacements: { caseId, roleCode: RoleCode.ASSESSOR },
      },
    );

    await this.sequelize.query(
      `INSERT INTO tax.tax_assessment_assignment
              (case_id, user_id, role_code, assigned_by, is_current)
       VALUES (:caseId, :userId, :roleCode, :assignedBy, true)`,
      {
        type: QueryTypes.INSERT,
        transaction,
        replacements: {
          caseId,
          userId: assigneeUserId,
          roleCode: RoleCode.ASSESSOR,
          assignedBy: caller.userId ?? null,
        },
      },
    );

    await this.writeEvent(transaction, caseId, CaseEventType.CASE_ASSIGNED, null, null, caller, {
      assigneeUsername: username,
      assigneeUserId,
      roleCode: RoleCode.ASSESSOR,
    });
  }

  async assign(
    caseId: number,
    assigneeUserId: number,
    roleCode: string,
    caller: RequestContext,
  ): Promise<void> {
    const current = await this.findById(caseId);
    if (isFrozenStatus(current.statusCode)) {
      throw new ConflictException(
        `Case ${current.caseNumber} is ${current.statusCode} and can no longer be reassigned.`,
      );
    }

    await this.sequelize.transaction(async (t) => {
      // One current holder per role. Releasing the previous one keeps the
      // history rather than overwriting it.
      await this.sequelize.query(
        `UPDATE tax.tax_assessment_assignment
            SET is_current = false, released_at = CURRENT_TIMESTAMP
          WHERE case_id = :caseId AND role_code = :roleCode AND is_current`,
        { type: QueryTypes.UPDATE, transaction: t, replacements: { caseId, roleCode } },
      );

      await this.sequelize.query(
        `INSERT INTO tax.tax_assessment_assignment
                (case_id, user_id, role_code, assigned_by, is_current)
         VALUES (:caseId, :userId, :roleCode, :assignedBy, true)`,
        {
          type: QueryTypes.INSERT,
          transaction: t,
          replacements: {
            caseId,
            userId: assigneeUserId,
            roleCode,
            assignedBy: currentUserId() ?? null,
          },
        },
      );

      await this.writeEvent(t, caseId, CaseEventType.CASE_ASSIGNED, null, null, caller, {
        assigneeUserId,
        roleCode,
      });
    });
  }

  // ------------------------------------------------------------------ reads

  async findById(caseId: number): Promise<AssessmentCase> {
    // `Number('1; DROP TABLE …')` is NaN, and NaN reaches the driver as a
    // parameter Postgres cannot bind, which surfaces as a 500 carrying a
    // database message. The query was never injectable -- every statement is
    // parameterised -- but answering a malformed id with a server error tells
    // an attacker they reached the database, and tells an honest caller
    // nothing useful.
    if (!Number.isInteger(caseId) || caseId <= 0) {
      throw new BadRequestException(`'${caseId}' is not a case reference.`);
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT * FROM tax.tax_assessment_case WHERE id = :caseId AND is_active`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('No such assessment case');
    }
    return toCase(row);
  }

  async findByNumber(caseNumber: string): Promise<AssessmentCase> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT * FROM tax.tax_assessment_case WHERE case_number = :caseNumber AND is_active`,
      { type: QueryTypes.SELECT, replacements: { caseNumber } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('No such assessment case');
    }
    return toCase(row);
  }

  /** The domain audit ledger for a case, newest first. */
  async timeline(caseId: number): Promise<
    Array<{
      eventType: string;
      fromStatus: string | null;
      toStatus: string | null;
      actorUserId: number | null;
      actorRoleCode: string | null;
      occurredAt: Date;
      payload: Record<string, unknown> | null;
    }>
  > {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT event_type, from_status, to_status, actor_user_id, actor_role_code,
              occurred_at, payload_json
         FROM tax.tax_assessment_event
        WHERE case_id = :caseId
        ORDER BY occurred_at DESC, id DESC`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    return rows.map((row) => ({
      eventType: String(row['event_type']),
      fromStatus: row['from_status'] === null ? null : String(row['from_status']),
      toStatus: row['to_status'] === null ? null : String(row['to_status']),
      actorUserId: row['actor_user_id'] === null ? null : Number(row['actor_user_id']),
      actorRoleCode: row['actor_role_code'] === null ? null : String(row['actor_role_code']),
      occurredAt: row['occurred_at'] as Date,
      payload: row['payload_json'] as Record<string, unknown> | null,
    }));
  }

  // ---------------------------------------------------------------- internals

  /**
   * Append to the domain event ledger.
   *
   * Always inside the caller's transaction, so a status change and its ledger
   * entry succeed or fail together.
   */
  async writeEvent(
    transaction: Transaction,
    caseId: number,
    eventType: CaseEventType,
    fromStatus: CaseStatus | null,
    toStatus: CaseStatus | null,
    caller: RequestContext,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO tax.tax_assessment_event
              (case_id, event_type, from_status, to_status, actor_user_id,
               actor_role_code, payload_json, correlation_id, created_by)
       VALUES (:caseId, :eventType, :fromStatus, :toStatus, :actorUserId,
               :actorRole, CAST(:payload AS jsonb), :correlationId, :actorUserId)`,
      {
        type: QueryTypes.INSERT,
        transaction,
        replacements: {
          caseId,
          eventType,
          fromStatus,
          toStatus,
          actorUserId: caller.userId ?? null,
          actorRole: caller.roleCodes[0] ?? null,
          payload: JSON.stringify(payload),
          correlationId: caller.correlationId,
        },
      },
    );
  }

  private async loadTaxpayer(
    taxpayerId: number,
  ): Promise<{ tin: string; name: string; jurisdictionCode: string }> {
    const rows = await this.sequelize.query<{
      tin: string;
      name: string;
      jurisdiction_code: string;
      status: string;
    }>(
      `SELECT tin, name, jurisdiction_code, status
         FROM platform.taxpayer WHERE id = :taxpayerId AND is_active`,
      { type: QueryTypes.SELECT, replacements: { taxpayerId } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('No such taxpayer');
    }
    if (row.status !== 'ACTIVE') {
      throw new BadRequestException(`Taxpayer ${row.tin} is ${row.status} and cannot be assessed.`);
    }
    return { tin: row.tin, name: row.name, jurisdictionCode: row.jurisdiction_code };
  }

  /**
   * The currency a jurisdiction assesses this tax in.
   *
   * Read from the published rule set, which declares the currency it computes
   * in. Falling back to a hard-coded `'GBP'` was a genuine configurability
   * defect: it silently opened every case in a second jurisdiction in the
   * wrong currency, and nothing downstream looked broken until the figures
   * were read by somebody who knew what they should be.
   *
   * Where no rule set is published yet, the jurisdiction's own configured
   * currency is used, and the absence is logged rather than guessed at
   * silently.
   */
  private async currencyFor(jurisdictionCode: string, taxTypeCode: string): Promise<string> {
    const fromRuleSet = await this.sequelize.query<{ currency_code: string }>(
      `SELECT currency_code
         FROM tax.tax_rule_set
        WHERE jurisdiction_code = :jurisdiction
          AND tax_type_code = :taxType
          AND status = 'PUBLISHED'
          AND is_active
        ORDER BY effective_from DESC NULLS LAST
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { jurisdiction: jurisdictionCode, taxType: taxTypeCode },
      },
    );

    const declared = fromRuleSet[0]?.currency_code;
    if (declared !== undefined) return declared;

    // `platform.tax_type` is per jurisdiction and carries the currency the
    // tax is denominated in, which is the right answer before any rule set
    // exists to refine it.
    const fromTaxType = await this.sequelize.query<{ default_currency_code: string | null }>(
      `SELECT default_currency_code
         FROM platform.tax_type
        WHERE jurisdiction_code = :jurisdiction
          AND tax_type_code = :taxType
          AND is_active
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { jurisdiction: jurisdictionCode, taxType: taxTypeCode },
      },
    );

    const fallback = fromTaxType[0]?.default_currency_code ?? undefined;
    if (fallback !== undefined) {
      this.logger.warn(
        `No published rule set for ${jurisdictionCode} ${taxTypeCode}; the case currency falls ` +
          `back to the jurisdiction default ${fallback}. Publish a rule set before assessing.`,
      );
      return fallback;
    }

    throw new BadRequestException(
      `No currency can be determined for ${jurisdictionCode} ${taxTypeCode}. Publish a rule ` +
        'set for this jurisdiction and tax type, or supply currencyCode explicitly.',
    );
  }

  private async referencePattern(jurisdictionCode: string): Promise<string> {
    const rows = await this.sequelize.query<{ reference_pattern: string | null }>(
      `SELECT reference_pattern FROM forms.form_category
        WHERE category_code = 'TAX' AND jurisdiction_code = :jurisdiction AND is_active`,
      { type: QueryTypes.SELECT, replacements: { jurisdiction: jurisdictionCode } },
    );
    return rows[0]?.reference_pattern ?? 'TA{YYYY}{SEQ:8}';
  }
}

/**
 * Statuses from which no further movement is expected.
 *
 * Used to cancel the coordinating process instance. Deliberately narrow: only
 * the genuinely final ones, because cancelling the process of a case that is
 * merely paused would strand the work when it resumes.
 */
function isTerminalStatus(status: string): boolean {
  const terminal: readonly string[] = [
    CaseStatus.CLOSED,
    CaseStatus.CANCELLED,
    CaseStatus.TIME_BARRED,
    CaseStatus.WRITTEN_OFF,
  ];
  return terminal.includes(status);
}

function toCase(row: Record<string, unknown>): AssessmentCase {
  return {
    id: Number(row['id']),
    uuid: String(row['uuid']),
    caseNumber: String(row['case_number']),
    taxpayerId: Number(row['taxpayer_id']),
    tin: String(row['tin']),
    taxpayerName: String(row['taxpayer_name']),
    taxTypeCode: String(row['tax_type_code']),
    jurisdictionCode: String(row['jurisdiction_code']),
    assessmentYear: String(row['assessment_year']),
    assessmentType: String(row['assessment_type']),
    triggerPath: String(row['trigger_path']),
    statusCode: String(row['status_code']) as CaseStatus,
    liabilityStatus: String(row['liability_status']),
    version: Number(row['version']),
    currencyCode: String(row['currency_code']),
    assessedBase: row['assessed_base'] === null ? null : String(row['assessed_base']),
    netPayable: row['net_payable'] === null ? null : String(row['net_payable']),
    limitationDate: row['limitation_date'] === null ? null : String(row['limitation_date']),
    openedAt: row['opened_at'] as Date,
  };
}
