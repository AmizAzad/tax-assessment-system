/**
 * Payload redaction for audit traces and logs.
 *
 * Plan reference: V2 sections 19.2, 20; risk R13.
 *
 * ## Allowlist, not blocklist
 *
 * Only fields named here are recorded. Everything else is replaced with a
 * placeholder. A blocklist is a promise to have thought of every sensitive
 * field name, and the cost of being wrong is a taxpayer's financial position
 * sitting in a log aggregator that a much wider group can read than can read
 * the case itself.
 *
 * The allowlist is therefore short on purpose: identifiers, codes, statuses
 * and counts. Anything that is a *value* — an amount, a name, an address, a
 * narrative — is redacted whether or not anyone remembered to list it.
 */

/** Fields safe to record: they identify or classify, they do not disclose. */
const SAFE_FIELDS = new Set([
  'id',
  'uuid',
  'caseId',
  'caseNumber',
  'noticeNumber',
  'objectionNumber',
  'appealNumber',
  'taxTypeCode',
  'jurisdictionCode',
  'assessmentYear',
  'assessmentType',
  'triggerPath',
  'statusCode',
  'status',
  'liabilityStatus',
  'stepCode',
  'actionCode',
  'roleCode',
  'roleCodes',
  'currencyCode',
  'languageCode',
  'page',
  'pageSize',
  'sort',
  'version',
  'ruleSetCode',
  'ruleSetVersion',
  'deadlineType',
  'channel',
  'eventType',
  'processInstanceId',
  'businessKey',
  'taskId',
  'groupCode',
  'itemCode',
  'templateCode',
  'correlationId',
]);

/**
 * Fields redacted even if they somehow appear in the allowlist.
 *
 * A second line of defence against a careless future edit: adding `tin` to
 * SAFE_FIELDS would not be enough to start logging it.
 */
const ALWAYS_REDACT = new Set([
  'tin',
  'taxpayerName',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'secret',
  'apiKey',
  'signature',
  'email',
  'phone',
  'address',
]);

const REDACTED = '[redacted]';

/** Field-name fragments that mark a value as monetary or personal. */
const SENSITIVE_PATTERNS = [
  /amount/i,
  /balance/i,
  /payable/i,
  /refund/i,
  /penalty/i,
  /interest/i,
  /credit/i,
  /revenue/i,
  /income/i,
  /turnover/i,
  /salary/i,
  /narrative/i,
  /opinion/i,
  /comment/i,
  /reason/i,
  /grounds/i,
  /name$/i,
];

export function isSensitiveFieldName(name: string): boolean {
  if (ALWAYS_REDACT.has(name)) return true;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Produce a version of a payload that is safe to persist in a trace.
 *
 * @param value the payload
 * @param maxDepth guards against a pathological nesting depth in an untrusted
 *        body; beyond it, the subtree is summarised rather than walked
 */
export function redact(value: unknown, maxDepth = 6): unknown {
  return redactAt(value, maxDepth, 0);
}

function redactAt(value: unknown, maxDepth: number, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth >= maxDepth) {
    return '[depth limit]';
  }

  if (Array.isArray(value)) {
    // Element values are not individually interesting in a trace, and a long
    // array of adjustments is exactly the payload we must not record.
    return value.length === 0 ? [] : [`[${value.length} items]`];
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (isSensitiveFieldName(key)) {
        output[key] = REDACTED;
        continue;
      }
      if (SAFE_FIELDS.has(key)) {
        output[key] =
          typeof entry === 'object' && entry !== null
            ? redactAt(entry, maxDepth, depth + 1)
            : entry;
        continue;
      }
      if (typeof entry === 'object') {
        output[key] = redactAt(entry, maxDepth, depth + 1);
        continue;
      }
      // Not named as safe: redact rather than guess.
      output[key] = REDACTED;
    }
    return output;
  }

  // A bare scalar with no field name to judge it by.
  return REDACTED;
}

/** Redact a header map, keeping only the ones useful for tracing. */
export function redactHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const safe = new Set(['content-type', 'content-length', 'user-agent', 'x-correlation-id']);
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (safe.has(lower)) {
      output[lower] = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
    }
  }
  return output;
}

export { SAFE_FIELDS, ALWAYS_REDACT, REDACTED };
