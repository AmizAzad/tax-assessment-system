import { validateBpmn } from '../src/workflow/bpmn-validator';

/**
 * Publish-time BPMN validation.
 *
 * Plan reference: V2 sections 5.2, 5.5, 20.
 *
 * The headline case: Flowable leaves a user task with no candidate groups
 * claimable by anyone. In this system that would mean a review task reachable
 * by the taxpayer whose assessment is under review. These tests are the
 * evidence that such a definition cannot be published.
 */

const wrap = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://tax-assessment">
  <process id="TAX_ASSESSMENT_MAIN" isExecutable="true">
    <startEvent id="start"/>
    ${body}
    <endEvent id="end"/>
  </process>
</definitions>`;

const goodUserTask = `
    <userTask id="TA_REVIEW" name="Review" flowable:candidateGroups="TA_REVIEWER">
      <extensionElements>
        <flowable:properties>
          <flowable:property name="stepCode" value="TA_REVIEW"/>
          <flowable:property name="formId" value="TA-11"/>
          <flowable:property name="roles" value="TA_REVIEWER"/>
        </flowable:properties>
      </extensionElements>
    </userTask>`;

const goodServiceTask = `
    <serviceTask id="calculate" flowable:delegateExpression="\${apiInvoker}">
      <extensionElements>
        <flowable:field name="endpoint">
          <flowable:string>/api/v1/cases/\${caseId}/calculate</flowable:string>
        </flowable:field>
      </extensionElements>
    </serviceTask>`;

describe('BPMN validation - accepts a well-formed definition', () => {
  it('accepts a process with a properly declared user task', () => {
    const result = validateBpmn(wrap(goodUserTask));
    expect(result.valid).toBe(true);
    expect(result.processKey).toBe('TAX_ASSESSMENT_MAIN');
    expect(result.problems.filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('accepts a service task using the apiInvoker delegate', () => {
    const result = validateBpmn(wrap(goodServiceTask));
    expect(result.valid).toBe(true);
  });

  it('accepts a definition regardless of namespace prefix', () => {
    // Different modelers emit bpmn:, bpmn2:, or no prefix. The validator must
    // not care which tool drew the diagram.
    const prefixed = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:flowable="http://flowable.org/bpmn">
  <bpmn2:process id="P1" isExecutable="true">
    <bpmn2:startEvent id="s"/>
    <bpmn2:userTask id="t" flowable:candidateGroups="TA_ASSESSOR">
      <bpmn2:extensionElements>
        <flowable:properties>
          <flowable:property name="stepCode" value="TA_PREPARE"/>
          <flowable:property name="formId" value="TA-04"/>
        </flowable:properties>
      </bpmn2:extensionElements>
    </bpmn2:userTask>
    <bpmn2:endEvent id="e"/>
  </bpmn2:process>
</bpmn2:definitions>`;
    expect(validateBpmn(prefixed).valid).toBe(true);
  });
});

describe('BPMN validation - the role-less user task control', () => {
  it('REJECTS a user task with no candidate groups and no roles property', () => {
    const result = validateBpmn(
      wrap(`
    <userTask id="TA_REVIEW" name="Review">
      <extensionElements>
        <flowable:properties>
          <flowable:property name="stepCode" value="TA_REVIEW"/>
          <flowable:property name="formId" value="TA-11"/>
        </flowable:properties>
      </extensionElements>
    </userTask>`),
    );

    expect(result.valid).toBe(false);
    expect(result.problems).toContainEqual(
      expect.objectContaining({
        code: 'USER_TASK_WITHOUT_ROLES',
        elementId: 'TA_REVIEW',
        severity: 'error',
      }),
    );
  });

  it('explains the consequence rather than just naming the rule', () => {
    const result = validateBpmn(wrap(`<userTask id="X"/>`));
    const problem = result.problems.find((p) => p.code === 'USER_TASK_WITHOUT_ROLES');
    expect(problem?.message).toMatch(/claimable by any authenticated user/);
  });

  it('rejects an empty candidateGroups attribute', () => {
    // An empty string is not a role list, and Flowable treats it as absent.
    const result = validateBpmn(
      wrap(`<userTask id="X" flowable:candidateGroups="">
        <extensionElements><flowable:properties>
          <flowable:property name="stepCode" value="S"/>
          <flowable:property name="formId" value="F"/>
        </flowable:properties></extensionElements>
      </userTask>`),
    );
    expect(result.problems.map((p) => p.code)).toContain('USER_TASK_WITHOUT_ROLES');
  });

  it('accepts a roles property when candidateGroups is absent', () => {
    const result = validateBpmn(
      wrap(`<userTask id="X">
        <extensionElements><flowable:properties>
          <flowable:property name="stepCode" value="S"/>
          <flowable:property name="formId" value="F"/>
          <flowable:property name="roles" value="TA_ASSESSOR"/>
        </flowable:properties></extensionElements>
      </userTask>`),
    );
    expect(result.problems.map((p) => p.code)).not.toContain('USER_TASK_WITHOUT_ROLES');
  });

  it('rejects every role-less task in a process, not just the first', () => {
    const result = validateBpmn(wrap(`<userTask id="A"/><userTask id="B"/><userTask id="C"/>`));
    const offenders = result.problems
      .filter((p) => p.code === 'USER_TASK_WITHOUT_ROLES')
      .map((p) => p.elementId);
    expect(offenders).toEqual(['A', 'B', 'C']);
  });
});

describe('BPMN validation - user task contract', () => {
  it('requires a stepCode', () => {
    const result = validateBpmn(wrap(`<userTask id="X" flowable:candidateGroups="TA_ASSESSOR"/>`));
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'USER_TASK_WITHOUT_STEP_CODE', severity: 'error' }),
    );
  });

  it('warns but does not block on a missing formId', () => {
    const result = validateBpmn(
      wrap(`<userTask id="X" flowable:candidateGroups="TA_ASSESSOR">
        <extensionElements><flowable:properties>
          <flowable:property name="stepCode" value="S"/>
        </flowable:properties></extensionElements>
      </userTask>`),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'USER_TASK_WITHOUT_FORM', severity: 'warning' }),
    );
    expect(result.valid).toBe(true);
  });
});

describe('BPMN validation - service task contract', () => {
  it('rejects a service task with no delegate', () => {
    const result = validateBpmn(wrap(`<serviceTask id="X"/>`));
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'SERVICE_TASK_WITHOUT_DELEGATE', severity: 'error' }),
    );
  });

  it('rejects a Java class delegate', () => {
    // A process definition is configuration. Letting it name a class would let
    // configuration choose what code runs inside the engine.
    const result = validateBpmn(
      wrap(`<serviceTask id="X" flowable:class="com.example.Whatever"/>`),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'SERVICE_TASK_UNKNOWN_DELEGATE', severity: 'error' }),
    );
  });

  it('rejects an arbitrary expression delegate', () => {
    const result = validateBpmn(
      wrap(`<serviceTask id="X" flowable:expression="\${someBean.doThing()}"/>`),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'SERVICE_TASK_UNKNOWN_DELEGATE' }),
    );
  });

  it('rejects a delegate other than apiInvoker', () => {
    const result = validateBpmn(
      wrap(`<serviceTask id="X" flowable:delegateExpression="\${statusUpdater}"/>`),
    );
    const problem = result.problems.find((p) => p.code === 'SERVICE_TASK_UNKNOWN_DELEGATE');
    expect(problem?.message).toMatch(/statusUpdater/);
  });

  it('requires an endpoint field on an apiInvoker task', () => {
    const result = validateBpmn(
      wrap(`<serviceTask id="X" flowable:delegateExpression="\${apiInvoker}"/>`),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'SERVICE_TASK_WITHOUT_ENDPOINT', severity: 'error' }),
    );
  });
});

describe('BPMN validation - structural checks', () => {
  it('rejects XML with no process', () => {
    const result = validateBpmn(`<?xml version="1.0"?><definitions/>`);
    expect(result.valid).toBe(false);
    expect(result.problems[0]?.code).toBe('NO_PROCESS');
  });

  it('rejects more than one process per definition', () => {
    const twoProcesses = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="A" isExecutable="true"><startEvent id="s1"/><endEvent id="e1"/></process>
  <process id="B" isExecutable="true"><startEvent id="s2"/><endEvent id="e2"/></process>
</definitions>`;
    expect(validateBpmn(twoProcesses).problems).toContainEqual(
      expect.objectContaining({ code: 'MULTIPLE_PROCESSES' }),
    );
  });

  it('rejects a non-executable process', () => {
    const notExecutable = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="A"><startEvent id="s"/><endEvent id="e"/></process>
</definitions>`;
    expect(validateBpmn(notExecutable).problems).toContainEqual(
      expect.objectContaining({ code: 'NOT_EXECUTABLE' }),
    );
  });

  it('rejects a process with no start event', () => {
    const noStart = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="A" isExecutable="true"><endEvent id="e"/></process>
</definitions>`;
    expect(validateBpmn(noStart).problems).toContainEqual(
      expect.objectContaining({ code: 'NO_START_EVENT' }),
    );
  });

  it('warns on a process with no end event', () => {
    const noEnd = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="A" isExecutable="true"><startEvent id="s"/></process>
</definitions>`;
    expect(validateBpmn(noEnd).problems).toContainEqual(
      expect.objectContaining({ code: 'NO_END_EVENT', severity: 'warning' }),
    );
  });

  it('rejects malformed XML rather than throwing', () => {
    const result = validateBpmn('<definitions><process</definitions>');
    expect(result.valid).toBe(false);
    expect(result.problems[0]?.code).toBe('MALFORMED_XML');
  });

  it('fails closed on empty input', () => {
    expect(validateBpmn('').valid).toBe(false);
  });
});
