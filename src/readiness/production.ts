import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import Redis from 'ioredis';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { parseConfigEnvironment, type Env } from '../config';

export type ReadinessStatus = 'pass' | 'warn' | 'fail';

export type ReadinessCheckResult = Readonly<{
  id: string;
  status: ReadinessStatus;
  code: string;
  duration_ms: number;
}>;

export type ProductionReadinessOptions = Readonly<{
  environment: NodeJS.ProcessEnv;
  publicUrl?: string;
  timeoutMs: number;
  billing: boolean;
}>;

export type DatabaseSchemaSnapshot = Readonly<{
  serverVersionNumber: number;
  extensions: readonly string[];
  tables: readonly string[];
  embeddingType: string | null;
  embeddingModelType: string | null;
  hasMatchKnowledge: boolean;
}>;

export type HealthSnapshot = Readonly<{
  statusCode: number;
  redirected: boolean;
  status: unknown;
  timestamp: unknown;
}>;

export type BillingSnapshot = Readonly<{
  statusCode: number;
  balance: unknown;
  apiError: boolean;
}>;

export type VoximplantBillingSnapshot = BillingSnapshot &
  Readonly<{
    active: unknown;
    frozen: unknown;
  }>;

export interface ProductionReadinessDependencies {
  now(): number;
  databaseConnection(
    environment: NodeJS.ProcessEnv,
    timeoutMs: number
  ): Promise<void>;
  databaseSchema(
    environment: NodeJS.ProcessEnv,
    timeoutMs: number
  ): Promise<DatabaseSchemaSnapshot>;
  redisPing(
    environment: NodeJS.ProcessEnv,
    timeoutMs: number
  ): Promise<boolean>;
  s3HeadBucket(
    environment: NodeJS.ProcessEnv,
    bucket: string,
    timeoutMs: number
  ): Promise<void>;
  hasActiveVoiceAgent(
    environment: NodeJS.ProcessEnv,
    timeoutMs: number
  ): Promise<boolean>;
  resolveHost(hostname: string): Promise<readonly string[]>;
  publicHealth(
    url: URL,
    resolvedAddress: string,
    timeoutMs: number
  ): Promise<HealthSnapshot>;
  negativeWebSocketAuth(
    url: URL,
    resolvedAddress: string,
    invalidToken: string,
    timeoutMs: number
  ): Promise<number>;
  fishBilling(apiKey: string, timeoutMs: number): Promise<BillingSnapshot>;
  voximplantBilling(
    accountId: string,
    apiKey: string,
    timeoutMs: number
  ): Promise<VoximplantBillingSnapshot>;
}

const REQUIRED_TABLES = Object.freeze([
  'organizations',
  'users',
  'agents',
  'leads',
  'conversations',
  'messages',
  'knowledge_chunks',
  'call_recordings',
  'daily_metrics',
  'crm_connections',
  'subscriptions',
  'usage_events',
]);

const REQUIRED_EXTENSIONS = Object.freeze(['uuid-ossp', 'pgcrypto', 'vector']);
const MAX_HEALTH_AGE_MS = 120_000;
const MAX_HEALTH_FUTURE_SKEW_MS = 30_000;
const MAX_JSON_BYTES = 16 * 1024;

type CheckOutcome = Readonly<{
  status: ReadinessStatus;
  code: string;
}>;

const pass = (code: string): CheckOutcome => ({ status: 'pass', code });
const warn = (code: string): CheckOutcome => ({ status: 'warn', code });
const fail = (code: string): CheckOutcome => ({ status: 'fail', code });

export async function runProductionReadiness(
  options: ProductionReadinessOptions,
  dependencies: ProductionReadinessDependencies =
    createDefaultProductionReadinessDependencies()
): Promise<readonly ReadinessCheckResult[]> {
  const results: ReadinessCheckResult[] = [];
  const environmentOutcome = validateProductionEnvironment(
    options.environment,
    options.publicUrl
  );
  results.push(
    await executeCheck(
      'env.production',
      dependencies,
      'validation_failed',
      async () => environmentOutcome
    )
  );

  const databaseConfigured = hasValue(options.environment['DATABASE_URL']);
  const databaseConnection = databaseConfigured
    ? await executeCheck(
        'db.connection',
        dependencies,
        'connection_failed',
        async () => {
          await dependencies.databaseConnection(
            options.environment,
            options.timeoutMs
          );
          return pass('reachable');
        }
      )
    : immediateResult('db.connection', fail('configuration_missing'));
  results.push(databaseConnection);

  const databaseReady = databaseConnection.status === 'pass';
  results.push(
    databaseReady
      ? await executeCheck(
          'db.schema',
          dependencies,
          'inspection_failed',
          async () =>
            validateDatabaseSchema(
              await dependencies.databaseSchema(
                options.environment,
                options.timeoutMs
              )
            )
        )
      : immediateResult('db.schema', warn('dependency_unavailable'))
  );

  const redisUrl = options.environment['REDIS_URL'];
  results.push(
    hasValue(redisUrl) && redisUrl !== 'memory'
      ? await executeCheck(
          'redis.ping',
          dependencies,
          'connection_failed',
          async () =>
            (await dependencies.redisPing(
              options.environment,
              options.timeoutMs
            ))
              ? pass('reachable')
              : fail('unexpected_response')
        )
      : immediateResult('redis.ping', fail('configuration_invalid'))
  );

  for (const [id, bucketKey] of [
    ['s3.recordings', 'S3_BUCKET_RECORDINGS'],
    ['s3.knowledge', 'S3_BUCKET_KNOWLEDGE'],
  ] as const) {
    const bucket = options.environment[bucketKey];
    const s3Configured =
      hasValue(options.environment['S3_ENDPOINT']) &&
      hasValue(options.environment['S3_ACCESS_KEY']) &&
      hasValue(options.environment['S3_SECRET_KEY']) &&
      hasValue(bucket);
    results.push(
      s3Configured
        ? await executeCheck(id, dependencies, 'head_failed', async () => {
            await dependencies.s3HeadBucket(
              options.environment,
              bucket!,
              options.timeoutMs
            );
            return pass('reachable');
          })
        : immediateResult(id, fail('configuration_missing'))
    );
  }

  const orgConfigured = isUuid(options.environment['VOICE_DEFAULT_ORG_ID']);
  results.push(
    databaseReady && orgConfigured
      ? await executeCheck(
          'voice.agent',
          dependencies,
          'inspection_failed',
          async () =>
            (await dependencies.hasActiveVoiceAgent(
              options.environment,
              options.timeoutMs
            ))
              ? pass('active')
              : fail('not_found')
        )
      : immediateResult(
          'voice.agent',
          databaseReady
            ? fail('configuration_invalid')
            : warn('dependency_unavailable')
        )
  );

  const publicTarget = parsePublicTarget(
    options.publicUrl ?? options.environment['WEBHOOK_BASE_URL']
  );
  let resolvedPublicAddress: string | undefined;
  if (publicTarget) {
    try {
      const addresses = await withTimeout(
        dependencies.resolveHost(publicTarget.hostname),
        options.timeoutMs
      );
      if (
        addresses.length > 0 &&
        addresses.every(address => isPublicAddress(address))
      ) {
        resolvedPublicAddress = addresses[0];
      }
    } catch {
      resolvedPublicAddress = undefined;
    }
  }

  results.push(
    publicTarget && resolvedPublicAddress
      ? await executeCheck(
          'public.health',
          dependencies,
          'request_failed',
          async () =>
            validateHealthSnapshot(
              await dependencies.publicHealth(
                healthUrl(publicTarget),
                resolvedPublicAddress,
                options.timeoutMs
              ),
              dependencies.now()
            )
        )
      : immediateResult(
          'public.health',
          fail(publicTarget ? 'host_not_public' : 'configuration_invalid')
        )
  );

  const orgId = options.environment['VOICE_DEFAULT_ORG_ID'];
  results.push(
    publicTarget && resolvedPublicAddress && isUuid(orgId)
      ? await executeCheck(
          'public.ws_auth',
          dependencies,
          'request_failed',
          async () => {
            const statusCode = await dependencies.negativeWebSocketAuth(
              voiceWebSocketUrl(publicTarget, orgId!),
              resolvedPublicAddress,
              invalidVoiceToken(options.environment['VOICE_WS_AUTH_TOKEN']),
              options.timeoutMs
            );
            return statusCode === 401 || statusCode === 403
              ? pass('rejected')
              : fail(
                  statusCode === 101 || statusCode === 200
                    ? 'authentication_bypassed'
                    : 'unexpected_status'
                );
          }
        )
      : immediateResult(
          'public.ws_auth',
          fail(
            publicTarget && resolvedPublicAddress
              ? 'configuration_invalid'
              : 'host_unavailable'
          )
        )
  );

  if (options.billing) {
    const fishApiKey = options.environment['FISH_API_KEY'];
    results.push(
      hasValue(fishApiKey)
        ? await executeCheck(
            'billing.fish',
            dependencies,
            'request_failed',
            async () =>
              validateBillingSnapshot(
                await dependencies.fishBilling(fishApiKey!, options.timeoutMs)
              )
          )
        : immediateResult('billing.fish', fail('configuration_missing'))
    );

    const accountId = options.environment['VOXIMPLANT_ACCOUNT_ID'];
    const voximplantApiKey = options.environment['VOXIMPLANT_API_KEY'];
    results.push(
      hasValue(accountId) && hasValue(voximplantApiKey)
        ? await executeCheck(
            'billing.voximplant',
            dependencies,
            'request_failed',
            async () =>
              validateVoximplantBillingSnapshot(
                await dependencies.voximplantBilling(
                  accountId!,
                  voximplantApiKey!,
                  options.timeoutMs
                )
              )
          )
        : immediateResult('billing.voximplant', fail('configuration_missing'))
    );
  }

  return Object.freeze(results);
}

export function readinessExitCode(
  results: readonly ReadinessCheckResult[],
  strict: boolean
): 0 | 1 {
  return results.some(
    result => result.status === 'fail' || (strict && result.status === 'warn')
  )
    ? 1
    : 0;
}

export function formatReadinessResults(
  results: readonly ReadinessCheckResult[],
  format: 'text' | 'json'
): string {
  const sanitized = results.map(result => ({
    id: safeAtom(result.id),
    status: result.status,
    code: safeAtom(result.code),
    duration_ms: safeDuration(result.duration_ms),
  }));
  if (format === 'json') return JSON.stringify(sanitized);
  return sanitized
    .map(
      result =>
        `id=${result.id} status=${result.status} code=${result.code} duration_ms=${result.duration_ms}`
    )
    .join('\n');
}

export function createDefaultProductionReadinessDependencies(): ProductionReadinessDependencies {
  return {
    now: () => Date.now(),
    databaseConnection: async (environment, timeoutMs) => {
      const pool = createReadinessPool(environment, timeoutMs);
      try {
        await pool.query('SELECT 1');
      } finally {
        await pool.end().catch(() => undefined);
      }
    },
    databaseSchema: async (environment, timeoutMs) => {
      const pool = createReadinessPool(environment, timeoutMs);
      try {
        const result = await pool.query<{
          server_version_number: number | string;
          extensions: string[];
          tables: string[];
          embedding_type: string | null;
          embedding_model_type: string | null;
          has_match_knowledge: boolean;
        }>(
          `SELECT
             current_setting('server_version_num')::integer AS server_version_number,
             ARRAY(
               SELECT extname FROM pg_extension
               WHERE extname = ANY($1::text[])
             ) AS extensions,
             ARRAY(
               SELECT tablename FROM pg_tables
               WHERE schemaname = 'public' AND tablename = ANY($2::text[])
             ) AS tables,
             (
               SELECT format_type(attribute.atttypid, attribute.atttypmod)
               FROM pg_attribute attribute
               JOIN pg_class relation ON relation.oid = attribute.attrelid
               JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'public'
                 AND relation.relname = 'knowledge_chunks'
                 AND attribute.attname = 'embedding'
                 AND NOT attribute.attisdropped
             ) AS embedding_type,
             (
               SELECT format_type(attribute.atttypid, attribute.atttypmod)
               FROM pg_attribute attribute
               JOIN pg_class relation ON relation.oid = attribute.attrelid
               JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'public'
                 AND relation.relname = 'knowledge_chunks'
                 AND attribute.attname = 'embedding_model'
                 AND NOT attribute.attisdropped
             ) AS embedding_model_type,
             EXISTS(
               SELECT 1
               FROM pg_proc procedure
               JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
              WHERE namespace.nspname = 'public'
                AND procedure.proname = 'match_knowledge'
                AND procedure.pronargs = 5
                AND oidvectortypes(procedure.proargtypes) =
                  'vector, integer, uuid, text, double precision'
             ) AS has_match_knowledge`,
          [REQUIRED_EXTENSIONS, REQUIRED_TABLES]
        );
        const row = result.rows[0];
        if (!row) throw new Error('schema snapshot unavailable');
        return {
          serverVersionNumber: Number(row.server_version_number),
          extensions: row.extensions ?? [],
          tables: row.tables ?? [],
          embeddingType: row.embedding_type,
          embeddingModelType: row.embedding_model_type,
          hasMatchKnowledge: row.has_match_knowledge,
        };
      } finally {
        await pool.end().catch(() => undefined);
      }
    },
    redisPing: async (environment, timeoutMs) => {
      const redis = new Redis(environment['REDIS_URL']!, {
        password: environment['REDIS_PASSWORD'] || undefined,
        lazyConnect: true,
        connectTimeout: timeoutMs,
        commandTimeout: timeoutMs,
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
      });
      // Without a listener ioredis writes raw connection errors to stderr
      // before the readiness layer can replace them with a stable code.
      redis.on('error', ignoreRedisError);
      try {
        await redis.connect();
        return (await redis.ping()) === 'PONG';
      } finally {
        redis.disconnect(false);
      }
    },
    s3HeadBucket: async (environment, bucket, timeoutMs) => {
      const client = new S3Client({
        endpoint: environment['S3_ENDPOINT'],
        region: environment['S3_REGION'] || 'us-east-1',
        credentials: {
          accessKeyId: environment['S3_ACCESS_KEY']!,
          secretAccessKey: environment['S3_SECRET_KEY']!,
        },
        forcePathStyle: true,
      });
      try {
        await client.send(
          new HeadBucketCommand({ Bucket: bucket }),
          { abortSignal: AbortSignal.timeout(timeoutMs) }
        );
      } finally {
        client.destroy();
      }
    },
    hasActiveVoiceAgent: async (environment, timeoutMs) => {
      const pool = createReadinessPool(environment, timeoutMs);
      try {
        const result = await pool.query<{ present: boolean }>(
          `SELECT EXISTS(
             SELECT 1
             FROM organizations organization
             JOIN agents agent ON agent.org_id = organization.id
             WHERE organization.id = $1::uuid
               AND agent.is_active = true
               AND 'voice' = ANY(agent.channels)
           ) AS present`,
          [environment['VOICE_DEFAULT_ORG_ID']]
        );
        return result.rows[0]?.present === true;
      } finally {
        await pool.end().catch(() => undefined);
      }
    },
    resolveHost: async hostname => {
      if (isIP(normalizeHostname(hostname))) {
        return [normalizeHostname(hostname)];
      }
      const addresses = await lookup(hostname, { all: true, verbatim: true });
      return addresses.map(entry => entry.address);
    },
    publicHealth: async (url, resolvedAddress, timeoutMs) => {
      const response = await requestPinnedHttpsJson(
        url,
        resolvedAddress,
        timeoutMs
      );
      const body = response.body;
      return {
        statusCode: response.statusCode,
        redirected:
          response.statusCode >= 300 && response.statusCode < 400,
        status: isRecord(body) ? body['status'] : undefined,
        timestamp: isRecord(body) ? body['timestamp'] : undefined,
      };
    },
    negativeWebSocketAuth: (
      url,
      resolvedAddress,
      invalidToken,
      timeoutMs
    ) =>
      probeNegativeWebSocketAuth(
        url,
        resolvedAddress,
        invalidToken,
        timeoutMs
      ),
    fishBilling: async (apiKey, timeoutMs) => {
      const response = await fetch(
        'https://api.fish.audio/wallet/self/api-credit',
        {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
        }
      );
      const body = await readBoundedJson(response, MAX_JSON_BYTES);
      return {
        statusCode: response.status,
        balance: isRecord(body) ? body['credit'] : undefined,
        apiError: response.status < 200 || response.status >= 300,
      };
    },
    voximplantBilling: async (accountId, apiKey, timeoutMs) => {
      const body = new URLSearchParams({
        account_id: accountId,
        api_key: apiKey,
        return_live_balance: 'true',
      });
      const response = await fetch(
        'https://api.voximplant.com/platform_api/GetAccountInfo',
        {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
        }
      );
      const payload = await readBoundedJson(response, MAX_JSON_BYTES);
      const result =
        isRecord(payload) && isRecord(payload['result'])
          ? payload['result']
          : undefined;
      return {
        statusCode: response.status,
        balance: result?.['live_balance'] ?? result?.['balance'],
        active: result?.['active'],
        frozen: result?.['frozen'],
        apiError:
          response.status < 200 ||
          response.status >= 300 ||
          (isRecord(payload) && payload['error'] !== undefined),
      };
    },
  };
}

function validateProductionEnvironment(
  environment: NodeJS.ProcessEnv,
  publicUrlOverride: string | undefined
): CheckOutcome {
  let parsed: Env;
  try {
    parsed = parseConfigEnvironment(environment);
  } catch {
    return fail('configuration_invalid');
  }

  if (parsed.NODE_ENV !== 'production') return fail('not_production');
  if (parsed.VOICE_RUNTIME !== 'pipeline') {
    return fail('voice_pipeline_disabled');
  }

  const voximplantAccountId = environment['VOXIMPLANT_ACCOUNT_ID'];
  const voximplantApiKey = environment['VOXIMPLANT_API_KEY'];
  if (!hasValue(voximplantAccountId) || !hasValue(voximplantApiKey)) {
    return fail('configuration_missing');
  }

  if (
    !hasProtocol(parsed.DATABASE_URL, ['postgres:', 'postgresql:']) ||
    !hasProtocol(parsed.REDIS_URL, ['redis:', 'rediss:']) ||
    !hasProtocol(parsed.S3_ENDPOINT, ['http:', 'https:']) ||
    !parsePublicTarget(publicUrlOverride ?? parsed.WEBHOOK_BASE_URL)
  ) {
    return fail('configuration_invalid');
  }

  const secrets = [
    parsed.JWT_SECRET,
    parsed.ANTHROPIC_API_KEY,
    parsed.GOOGLE_API_KEY,
    parsed.DEEPGRAM_API_KEY!,
    parsed.FISH_API_KEY!,
    parsed.FISH_TTS_REFERENCE_ID!,
    parsed.VOICE_WS_AUTH_TOKEN!,
    parsed.S3_ACCESS_KEY,
    parsed.S3_SECRET_KEY,
    voximplantAccountId,
    voximplantApiKey,
    ...(parsed.ASSEMBLYAI_API_KEY ? [parsed.ASSEMBLYAI_API_KEY] : []),
    ...(parsed.CEREBRAS_API_KEYS ?? []),
  ];
  if (
    secrets.some(looksLikePlaceholder) ||
    !isStrongSecret(parsed.JWT_SECRET, 32) ||
    !isStrongSecret(parsed.VOICE_WS_AUTH_TOKEN!, 32) ||
    !isStrongSecret(parsed.ANTHROPIC_API_KEY, 16) ||
    !isStrongSecret(parsed.GOOGLE_API_KEY, 16) ||
    !isStrongSecret(parsed.DEEPGRAM_API_KEY!, 16) ||
    !isStrongSecret(parsed.FISH_API_KEY!, 16) ||
    (hasValue(parsed.ASSEMBLYAI_API_KEY) &&
      !isStrongSecret(parsed.ASSEMBLYAI_API_KEY, 16)) ||
    !isStrongSecret(parsed.S3_ACCESS_KEY, 8) ||
    !isStrongSecret(parsed.S3_SECRET_KEY, 16) ||
    !isStrongSecret(voximplantApiKey, 20) ||
    (hasValue(parsed.REDIS_PASSWORD) &&
      !isStrongSecret(parsed.REDIS_PASSWORD, 16)) ||
    (parsed.CEREBRAS_API_KEYS?.some(key => !isStrongSecret(key, 16)) ?? false)
  ) {
    return fail('unsafe_defaults');
  }
  return hasValue(parsed.ASSEMBLYAI_API_KEY)
    ? pass('ready')
    : warn('fallback_unconfigured');
}

function validateDatabaseSchema(snapshot: DatabaseSchemaSnapshot): CheckOutcome {
  if (
    !Number.isInteger(snapshot.serverVersionNumber) ||
    snapshot.serverVersionNumber < 160_000
  ) {
    return fail('version_unsupported');
  }
  if (
    REQUIRED_EXTENSIONS.some(extension => !snapshot.extensions.includes(extension))
  ) {
    return fail('extensions_missing');
  }
  if (REQUIRED_TABLES.some(table => !snapshot.tables.includes(table))) {
    return fail('tables_missing');
  }
  if (snapshot.embeddingType !== 'vector(768)') {
    return fail('embedding_invalid');
  }
  if (snapshot.embeddingModelType !== 'text') {
    return fail('embedding_model_invalid');
  }
  if (!snapshot.hasMatchKnowledge) return fail('function_missing');
  return pass('ready');
}

function validateHealthSnapshot(
  snapshot: HealthSnapshot,
  nowMs: number
): CheckOutcome {
  if (snapshot.redirected) return fail('redirect_rejected');
  if (snapshot.statusCode !== 200) return fail('unexpected_status');
  if (snapshot.status !== 'ok') return fail('invalid_payload');
  if (typeof snapshot.timestamp !== 'string') return fail('invalid_timestamp');
  const timestampMs = Date.parse(snapshot.timestamp);
  if (!Number.isFinite(timestampMs)) return fail('invalid_timestamp');
  const ageMs = nowMs - timestampMs;
  if (ageMs > MAX_HEALTH_AGE_MS || ageMs < -MAX_HEALTH_FUTURE_SKEW_MS) {
    return fail('stale_timestamp');
  }
  return pass('healthy');
}

function validateBillingSnapshot(snapshot: BillingSnapshot): CheckOutcome {
  if (
    snapshot.apiError ||
    snapshot.statusCode < 200 ||
    snapshot.statusCode >= 300
  ) {
    return fail('provider_rejected');
  }
  return isPositiveDecimal(snapshot.balance)
    ? pass('balance_positive')
    : fail('balance_empty');
}

function validateVoximplantBillingSnapshot(
  snapshot: VoximplantBillingSnapshot
): CheckOutcome {
  const provider = validateBillingSnapshot(snapshot);
  if (provider.status === 'fail' && provider.code === 'provider_rejected') {
    return provider;
  }
  if (snapshot.active !== true) return fail('account_inactive');
  if (snapshot.frozen === true) return fail('account_frozen');
  return provider;
}

async function executeCheck(
  id: string,
  dependencies: Pick<ProductionReadinessDependencies, 'now'>,
  errorCode: string,
  action: () => Promise<CheckOutcome>
): Promise<ReadinessCheckResult> {
  const startedAt = dependencies.now();
  try {
    const outcome = await action();
    return immediateResult(
      id,
      outcome,
      safeDuration(dependencies.now() - startedAt)
    );
  } catch {
    return immediateResult(
      id,
      fail(errorCode),
      safeDuration(dependencies.now() - startedAt)
    );
  }
}

function immediateResult(
  id: string,
  outcome: CheckOutcome,
  durationMs = 0
): ReadinessCheckResult {
  return Object.freeze({
    id,
    status: outcome.status,
    code: outcome.code,
    duration_ms: safeDuration(durationMs),
  });
}

function createReadinessPool(
  environment: NodeJS.ProcessEnv,
  timeoutMs: number
): Pool {
  return new Pool({
    connectionString: environment['DATABASE_URL'],
    max: 1,
    idleTimeoutMillis: timeoutMs,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });
}

function parsePublicTarget(value: string | undefined): URL | undefined {
  if (!hasValue(value)) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      !isPublicHostname(url.hostname)
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function healthUrl(base: URL): URL {
  return new URL('/health', base);
}

function voiceWebSocketUrl(base: URL, orgId: string): URL {
  const url = new URL('/ws/voice', base);
  url.protocol = 'wss:';
  url.search = new URLSearchParams({
    orgId,
    callId: 'production-readiness',
    phone: '0000000',
  }).toString();
  return url;
}

function invalidVoiceToken(configuredToken: string | undefined): string {
  let token: string;
  do {
    token = `readiness-invalid-${randomBytes(32).toString('hex')}`;
  } while (token === configuredToken);
  return token;
}

function isPublicHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname).toLowerCase().replace(/\.$/, '');
  const ipVersion = isIP(normalized);
  if (ipVersion !== 0) return isPublicAddress(normalized);
  if (
    normalized.length === 0 ||
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    !normalized.includes('.')
  ) {
    return false;
  }
  return true;
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isPublicAddress(address: string): boolean {
  const normalized = normalizeHostname(address).toLowerCase();
  const version = isIP(normalized);
  if (version === 4) {
    const octets = normalized.split('.').map(Number);
    const first = octets[0]!;
    const second = octets[1]!;
    const third = octets[2]!;
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  if (version === 6) {
    if (normalized === '::' || normalized === '::1') return false;
    if (/^(fc|fd|fe[89ab])/i.test(normalized)) return false;
    const mapped = mappedIpv4Address(normalized);
    return mapped ? isPublicAddress(mapped) : true;
  }
  return false;
}

function mappedIpv4Address(address: string): string | undefined {
  if (!address.startsWith('::ffff:')) return undefined;
  const suffix = address.slice('::ffff:'.length);
  if (isIP(suffix) === 4) return suffix;
  const words = suffix.split(':');
  if (
    words.length !== 2 ||
    words.some(word => !/^[0-9a-f]{1,4}$/i.test(word))
  ) {
    return undefined;
  }
  const high = Number.parseInt(words[0]!, 16);
  const low = Number.parseInt(words[1]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
}

async function probeNegativeWebSocketAuth(
  url: URL,
  resolvedAddress: string,
  invalidToken: string,
  timeoutMs: number
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url, {
      headers: { 'X-Voice-Token': invalidToken },
      handshakeTimeout: timeoutMs,
      followRedirects: false,
      perMessageDeflate: false,
      lookup: createPinnedLookup(resolvedAddress),
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error('websocket probe timeout'));
    }, timeoutMs);
    timer.unref?.();

    const settle = (statusCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      resolve(statusCode);
    };
    socket.once('open', () => settle(101));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      settle(response.statusCode ?? 0);
    });
    socket.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

type PinnedHttpsJsonResponse = Readonly<{
  statusCode: number;
  body: unknown;
}>;

async function requestPinnedHttpsJson(
  url: URL,
  resolvedAddress: string,
  timeoutMs: number
): Promise<PinnedHttpsJsonResponse> {
  return new Promise<PinnedHttpsJsonResponse>((resolve, reject) => {
    let settled = false;
    const settleError = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: createPinnedLookup(resolvedAddress),
        servername: normalizeHostname(url.hostname),
        headers: {
          accept: 'application/json',
          'accept-encoding': 'identity',
        },
      },
      response => {
        const chunks: Buffer[] = [];
        let byteLength = 0;
        response.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteLength += buffer.length;
          if (byteLength > MAX_JSON_BYTES) {
            response.destroy();
            settleError(new Error('response too large'));
            return;
          }
          chunks.push(buffer);
        });
        response.once('error', settleError);
        response.once('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            statusCode: response.statusCode ?? 0,
            body: parseJson(Buffer.concat(chunks, byteLength)),
          });
        });
      }
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('request timeout'));
    });
    request.once('error', settleError);
    request.end();
  });
}

function createPinnedLookup(resolvedAddress: string): LookupFunction {
  const family = isIP(resolvedAddress);
  if (family !== 4 && family !== 6) {
    throw new Error('invalid resolved address');
  }
  return (_hostname, options, callback): void => {
    if (options.all) {
      callback(null, [{ address: resolvedAddress, family }]);
      return;
    }
    callback(null, resolvedAddress, family);
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('operation timeout'));
    }, timeoutMs);
    promise.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function readBoundedJson(
  response: Response,
  maxBytes: number
): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error('response too large');
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  return parseJson(combined);
}

function parseJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isPositiveDecimal(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    return false;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUuid(value: string | undefined): value is string {
  return (
    hasValue(value) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function hasProtocol(value: string, allowed: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return allowed.includes(url.protocol);
  } catch {
    return false;
  }
}

function looksLikePlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === 'minioadmin' ||
    normalized === 'placeholder' ||
    normalized === 'changeme' ||
    normalized === 'change-me' ||
    normalized === 'your-api-key' ||
    normalized === 'your-account-id' ||
    normalized.startsWith('your-') ||
    normalized.includes('...') ||
    (normalized.startsWith('<') && normalized.endsWith('>'))
  );
}

function isStrongSecret(value: string, minimumLength: number): boolean {
  return (
    value.length >= minimumLength &&
    new Set(value).size >= 8 &&
    !looksLikePlaceholder(value)
  );
}

function ignoreRedisError(_error: unknown): void {
  // Intentionally empty: callers receive the rejected connect/ping promise.
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeAtom(value: string): string {
  return /^[a-z0-9._-]+$/i.test(value) ? value : 'invalid';
}

function safeDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
