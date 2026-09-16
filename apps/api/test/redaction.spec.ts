import { isSensitiveFieldName, redact, redactHeaders } from '../src/platform/audit/redaction';

/**
 * Payload redaction.
 *
 * Plan reference: V2 sections 19.2, 20; risk R13.
 *
 * The failure this guards against: a taxpayer's financial position sitting in
 * a log aggregator that a far wider group can read than can read the case
 * itself. Redaction is an allowlist, so the test that matters most is that an
 * *unknown* field is redacted rather than passed through.
 */

describe('redaction - the allowlist default', () => {
  it('redacts a field nobody thought to name', () => {
    // The whole point of an allowlist. A field invented next year is redacted
    // without anyone having to remember to add it to a blocklist.
    const output = redact({ someFieldInventedLater: 'sensitive value' }) as Record<string, unknown>;
    expect(output['someFieldInventedLater']).toBe('[redacted]');
  });

  it('keeps identifiers and codes, which classify rather than disclose', () => {
    const output = redact({
      caseNumber: 'TA-2026-00000001',
      taxTypeCode: 'CIT',
      statusCode: 'UNDER_REVIEW',
      assessmentYear: '2025',
      page: 1,
    }) as Record<string, unknown>;

    expect(output).toEqual({
      caseNumber: 'TA-2026-00000001',
      taxTypeCode: 'CIT',
      statusCode: 'UNDER_REVIEW',
      assessmentYear: '2025',
      page: 1,
    });
  });
});

describe('redaction - money and identity never leak', () => {
  const mustRedact = [
    'assessedAmount',
    'declaredAmount',
    'totalPayable',
    'netPayableOrRefundable',
    'penaltyAmount',
    'interestAmount',
    'withholdingCredit',
    'outstandingBalance',
    'operatingRevenue',
    'taxableIncome',
    'annualTurnover',
  ];

  it.each(mustRedact)('redacts %s', (field) => {
    const output = redact({ [field]: 125000 }) as Record<string, unknown>;
    expect(output[field]).toBe('[redacted]');
  });

  const identity = ['tin', 'taxpayerName', 'email', 'phone', 'address'];

  it.each(identity)('redacts %s', (field) => {
    const output = redact({ [field]: 'value' }) as Record<string, unknown>;
    expect(output[field]).toBe('[redacted]');
  });

  const secrets = ['password', 'token', 'accessToken', 'authorization', 'secret', 'apiKey'];

  it.each(secrets)('redacts %s', (field) => {
    const output = redact({ [field]: 'value' }) as Record<string, unknown>;
    expect(output[field]).toBe('[redacted]');
  });

  it('redacts free text that could carry anything', () => {
    const output = redact({
      narrative: 'The taxpayer understated revenue by 25,000',
      officerOpinion: 'Recommend assessment',
      groundsNarrative: 'We dispute the finding',
    }) as Record<string, unknown>;

    expect(output['narrative']).toBe('[redacted]');
    expect(output['officerOpinion']).toBe('[redacted]');
    expect(output['groundsNarrative']).toBe('[redacted]');
  });
});

describe('redaction - structure', () => {
  it('summarises an array rather than recording its contents', () => {
    // A list of adjustments is exactly the payload that must not be logged.
    const output = redact({ adjustments: [{ a: 1 }, { a: 2 }, { a: 3 }] }) as Record<
      string,
      unknown
    >;
    expect(output['adjustments']).toEqual(['[3 items]']);
  });

  it('keeps an empty array as empty', () => {
    const output = redact({ items: [] }) as Record<string, unknown>;
    expect(output['items']).toEqual([]);
  });

  it('walks into nested objects', () => {
    const output = redact({
      filter: { taxTypeCode: 'CIT', assessedAmount: 5000 },
    }) as Record<string, Record<string, unknown>>;

    expect(output['filter']!['taxTypeCode']).toBe('CIT');
    expect(output['filter']!['assessedAmount']).toBe('[redacted]');
  });

  it('stops at a depth limit rather than recursing without bound', () => {
    // The body is untrusted input; a pathological nesting depth must not turn
    // an audit write into a stack overflow.
    let deep: Record<string, unknown> = { caseNumber: 'X' };
    for (let i = 0; i < 20; i += 1) {
      deep = { nested: deep };
    }
    const output = JSON.stringify(redact(deep));
    expect(output).toContain('[depth limit]');
  });

  it('passes null and undefined through unchanged', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('redacts a bare scalar, having no field name to judge it by', () => {
    expect(redact('some value')).toBe('[redacted]');
    expect(redact(42)).toBe('[redacted]');
  });
});

describe('redaction - headers', () => {
  it('keeps only headers useful for tracing', () => {
    const output = redactHeaders({
      'content-type': 'application/json',
      'user-agent': 'curl/8.0',
      'x-correlation-id': 'abc-123',
      authorization: 'Bearer secret-token',
      cookie: 'session=secret',
    });

    expect(output).toEqual({
      'content-type': 'application/json',
      'user-agent': 'curl/8.0',
      'x-correlation-id': 'abc-123',
    });
    expect(output['authorization']).toBeUndefined();
    expect(output['cookie']).toBeUndefined();
  });
});

describe('isSensitiveFieldName', () => {
  it('recognises monetary and personal field names by shape', () => {
    expect(isSensitiveFieldName('someNewAmount')).toBe(true);
    expect(isSensitiveFieldName('closingBalance')).toBe(true);
    expect(isSensitiveFieldName('companyName')).toBe(true);
    expect(isSensitiveFieldName('tin')).toBe(true);
  });

  it('does not flag identifiers and codes', () => {
    expect(isSensitiveFieldName('caseNumber')).toBe(false);
    expect(isSensitiveFieldName('statusCode')).toBe(false);
    expect(isSensitiveFieldName('page')).toBe(false);
  });
});
