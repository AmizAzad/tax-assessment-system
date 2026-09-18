/**
 * Typed application configuration.
 *
 * Configuration is read once at boot and validated. A missing required value
 * fails startup rather than surfacing as an undefined at the first request:
 * a tax system that boots with no database password configured and then
 * fails-open on authorisation is worse than one that refuses to start.
 */

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

export interface RedisConfig {
  readonly host: string;
  readonly port: number;
}

export interface StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly from: string;
}

export interface OidcConfig {
  readonly issuerUrl: string;
  readonly audience: string;
}

export interface AppConfig {
  readonly env: string;
  readonly port: number;
  readonly logLevel: string;
  readonly defaultJurisdiction: string;
  readonly defaultCurrency: string;
  /** Whether this process claims scheduled jobs. */
  readonly schedulerEnabled: boolean;
  /** Whether a passed limitation deadline time-bars the case (ADR-017). */
  readonly timeBarOnLimitationExpiry: boolean;
  readonly database: DatabaseConfig;
  readonly redis: RedisConfig;
  readonly oidc: OidcConfig;
  readonly storage: StorageConfig;
  readonly smtp: SmtpConfig;
  readonly bpmnEngineUrl: string;
  /** Shared secret the BPMN engine presents on the webhook endpoint. */
  readonly bpmnServiceToken: string;
  /**
   * Browser origins allowed to call this API.
   *
   * An allowlist, not `*`. The API answers with the taxpayer's financial
   * position on a bearer token, and a wildcard origin means any page the
   * officer has open can read it if it can get hold of one.
   */
  readonly allowedOrigins: readonly string[];
}

class MissingConfigurationError extends Error {
  constructor(key: string) {
    super(
      `Required configuration ${key} is not set. ` +
        `Copy .env.example to .env for local development.`,
    );
    this.name = 'MissingConfigurationError';
  }
}

function required(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    throw new MissingConfigurationError(key);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function port(key: string, fallback: string): number {
  const raw = optional(key, fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Configuration ${key} must be a valid port number, received: "${raw}"`);
  }
  return parsed;
}

export function loadConfiguration(): AppConfig {
  return {
    env: optional('NODE_ENV', 'development'),
    port: port('API_PORT', '3000'),
    logLevel: optional('LOG_LEVEL', 'info'),
    defaultJurisdiction: optional('DEFAULT_JURISDICTION', 'GB'),
    defaultCurrency: optional('DEFAULT_CURRENCY', 'GBP'),
    /**
     * Whether this process runs scheduled jobs.
     *
     * Defaults to true so a single `npm run start:dev` behaves as it always
     * has. In a deployment that runs the worker, set it to false on the API:
     * the jobs are exclusive anyway, but a process that never claims work does
     * not spend its event loop sweeping a large register.
     */
    schedulerEnabled: optional('SCHEDULER_ENABLED', 'true') !== 'false',
    /**
     * Whether the deadline sweep time-bars a case whose limitation date has
     * passed (ADR-017).
     *
     * Defaults off, the inverse of `schedulerEnabled` above, because
     * `TIME_BARRED` is terminal and extinguishes the authority's right to
     * collect. An existing deployment must not start terminating cases
     * because it took a release, so an authority whose limitation rules are
     * unconditional turns this on deliberately.
     */
    timeBarOnLimitationExpiry: optional('TIME_BAR_ON_LIMITATION_EXPIRY', 'false') === 'true',
    database: {
      host: optional('DB_HOST', 'localhost'),
      port: port('DB_PORT', '5433'),
      username: optional('DB_USER', 'tas'),
      password: required('DB_PASSWORD'),
      database: optional('DB_NAME', 'tax_assessment'),
    },
    redis: {
      host: optional('REDIS_HOST', 'localhost'),
      port: port('REDIS_PORT', '6380'),
    },
    oidc: {
      issuerUrl: optional('OIDC_ISSUER_URL', 'http://localhost:8085/realms/tax-assessment'),
      audience: optional('OIDC_AUDIENCE', 'tas-api'),
    },
    storage: {
      endpoint: optional('STORAGE_ENDPOINT', 'http://localhost:9000'),
      region: optional('STORAGE_REGION', 'us-east-1'),
      bucket: optional('STORAGE_BUCKET', 'tax-assessment'),
      accessKey: optional('STORAGE_ACCESS_KEY', 'tas'),
      secretKey: optional('STORAGE_SECRET_KEY', 'tas_local_dev_only'),
    },
    smtp: {
      host: optional('SMTP_HOST', 'localhost'),
      port: port('SMTP_PORT', '1025'),
      from: optional('SMTP_FROM', 'no-reply@tax-assessment.local'),
    },
    bpmnEngineUrl: optional('BPMN_ENGINE_URL', 'http://localhost:8080'),
    bpmnServiceToken: optional('BPMN_SERVICE_TOKEN', ''),
    allowedOrigins: optional('ALLOWED_ORIGINS', 'http://localhost:4200')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  };
}
