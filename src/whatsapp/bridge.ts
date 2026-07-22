import { promises as fs } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import type {
  BaileysEventMap,
  WAMessage,
  WASocket,
} from 'baileys';
import { logger } from '../utils/logger';
import {
  isDirectWhatsAppJid,
  normalizeOutboundPhone,
  parseInboundWhatsAppMessage,
  extractWhatsAppText,
  phoneFromWhatsAppJid,
  type ParsedWhatsAppMessage,
} from './message';
import {
  importBaileys,
  type BaileysModule,
} from './import-baileys';
import { classifyWhatsAppControlCommand } from './policy';

export type WhatsAppBridgeStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'error';

export interface WhatsAppStatusSnapshot {
  status: WhatsAppBridgeStatus;
  qrCode?: string;
  phone?: string;
  pushName?: string;
  lastConnectedAt?: string;
  error?: string;
}

export interface WhatsAppBridgeOptions {
  authRoot: string;
  inboundMaxChars: number;
  outboundMaxChars: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  inboundGlobalConcurrency?: number;
  inboundTenantConcurrency?: number;
  inboundGlobalQueueLimit?: number;
  inboundTenantQueueLimit?: number;
  inboundLidLookupTimeoutMs?: number;
  onIncomingMessage: (
    orgId: string,
    message: ParsedWhatsAppMessage
  ) => Promise<void>;
  loadBaileys?: () => Promise<BaileysModule>;
}

type InboundLane = 'control' | 'normal';

type QueuedInboundMessage = {
  readonly lane: InboundLane;
  readonly command: ReturnType<typeof classifyWhatsAppControlCommand>;
  readonly contactKey: string;
  readonly sequence: number;
  readonly socket: WASocket;
  rawMessage?: WAMessage;
  message?: ParsedWhatsAppMessage;
  parsing: boolean;
  cancelled: boolean;
};

type ReadyInboundMessage = QueuedInboundMessage & {
  message: ParsedWhatsAppMessage;
};

interface WhatsAppSession {
  orgId: string;
  generation: number;
  reconnectAttempts: number;
  snapshot: WhatsAppStatusSnapshot;
  socket?: WASocket;
  connectPromise?: Promise<WhatsAppStatusSnapshot>;
  reconnectTimer?: NodeJS.Timeout;
  pendingControlMessages: QueuedInboundMessage[];
  pendingNormalMessages: QueuedInboundMessage[];
  activeControlContacts: Set<string>;
  activeNormalContacts: Set<string>;
  inboundParsing: number;
  normalParsing: number;
  inboundInFlight: number;
  normalInFlight: number;
}

type BaileysLogger = NonNullable<
  Parameters<BaileysModule['makeWASocket']>[0]['logger']
>;

// Baileys logs the full pairing handshake at info level, including material
// that must never be copied to application or container logs. The bridge
// exposes only redacted lifecycle events through our own logger below.
const silentBaileysLogger: BaileysLogger = {
  level: 'silent',
  child: () => silentBaileysLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ORG_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_INBOUND_GLOBAL_CONCURRENCY = 32;
const DEFAULT_INBOUND_TENANT_CONCURRENCY = 8;
const DEFAULT_INBOUND_GLOBAL_QUEUE_LIMIT = 1_024;
const DEFAULT_INBOUND_TENANT_QUEUE_LIMIT = 128;
const DEFAULT_INBOUND_LID_LOOKUP_TIMEOUT_MS = 1_000;

export class InvalidWhatsAppInputError extends Error {}
export class WhatsAppNotConnectedError extends Error {}

export class WhatsAppBridge {
  private readonly authRoot: string;
  private readonly sessions = new Map<string, WhatsAppSession>();
  private readonly options: WhatsAppBridgeOptions;
  private readonly inboundGlobalConcurrency: number;
  private readonly inboundTenantConcurrency: number;
  private readonly inboundGlobalQueueLimit: number;
  private readonly inboundTenantQueueLimit: number;
  private readonly inboundLidLookupTimeoutMs: number;
  private readonly inboundIdleWaiters = new Set<() => void>();
  private globalInboundParsing = 0;
  private globalNormalParsing = 0;
  private globalInboundInFlight = 0;
  private globalNormalInFlight = 0;
  private globalQueuedMessages = 0;
  private nextInboundSequence = 0;
  private disconnectReason?: BaileysModule['DisconnectReason'];

  constructor(options: WhatsAppBridgeOptions) {
    this.options = options;
    this.authRoot = path.resolve(options.authRoot);
    this.inboundGlobalConcurrency = positiveIntegerOption(
      options.inboundGlobalConcurrency,
      DEFAULT_INBOUND_GLOBAL_CONCURRENCY,
      'inboundGlobalConcurrency',
      2
    );
    this.inboundTenantConcurrency = Math.min(
      this.inboundGlobalConcurrency,
      positiveIntegerOption(
        options.inboundTenantConcurrency,
        DEFAULT_INBOUND_TENANT_CONCURRENCY,
        'inboundTenantConcurrency',
        2
      )
    );
    this.inboundGlobalQueueLimit = positiveIntegerOption(
      options.inboundGlobalQueueLimit,
      DEFAULT_INBOUND_GLOBAL_QUEUE_LIMIT,
      'inboundGlobalQueueLimit'
    );
    this.inboundTenantQueueLimit = Math.min(
      this.inboundGlobalQueueLimit,
      positiveIntegerOption(
        options.inboundTenantQueueLimit,
        DEFAULT_INBOUND_TENANT_QUEUE_LIMIT,
        'inboundTenantQueueLimit'
      )
    );
    this.inboundLidLookupTimeoutMs = positiveIntegerOption(
      options.inboundLidLookupTimeoutMs,
      DEFAULT_INBOUND_LID_LOOKUP_TIMEOUT_MS,
      'inboundLidLookupTimeoutMs'
    );
  }

  getStatus(orgId: string): WhatsAppStatusSnapshot {
    this.validateOrgId(orgId);
    return this.cloneSnapshot(this.getOrCreateSession(orgId).snapshot);
  }

  async connect(orgId: string): Promise<WhatsAppStatusSnapshot> {
    this.validateOrgId(orgId);
    const session = this.getOrCreateSession(orgId);

    if (
      session.socket &&
      (session.snapshot.status === 'connecting' ||
        session.snapshot.status === 'qr' ||
        session.snapshot.status === 'connected')
    ) {
      return this.cloneSnapshot(session.snapshot);
    }
    if (session.connectPromise) return session.connectPromise;

    const promise = this.startSession(session).finally(() => {
      if (session.connectPromise === promise) session.connectPromise = undefined;
    });
    session.connectPromise = promise;
    return promise;
  }

  async reconnect(orgId: string): Promise<WhatsAppStatusSnapshot> {
    this.validateOrgId(orgId);
    const session = this.getOrCreateSession(orgId);
    await this.stopSocket(session);
    return this.connect(orgId);
  }

  async logout(orgId: string): Promise<WhatsAppStatusSnapshot> {
    this.validateOrgId(orgId);
    const session = this.getOrCreateSession(orgId);
    const socket = this.detachSocket(session);

    if (socket) {
      try {
        await socket.logout('SalesAgent AI user requested logout');
      } catch (error) {
        logger.warn('WhatsApp remote logout failed; clearing local credentials', {
          orgId,
          reason: safeConnectionError(error),
        });
        try {
          await socket.end(undefined);
        } catch {
          // The transport may already be closed.
        }
      }
    }

    await this.removeAuthDirectory(orgId);
    session.snapshot = { status: 'disconnected' };
    session.reconnectAttempts = 0;
    return this.cloneSnapshot(session.snapshot);
  }

  async reset(orgId: string): Promise<WhatsAppStatusSnapshot> {
    this.validateOrgId(orgId);
    const session = this.getOrCreateSession(orgId);
    await this.stopSocket(session);
    await this.removeAuthDirectory(orgId);
    session.snapshot = { status: 'disconnected' };
    session.reconnectAttempts = 0;
    return this.cloneSnapshot(session.snapshot);
  }

  async restorePersistedSessions(): Promise<void> {
    await this.ensureSecureDirectory(this.authRoot);
    const entries = await fs.readdir(this.authRoot, { withFileTypes: true });
    const orgIds = entries
      .filter(entry => entry.isDirectory() && ORG_ID_PATTERN.test(entry.name))
      .map(entry => entry.name);

    await Promise.all(orgIds.map(async orgId => {
      try {
        await this.connect(orgId);
      } catch (error) {
        logger.error('Failed to restore WhatsApp session', {
          orgId,
          reason: safeConnectionError(error),
        });
      }
    }));
  }

  async sendMessage(
    orgId: string,
    phone: string,
    text: string,
    replyJid: string,
    messageId?: string
  ): Promise<string> {
    this.validateOrgId(orgId);
    const normalizedText = text.trim();
    if (
      normalizedText.length === 0 ||
      normalizedText.length > this.options.outboundMaxChars
    ) {
      throw new InvalidWhatsAppInputError(
        `WhatsApp text must contain 1-${this.options.outboundMaxChars} characters`
      );
    }

    if (!normalizeOutboundPhone(phone)) {
      throw new InvalidWhatsAppInputError('Invalid WhatsApp phone number');
    }
    if (!isDirectWhatsAppJid(replyJid)) {
      throw new InvalidWhatsAppInputError(
        'A verified inbound WhatsApp reply JID is required'
      );
    }
    if (
      messageId !== undefined &&
      !/^[A-Za-z0-9_-]{8,128}$/.test(messageId)
    ) {
      throw new InvalidWhatsAppInputError('Invalid WhatsApp message id');
    }

    const session = this.getOrCreateSession(orgId);
    if (session.snapshot.status !== 'connected' || !session.socket) {
      throw new WhatsAppNotConnectedError(
        'WhatsApp is not connected for this organization'
      );
    }

    const sent = await session.socket.sendMessage(
      replyJid,
      { text: normalizedText },
      messageId ? { messageId } : undefined
    );
    logger.debug('WhatsApp message sent', {
      orgId,
      textLength: normalizedText.length,
    });
    return sent?.key.id ?? messageId ?? 'unknown';
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map(session => this.stopSocket(session)));
    this.scheduleInboundMessages();
    await this.waitForInboundIdle();
  }

  private async startSession(
    session: WhatsAppSession
  ): Promise<WhatsAppStatusSnapshot> {
    const generation = ++session.generation;
    this.clearReconnectTimer(session);
    session.snapshot = {
      ...session.snapshot,
      status: 'connecting',
      qrCode: undefined,
      error: undefined,
    };

    try {
      const authDirectory = this.authDirectory(session.orgId);
      await this.ensureSecureDirectory(authDirectory);
      const baileys = await (this.options.loadBaileys?.() ?? importBaileys());
      this.disconnectReason = baileys.DisconnectReason;
      const { state, saveCreds } = await baileys.useMultiFileAuthState(
        authDirectory
      );

      if (session.generation !== generation) {
        return this.cloneSnapshot(session.snapshot);
      }

      const makeWASocket = baileys.default ?? baileys.makeWASocket;
      const socket = makeWASocket({
        auth: state,
        browser: baileys.Browsers.ubuntu('SalesAgent AI'),
        logger: silentBaileysLogger,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
      });
      session.socket = socket;

      socket.ev.on('creds.update', () => {
        if (!this.isCurrent(session, socket, generation)) return;
        void saveCreds()
          .then(() => this.secureAuthFiles(authDirectory))
          .catch(error => {
            logger.error('Failed to persist WhatsApp credentials', {
              orgId: session.orgId,
              reason: safeConnectionError(error),
            });
          });
      });
      socket.ev.on('connection.update', update => {
        void this.handleConnectionUpdate(session, socket, generation, update)
          .catch(error => {
            logger.error('WhatsApp connection update failed', {
              orgId: session.orgId,
              reason: safeConnectionError(error),
            });
          });
      });
      socket.ev.on('messages.upsert', event => {
        if (!this.isCurrent(session, socket, generation)) return;
        this.handleMessageUpsert(session, socket, generation, event);
      });

      return this.cloneSnapshot(session.snapshot);
    } catch (error) {
      if (session.generation === generation) {
        session.socket = undefined;
        session.snapshot = {
          status: 'error',
          error: safeConnectionError(error),
        };
      }
      throw error;
    }
  }

  private async handleConnectionUpdate(
    session: WhatsAppSession,
    socket: WASocket,
    generation: number,
    update: BaileysEventMap['connection.update']
  ): Promise<void> {
    if (!this.isCurrent(session, socket, generation)) return;

    if (update.qr) {
      const qrCode = await QRCode.toDataURL(update.qr, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
      });
      if (!this.isCurrent(session, socket, generation)) return;
      session.snapshot = {
        ...session.snapshot,
        status: 'qr',
        qrCode,
        error: undefined,
      };
    }

    if (update.connection === 'connecting' && session.snapshot.status !== 'qr') {
      session.snapshot = {
        ...session.snapshot,
        status: 'connecting',
        error: undefined,
      };
    }

    if (update.connection === 'open') {
      const phone = socket.user?.id
        ? phoneFromWhatsAppJid(socket.user.id) ?? undefined
        : undefined;
      session.snapshot = {
        status: 'connected',
        phone,
        pushName: socket.user?.name || undefined,
        lastConnectedAt: new Date().toISOString(),
      };
      session.reconnectAttempts = 0;
      logger.info('WhatsApp bridge connected', { orgId: session.orgId });
      return;
    }

    if (update.connection !== 'close') return;

    session.socket = undefined;
    const statusCode = disconnectStatusCode(update.lastDisconnect?.error);
    if (statusCode === this.disconnectReason?.loggedOut) {
      await this.removeAuthDirectory(session.orgId);
      session.snapshot = { status: 'disconnected' };
      session.reconnectAttempts = 0;
      logger.info('WhatsApp device logged out', { orgId: session.orgId });
      return;
    }

    const invalidSession =
      statusCode === this.disconnectReason?.badSession ||
      statusCode === this.disconnectReason?.multideviceMismatch;
    const nonRetryable =
      invalidSession ||
      statusCode === this.disconnectReason?.forbidden ||
      statusCode === this.disconnectReason?.connectionReplaced;
    if (nonRetryable) {
      if (invalidSession) await this.removeAuthDirectory(session.orgId);
      session.snapshot = {
        status: 'error',
        error: statusCode
          ? `WhatsApp connection requires manual recovery (code ${statusCode})`
          : 'WhatsApp connection requires manual recovery',
      };
      session.reconnectAttempts = 0;
      logger.warn('WhatsApp connection stopped after non-retryable error', {
        orgId: session.orgId,
        statusCode,
      });
      return;
    }

    session.snapshot = {
      ...withoutQr(session.snapshot),
      status: 'connecting',
      error: statusCode
        ? `WhatsApp connection closed (code ${statusCode}); reconnecting`
        : 'WhatsApp connection closed; reconnecting',
    };
    this.scheduleReconnect(session);
  }

  private handleMessageUpsert(
    session: WhatsAppSession,
    socket: WASocket,
    generation: number,
    event: BaileysEventMap['messages.upsert']
  ): void {
    if (event.type !== 'notify') return;

    for (const message of event.messages) {
      if (!this.isCurrent(session, socket, generation)) return;
      this.admitInboundMessage(session, socket, message);
    }
  }

  private admitInboundMessage(
    session: WhatsAppSession,
    socket: WASocket,
    rawMessage: WAMessage
  ): void {
    const candidate = prepareInboundCandidate(
      rawMessage,
      this.options.inboundMaxChars
    );
    if (!candidate) return;

    const command = classifyWhatsAppControlCommand(candidate.text);
    const lane: InboundLane = command
      ? 'control'
      : 'normal';
    const task: QueuedInboundMessage = {
      lane,
      command,
      contactKey: candidate.contactKey,
      sequence: this.nextInboundSequence++,
      socket,
      rawMessage: candidate.parsedMessage ? undefined : candidate.message,
      message: candidate.parsedMessage,
      parsing: false,
      cancelled: false,
    };

    // A newer STOP supersedes control commands that have not reached the
    // policy handler for the same contact. This both preserves the restrictive
    // intent and guarantees that a stale START cannot consume its queue slot.
    if (command === 'stop') {
      this.removeSupersededControlMessages(session, task.contactKey);
    }

    if (!this.makeQueueRoom(session, task)) {
      logger.warn('WhatsApp inbound admission rejected', {
        orgId: session.orgId,
        lane,
        reason: 'queue_limit',
      });
      return;
    }

    const queue = lane === 'control'
      ? session.pendingControlMessages
      : session.pendingNormalMessages;
    queue.push(task);
    this.globalQueuedMessages += 1;
    this.scheduleInboundMessages();
  }

  private makeQueueRoom(
    session: WhatsAppSession,
    task: QueuedInboundMessage
  ): boolean {
    while (this.sessionQueuedMessages(session) >= this.inboundTenantQueueLimit) {
      if (task.lane !== 'control') return false;
      if (this.evictQueuedNormalMessage(session)) continue;
      if (
        task.command !== 'stop' ||
        !this.evictQueuedControlMessageForStop([session])
      ) {
        return false;
      }
    }

    // Consent and handoff commands must not be rejected merely because normal
    // model work filled the waiting queue. A STOP may additionally replace the
    // oldest queued control command, including across tenants, so the newest
    // explicit opt-out is never the command rejected at the global boundary.
    while (this.globalQueuedMessages >= this.inboundGlobalQueueLimit) {
      if (task.lane !== 'control') return false;
      const sessions = [...this.sessions.values()];
      const evictedNormal = sessions.some(candidate =>
        this.evictQueuedNormalMessage(candidate)
      );
      if (evictedNormal) continue;
      if (
        task.command !== 'stop' ||
        !this.evictQueuedControlMessageForStop(sessions)
      ) {
        return false;
      }
    }

    return true;
  }

  private evictQueuedNormalMessage(session: WhatsAppSession): boolean {
    const evicted = session.pendingNormalMessages.at(-1);
    if (!evicted) return false;
    this.removeQueuedMessage(session, evicted);
    logger.warn('WhatsApp queued model turn evicted for control command', {
      orgId: session.orgId,
      reason: 'control_priority',
    });
    return true;
  }

  private removeSupersededControlMessages(
    session: WhatsAppSession,
    contactKey: string
  ): void {
    const superseded = session.pendingControlMessages.filter(
      task => task.contactKey === contactKey
    );
    for (const task of superseded) {
      this.removeQueuedMessage(session, task);
    }
    if (superseded.length > 0) {
      logger.warn('WhatsApp queued control command superseded by STOP', {
        orgId: session.orgId,
        count: superseded.length,
        reason: 'newer_stop',
      });
    }
  }

  private evictQueuedControlMessageForStop(
    sessions: readonly WhatsAppSession[]
  ): boolean {
    const controls = sessions.flatMap(session =>
      session.pendingControlMessages.map(task => ({ session, task }))
    );
    const victim = controls
      .filter(({ task }) => task.command !== 'stop')
      .sort((left, right) => left.task.sequence - right.task.sequence)[0] ??
      controls.sort(
        (left, right) => left.task.sequence - right.task.sequence
      )[0];
    if (!victim) return false;

    this.removeQueuedMessage(victim.session, victim.task);
    logger.warn('WhatsApp queued control command evicted for newer STOP', {
      orgId: victim.session.orgId,
      reason: 'newer_stop_priority',
    });
    return true;
  }

  private removeQueuedMessage(
    session: WhatsAppSession,
    task: QueuedInboundMessage
  ): boolean {
    const queue = task.lane === 'control'
      ? session.pendingControlMessages
      : session.pendingNormalMessages;
    const index = queue.indexOf(task);
    if (index < 0) return false;
    queue.splice(index, 1);
    task.cancelled = true;
    this.globalQueuedMessages -= 1;
    return true;
  }

  private scheduleInboundMessages(): void {
    let started = true;
    while (started) {
      started = false;

      const control = this.takeNextInboundMessage('control');
      if (control) {
        this.startInboundMessage(control.session, control.task);
        started = true;
        continue;
      }

      const controlParse = this.takeNextInboundParse('control');
      if (controlParse) {
        this.startInboundParse(controlParse.session, controlParse.task);
        started = true;
        continue;
      }

      const normal = this.takeNextInboundMessage('normal');
      if (normal) {
        this.startInboundMessage(normal.session, normal.task);
        started = true;
        continue;
      }

      const normalParse = this.takeNextInboundParse('normal');
      if (normalParse) {
        this.startInboundParse(normalParse.session, normalParse.task);
        started = true;
      }
    }
    this.resolveInboundIdleWaiters();
  }

  private takeNextInboundMessage(
    lane: InboundLane
  ): { session: WhatsAppSession; task: ReadyInboundMessage } | undefined {
    const priorities = lane === 'control' ? [true, false] : [false];
    for (const stopOnly of priorities) {
      for (const session of this.sessions.values()) {
        const queue = lane === 'control'
          ? session.pendingControlMessages
          : session.pendingNormalMessages;
        const index = queue.findIndex(task =>
          isReadyInboundMessage(task) &&
          (!stopOnly || task.command === 'stop') &&
          (stopOnly || task.command !== 'stop') &&
          this.canStartInboundMessage(session, task)
        );
        if (index < 0) continue;
        const [task] = queue.splice(index, 1);
        this.globalQueuedMessages -= 1;
        return { session, task: task! as ReadyInboundMessage };
      }
    }
    return undefined;
  }

  private takeNextInboundParse(
    lane: InboundLane
  ): { session: WhatsAppSession; task: QueuedInboundMessage } | undefined {
    const priorities = lane === 'control' ? [true, false] : [false];
    for (const stopOnly of priorities) {
      for (const session of this.sessions.values()) {
        const queue = lane === 'control'
          ? session.pendingControlMessages
          : session.pendingNormalMessages;
        const task = queue.find(candidate =>
          !candidate.cancelled &&
          !candidate.parsing &&
          !candidate.message &&
          (!stopOnly || candidate.command === 'stop') &&
          (stopOnly || candidate.command !== 'stop') &&
          this.canStartInboundParse(session, candidate)
        );
        if (task) return { session, task };
      }
    }
    return undefined;
  }

  private canStartInboundParse(
    session: WhatsAppSession,
    task: QueuedInboundMessage
  ): boolean {
    if (
      this.globalInboundParsing >= this.inboundGlobalConcurrency ||
      session.inboundParsing >= this.inboundTenantConcurrency
    ) {
      return false;
    }
    if (task.lane === 'control') return true;

    return (
      this.globalNormalParsing < this.inboundGlobalConcurrency - 1 &&
      session.normalParsing < this.inboundTenantConcurrency - 1
    );
  }

  private canStartInboundMessage(
    session: WhatsAppSession,
    task: ReadyInboundMessage
  ): boolean {
    if (
      this.globalInboundInFlight >= this.inboundGlobalConcurrency ||
      session.inboundInFlight >= this.inboundTenantConcurrency
    ) {
      return false;
    }

    if (task.lane === 'control') {
      return (
        !session.activeControlContacts.has(task.contactKey) &&
        !this.hasEarlierPendingMessage(
          session.pendingControlMessages,
          task
        )
      );
    }

    const globalNormalLimit = this.inboundGlobalConcurrency - 1;
    const tenantNormalLimit = this.inboundTenantConcurrency - 1;
    return (
      this.globalNormalInFlight < globalNormalLimit &&
      session.normalInFlight < tenantNormalLimit &&
      !session.activeNormalContacts.has(task.contactKey) &&
      !session.activeControlContacts.has(task.contactKey) &&
      !session.pendingControlMessages.some(
        pending => pending.contactKey === task.contactKey
      ) &&
      !this.hasEarlierPendingMessage(session.pendingNormalMessages, task)
    );
  }

  private hasEarlierPendingMessage(
    queue: readonly QueuedInboundMessage[],
    task: QueuedInboundMessage
  ): boolean {
    const taskIndex = queue.indexOf(task);
    const end = taskIndex >= 0 ? taskIndex : queue.length;
    return queue
      .slice(0, end)
      .some(pending => pending.contactKey === task.contactKey);
  }

  private startInboundMessage(
    session: WhatsAppSession,
    task: ReadyInboundMessage
  ): void {
    this.globalInboundInFlight += 1;
    session.inboundInFlight += 1;
    const activeContacts = task.lane === 'control'
      ? session.activeControlContacts
      : session.activeNormalContacts;
    activeContacts.add(task.contactKey);
    if (task.lane === 'normal') {
      this.globalNormalInFlight += 1;
      session.normalInFlight += 1;
    }

    void Promise.resolve()
      .then(() => this.options.onIncomingMessage(session.orgId, task.message))
      .catch(error => {
        logger.error('WhatsApp contact queue failed', {
          orgId: session.orgId,
          lane: task.lane,
          reason: safeConnectionError(error),
        });
      })
      .finally(() => {
        this.globalInboundInFlight -= 1;
        session.inboundInFlight -= 1;
        activeContacts.delete(task.contactKey);
        if (task.lane === 'normal') {
          this.globalNormalInFlight -= 1;
          session.normalInFlight -= 1;
        }
        this.scheduleInboundMessages();
      });
  }

  private startInboundParse(
    session: WhatsAppSession,
    task: QueuedInboundMessage
  ): void {
    const rawMessage = task.rawMessage;
    if (!rawMessage) return;

    task.parsing = true;
    this.globalInboundParsing += 1;
    session.inboundParsing += 1;
    if (task.lane === 'normal') {
      this.globalNormalParsing += 1;
      session.normalParsing += 1;
    }

    void parseInboundWhatsAppMessage(
      rawMessage,
      this.options.inboundMaxChars,
      lid => this.lookupPhoneForLid(task.socket, lid)
    )
      .then(parsed => {
        if (task.cancelled) return;
        if (!parsed) {
          this.removeQueuedMessage(session, task);
          return;
        }
        task.message = parsed;
        task.rawMessage = undefined;
      })
      .catch(error => {
        if (!task.cancelled) {
          this.removeQueuedMessage(session, task);
          logger.error('WhatsApp inbound parsing failed', {
            orgId: session.orgId,
            reason: safeConnectionError(error),
          });
        }
      })
      .finally(() => {
        task.parsing = false;
        this.globalInboundParsing -= 1;
        session.inboundParsing -= 1;
        if (task.lane === 'normal') {
          this.globalNormalParsing -= 1;
          session.normalParsing -= 1;
        }
        this.scheduleInboundMessages();
      });
  }

  private async lookupPhoneForLid(
    socket: WASocket,
    lid: string
  ): Promise<string | null> {
    let timeout: NodeJS.Timeout | undefined;
    const lookup = Promise.resolve()
      .then(() => socket.signalRepository.lidMapping.getPNForLID(lid))
      .catch(() => null);
    const fallback = new Promise<null>(resolve => {
      timeout = setTimeout(resolve, this.inboundLidLookupTimeoutMs, null);
    });
    try {
      return await Promise.race([lookup, fallback]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private sessionQueuedMessages(session: WhatsAppSession): number {
    return (
      session.pendingControlMessages.length +
      session.pendingNormalMessages.length
    );
  }

  private waitForInboundIdle(): Promise<void> {
    if (
      this.globalInboundInFlight === 0 &&
      this.globalInboundParsing === 0 &&
      this.globalQueuedMessages === 0
    ) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.inboundIdleWaiters.add(resolve));
  }

  private resolveInboundIdleWaiters(): void {
    if (
      this.globalInboundInFlight !== 0 ||
      this.globalInboundParsing !== 0 ||
      this.globalQueuedMessages !== 0
    ) {
      return;
    }
    for (const resolve of this.inboundIdleWaiters) resolve();
    this.inboundIdleWaiters.clear();
  }

  private scheduleReconnect(session: WhatsAppSession): void {
    if (session.reconnectTimer) return;
    const exponent = Math.min(session.reconnectAttempts, 10);
    const delay = Math.min(
      this.options.reconnectBaseDelayMs * 2 ** exponent,
      this.options.reconnectMaxDelayMs
    );
    session.reconnectAttempts += 1;
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = undefined;
      void this.connect(session.orgId).catch(error => {
        session.snapshot = {
          status: 'error',
          error: safeConnectionError(error),
        };
        this.scheduleReconnect(session);
      });
    }, delay);
    session.reconnectTimer.unref();
  }

  private async stopSocket(session: WhatsAppSession): Promise<void> {
    const socket = this.detachSocket(session);
    if (socket) {
      try {
        await socket.end(undefined);
      } catch {
        // The transport may already be closed.
      }
    }
    session.snapshot = {
      ...withoutQr(session.snapshot),
      status: 'disconnected',
      error: undefined,
    };
  }

  private detachSocket(session: WhatsAppSession): WASocket | undefined {
    this.clearReconnectTimer(session);
    session.generation += 1;
    const socket = session.socket;
    session.socket = undefined;
    session.connectPromise = undefined;
    return socket;
  }

  private clearReconnectTimer(session: WhatsAppSession): void {
    if (!session.reconnectTimer) return;
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = undefined;
  }

  private isCurrent(
    session: WhatsAppSession,
    socket: WASocket,
    generation: number
  ): boolean {
    return session.generation === generation && session.socket === socket;
  }

  private getOrCreateSession(orgId: string): WhatsAppSession {
    const existing = this.sessions.get(orgId);
    if (existing) return existing;

    const session: WhatsAppSession = {
      orgId,
      generation: 0,
      reconnectAttempts: 0,
      snapshot: { status: 'disconnected' },
      pendingControlMessages: [],
      pendingNormalMessages: [],
      activeControlContacts: new Set(),
      activeNormalContacts: new Set(),
      inboundParsing: 0,
      normalParsing: 0,
      inboundInFlight: 0,
      normalInFlight: 0,
    };
    this.sessions.set(orgId, session);
    return session;
  }

  private validateOrgId(orgId: string): void {
    if (!ORG_ID_PATTERN.test(orgId)) {
      throw new InvalidWhatsAppInputError('Invalid organization id');
    }
  }

  private authDirectory(orgId: string): string {
    this.validateOrgId(orgId);
    const directory = path.resolve(this.authRoot, orgId);
    if (!directory.startsWith(`${this.authRoot}${path.sep}`)) {
      throw new InvalidWhatsAppInputError('Invalid WhatsApp auth directory');
    }
    return directory;
  }

  private async ensureSecureDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
  }

  private async secureAuthFiles(directory: string): Promise<void> {
    await this.ensureSecureDirectory(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async entry => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await fs.chmod(target, 0o700);
      } else if (entry.isFile()) {
        await fs.chmod(target, 0o600);
      }
    }));
  }

  private async removeAuthDirectory(orgId: string): Promise<void> {
    const directory = this.authDirectory(orgId);
    await fs.rm(directory, { recursive: true, force: true });
  }

  private cloneSnapshot(snapshot: WhatsAppStatusSnapshot): WhatsAppStatusSnapshot {
    return { ...snapshot };
  }
}

function withoutQr(snapshot: WhatsAppStatusSnapshot): WhatsAppStatusSnapshot {
  const result = { ...snapshot };
  delete result.qrCode;
  return result;
}

function prepareInboundCandidate(
  message: WAMessage,
  maxChars: number
): Readonly<{
  text: string;
  contactKey: string;
  message: WAMessage;
  parsedMessage?: ParsedWhatsAppMessage;
}> | null {
  if (message.key.fromMe) return null;

  const replyJid = message.key.remoteJid ?? '';
  if (!isDirectWhatsAppJid(replyJid)) return null;

  const messageId = message.key.id ?? '';
  if (messageId.length === 0 || messageId.length > 255) return null;

  const text = extractWhatsAppText(message);
  if (!text || text.length > maxChars) return null;

  const altJid = message.key.remoteJidAlt;
  const identityJid = altJid && altJid.endsWith('@s.whatsapp.net')
    ? altJid
    : replyJid;
  const pushName = typeof message.pushName === 'string'
    ? message.pushName
    : undefined;
  const compactMessage = {
    key: {
      id: messageId,
      fromMe: false,
      remoteJid: replyJid,
      remoteJidAlt: altJid,
    },
    message: { conversation: text },
    pushName,
  } as WAMessage;
  const requiresLidLookup = replyJid.endsWith('@lid') &&
    !(altJid && altJid.endsWith('@s.whatsapp.net'));
  const phone = requiresLidLookup
    ? null
    : phoneFromWhatsAppJid(identityJid);
  if (!requiresLidLookup && !phone) return null;
  return {
    text,
    contactKey: identityJid.toLocaleLowerCase('en-US'),
    message: compactMessage,
    parsedMessage: phone
      ? {
          messageId,
          phone,
          replyJid,
          text,
          pushName: pushName?.trim() || undefined,
        }
      : undefined,
  };
}

function isReadyInboundMessage(
  task: QueuedInboundMessage
): task is ReadyInboundMessage {
  return Boolean(task.message);
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum = 1
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum) {
    throw new InvalidWhatsAppInputError(
      `${name} must be an integer greater than or equal to ${minimum}`
    );
  }
  return resolved;
}

function disconnectStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const output = (error as { output?: { statusCode?: unknown } }).output;
  return typeof output?.statusCode === 'number' ? output.statusCode : undefined;
}

function safeConnectionError(error: unknown): string {
  const statusCode = disconnectStatusCode(error);
  if (statusCode) return `WhatsApp connection error (code ${statusCode})`;
  if (error instanceof InvalidWhatsAppInputError) return error.message;
  if (error instanceof WhatsAppNotConnectedError) return error.message;
  return 'WhatsApp bridge operation failed';
}
