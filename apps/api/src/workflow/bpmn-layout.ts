import { XMLParser } from 'fast-xml-parser';

/**
 * Giving a definition coordinates.
 *
 * Plan reference: V2 sections 5.2, 18.1 screens 14 and 20.
 *
 * ## Why this exists
 *
 * A BPMN definition authored by hand carries no diagram interchange, because
 * nothing about *executing* a process needs to know where a box is. Our own
 * definition is authored that way deliberately: the file is reviewed as text,
 * and coordinates in a diff are noise.
 *
 * But a viewer cannot draw without them. bpmn-js renders nothing for an
 * element with no shape, so the journey screen would show an empty canvas for
 * the very definition the system ships.
 *
 * ## Why it is on the server
 *
 * So there is one implementation. The journey screen, the modeller and any
 * future export of a diagram all need the same answer, and three browsers
 * agreeing by coincidence is not the same as one function.
 *
 * ## What it is not
 *
 * A good automatic layout. It produces a readable left-to-right arrangement
 * with orthogonal connectors, which is enough to answer "where has this case
 * got to". A definition opened in the modeller and saved carries the author's
 * own layout from then on, and this function stops being involved — the check
 * is simply whether the XML already has a `BPMNDiagram`.
 */

/** Element sizes, from the BPMN specification's usual rendering. */
const TASK = { width: 100, height: 80 };
const EVENT = { width: 36, height: 36 };
const GATEWAY = { width: 50, height: 50 };

const COLUMN_SPACING = 180;
const ROW_SPACING = 150;
const ORIGIN = { x: 160, y: 120 };

const TASK_TYPES = new Set([
  'task',
  'userTask',
  'serviceTask',
  'scriptTask',
  'sendTask',
  'receiveTask',
  'manualTask',
  'businessRuleTask',
  'callActivity',
  'subProcess',
]);

const EVENT_TYPES = new Set([
  'startEvent',
  'endEvent',
  'intermediateCatchEvent',
  'intermediateThrowEvent',
  'boundaryEvent',
]);

const GATEWAY_TYPES = new Set([
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'eventBasedGateway',
  'complexGateway',
]);

interface Node {
  readonly id: string;
  readonly kind: string;
  readonly attachedTo?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rank: number;
}

interface Flow {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

/** Whether a definition already carries coordinates. */
export function hasDiagram(bpmnXml: string): boolean {
  return /<(?:\w+:)?BPMNDiagram\b/.test(bpmnXml);
}

/**
 * Return the definition with diagram interchange, adding it if absent.
 *
 * Never throws: a definition that cannot be laid out is returned untouched,
 * and the screen reports that it could not draw it. Failing here would take
 * down a journey view over a cosmetic problem.
 */
export function withDiagram(bpmnXml: string): string {
  if (hasDiagram(bpmnXml)) {
    return bpmnXml;
  }

  try {
    const { nodes, flows } = read(bpmnXml);
    if (nodes.size === 0) {
      return bpmnXml;
    }

    place(nodes, flows);
    return insert(bpmnXml, render(nodes, flows));
  } catch {
    return bpmnXml;
  }
}

// ------------------------------------------------------------------ reading

function read(bpmnXml: string): { nodes: Map<string, Node>; flows: Flow[] } {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    // Namespace prefixes are stripped so that `bpmn:userTask` and `userTask`
    // are the same element. Definitions here are written both ways.
    removeNSPrefix: true,
    // Every *element* becomes an array, so a process with one user task and a
    // process with six are read the same way. Attributes are excluded: making
    // `@id` an array would turn every identifier into a one-element list and
    // silently match nothing.
    isArray: (_name, _path, _isLeaf, isAttribute) => !isAttribute,
  });

  const document = parser.parse(bpmnXml) as Record<string, unknown>;
  const definitions = first(document['definitions']);
  const process = first((definitions ?? {})['process']);
  if (process === undefined) {
    return { nodes: new Map(), flows: [] };
  }

  const nodes = new Map<string, Node>();
  const flows: Flow[] = [];

  for (const [kind, entries] of Object.entries(process)) {
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries as Record<string, unknown>[]) {
      const id = entry['@id'];
      if (typeof id !== 'string') {
        continue;
      }

      if (kind === 'sequenceFlow') {
        const source = entry['@sourceRef'];
        const target = entry['@targetRef'];
        if (typeof source === 'string' && typeof target === 'string') {
          flows.push({ id, source, target });
        }
        continue;
      }

      if (!TASK_TYPES.has(kind) && !EVENT_TYPES.has(kind) && !GATEWAY_TYPES.has(kind)) {
        continue;
      }

      const size = TASK_TYPES.has(kind) ? TASK : GATEWAY_TYPES.has(kind) ? GATEWAY : EVENT;
      const attachedTo = entry['@attachedToRef'];

      nodes.set(id, {
        id,
        kind,
        attachedTo: typeof attachedTo === 'string' ? attachedTo : undefined,
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
        rank: -1,
      });
    }
  }

  return { nodes, flows };
}

function first(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    return value[0] as Record<string, unknown> | undefined;
  }
  return value as Record<string, unknown> | undefined;
}

// ----------------------------------------------------------------- placing

/**
 * Rank by distance from a start event, then stack within the rank.
 *
 * Breadth-first rather than longest-path: a rework loop makes the graph
 * cyclic, and the longest path through a cycle is not finite. Breadth-first
 * gives every element the earliest column it can legitimately appear in,
 * which reads correctly for a process that mostly flows forwards.
 */
function place(nodes: Map<string, Node>, flows: readonly Flow[]): void {
  const outgoing = new Map<string, string[]>();
  for (const flow of flows) {
    const targets = outgoing.get(flow.source) ?? [];
    targets.push(flow.target);
    outgoing.set(flow.source, targets);
  }

  const starts = [...nodes.values()].filter((node) => node.kind === 'startEvent');
  const queue = starts.length > 0 ? [...starts] : [[...nodes.values()][0]!];
  for (const node of queue) {
    node.rank = 0;
  }

  const seen = new Set(queue.map((node) => node.id));
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const targetId of outgoing.get(node.id) ?? []) {
      const target = nodes.get(targetId);
      if (target === undefined || seen.has(targetId)) {
        continue;
      }
      target.rank = node.rank + 1;
      seen.add(targetId);
      queue.push(target);
    }
  }

  // Anything the walk never reached — an element only a boundary event leads
  // to, or a fragment with no inbound flow — goes after everything else
  // rather than being left on top of the start event.
  const maximumRank = Math.max(0, ...[...nodes.values()].map((node) => node.rank));
  for (const node of nodes.values()) {
    if (node.rank === -1 && node.attachedTo === undefined) {
      node.rank = maximumRank + 1;
    }
  }

  const rows = new Map<number, number>();
  for (const node of [...nodes.values()].sort((a, b) => a.rank - b.rank)) {
    if (node.attachedTo !== undefined) {
      continue;
    }
    const row = rows.get(node.rank) ?? 0;
    rows.set(node.rank, row + 1);

    node.x = ORIGIN.x + node.rank * COLUMN_SPACING;
    node.y = ORIGIN.y + row * ROW_SPACING;

    // Centre the smaller shapes against the task lane, so a gateway between
    // two tasks sits on their centre line rather than at their top edge.
    node.y += (TASK.height - node.height) / 2;
  }

  // A boundary event hangs off the bottom edge of the activity it interrupts.
  for (const node of nodes.values()) {
    if (node.attachedTo === undefined) {
      continue;
    }
    const host = nodes.get(node.attachedTo);
    if (host === undefined) {
      continue;
    }
    node.rank = host.rank;
    node.x = host.x + host.width - node.width - 10;
    node.y = host.y + host.height - node.height / 2;
  }
}

// --------------------------------------------------------------- rendering

function render(nodes: Map<string, Node>, flows: readonly Flow[]): string {
  const shapes = [...nodes.values()]
    .map(
      (node) =>
        `      <bpmndi:BPMNShape id="${node.id}_di" bpmnElement="${node.id}"` +
        `${GATEWAY_TYPES.has(node.kind) ? ' isMarkerVisible="true"' : ''}>\n` +
        `        <dc:Bounds x="${round(node.x)}" y="${round(node.y)}" ` +
        `width="${node.width}" height="${node.height}" />\n` +
        `      </bpmndi:BPMNShape>`,
    )
    .join('\n');

  const edges = flows
    .map((flow) => {
      const source = nodes.get(flow.source);
      const target = nodes.get(flow.target);
      if (source === undefined || target === undefined) {
        return '';
      }
      const waypoints = route(source, target)
        .map((point) => `        <di:waypoint x="${round(point.x)}" y="${round(point.y)}" />`)
        .join('\n');
      return (
        `      <bpmndi:BPMNEdge id="${flow.id}_di" bpmnElement="${flow.id}">\n` +
        `${waypoints}\n` +
        `      </bpmndi:BPMNEdge>`
      );
    })
    .filter((edge) => edge !== '')
    .join('\n');

  return (
    `  <bpmndi:BPMNDiagram id="BPMNDiagram_generated">\n` +
    `    <bpmndi:BPMNPlane id="BPMNPlane_generated">\n` +
    `${shapes}\n${edges}\n` +
    `    </bpmndi:BPMNPlane>\n` +
    `  </bpmndi:BPMNDiagram>\n`
  );
}

/**
 * Waypoints between two shapes.
 *
 * Forwards: out of the right edge, into the left edge, with a vertical dogleg
 * when the rows differ. Backwards — a rework loop — drops below both shapes
 * and comes back, so the connector does not run through the boxes between
 * them.
 */
function route(source: Node, target: Node): readonly { x: number; y: number }[] {
  const from = { x: source.x + source.width, y: source.y + source.height / 2 };
  const to = { x: target.x, y: target.y + target.height / 2 };

  if (target.rank > source.rank) {
    if (Math.abs(from.y - to.y) < 2) {
      return [from, to];
    }
    const middle = from.x + (to.x - from.x) / 2;
    return [from, { x: middle, y: from.y }, { x: middle, y: to.y }, to];
  }

  const below = Math.max(source.y + source.height, target.y + target.height) + 40;
  const exit = { x: source.x + source.width / 2, y: source.y + source.height };
  const entry = { x: target.x + target.width / 2, y: target.y + target.height };
  return [exit, { x: exit.x, y: below }, { x: entry.x, y: below }, entry];
}

/**
 * Put the diagram immediately before the closing tag.
 *
 * BPMN requires `BPMNDiagram` to follow the process, and the closing tag is
 * the one place guaranteed to be after everything else regardless of what the
 * definition contains.
 */
function insert(bpmnXml: string, diagram: string): string {
  const closing = /<\/(\w+:)?definitions>/.exec(bpmnXml);
  if (closing === null) {
    return bpmnXml;
  }

  const prefix = closing[1] ?? '';
  const withNamespaces = declareNamespaces(bpmnXml);

  return withNamespaces.replace(
    new RegExp(`</${prefix}definitions>`),
    `${diagram}</${prefix}definitions>`,
  );
}

/** The DI namespaces, added to the root element if the author omitted them. */
function declareNamespaces(bpmnXml: string): string {
  const additions: string[] = [];
  if (!bpmnXml.includes('xmlns:bpmndi=')) {
    additions.push('xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"');
  }
  if (!bpmnXml.includes('xmlns:dc=')) {
    additions.push('xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"');
  }
  if (!bpmnXml.includes('xmlns:di=')) {
    additions.push('xmlns:di="http://www.omg.org/spec/DD/20100524/DI"');
  }
  if (additions.length === 0) {
    return bpmnXml;
  }

  const root = /<(\w+:)?definitions\b/.exec(bpmnXml);
  if (root === null) {
    return bpmnXml;
  }

  const insertAt = root.index + root[0].length;
  return `${bpmnXml.slice(0, insertAt)} ${additions.join(' ')}${bpmnXml.slice(insertAt)}`;
}

function round(value: number): number {
  // A pixel coordinate, not a monetary value. The repository rule against
  // Math.round exists so that a statutory rounding rule is never implemented
  // by accident (ADR-007); a diagram is the one place where "near enough" is
  // the whole requirement.
  // eslint-disable-next-line no-restricted-syntax
  return Math.round(value);
}
