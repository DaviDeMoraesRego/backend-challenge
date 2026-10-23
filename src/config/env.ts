import { z } from 'zod';

const boolFromEnv = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined) return def;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

/**
 * Segredo opcional: `VAR=` (vazio) no compose equivale a "não definida" — evita
 * quebrar o boot de dev sem relaxar o fail-fast de produção (`superRefine`).
 */
const optionalSecret = (min: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    z.string().min(min).optional(),
  );

export const ROLES = [
  'api',
  'sqs-consumer',
  'outbox-publisher',
  'pending-reference-worker',
  'reconciliation-job',
  'outbox-retention-job',
] as const;

export type Role = (typeof ROLES)[number];

const ROLE_ALIASES: Record<string, Role> = {
  api: 'api',
  consumer: 'sqs-consumer',
  'sqs-consumer': 'sqs-consumer',
  'outbox-publisher': 'outbox-publisher',
  'pending-worker': 'pending-reference-worker',
  'pending-reference-worker': 'pending-reference-worker',
  reconciliation: 'reconciliation-job',
  'reconciliation-job': 'reconciliation-job',
  retention: 'outbox-retention-job',
  'outbox-retention-job': 'outbox-retention-job',
};

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  ROLE: z.string().default('api'),
  PORT: int(3000, 1),
  INSTANCE_ID: z.string().default('local-1'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z
    .string()
    .default('postgres://wagering_app:wagering_app@localhost:5432/wagering'),
  DATABASE_URL_MIGRATOR: z.string().optional(),
  PG_POOL_MAX: int(48, 1),
  PG_CONNECT_TIMEOUT_MS: int(5000, 1),

  SQS_ENDPOINT: z.string().optional(),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  SQS_TRANSACTIONS_QUEUE_URL: z
    .string()
    .default('http://localhost:4566/000000000000/wager-transactions.fifo'),
  SQS_TRANSACTIONS_DLQ_URL: z
    .string()
    .default('http://localhost:4566/000000000000/wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE_URL: z
    .string()
    .default('http://localhost:4566/000000000000/wager-events.fifo'),
  SQS_CONSUMER_CONCURRENCY: int(8, 1),
  SQS_WAIT_TIME_SECONDS: int(20, 0),
  SQS_VISIBILITY_TIMEOUT_SECONDS: int(45, 1),
  /** HMAC-SHA256 do envelope — fecha a fronteira de confiança da fila. */
  SQS_SIGNING_SECRET: optionalSecret(32),
  SQS_REQUIRE_SIGNATURE: boolFromEnv(false),

  AUTH_ENABLED: boolFromEnv(true),
  KEYCLOAK_ISSUER: z.string().default('http://localhost:8080/realms/jungle'),
  KEYCLOAK_JWKS_URL: z
    .string()
    .default('http://localhost:8080/realms/jungle/protocol/openid-connect/certs'),
  KEYCLOAK_AUDIENCE: z.string().default('wagering-api'),
  /** Algoritmos aceitos na verificação — nunca deixar o `alg` do token decidir. */
  JWT_ALGORITHMS: z.string().default('RS256'),
  JWT_CLOCK_TOLERANCE_SECONDS: int(5, 0),

  SUPPORTED_CURRENCIES: z.string().default('BRL,USD'),
  PROVIDERS: z.string().default('provider-a,provider-b'),

  METRICS_ENABLED: boolFromEnv(true),
  /** Token exigido no scrape de `/metrics` (obrigatório em produção). */
  METRICS_AUTH_TOKEN: optionalSecret(16),
  OTEL_ENABLED: boolFromEnv(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),
  OTEL_SERVICE_NAME: z.string().default('wagering-api'),

  LOCK_TIMEOUT_MS: int(2000, 1),
  STATEMENT_TIMEOUT_MS: int(10000, 1),
  IDLE_TX_TIMEOUT_MS: int(15000, 1),
  TX_MAX_RETRIES: int(3, 0),

  OUTBOX_POLL_MS: int(1000, 10),
  OUTBOX_BATCH_SIZE: int(100, 1),
  OUTBOX_LEASE_MS: int(30000, 1000),
  OUTBOX_MAX_ATTEMPTS: int(25, 1),

  PENDING_WORKER_POLL_MS: int(2000, 50),
  PENDING_LEASE_MS: int(60000, 1000),
  PENDING_BATCH_SIZE: int(50, 1),
  PENDING_MAX_ATTEMPTS: int(12, 1),
  PENDING_TTL_HOURS: int(24, 1),

  RECONCILE_SWEEP_MS: int(300000, 1000),
  RECONCILE_BATCH_SIZE: int(500, 1),

  RETENTION_INTERVAL_MS: int(3600000, 1000),
  OUTBOX_RETENTION_DAYS: int(7, 1),
  INBOX_RETENTION_DAYS: int(14, 1),

  SHUTDOWN_GRACE_MS: int(25000, 0),

  IDEMPOTENCY_KEY_MAX_LENGTH: int(128, 16),

  FAULT_INJECTION_ENABLED: boolFromEnv(false),
  FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK: boolFromEnv(false),
  FAULT_CRASH_AFTER_PUBLISH_BEFORE_MARK: boolFromEnv(false),
  FAULT_CRASH_AFTER_CLAIM_OUTBOX: boolFromEnv(false),
  FAULT_DELAY_LOCK_MS: int(0, 0),
}).superRefine((env, ctx) => {
  const fail = (path: string, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };

  if (env.SQS_REQUIRE_SIGNATURE && !env.SQS_SIGNING_SECRET) {
    fail('SQS_SIGNING_SECRET', 'obrigatório quando SQS_REQUIRE_SIGNATURE=true');
  }

  if (env.NODE_ENV.toLowerCase() !== 'production') return;

  if (!env.AUTH_ENABLED) {
    fail('AUTH_ENABLED', 'autenticação não pode ser desabilitada em produção');
  }
  if (env.FAULT_INJECTION_ENABLED) {
    fail('FAULT_INJECTION_ENABLED', 'injeção de falhas proibida em produção (kill switch)');
  }
  if (!env.SQS_REQUIRE_SIGNATURE) {
    fail('SQS_REQUIRE_SIGNATURE', 'assinatura de mensagens obrigatória em produção');
  }
  if (!env.METRICS_AUTH_TOKEN) {
    fail('METRICS_AUTH_TOKEN', 'token de scrape obrigatório em produção');
  }
  if (/wagering_(app|migrator):wagering_(app|migrator)|postgres:postgres/.test(env.DATABASE_URL)) {
    fail('DATABASE_URL', 'credencial padrão de desenvolvimento proibida em produção');
  }
  if (env.AWS_SECRET_ACCESS_KEY === 'test' || env.AWS_ACCESS_KEY_ID === 'test') {
    fail('AWS_SECRET_ACCESS_KEY', 'credencial AWS padrão proibida em produção');
  }
  if (!env.KEYCLOAK_ISSUER.startsWith('https://')) {
    fail('KEYCLOAK_ISSUER', 'HTTPS obrigatório em produção');
  }
  if (!env.KEYCLOAK_JWKS_URL.startsWith('https://')) {
    fail('KEYCLOAK_JWKS_URL', 'HTTPS obrigatório em produção');
  }
});

export type EnvShape = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly env: EnvShape;
  readonly roles: readonly Role[];
  readonly currencies: ReadonlySet<string>;
  readonly providers: ReadonlySet<string>;
  has(role: Role): boolean;
}

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const parseRoles = (raw: string): Role[] => {
  const roles = new Set<Role>();
  for (const item of splitList(raw)) {
    const role = ROLE_ALIASES[item.toLowerCase()];
    if (!role) {
      throw new Error(
        `ROLE desconhecido: "${item}". Válidos: ${Object.keys(ROLE_ALIASES).join(', ')}`,
      );
    }
    roles.add(role);
  }
  if (roles.size === 0) {
    throw new Error('ROLE não pode ser vazio');
  }
  return [...roles];
};

/** Fail-fast no boot: configuração inválida derruba o processo com erro legível. */
export function loadEnv(source: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuração de ambiente inválida → ${issues}`);
  }
  const env = result.data;
  const roles = parseRoles(env.ROLE);
  const currencies = new Set(splitList(env.SUPPORTED_CURRENCIES).map((c) => c.toUpperCase()));
  const providers = new Set(splitList(env.PROVIDERS));
  if (currencies.size === 0) throw new Error('SUPPORTED_CURRENCIES não pode ser vazio');
  if (providers.size === 0) throw new Error('PROVIDERS não pode ser vazio');
  return {
    env,
    roles,
    currencies,
    providers,
    has: (role: Role) => roles.includes(role),
  };
}
