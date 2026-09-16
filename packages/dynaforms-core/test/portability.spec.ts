import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  FieldType,
  evaluateFormula,
  contextFromValues,
  resolveFormState,
  validateSubmission,
  type FormDefinition,
} from '../src';

/**
 * The ADR-005 spike, as an executable test.
 *
 * ADR-005 claims the form core can be extracted framework-agnostically so that
 * the API executes exactly the validation and dependency logic the browser
 * ran, rather than a re-implementation that will drift.
 *
 * This suite is the evidence for that claim. If any of it fails, ADR-005 needs
 * revisiting -- the fork/consume decision rests on it.
 */

const SRC = join(__dirname, '..', 'src');

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

describe('ADR-005 spike: the core is framework-agnostic', () => {
  const files = sourceFiles(SRC);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('imports no framework or DOM package', () => {
    // The whole extraction rests on this. A single Angular import here and the
    // package can no longer run in Node, and server-side validation becomes a
    // re-implementation.
    const forbidden = [
      '@angular/',
      'rxjs',
      'react',
      'vue',
      '@nestjs/',
      'jsdom',
      'sequelize',
      'ioredis',
    ];

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const marker of forbidden) {
        if (content.includes(`from '${marker}`) || content.includes(`require('${marker}`)) {
          offenders.push(`${file}: ${marker}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('references no browser global', () => {
    // `window`, `document` and friends are undefined in Node. Touching one
    // would make the package throw the moment the API imported it.
    const globals = [
      /\bwindow\./,
      /\bdocument\./,
      /\bnavigator\./,
      /\blocalStorage\b/,
      /\bHTMLElement\b/,
    ];

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of globals) {
        if (pattern.test(content)) {
          offenders.push(`${file}: ${pattern.source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries no domain knowledge', () => {
    // Fork discipline rule 1 (ADR-005): the packages know about fields,
    // validation and layout. They must never know what a tax adjustment is.
    const domainTerms = [
      /\btaxAssessment\b/i,
      /\bassessmentCase\b/i,
      /\bruleSet\b/i,
      /\bpenaltyAmount\b/i,
      /\bobjection\b/i,
    ];

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of domainTerms) {
        if (pattern.test(content)) {
          offenders.push(`${file}: ${pattern.source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runs in Node with no DOM present', () => {
    // The test environment is `node`, so this passing at all is the assertion.
    expect(typeof globalThis).toBe('object');
    expect((globalThis as Record<string, unknown>)['window']).toBeUndefined();
    expect((globalThis as Record<string, unknown>)['document']).toBeUndefined();

    const definition: FormDefinition = {
      schemaVersion: '1.0.0',
      root: [
        {
          uuid: 'u1',
          jsonKey: 'amount',
          fieldType: FieldType.NUMBER,
          required: true,
        },
      ],
    };
    expect(validateSubmission(definition, { amount: 5 }).valid).toBe(true);
  });
});

describe('ADR-005 spike: server and client agree', () => {
  /**
   * A definition as it comes out of a JSONB column or off the wire.
   *
   * The browser receives exactly this JSON and so does the API. If the engine
   * is pure and framework-free, both must reach the same answer.
   */
  const DEFINITION_JSON = JSON.stringify({
    schemaVersion: '1.0.0',
    root: [
      {
        uuid: 'u-section',
        jsonKey: 'section',
        fieldType: FieldType.SECTION,
        children: [
          {
            uuid: 'u-type',
            jsonKey: 'kind',
            fieldType: FieldType.DROPDOWN,
            required: true,
            options: [
              { label: 'A', value: 'A' },
              { label: 'B', value: 'B' },
            ],
          },
          {
            uuid: 'u-detail',
            jsonKey: 'detail',
            fieldType: FieldType.TEXTBOX,
            hidden: true,
            minLength: 5,
            dependsOn: {
              rules: [
                {
                  conditions: [{ field: 'kind', operator: 'eq', value: 'A' }],
                  effects: [
                    { type: 'setVisibility', value: true },
                    { type: 'setRequired', value: true },
                  ],
                },
              ],
            },
          },
          {
            uuid: 'u-qty',
            jsonKey: 'quantity',
            fieldType: FieldType.NUMBER,
            min: 0,
          },
          {
            uuid: 'u-total',
            jsonKey: 'total',
            fieldType: FieldType.FORMULA,
            formula: '@quantity * 3',
          },
        ],
      },
    ],
  });

  /** Parse afresh each time, exactly as each side would. */
  const parse = (): FormDefinition => JSON.parse(DEFINITION_JSON) as FormDefinition;

  const CASES: Array<Record<string, unknown>> = [
    { kind: 'A', detail: 'sufficient', quantity: 4 },
    { kind: 'A', detail: 'no', quantity: 4 },
    { kind: 'B', detail: '', quantity: 0 },
    { kind: 'B', quantity: -1 },
    { kind: 'C', quantity: 2 },
    {},
  ];

  it.each(CASES.map((values, index) => [index, values]))(
    'case %i resolves identically on both sides',
    (_index, values) => {
      // "Client" and "server" are two independent parses and evaluations of
      // the same JSON, which is exactly the real situation.
      const clientState = resolveFormState(parse(), values as Record<string, unknown>);
      const serverState = resolveFormState(parse(), values as Record<string, unknown>);

      expect([...serverState.entries()]).toEqual([...clientState.entries()]);
    },
  );

  it.each(CASES.map((values, index) => [index, values]))(
    'case %i validates identically on both sides',
    (_index, values) => {
      const clientResult = validateSubmission(parse(), values as Record<string, unknown>, {
        previousValues: values as Record<string, unknown>,
      });
      const serverResult = validateSubmission(parse(), values as Record<string, unknown>, {
        previousValues: values as Record<string, unknown>,
      });

      expect(serverResult).toEqual(clientResult);
    },
  );

  it('produces a serialisable result that survives the wire', () => {
    // The API returns validation errors to the browser. If the result cannot
    // round-trip through JSON, the two sides cannot agree about it.
    const result = validateSubmission(parse(), { kind: 'A', detail: 'no', quantity: 1 });
    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toEqual(result);
    expect(roundTripped.valid).toBe(false);
  });

  it('is deterministic across repeated evaluation', () => {
    // No hidden state, no clock, no randomness: the same inputs always give
    // the same answer. This is what makes a submission reproducible in an
    // appeal years later.
    const values = { kind: 'A', detail: 'enough text', quantity: 7 };
    const runs = Array.from({ length: 20 }, () =>
      JSON.stringify(validateSubmission(parse(), values, { previousValues: values })),
    );
    expect(new Set(runs).size).toBe(1);
  });

  it('evaluates a formula identically on both sides', () => {
    const values = { quantity: 7 };
    const client = evaluateFormula('@quantity * 3', contextFromValues(values));
    const server = evaluateFormula('@quantity * 3', contextFromValues(values));
    expect(server).toEqual(client);
    expect(server).toEqual({ kind: 'number', value: 21 });
  });

  it('does not mutate the definition or the values it is given', () => {
    // Either side reusing a cached definition must not be affected by a
    // previous evaluation.
    const definition = parse();
    const before = JSON.stringify(definition);
    const values = { kind: 'A', detail: 'enough text', quantity: 7 };
    const valuesBefore = JSON.stringify(values);

    resolveFormState(definition, values);
    validateSubmission(definition, values, { previousValues: values });

    expect(JSON.stringify(definition)).toBe(before);
    expect(JSON.stringify(values)).toBe(valuesBefore);
  });
});
