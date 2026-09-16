import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BpmnDiagram } from './bpmn-diagram';

/**
 * Drawing a process, and marking where a case has reached.
 *
 * Plan reference: V2 section 18.1 screen 14.
 *
 * This runs in a real browser, which is the point: bpmn-js builds SVG through
 * the DOM, and a test that stubbed it would prove nothing about whether a
 * diagram appears. What is asserted is what an officer is actually looking
 * for — a shape per step, and the current step marked differently from the
 * finished ones.
 *
 * The fixture is a definition *with* coordinates, because that is what the API
 * returns: it lays out a definition authored without them before sending it
 * (see `bpmn-layout.ts`, and its own tests).
 */

const DIAGRAM = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://tax-assessment">
  <process id="P" isExecutable="true">
    <startEvent id="start" name="Case opened" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="retrieveEvidence" />
    <serviceTask id="retrieveEvidence" name="Retrieve evidence"
                 flowable:delegateExpression="\${apiInvoker}" />
    <sequenceFlow id="f2" sourceRef="retrieveEvidence" targetRef="prepare" />
    <userTask id="prepare" name="Prepare the assessment"
              flowable:candidateGroups="TA_ASSESSOR" />
    <sequenceFlow id="f3" sourceRef="prepare" targetRef="done" />
    <endEvent id="done" name="Served" />
  </process>
  <bpmndi:BPMNDiagram id="d">
    <bpmndi:BPMNPlane id="p" bpmnElement="P">
      <bpmndi:BPMNShape id="start_di" bpmnElement="start">
        <dc:Bounds x="160" y="142" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="retrieveEvidence_di" bpmnElement="retrieveEvidence">
        <dc:Bounds x="340" y="120" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="prepare_di" bpmnElement="prepare">
        <dc:Bounds x="520" y="120" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="done_di" bpmnElement="done">
        <dc:Bounds x="700" y="142" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="f1_di" bpmnElement="f1">
        <di:waypoint x="196" y="160" />
        <di:waypoint x="340" y="160" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f2_di" bpmnElement="f2">
        <di:waypoint x="440" y="160" />
        <di:waypoint x="520" y="160" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f3_di" bpmnElement="f3">
        <di:waypoint x="620" y="160" />
        <di:waypoint x="700" y="160" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`;

/** bpmn-js imports asynchronously; wait for the canvas to have something in it. */
async function settle(fixture: ComponentFixture<BpmnDiagram>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    fixture.detectChanges();
    if (fixture.nativeElement.querySelector('.djs-container') !== null) {
      return;
    }
  }
}

describe('BpmnDiagram', () => {
  let fixture: ComponentFixture<BpmnDiagram>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [BpmnDiagram] }).compileComponents();
    fixture = TestBed.createComponent(BpmnDiagram);
  });

  it('draws a shape for every step', async () => {
    fixture.componentInstance.bpmnXml = DIAGRAM;
    fixture.detectChanges();
    await settle(fixture);

    const element = fixture.nativeElement as HTMLElement;
    for (const id of ['start', 'retrieveEvidence', 'prepare', 'done']) {
      expect(element.querySelector(`[data-element-id="${id}"]`))
        .withContext(`shape for ${id}`)
        .not.toBeNull();
    }
  });

  it('marks what has finished and what is running now', async () => {
    fixture.componentInstance.bpmnXml = DIAGRAM;
    fixture.componentInstance.completed = ['start', 'retrieveEvidence'];
    fixture.componentInstance.active = ['prepare'];
    fixture.detectChanges();
    await settle(fixture);

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-element-id="retrieveEvidence"]')!.classList)
      .withContext('a finished step')
      .toContain('tas-activity-done');
    expect(element.querySelector('[data-element-id="prepare"]')!.classList)
      .withContext('the step being worked')
      .toContain('tas-activity-active');
    expect(element.querySelector('[data-element-id="done"]')!.classList)
      .withContext('a step not yet reached')
      .not.toContain('tas-activity-done');
  });

  /**
   * A rework loop runs an activity twice, so it appears in both lists. The
   * reader wants the current state, so active must win.
   */
  it('shows a step that has run and is running again as running', async () => {
    fixture.componentInstance.bpmnXml = DIAGRAM;
    fixture.componentInstance.completed = ['prepare'];
    fixture.componentInstance.active = ['prepare'];
    fixture.detectChanges();
    await settle(fixture);

    const classes = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-element-id="prepare"]',
    )!.classList;
    expect(classes).toContain('tas-activity-active');
  });

  it('reports a definition it cannot draw instead of failing silently', async () => {
    fixture.componentInstance.bpmnXml = '<definitions>not really</definitions>';
    fixture.detectChanges();

    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      fixture.detectChanges();
      if (fixture.componentInstance.failure() !== null) {
        break;
      }
    }

    expect(fixture.componentInstance.failure()).toContain('could not be drawn');
  });

  it('draws nothing, and does not fail, when there is no definition', async () => {
    fixture.componentInstance.bpmnXml = null;
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.componentInstance.failure()).toBeNull();
  });
});
