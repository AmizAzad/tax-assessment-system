import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasDiagram, withDiagram } from '../src/workflow/bpmn-layout';

/**
 * Giving a hand-authored definition coordinates.
 *
 * Plan reference: V2 sections 5.2, 18.1 screens 14 and 20.
 *
 * The definition this system ships carries no diagram interchange, because it
 * is reviewed as text. A viewer draws nothing without it, so the journey
 * screen would be blank for the one process the product comes with. These
 * tests hold the output to what a viewer actually needs: a shape for every
 * element it will be asked to highlight, an edge for every flow, and at least
 * two waypoints on each.
 */

const DEFINITION = join(
  __dirname,
  '..',
  '..',
  '..',
  'db',
  'bpmn',
  'TAX_ASSESSMENT_MAIN.bpmn20.xml',
);

const simple = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://tax-assessment">
  <process id="P" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="prepare" />
    <userTask id="prepare" name="Prepare" flowable:candidateGroups="TA_ASSESSOR" />
    <sequenceFlow id="f2" sourceRef="prepare" targetRef="gate" />
    <exclusiveGateway id="gate" />
    <sequenceFlow id="f3" sourceRef="gate" targetRef="prepare" />
    <sequenceFlow id="f4" sourceRef="gate" targetRef="done" />
    <endEvent id="done" />
  </process>
</definitions>`;

const shapesOf = (xml: string): string[] =>
  [...xml.matchAll(/<bpmndi:BPMNShape[^>]*bpmnElement="([^"]+)"/g)].map((match) => match[1]!);

const edgesOf = (xml: string): string[] =>
  [...xml.matchAll(/<bpmndi:BPMNEdge[^>]*bpmnElement="([^"]+)"/g)].map((match) => match[1]!);

describe('BPMN layout', () => {
  it('adds a diagram to a definition that has none', () => {
    expect(hasDiagram(simple)).toBe(false);
    expect(hasDiagram(withDiagram(simple))).toBe(true);
  });

  it('gives every element a shape', () => {
    const shapes = shapesOf(withDiagram(simple));
    expect(shapes.sort()).toEqual(['done', 'gate', 'prepare', 'start']);
  });

  it('gives every sequence flow an edge', () => {
    expect(edgesOf(withDiagram(simple)).sort()).toEqual(['f1', 'f2', 'f3', 'f4']);
  });

  it('gives every edge at least two waypoints', () => {
    const laidOut = withDiagram(simple);
    for (const edge of laidOut.split('<bpmndi:BPMNEdge').slice(1)) {
      const waypoints = (edge.split('</bpmndi:BPMNEdge>')[0] ?? '').match(/<di:waypoint /g) ?? [];
      expect(waypoints.length).toBeGreaterThanOrEqual(2);
    }
  });

  /**
   * The rework loop is why this cannot be a longest-path layout: `gate` flows
   * back to `prepare`, so the graph is cyclic and the longest path through it
   * is not finite. A layout that hung on this would hang on the real
   * definition, which has three such loops.
   */
  it('terminates on a cyclic process', () => {
    expect(edgesOf(withDiagram(simple))).toContain('f3');
  });

  it('declares the namespaces it uses', () => {
    const laidOut = withDiagram(simple);
    expect(laidOut).toContain('xmlns:bpmndi=');
    expect(laidOut).toContain('xmlns:dc=');
    expect(laidOut).toContain('xmlns:di=');
  });

  it('leaves a definition that already has a diagram alone', () => {
    const once = withDiagram(simple);
    expect(withDiagram(once)).toBe(once);
  });

  it('returns the input unchanged rather than throwing on nonsense', () => {
    expect(withDiagram('not xml at all')).toBe('not xml at all');
    expect(withDiagram('<definitions></definitions>')).toBe('<definitions></definitions>');
  });

  /**
   * The definition that ships with the release. If this stops laying out, the
   * journey screen goes blank for every case in the system.
   */
  describe('the shipped definition', () => {
    const xml = readFileSync(DEFINITION, 'utf8');
    const laidOut = withDiagram(xml);

    it('is still authored without coordinates', () => {
      expect(hasDiagram(xml)).toBe(false);
    });

    it('lays out every task, gateway and event', () => {
      const shapes = shapesOf(laidOut);
      for (const id of [
        'start',
        'retrieveEvidence',
        'evidenceGate',
        'chaseEvidence',
        'prepareAssessment',
        'review',
      ]) {
        expect(shapes).toContain(id);
      }
    });

    it('lays out the boundary event on its host', () => {
      expect(shapesOf(laidOut)).toContain('evidenceFailed');
    });

    it('places no two elements at the same point', () => {
      const points = [...laidOut.matchAll(/<dc:Bounds x="(\d+)" y="(\d+)"/g)].map(
        (match) => `${match[1]},${match[2]}`,
      );
      expect(new Set(points).size).toBe(points.length);
    });
  });
});
