import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { WAMessage } from 'baileys';
import {
  InvalidWhatsAppInputError,
  WhatsAppBridge,
  type WhatsAppBridgeOptions,
} from '../../src/whatsapp/bridge';
import { importBaileys, type BaileysModule } from '../../src/whatsapp/import-baileys';
import { classifyWhatsAppControlCommand } from '../../src/whatsapp/policy';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ORG_ID = '22222222-2222-4222-8222-222222222222';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function temporaryAuthRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'salesagent-wa-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

type InboundLimitOptions = Pick<
  WhatsAppBridgeOptions,
  | 'inboundGlobalConcurrency'
  | 'inboundTenantConcurrency'
  | 'inboundGlobalQueueLimit'
  | 'inboundTenantQueueLimit'
  | 'inboundLidLookupTimeoutMs'
>;

type HarnessInboundMessage = Readonly<{
  id: string;
  text: string;
  phone?: string;
  replyJid?: string;
  remoteJidAlt?: string;
}>;

async function createInboundHarness(
  onIncomingMessage: WhatsAppBridgeOptions['onIncomingMessage'],
  limits: Partial<InboundLimitOptions> = {},
  getPhoneForLid: (
    lid: string,
    orgId: string
  ) => Promise<string | null> = async () => null
): Promise<Readonly<{
  bridge: WhatsAppBridge;
  connectOrg: (orgId: string) => Promise<void>;
  emitMessages: (
    messages: readonly HarnessInboundMessage[],
    orgId?: string
  ) => void;
}>> {
  const handlersByOrg = new Map<
    string,
    Map<string, Array<(value: unknown) => void>>
  >();
  const fakeBaileys = {
    default: (options: Record<string, unknown>) => {
      const orgId = (options.auth as { testOrgId?: unknown }).testOrgId;
      if (typeof orgId !== 'string') throw new Error('Missing test organization');
      const handlers = new Map<string, Array<(value: unknown) => void>>();
      handlersByOrg.set(orgId, handlers);
      return {
        ev: {
          on(event: string, handler: (value: unknown) => void) {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
          },
        },
        signalRepository: {
          lidMapping: {
            getPNForLID: (lid: string) => getPhoneForLid(lid, orgId),
          },
        },
        sendMessage: async () => ({ key: { id: 'outbound-test' } }),
        end: async () => {},
        logout: async () => {},
      };
    },
    makeWASocket: () => {
      throw new Error('Unexpected makeWASocket fallback');
    },
    Browsers: { ubuntu: () => ['Ubuntu', 'Chrome', '1'] },
    DisconnectReason: {
      loggedOut: 401,
      badSession: 500,
      multideviceMismatch: 411,
      forbidden: 403,
      connectionReplaced: 440,
    },
    useMultiFileAuthState: async (authDirectory: string) => ({
      state: { testOrgId: path.basename(authDirectory) },
      saveCreds: async () => {},
    }),
  } as unknown as BaileysModule;
  const bridge = new WhatsAppBridge({
    authRoot: await temporaryAuthRoot(),
    inboundMaxChars: 4096,
    outboundMaxChars: 4096,
    reconnectBaseDelayMs: 250,
    reconnectMaxDelayMs: 1000,
    loadBaileys: async () => fakeBaileys,
    onIncomingMessage,
    ...limits,
  });
  await bridge.connect(ORG_ID);

  return {
    bridge,
    async connectOrg(orgId) {
      await bridge.connect(orgId);
    },
    emitMessages(messages, orgId = ORG_ID) {
      const handlers = handlersByOrg.get(orgId);
      if (!handlers) throw new Error(`Organization ${orgId} is not connected`);
      const event = {
        type: 'notify',
        messages: messages.map(({
          id,
          text,
          phone = '77005554433',
          replyJid,
          remoteJidAlt,
        }) => ({
          key: {
            id,
            fromMe: false,
            remoteJid: replyJid ?? `${phone}@s.whatsapp.net`,
            remoteJidAlt,
          },
          message: { conversation: text },
        } as WAMessage)),
      };
      for (const handler of handlers.get('messages.upsert') ?? []) {
        handler(event);
      }
    },
  };
}

describe('WhatsApp bridge lifecycle', () => {
  it('loads the ESM-only Baileys package from the CommonJS backend', async () => {
    const module = await importBaileys();
    assert.equal(typeof module.makeWASocket, 'function');
    assert.equal(typeof module.useMultiFileAuthState, 'function');
  });

  it('connects once, exposes QR as a data URL and routes notify text', async () => {
    const handlers = new Map<string, Array<(value: unknown) => void>>();
    const sent: Array<{ jid: string; text: string }> = [];
    const inbound: Array<{ orgId: string; messageId: string }> = [];
    let loadCount = 0;
    let socketOptions: Record<string, unknown> | undefined;

    const socket = {
      user: { id: '77001234567:0@s.whatsapp.net', name: 'Sales Agent' },
      ev: {
        on(event: string, handler: (value: unknown) => void) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
      },
      signalRepository: {
        lidMapping: { getPNForLID: async () => null },
      },
      sendMessage: async (jid: string, content: { text: string }) => {
        sent.push({ jid, text: content.text });
      },
      end: async () => {},
      logout: async () => {},
    };
    const emit = (event: string, value: unknown): void => {
      for (const handler of handlers.get(event) ?? []) handler(value);
    };
    const fakeBaileys = {
      default: (options: Record<string, unknown>) => {
        socketOptions = options;
        return socket;
      },
      makeWASocket: () => socket,
      Browsers: { ubuntu: () => ['Ubuntu', 'Chrome', '1'] },
      DisconnectReason: {
        loggedOut: 401,
        badSession: 500,
        multideviceMismatch: 411,
        forbidden: 403,
        connectionReplaced: 440,
      },
      useMultiFileAuthState: async () => ({
        state: {},
        saveCreds: async () => {},
      }),
    } as unknown as BaileysModule;

    const bridge = new WhatsAppBridge({
      authRoot: await temporaryAuthRoot(),
      inboundMaxChars: 4096,
      outboundMaxChars: 4096,
      reconnectBaseDelayMs: 250,
      reconnectMaxDelayMs: 1000,
      loadBaileys: async () => {
        loadCount += 1;
        return fakeBaileys;
      },
      onIncomingMessage: async (orgId, value) => {
        inbound.push({ orgId, messageId: value.messageId });
      },
    });

    assert.deepEqual(bridge.getStatus(ORG_ID), { status: 'disconnected' });
    await bridge.connect(ORG_ID);
    await bridge.connect(ORG_ID);
    assert.equal(loadCount, 1);
    assert.equal(socketOptions?.syncFullHistory, false);
    assert.equal(socketOptions?.markOnlineOnConnect, false);
    assert.equal(socketOptions?.emitOwnEvents, false);
    assert.equal(typeof socketOptions?.logger, 'object');
    assert.equal(
      (socketOptions?.logger as { level?: string } | undefined)?.level,
      'silent'
    );
    assert.equal('shouldSyncHistoryMessage' in (socketOptions ?? {}), false);

    emit('connection.update', { qr: 'test-qr-secret' });
    await waitFor(() => bridge.getStatus(ORG_ID).status === 'qr');
    assert.equal(bridge.getStatus(ORG_ID).status, 'qr');
    assert.match(bridge.getStatus(ORG_ID).qrCode ?? '', /^data:image\/png;base64,/);

    emit('connection.update', { connection: 'open' });
    await nextTurn();
    assert.deepEqual(bridge.getStatus(ORG_ID), {
      status: 'connected',
      phone: '77001234567',
      pushName: 'Sales Agent',
      lastConnectedAt: bridge.getStatus(ORG_ID).lastConnectedAt,
    });

    emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: {
          id: 'inbound-1',
          fromMe: false,
          remoteJid: '77005554433@s.whatsapp.net',
        },
        message: { conversation: 'Здравствуйте' },
      } as WAMessage],
    });
    await nextTurn();
    assert.deepEqual(inbound, [{ orgId: ORG_ID, messageId: 'inbound-1' }]);

    await bridge.sendMessage(
      ORG_ID,
      '77005554433',
      ' Ответ ',
      '123456789012345@lid'
    );
    assert.deepEqual(sent, [{ jid: '123456789012345@lid', text: 'Ответ' }]);
    await assert.rejects(
      () => bridge.sendMessage(ORG_ID, '77005554433', 'Холодное сообщение', ''),
      InvalidWhatsAppInputError
    );
    await bridge.shutdown();
  });

  it('rejects invalid tenant ids before touching auth storage', async () => {
    const bridge = new WhatsAppBridge({
      authRoot: await temporaryAuthRoot(),
      inboundMaxChars: 4096,
      outboundMaxChars: 4096,
      reconnectBaseDelayMs: 250,
      reconnectMaxDelayMs: 1000,
      onIncomingMessage: async () => {},
    });
    assert.throws(
      () => bridge.getStatus('../../escape'),
      InvalidWhatsAppInputError
    );
  });

  it('lets STOP invalidate a model turn without waiting for the model', async () => {
    const modelStarted = deferred();
    const releaseModel = deferred();
    const outbound: string[] = [];
    let modeVersion = 0;
    let modelSettled = false;
    const harness = await createInboundHarness(async (_orgId, message) => {
      const command = classifyWhatsAppControlCommand(message.text);
      if (command) {
        modeVersion += 1;
        outbound.push(`control:${command}`);
        return;
      }

      const capturedVersion = modeVersion;
      modelStarted.resolve();
      await releaseModel.promise;
      modelSettled = true;
      if (capturedVersion === modeVersion) outbound.push('ai:stale');
    });

    try {
      harness.emitMessages([{ id: 'normal-before-stop', text: 'Расскажите подробнее' }]);
      await modelStarted.promise;

      harness.emitMessages([{ id: 'stop-during-model', text: 'СТОП' }]);
      await waitFor(() => modeVersion === 1);
      assert.equal(modelSettled, false);
      assert.deepEqual(outbound, ['control:stop']);

      releaseModel.resolve();
      await harness.bridge.shutdown();
      assert.equal(modelSettled, true);
      assert.deepEqual(outbound, ['control:stop']);
    } finally {
      releaseModel.resolve();
      await harness.bridge.shutdown();
    }
  });

  it('bounds queued model turns while preserving admission for STOP', async () => {
    const firstModelStarted = deferred();
    const releaseFirstModel = deferred();
    const controlProcessed = deferred();
    const processedNormalIds: string[] = [];
    const harness = await createInboundHarness(
      async (_orgId, message) => {
        if (classifyWhatsAppControlCommand(message.text)) {
          controlProcessed.resolve();
          return;
        }
        processedNormalIds.push(message.messageId);
        if (message.messageId === 'normal-1') {
          firstModelStarted.resolve();
          await releaseFirstModel.promise;
        }
      },
      {
        inboundGlobalConcurrency: 2,
        inboundTenantConcurrency: 2,
        inboundGlobalQueueLimit: 2,
        inboundTenantQueueLimit: 2,
      }
    );

    try {
      harness.emitMessages([
        { id: 'normal-1', text: 'Первое сообщение' },
        { id: 'normal-2', text: 'Второе сообщение' },
        { id: 'normal-3', text: 'Третье сообщение' },
        { id: 'normal-4', text: 'Четвёртое сообщение' },
        { id: 'stop-at-capacity', text: 'STOP' },
      ]);
      await firstModelStarted.promise;
      await controlProcessed.promise;
      assert.deepEqual(processedNormalIds, ['normal-1']);

      releaseFirstModel.resolve();
      await harness.bridge.shutdown();
      assert.deepEqual(processedNormalIds, ['normal-1', 'normal-2']);
    } finally {
      releaseFirstModel.resolve();
      await harness.bridge.shutdown();
    }
  });

  it('keeps the newest same-contact STOP when controls fill the tenant queue', async () => {
    const releaseActiveControl = deferred();
    const processed: string[] = [];
    const harness = await createInboundHarness(
      async (_orgId, message) => {
        processed.push(message.messageId);
        if (message.messageId === 'active-human') {
          await releaseActiveControl.promise;
        }
      },
      {
        inboundGlobalConcurrency: 2,
        inboundTenantConcurrency: 2,
        inboundGlobalQueueLimit: 1,
        inboundTenantQueueLimit: 1,
      }
    );

    try {
      harness.emitMessages([
        { id: 'active-human', text: 'ОПЕРАТОР' },
      ]);
      await waitFor(() => processed.includes('active-human'));

      harness.emitMessages([{ id: 'old-start', text: 'СТАРТ' }]);
      await nextTurn();
      harness.emitMessages([{ id: 'new-stop', text: 'СТОП' }]);

      releaseActiveControl.resolve();
      await harness.bridge.shutdown();
      assert.deepEqual(processed, ['active-human', 'new-stop']);
    } finally {
      releaseActiveControl.resolve();
      await harness.bridge.shutdown();
    }
  });

  it('admits STOP when another tenant fills the global queue with controls', async () => {
    const releaseActiveControls = deferred();
    const processed = new Set<string>();
    const harness = await createInboundHarness(
      async (orgId, message) => {
        processed.add(`${orgId}:${message.messageId}`);
        if (message.messageId.startsWith('active-')) {
          await releaseActiveControls.promise;
        }
      },
      {
        inboundGlobalConcurrency: 2,
        inboundTenantConcurrency: 2,
        inboundGlobalQueueLimit: 2,
        inboundTenantQueueLimit: 2,
      }
    );
    await harness.connectOrg(SECOND_ORG_ID);

    try {
      harness.emitMessages([
        { id: 'active-first', text: 'ОПЕРАТОР', phone: '77000000001' },
      ]);
      harness.emitMessages([
        { id: 'active-second', text: 'ОПЕРАТОР', phone: '77000000002' },
      ], SECOND_ORG_ID);
      await waitFor(() =>
        processed.has(`${ORG_ID}:active-first`) &&
        processed.has(`${SECOND_ORG_ID}:active-second`)
      );

      harness.emitMessages([
        { id: 'queued-oldest', text: 'СТАРТ', phone: '77000000003' },
        { id: 'queued-newer', text: 'ОПЕРАТОР', phone: '77000000004' },
      ]);
      await nextTurn();
      harness.emitMessages([
        { id: 'cross-tenant-stop', text: 'СТОП', phone: '77000000005' },
      ], SECOND_ORG_ID);

      releaseActiveControls.resolve();
      await harness.bridge.shutdown();
      assert.equal(
        processed.has(`${SECOND_ORG_ID}:cross-tenant-stop`),
        true
      );
      assert.equal(processed.has(`${ORG_ID}:queued-oldest`), false);
      assert.equal(processed.has(`${ORG_ID}:queued-newer`), true);
    } finally {
      releaseActiveControls.resolve();
      await harness.bridge.shutdown();
    }
  });

  it('bounds raw LID parsing and lets direct STOP bypass a hung lookup', async () => {
    const neverResolve = new Promise<string | null>(() => {});
    const controlProcessed = deferred();
    const processed: string[] = [];
    let lidLookupCalls = 0;
    const harness = await createInboundHarness(
      async (_orgId, message) => {
        processed.push(message.messageId);
        if (message.messageId === 'direct-stop') controlProcessed.resolve();
      },
      {
        inboundGlobalConcurrency: 2,
        inboundTenantConcurrency: 2,
        inboundGlobalQueueLimit: 2,
        inboundTenantQueueLimit: 2,
        inboundLidLookupTimeoutMs: 500,
      },
      async () => {
        lidLookupCalls += 1;
        return neverResolve;
      }
    );

    try {
      harness.emitMessages([
        ...Array.from({ length: 20 }, (_, index) => ({
          id: `lid-normal-${index + 1}`,
          text: `Сообщение ${index + 1}`,
          replyJid: `${900000000000000 + index}@lid`,
        })),
        {
          id: 'direct-stop',
          text: 'STOP',
          phone: '77009999999',
        },
      ]);

      await controlProcessed.promise;
      assert.deepEqual(processed, ['direct-stop']);
      assert.equal(lidLookupCalls, 1);

      await waitFor(() => processed.includes('lid-normal-1'), 1_500);
      await harness.bridge.shutdown();
      assert.equal(lidLookupCalls, 1);
      assert.deepEqual(processed.sort(), ['direct-stop', 'lid-normal-1']);
    } finally {
      await harness.bridge.shutdown();
    }
  });
});
