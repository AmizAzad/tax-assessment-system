import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * Publish-time validation of a BPMN process definition.
 *
 * Plan reference: V2 sections 5.2, 5.5, 20; ADR-002.
 *
 * ## Why this exists, and why it is here rather than in the engine
 *
 * Flowable's default for a user task with no candidate groups is that
 * *anyone* can claim it. In a tax system that means a review task reachable by
 * the taxpayer whose assessment is under review. The plan makes this explicit:
 * publish-time validation must reject any process containing a role-less user
 * task, and it must fail closed.
 *
 * It lives in the API rather than the engine because it is a business rule:
 * it needs to be testable without a database, and a rejection needs to explain
 * itself to whoever authored the diagram. By the time XML reaches the engine
 * it is expected to be publishable.
 */

export type BpmnProblemSeverity = 'error' | 'warning';

export interface BpmnProblem {
  readonly severity: BpmnProblemSeverity;
  readonly code:
    | 'NO_PROCESS'
    | 'MULTIPLE_PROCESSES'
    | 'NOT_EXECUTABLE'
    | 'USER_TASK_WITHOUT_ROLES'
    | 'USER_TASK_WITHOUT_STEP_CODE'
    | 'USER_TASK_WITHOUT_FORM'
    | 'SERVICE_TASK_WITHOUT_DELEGATE'
    | 'SERVICE_TASK_UNKNOWN_DELEGATE'
    | 'SERVICE_TASK_WITHOUT_ENDPOINT'
    | 'NO_START_EVENT'
    | 'NO_END_EVENT'
    | 'MALFORMED_XML';
  readonly elementId?: string;
  readonly message: string;
}

export interface BpmnValidationResult {
  readonly valid: boolean;
  readonly processKey?: string;
  readonly problems: readonly BpmnProblem[];
}

/** The only delegate a tax process may call. */
const ALLOWED_DELEGATE = 'apiInvoker';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Namespace prefixes vary by modeler (bpmn:, bpmn2:, none). Stripping them
  // means the validator does not care which tool authored the diagram.
  removeNSPrefix: true,
  isArray: (name) =>
    ['process', 'userTask', 'serviceTask', 'startEvent', 'endEvent', 'field', 'property'].includes(
      name,
    ),
});

export function validateBpmn(xml: string): BpmnValidationResult {
  // fast-xml-parser is lenient by default and will happily parse broken
  // markup into something plausible. Validate strictly first, so a malformed
  // definition is reported as malformed rather than as a missing <process>.
  const wellFormed = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (wellFormed !== true) {
    return {
      valid: false,
      problems: [
        {
          severity: 'error',
          code: 'MALFORMED_XML',
          message: `The definition is not well-formed XML: ${wellFormed.err.msg} (line ${wellFormed.err.line})`,
        },
      ],
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    return {
      valid: false,
      problems: [
        {
          severity: 'error',
          code: 'MALFORMED_XML',
          message: `The definition is not well-formed XML: ${
            error instanceof Error ? error.message : 'unknown parse error'
          }`,
        },
      ],
    };
  }

  const definitions = asRecord(parsed['definitions']);
  const processes = asArray(definitions?.['process']);

  if (processes.length === 0) {
    return {
      valid: false,
      problems: [
        {
          severity: 'error',
          code: 'NO_PROCESS',
          message: 'The definition contains no <process> element',
        },
      ],
    };
  }

  const problems: BpmnProblem[] = [];

  if (processes.length > 1) {
    problems.push({
      severity: 'error',
      code: 'MULTIPLE_PROCESSES',
      message:
        `The definition contains ${processes.length} processes. Deploy one process per ` +
        `definition so a version can be pinned to a case.`,
    });
  }

  const process = asRecord(processes[0]) ?? {};
  const processKey = stringAttr(process, 'id');

  if (stringAttr(process, 'isExecutable') !== 'true') {
    problems.push({
      severity: 'error',
      code: 'NOT_EXECUTABLE',
      elementId: processKey,
      message: 'The process is not marked isExecutable="true" and cannot be started',
    });
  }

  if (asArray(process['startEvent']).length === 0) {
    problems.push({
      severity: 'error',
      code: 'NO_START_EVENT',
      elementId: processKey,
      message: 'The process has no start event',
    });
  }

  if (asArray(process['endEvent']).length === 0) {
    problems.push({
      severity: 'warning',
      code: 'NO_END_EVENT',
      elementId: processKey,
      message: 'The process has no end event; instances will not complete cleanly',
    });
  }

  for (const raw of asArray(process['userTask'])) {
    problems.push(...validateUserTask(asRecord(raw) ?? {}));
  }

  for (const raw of asArray(process['serviceTask'])) {
    problems.push(...validateServiceTask(asRecord(raw) ?? {}));
  }

  return {
    valid: !problems.some((problem) => problem.severity === 'error'),
    processKey,
    problems,
  };
}

function validateUserTask(task: Record<string, unknown>): BpmnProblem[] {
  const problems: BpmnProblem[] = [];
  const id = stringAttr(task, 'id') ?? '(unnamed)';

  const candidateGroups = stringAttr(task, 'candidateGroups');
  const properties = extensionProperties(task);
  const roles = properties['roles'];

  const hasCandidateGroups = candidateGroups !== undefined && candidateGroups.trim() !== '';
  const hasRoles = roles !== undefined && roles.trim() !== '';

  if (!hasCandidateGroups && !hasRoles) {
    // The control this validator exists for. Flowable would leave the task
    // claimable by anyone.
    problems.push({
      severity: 'error',
      code: 'USER_TASK_WITHOUT_ROLES',
      elementId: id,
      message:
        `User task '${id}' declares no candidate groups and no 'roles' property. ` +
        `Flowable would leave it claimable by any authenticated user, including the ` +
        `taxpayer whose assessment is under review. Every user task must name its roles.`,
    });
  }

  if (properties['stepCode'] === undefined || properties['stepCode'].trim() === '') {
    problems.push({
      severity: 'error',
      code: 'USER_TASK_WITHOUT_STEP_CODE',
      elementId: id,
      message:
        `User task '${id}' has no 'stepCode' property. Gateway conditions and the ` +
        `transition table are keyed on it.`,
    });
  }

  if (properties['formId'] === undefined || properties['formId'].trim() === '') {
    problems.push({
      severity: 'warning',
      code: 'USER_TASK_WITHOUT_FORM',
      elementId: id,
      message: `User task '${id}' has no 'formId' property; there is nothing for an officer to fill in`,
    });
  }

  return problems;
}

function validateServiceTask(task: Record<string, unknown>): BpmnProblem[] {
  const problems: BpmnProblem[] = [];
  const id = stringAttr(task, 'id') ?? '(unnamed)';

  const delegate = stringAttr(task, 'delegateExpression');
  const expression = stringAttr(task, 'expression');
  const className = stringAttr(task, 'class');

  if (delegate === undefined && expression === undefined && className === undefined) {
    problems.push({
      severity: 'error',
      code: 'SERVICE_TASK_WITHOUT_DELEGATE',
      elementId: id,
      message: `Service task '${id}' declares no delegate. Use \${${ALLOWED_DELEGATE}}.`,
    });
    return problems;
  }

  // A class or an arbitrary expression would let a process definition -- which
  // is configuration -- execute code of its choosing inside the engine. Only
  // the audited delegate is permitted.
  if (className !== undefined || expression !== undefined) {
    problems.push({
      severity: 'error',
      code: 'SERVICE_TASK_UNKNOWN_DELEGATE',
      elementId: id,
      message:
        `Service task '${id}' uses a class or expression delegate. Only ` +
        `\${${ALLOWED_DELEGATE}} is permitted: a process definition is configuration and ` +
        `must not choose what code runs in the engine.`,
    });
    return problems;
  }

  const delegateName = delegate?.replace(/^\$\{/, '').replace(/\}$/, '').trim();
  if (delegateName !== ALLOWED_DELEGATE) {
    problems.push({
      severity: 'error',
      code: 'SERVICE_TASK_UNKNOWN_DELEGATE',
      elementId: id,
      message:
        `Service task '${id}' uses delegate '${delegateName}'. Only ` +
        `\${${ALLOWED_DELEGATE}} is permitted.`,
    });
    return problems;
  }

  const fields = extensionFields(task);
  if (fields['endpoint'] === undefined || fields['endpoint'].trim() === '') {
    problems.push({
      severity: 'error',
      code: 'SERVICE_TASK_WITHOUT_ENDPOINT',
      elementId: id,
      message: `Service task '${id}' uses \${${ALLOWED_DELEGATE}} but declares no 'endpoint' field`,
    });
  }

  return problems;
}

// --------------------------------------------------------------------- helpers

/** `flowable:properties/property` entries, as name -> value. */
function extensionProperties(element: Record<string, unknown>): Record<string, string> {
  const extensions = asRecord(element['extensionElements']);
  const container = asRecord(extensions?.['properties']);
  const collected: Record<string, string> = {};
  for (const raw of asArray(container?.['property'])) {
    const property = asRecord(raw);
    const name = stringAttr(property ?? {}, 'name');
    const value = stringAttr(property ?? {}, 'value');
    if (name !== undefined && value !== undefined) {
      collected[name] = value;
    }
  }
  return collected;
}

/** `flowable:field` entries, as name -> value (string child or attribute). */
function extensionFields(element: Record<string, unknown>): Record<string, string> {
  const extensions = asRecord(element['extensionElements']);
  const collected: Record<string, string> = {};
  for (const raw of asArray(extensions?.['field'])) {
    const field = asRecord(raw);
    if (field === undefined) continue;
    const name = stringAttr(field, 'name');
    if (name === undefined) continue;

    const stringValue = field['string'];
    const expressionValue = field['expression'];
    const attributeValue = stringAttr(field, 'stringValue') ?? stringAttr(field, 'expression');

    const value =
      typeof stringValue === 'string'
        ? stringValue
        : typeof expressionValue === 'string'
          ? expressionValue
          : attributeValue;

    if (value !== undefined) {
      collected[name] = String(value);
    }
  }
  return collected;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringAttr(element: Record<string, unknown>, name: string): string | undefined {
  const value = element[`@_${name}`];
  return value === undefined || value === null ? undefined : String(value);
}
