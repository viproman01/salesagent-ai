import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultProductionReadinessDependencies,
  formatReadinessResults,
  readinessExitCode,
  runProductionReadiness,
  type DatabaseSchemaSnapshot,
  type ProductionReadinessDependencies,
} from '../../src/readiness/production';
import {
  executeProductionReadinessCli,
  parseProductionReadinessArguments,
  type ReadinessCliRuntime,
} from '../../src/readiness/cli';

const NOW = Date.parse('2026-07-21T12:00:00.000Z');
const REQUIRED_TABLES = [
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
  'whatsapp_inbound_receipts',
  'whatsapp_outbox',
];

const REQUIRED_AUTOMATION_COLUMNS = [
  'conversations.assigned_user_id',
  'conversations.mode_version',
  'conversations.reply_mode',
  'messages.author_user_id',
  'messages.delivery_status',
  'messages.external_id',
  'messages.provider_message_id',
  'messages.sender_type',
  'messages.sequence_id',
];

function productionEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    JWT_SECRET: 'Prod-JWT-7yK2!mQ9#vR4@xL8$zN6%tB3',
    DATABASE_URL: 'postgresql://db.example.com/salesagent',
    REDIS_URL: 'rediss://redis.example.com',
    ANTHROPIC_API_KEY: 'anthropic-live-A7m2Q9x4P8r5',
    GOOGLE_API_KEY: 'google-live-B8n3R7y5K2v9',
    DEEPGRAM_API_KEY: 'deepgram-live-C4p8T2m7X9q5',
    ASSEMBLYAI_API_KEY: 'assembly-live-D6r3W8k2N7z4',
    FISH_API_KEY: 'fish-live-E9t4M7q2V8p5',
    FISH_TTS_REFERENCE_ID: 'reference-F2x7K4m9R3v8',
    VOICE_RUNTIME: 'pipeline',
    VOICE_DEFAULT_ORG_ID: '123e4567-e89b-42d3-a456-426614174000',
    VOICE_WS_AUTH_TOKEN: 'Voice-WS-8qL3!xR7#mN2@vK9$pT5%zC4',
    VOICE_LLM_FAST_PROVIDER: 'anthropic',
    S3_ENDPOINT: 'https://s3.example.com',
    S3_ACCESS_KEY: 'storage-access',
    S3_SECRET_KEY: 'Storage-Secret-9vK2!mQ7#xR4',
    S3_BUCKET_RECORDINGS: 'recordings',
    S3_BUCKET_KNOWLEDGE: 'knowledge',
    WEBHOOK_BASE_URL: 'https://voice.example.com',
    VOXIMPLANT_ACCOUNT_ID: '7531904',
    VOXIMPLANT_API_KEY: 'Vox-Live-8mQ2xR7kP4vN9tC6',
  };
}

function readySchema(): DatabaseSchemaSnapshot {
  return {
    serverVersionNumber: 160_000,
    extensions: ['uuid-ossp', 'pgcrypto', 'vector'],
    tables: REQUIRED_TABLES,
    automationColumns: REQUIRED_AUTOMATION_COLUMNS,
    embeddingType: 'vector(768)',
    embeddingModelType: 'text',
    hasMatchKnowledge: true,
  };
}

function readyDependencies(
  overrides: Partial<ProductionReadinessDependencies> = {}
): ProductionReadinessDependencies {
  return {
    now: () => NOW,
    databaseConnection: async () => undefined,
    databaseSchema: async () => readySchema(),
    redisPing: async () => true,
    s3HeadBucket: async () => undefined,
    hasActiveVoiceAgent: async () => true,
    resolveHost: async () => ['93.184.216.34'],
    publicHealth: async () => ({
      statusCode: 200,
      redirected: false,
      status: 'ok',
      timestamp: new Date(NOW).toISOString(),
    }),
    negativeWebSocketAuth: async () => 401,
    fishBilling: async () => ({
      statusCode: 200,
      balance: '1.25',
      apiError: false,
    }),
    voximplantBilling: async () => ({
      statusCode: 200,
      balance: 2,
      apiError: false,
      active: true,
      frozen: false,
    }),
    ...overrides,
  };
}

test('passes the full non-billing readiness path in a fixed order', async () => {
  let billingCalls = 0;
  const dependencies = readyDependencies({
    fishBilling: async () => {
      billingCalls += 1;
      throw new Error('must not run');
    },
    voximplantBilling: async () => {
      billingCalls += 1;
      throw new Error('must not run');
    },
  });

  const results = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 1_000,
      billing: false,
    },
    dependencies
  );

  assert.deepEqual(
    results.map(result => result.id),
    [
      'env.production',
      'db.connection',
      'db.schema',
      'redis.ping',
      's3.recordings',
      's3.knowledge',
      'voice.agent',
      'public.health',
      'public.ws_auth',
    ]
  );
  assert.equal(results.every(result => result.status === 'pass'), true);
  assert.equal(readinessExitCode(results, false), 0);
  assert.equal(billingCalls, 0);
});

test('calls both read-only billing probes only when billing is enabled', async () => {
  let fishCalls = 0;
  let voximplantCalls = 0;
  const results = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 1_000,
      billing: true,
    },
    readyDependencies({
      fishBilling: async () => {
        fishCalls += 1;
        return { statusCode: 200, balance: '0.01', apiError: false };
      },
      voximplantBilling: async () => {
        voximplantCalls += 1;
        return {
          statusCode: 200,
          balance: '4',
          apiError: false,
          active: true,
          frozen: false,
        };
      },
    })
  );

  assert.equal(fishCalls, 1);
  assert.equal(voximplantCalls, 1);
  assert.deepEqual(results.slice(-2).map(result => result.id), [
    'billing.fish',
    'billing.voximplant',
  ]);
  assert.equal(results.slice(-2).every(result => result.status === 'pass'), true);
});

test('fails zero provider balances without exposing their values', async () => {
  const results = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 1_000,
      billing: true,
    },
    readyDependencies({
      fishBilling: async () => ({
        statusCode: 200,
        balance: '0',
        apiError: false,
      }),
      voximplantBilling: async () => ({
        statusCode: 200,
        balance: 0,
        apiError: false,
        active: true,
        frozen: false,
      }),
    })
  );

  assert.equal(readinessExitCode(results, false), 1);
  assert.deepEqual(results.slice(-2).map(result => result.code), [
    'balance_empty',
    'balance_empty',
  ]);
});

test('requires an active, unfrozen Voximplant account', async () => {
  for (const [snapshot, expectedCode] of [
    [
      {
        statusCode: 200,
        balance: '2',
        apiError: false,
        active: false,
        frozen: false,
      },
      'account_inactive',
    ],
    [
      {
        statusCode: 200,
        balance: '2',
        apiError: false,
        active: true,
        frozen: true,
      },
      'account_frozen',
    ],
  ] as const) {
    const results = await runProductionReadiness(
      {
        environment: productionEnvironment(),
        timeoutMs: 1_000,
        billing: true,
      },
      readyDependencies({ voximplantBilling: async () => snapshot })
    );
    assert.equal(
      results.find(result => result.id === 'billing.voximplant')?.code,
      expectedCode
    );
  }
});

test('runs Zod first, requires Vox credentials, and rejects unsafe configuration', async () => {
  const cases: Array<readonly [NodeJS.ProcessEnv, string]> = [];

  const zodInvalid = productionEnvironment();
  zodInvalid['NODE_ENV'] = 'development';
  zodInvalid['VOICE_ENDPOINTING_DELAY_MS'] = 'not-a-number';
  cases.push([zodInvalid, 'configuration_invalid']);

  const missingVox = productionEnvironment();
  delete missingVox['VOXIMPLANT_API_KEY'];
  cases.push([missingVox, 'configuration_missing']);

  const wrongDatabaseProtocol = productionEnvironment();
  wrongDatabaseProtocol['DATABASE_URL'] = 'https://db.example.com/salesagent';
  cases.push([wrongDatabaseProtocol, 'configuration_invalid']);

  const placeholder = productionEnvironment();
  placeholder['JWT_SECRET'] =
    'your-super-secret-jwt-key-minimum-32-characters';
  cases.push([placeholder, 'unsafe_defaults']);

  const weakToken = productionEnvironment();
  weakToken['VOICE_WS_AUTH_TOKEN'] = 'x'.repeat(48);
  cases.push([weakToken, 'unsafe_defaults']);

  const placeholderFallback = productionEnvironment();
  placeholderFallback['ASSEMBLYAI_API_KEY'] = 'your-assembly-key';
  cases.push([placeholderFallback, 'unsafe_defaults']);

  for (const [environment, expectedCode] of cases) {
    const results = await runProductionReadiness(
      { environment, timeoutMs: 1_000, billing: false },
      readyDependencies()
    );
    assert.equal(results[0]?.code, expectedCode);
  }
});

test('strict mode promotes the optional fallback warning to exit code one', async () => {
  const environment = productionEnvironment();
  delete environment['ASSEMBLYAI_API_KEY'];
  const results = await runProductionReadiness(
    { environment, timeoutMs: 1_000, billing: false },
    readyDependencies()
  );

  assert.deepEqual(results[0], {
    id: 'env.production',
    status: 'warn',
    code: 'fallback_unconfigured',
    duration_ms: 0,
  });
  assert.equal(readinessExitCode(results, false), 0);
  assert.equal(readinessExitCode(results, true), 1);
});

test('rejects private public targets before any network probe', async () => {
  let networkCalls = 0;
  const results = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      publicUrl: 'https://127.0.0.1',
      timeoutMs: 1_000,
      billing: false,
    },
    readyDependencies({
      resolveHost: async () => {
        networkCalls += 1;
        return ['127.0.0.1'];
      },
      publicHealth: async () => {
        networkCalls += 1;
        throw new Error('must not run');
      },
      negativeWebSocketAuth: async () => {
        networkCalls += 1;
        return 401;
      },
    })
  );

  assert.equal(networkCalls, 0);
  assert.equal(results.find(result => result.id === 'public.health')?.status, 'fail');
  assert.equal(results.find(result => result.id === 'public.ws_auth')?.status, 'fail');
});

test('bounds DNS resolution and rejects private IPv4-mapped IPv6', async () => {
  const startedAt = Date.now();
  const timedOut = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 20,
      billing: false,
    },
    readyDependencies({
      resolveHost: () => new Promise<readonly string[]>(() => undefined),
    })
  );
  assert.equal(Date.now() - startedAt < 250, true);
  assert.equal(
    timedOut.find(result => result.id === 'public.health')?.code,
    'host_not_public'
  );

  let publicProbeCalls = 0;
  const mappedPrivate = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 1_000,
      billing: false,
    },
    readyDependencies({
      resolveHost: async () => ['::ffff:7f00:1'],
      publicHealth: async () => {
        publicProbeCalls += 1;
        throw new Error('must not run');
      },
      negativeWebSocketAuth: async () => {
        publicProbeCalls += 1;
        return 401;
      },
    })
  );
  assert.equal(publicProbeCalls, 0);
  assert.equal(
    mappedPrivate.find(result => result.id === 'public.health')?.status,
    'fail'
  );
});

test('pins the validated DNS address into both public connections', async () => {
  const addresses: string[] = [];
  const results = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 1_000,
      billing: false,
    },
    readyDependencies({
      resolveHost: async () => ['8.8.8.8'],
      publicHealth: async (_url, resolvedAddress) => {
        addresses.push(resolvedAddress);
        return {
          statusCode: 200,
          redirected: false,
          status: 'ok',
          timestamp: new Date(NOW).toISOString(),
        };
      },
      negativeWebSocketAuth: async (_url, resolvedAddress) => {
        addresses.push(resolvedAddress);
        return 403;
      },
    })
  );
  assert.deepEqual(addresses, ['8.8.8.8', '8.8.8.8']);
  assert.equal(
    results
      .filter(result => result.id.startsWith('public.'))
      .every(result => result.status === 'pass'),
    true
  );
});

test('accepts a global IPv6 literal and pins it without a DNS fallback', async () => {
  const globalAddress = '2606:4700:4700::1111';
  const pinned: string[] = [];
  const results = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      publicUrl: `https://[${globalAddress}]`,
      timeoutMs: 1_000,
      billing: false,
    },
    readyDependencies({
      resolveHost: async hostname => {
        assert.equal(hostname, `[${globalAddress}]`);
        return [globalAddress];
      },
      publicHealth: async (_url, resolvedAddress) => {
        pinned.push(resolvedAddress);
        return {
          statusCode: 200,
          redirected: false,
          status: 'ok',
          timestamp: new Date(NOW).toISOString(),
        };
      },
      negativeWebSocketAuth: async (_url, resolvedAddress) => {
        pinned.push(resolvedAddress);
        return 401;
      },
    })
  );
  assert.deepEqual(pinned, [globalAddress, globalAddress]);
  assert.equal(
    results
      .filter(result => result.id.startsWith('public.'))
      .every(result => result.status === 'pass'),
    true
  );
});

test('requires a fresh health timestamp and a negative WebSocket rejection', async () => {
  const results = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 1_000,
      billing: false,
    },
    readyDependencies({
      publicHealth: async () => ({
        statusCode: 200,
        redirected: false,
        status: 'ok',
        timestamp: new Date(NOW - 180_000).toISOString(),
      }),
      negativeWebSocketAuth: async () => 200,
    })
  );

  assert.equal(
    results.find(result => result.id === 'public.health')?.code,
    'stale_timestamp'
  );
  assert.equal(
    results.find(result => result.id === 'public.ws_auth')?.code,
    'authentication_bypassed'
  );
});

test('reports database schema blockers with stable codes', async () => {
  const results = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 1_000,
      billing: false,
    },
    readyDependencies({
      databaseSchema: async () => ({
        ...readySchema(),
        embeddingType: 'vector(3072)',
      }),
    })
  );

  assert.equal(results.find(result => result.id === 'db.schema')?.code, 'embedding_invalid');
  assert.equal(readinessExitCode(results, false), 1);
});

test('requires WhatsApp automation tables and state columns', async () => {
  const missingAutomationColumn = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 1_000,
      billing: false,
    },
    readyDependencies({
      databaseSchema: async () => ({
        ...readySchema(),
        automationColumns: REQUIRED_AUTOMATION_COLUMNS.slice(1),
      }),
    })
  );
  assert.equal(
    missingAutomationColumn.find(result => result.id === 'db.schema')?.code,
    'automation_columns_missing'
  );

  const missingOutbox = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 1_000,
      billing: false,
    },
    readyDependencies({
      databaseSchema: async () => ({
        ...readySchema(),
        tables: REQUIRED_TABLES.filter(table => table !== 'whatsapp_outbox'),
      }),
    })
  );
  assert.equal(
    missingOutbox.find(result => result.id === 'db.schema')?.code,
    'tables_missing'
  );
});

test('requires embedding model tracking and the five-argument search function', async () => {
  const missingModelColumn = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 1_000,
      billing: false,
    },
    readyDependencies({
      databaseSchema: async () => ({
        ...readySchema(),
        embeddingModelType: null,
      }),
    })
  );
  assert.equal(
    missingModelColumn.find(result => result.id === 'db.schema')?.code,
    'embedding_model_invalid'
  );

  const oldFunctionSignature = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 1_000,
      billing: false,
    },
    readyDependencies({
      databaseSchema: async () => ({
        ...readySchema(),
        hasMatchKnowledge: false,
      }),
    })
  );
  assert.equal(
    oldFunctionSignature.find(result => result.id === 'db.schema')?.code,
    'function_missing'
  );
});

test('text and JSON output never contain raw errors, URLs, UUIDs, or secrets', async () => {
  const leaked = [
    'super-secret-value',
    'postgresql://user:password@private.example/db',
    '123e4567-e89b-42d3-a456-426614174000',
  ];
  const results = await runProductionReadiness(
    {
      environment: productionEnvironment(),
      timeoutMs: 1_000,
      billing: false,
    },
    readyDependencies({
      databaseConnection: async () => {
        throw new Error(leaked.join(' '));
      },
      redisPing: async () => {
        throw { body: leaked, token: leaked[0] };
      },
    })
  );

  for (const output of [
    formatReadinessResults(results, 'text'),
    formatReadinessResults(results, 'json'),
  ]) {
    for (const value of leaked) assert.equal(output.includes(value), false);
    assert.equal(output.includes('http'), false);
    assert.equal(output.includes('password'), false);
  }
  const json = JSON.parse(formatReadinessResults(results, 'json')) as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(Object.keys(json[0]!).sort(), [
    'code',
    'duration_ms',
    'id',
    'status',
  ]);
});

test('Redis readiness errors are contained and never written to stderr', async () => {
  const dependencies = createDefaultProductionReadinessDependencies();
  const originalWrite = process.stderr.write;
  const originalConsoleError = console.error;
  let stderr = '';
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  console.error = (...values: unknown[]) => {
    stderr += values.map(String).join(' ');
  };
  try {
    await assert.rejects(() =>
      dependencies.redisPing(
        { REDIS_URL: 'redis://:raw-password@127.0.0.1:1/0' },
        250
      )
    );
  } finally {
    process.stderr.write = originalWrite;
    console.error = originalConsoleError;
  }
  assert.equal(stderr, '');
});

test('CLI timeout boundaries are exactly 250 through 30000 milliseconds', () => {
  assert.equal(
    parseProductionReadinessArguments(['--timeout-ms', '250']).timeoutMs,
    250
  );
  assert.equal(
    parseProductionReadinessArguments(['--timeout-ms=30000']).timeoutMs,
    30_000
  );
  assert.throws(() =>
    parseProductionReadinessArguments(['--timeout-ms', '249'])
  );
  assert.throws(() =>
    parseProductionReadinessArguments(['--timeout-ms', '30001'])
  );
});

test('CLI preserves JSON output for invalid arguments', async () => {
  let stdout = '';
  const runtime: ReadinessCliRuntime = {
    cwd: '/readiness',
    environment: productionEnvironment(),
    readEnvironmentFile: async () => {
      throw new Error('should not read environment');
    },
    runReadiness: async () => {
      throw new Error('should not run readiness checks');
    },
    writeOutput: output => {
      stdout += output;
    },
  };

  const exitCode = await executeProductionReadinessCli(
    ['--format', 'json', '--unknown'],
    runtime
  );
  assert.equal(exitCode, 2);
  assert.deepEqual(JSON.parse(stdout), [
    {
      id: 'cli.arguments',
      status: 'fail',
      code: 'invalid_arguments',
      duration_ms: 0,
    },
  ]);
});

test('CLI maps internal failures to code three without stderr or raw details', async () => {
  const raw =
    'https://private.example/ 123e4567-e89b-42d3-a456-426614174000 raw-secret';
  let stdout = '';
  const runtime: ReadinessCliRuntime = {
    cwd: '/readiness',
    environment: productionEnvironment(),
    readEnvironmentFile: async () => {
      throw new Error('default file absent');
    },
    runReadiness: async () => {
      throw new Error(raw);
    },
    writeOutput: output => {
      stdout += output;
    },
  };

  const exitCode = await executeProductionReadinessCli(
    ['--format', 'json'],
    runtime
  );
  assert.equal(exitCode, 3);
  assert.equal(stdout.includes(raw), false);
  assert.deepEqual(JSON.parse(stdout), [
    {
      id: 'cli.internal',
      status: 'fail',
      code: 'internal_failure',
      duration_ms: 0,
    },
  ]);
});
