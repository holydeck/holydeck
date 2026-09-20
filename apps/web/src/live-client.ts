// The live session a browser context actually holds (LIVE-15). This is the first client in this
// repository to open the socket `apps/app/src/live.ts` serves and to speak `@holydeck/contracts/live`'s
// frames over it: everything before it built either the server half of the protocol or a surface with
// nothing yet connected to it, and every surface after it — Stage look-ahead, Singer browsing, mid-service
// additions, run review — reads the live state through one of these rather than opening a socket of its own.
//
// What "multi-context coordination" means here is the whole shape of this module, so it is worth being
// plain about. A device runs several browser contexts at once: the operator's tab, and the separate
// Audience, Stage and Singer windows `output-launch.ts` opens. Each of them holds its own session against
// the hub, and they coordinate *through the server*, by the two version numbers every frame carries — the
// state revision a command is issued against, and the sequence a resume is measured from. They do not
// coordinate with each other. There is deliberately no BroadcastChannel, no SharedWorker, no leader
// election and no module-level state shared between clients: the moment two contexts on one device agreed
// something between themselves, that agreement would be a second source of truth, and a service would have
// two answers to "what is showing" with no way to tell which one the room is looking at.
//
// So the rules this module keeps are narrow and all point the same way:
//
//   * The server is authoritative, always. A snapshot is adopted exactly as it arrives, including when it
//     moves this context *backwards* — a hub that restarted, or a resume reaching further back than the
//     backlog still holds, answers with where the server stands, and where the server stands is where this
//     context now is, whatever it believed a moment ago.
//   * A context that drops reconnects and resumes from the last sequence it actually saw, so it is caught
//     up with exactly what it missed rather than guessing or reloading.
//   * Nothing one context does reaches another. Closing one closes one.
//
// Two details of the hub (`apps/app/src/live-protocol.ts`) are load-bearing here and easy to miss:
//
//   * `join()` writes a snapshot immediately, before it has read anything this client sent. A resuming
//     client therefore receives that join snapshot *first*, and the answer to its own resume second. The
//     first is skipped rather than adopted — see `skipSnapshots` below — because adopting it would walk
//     this context forward to the server's standing and then back through a replay it no longer needs.
//   * The hub beats every session and drops one that leaves three beats unanswered. A context that only
//     watches — an output window that never commands anything — still has to answer, or it is closed as
//     lapsed a quarter of a minute into a service. Answering a heartbeat with a heartbeat is the whole of
//     that, and it is done here rather than left to a caller to remember.
//
// Every browser API is injected as a narrow interface, the way `output-launch.ts` injects `WindowOpenerLike`
// and `local-output.ts` its fullscreen and wake-lock ones: a real socket is never opened in a test, and the
// failures this module exists to survive — an absent WebSocket, a refused handshake, a connection that dies
// mid-service — are exactly the ones a real browser will not reproduce on demand.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import {
  CAPABILITY_QUERY,
  CHANNEL_QUERY,
  CLIENT_VERSION_QUERY,
  LIVE_CLOSE,
  LIVE_PATH,
  SERVICE_QUERY,
  parseCommandFrame,
  parseFrame,
} from '@holydeck/contracts/live';
import { TICKET_QUERY } from '@holydeck/contracts/sessions';

import type {
  AckFrame,
  CommandFrame,
  EventFrame,
  LiveChannel,
  LiveFrame,
  LiveSessionState,
  SnapshotFrame,
} from '@holydeck/contracts/live';

// ---------------------------------------------------------------------------------------------------
// The socket, as little of it as this module needs
// ---------------------------------------------------------------------------------------------------

/** The fields this client reads off a socket event, across all four kinds it listens for. */
export interface SocketEventLike {
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
}

/**
 * A browser WebSocket reduced to the four things a live session needs of it: say something, end the
 * session, say whether it is open enough to be written to, and report what happens to it.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: SocketEventLike) => void): void;
}

/** How a socket is made. Injected, so nothing here ever reaches for a global. */
export type WebSocketOpener = (url: string) => WebSocketLike;

/** The one member of the global this module feature-detects before assuming anything of it. */
export interface LiveSocketGlobalLike {
  readonly WebSocket?: new (url: string) => WebSocketLike;
}

/** `WebSocket.OPEN`, named rather than assumed to be readable from a constructor this module never holds. */
const SOCKET_OPEN = 1;

/** A normal closure. Nothing failed, and nothing is reconnected over it. */
const NORMAL_CLOSE = 1000;

/**
 * Feature-detects the WebSocket API before ever calling it, the way `detectScreens` does the Window
 * Management one. `undefined` is not an error to throw at a caller mid-service: it is the fact that this
 * browser cannot hold a live session at all, which `createLiveClient` turns into a visible, terminal
 * failure rather than a socket that silently never opens.
 */
export function detectLiveSocket(global: LiveSocketGlobalLike): WebSocketOpener | undefined {
  const Constructor = global.WebSocket;
  if (typeof Constructor !== 'function') return undefined;
  return (url: string): WebSocketLike => new Constructor(url);
}

// ---------------------------------------------------------------------------------------------------
// What a session is opened with, and where
// ---------------------------------------------------------------------------------------------------

/**
 * What proves this context may open a socket: the ticket a signed-in session spent, or the capability a
 * shared join link carries with the service it opens (T81). Either is good for exactly one socket, which
 * is why a client is handed a way to obtain them rather than the values themselves — a reconnect three
 * hours into a service needs a ticket minted then, not the one this page loaded with.
 */
export type LiveCredentials =
  | { readonly kind: 'ticket'; readonly ticket: string }
  | { readonly kind: 'capability'; readonly capability: string; readonly service: string };

/**
 * Where this context's socket is opened. The page's own origin, with the scheme it is actually served
 * over: a page on `https:` opens `wss:`, and a page on `http:` opens `ws:`. Getting that wrong is not a
 * fallback a browser makes for anybody — it is a mixed-content refusal in the middle of a service.
 */
export function liveSocketUrl(
  pageOrigin: string,
  channel: LiveChannel,
  credentials: LiveCredentials,
  clientVersion: number = CLIENT_WINDOW.current,
): string {
  const url = new URL(LIVE_PATH, pageOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set(CHANNEL_QUERY, channel);
  url.searchParams.set(CLIENT_VERSION_QUERY, String(clientVersion));
  if (credentials.kind === 'ticket') {
    url.searchParams.set(TICKET_QUERY, credentials.ticket);
  } else {
    url.searchParams.set(CAPABILITY_QUERY, credentials.capability);
    url.searchParams.set(SERVICE_QUERY, credentials.service);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------------------------------
// What a caller is told
// ---------------------------------------------------------------------------------------------------

export const LIVE_FAILURES = ['unsupported', 'unauthorized', 'open-failed', 'closed', 'unreadable-frame'] as const;
export type LiveFailureReason = (typeof LIVE_FAILURES)[number];

/**
 * Why a session is not doing what it should be. Nothing here is ever swallowed: a caller renders these,
 * and `recoverable` is the difference between "this is coming back on its own" and "somebody has to do
 * something" — an absent WebSocket and a refused handshake are not waited out, they are shown.
 */
export interface LiveFailure {
  readonly reason: LiveFailureReason;
  /**
   * Diagnostic, never display copy. It is English, unlocalized, and sometimes a close reason written by
   * the server verbatim — a surface tells a person what has happened from `reason` and `recoverable`,
   * in its own localized words, and keeps this for a log or a details line.
   */
  readonly message: string;
  /** The close code, where a closed connection is what went wrong. */
  readonly code?: number;
  readonly recoverable: boolean;
}

/**
 * Where this context stands: the session state in the contract's own vocabulary, the two version numbers
 * it is holding, and whatever is currently wrong with it.
 */
export interface LiveStatus {
  readonly state: LiveSessionState;
  /** What a command is issued against. */
  readonly stateRevision: number;
  /** What a resume is measured from. */
  readonly sequence: number;
  readonly failure?: LiveFailure;
}

/** A snapshot, and whether taking it moved this context somewhere other than where it believed it was. */
export interface LiveSnapshot {
  readonly frame: SnapshotFrame;
  /**
   * True when the server answered with its own standing rather than the replay this context asked for —
   * the divergence correction. Anything a surface rendered from local state is stale and is re-read.
   */
  readonly resynchronised: boolean;
}

// ---------------------------------------------------------------------------------------------------
// Reconnecting
// ---------------------------------------------------------------------------------------------------

/** How a reconnect is put off. Injected for the same reason a clock is: a test does not wait out a run. */
export type RetrySchedule = (attempt: number, run: () => void) => void;

export const RETRY_BASE_MS = 500;
export const RETRY_CEILING_MS = 10_000;

/**
 * How long before the next attempt. Doubling, so a server that is down is not hammered by every context
 * on every device in the building; capped, so a service that comes back after a long outage is rejoined
 * within seconds rather than whenever an unbounded backoff happened to land.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

const afterDelay: RetrySchedule = (attempt, run) => {
  setTimeout(run, retryDelayMs(attempt));
};

/** Close codes no reconnect can fix: the two the hub refuses with, and an ordinary closure. */
const FINAL_CLOSE: ReadonlySet<number> = new Set([NORMAL_CLOSE, LIVE_CLOSE.unreadable, LIVE_CLOSE.refused]);

// ---------------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------------

export interface LiveClientOptions {
  /** Which channel this context watches. One per client; a context wanting two holds two clients. */
  readonly channel: LiveChannel;
  /** The origin the page was served from — `https://…` or `http://…`, not `ws…`. */
  readonly origin: string;
  /** Obtains what this attempt proves itself with. Called once per connection attempt, never cached. */
  readonly credentials: () => Promise<LiveCredentials | undefined>;
  /** `detectLiveSocket(globalThis)`. `undefined` where this browser has no WebSocket at all. */
  readonly open: WebSocketOpener | undefined;
  /** Explicit, so a frame's time is this context's time and a test does not read a real clock. */
  readonly clock?: () => string;
  /** Command identifiers, unique within this session. Defaults to a counter, which is enough: the hub
   *  matches an acknowledgement to a command per connection, not across a deployment. */
  readonly ids?: () => string;
  readonly clientVersion?: number;
  readonly retry?: RetrySchedule;
}

export interface LiveClient {
  readonly channel: LiveChannel;
  readonly status: LiveStatus;
  /** Opens the session, or reports why it could not be opened. Never throws. Resolves once the attempt
   *  has been made — being *synchronised* is a status a caller watches for, not a promise, because a
   *  reconnect three hours later has no caller waiting on it. */
  connect(): Promise<LiveStatus>;
  /**
   * Issues one command against the revision this context is currently holding, and resolves with what
   * the server made of it — `applied`, `duplicate`, `stale` or `unauthorized`. `undefined` means the
   * command never went out at all, or the session ended before it was answered; either way nothing was
   * guessed on the caller's behalf. `idempotencyKey` is the caller's, and must survive a retry: it is
   * what stops a command re-sent across a reconnect from being run a second time.
   */
  command(type: string, idempotencyKey: string): Promise<AckFrame | undefined>;
  onStatus(listener: (status: LiveStatus) => void): () => void;
  onSnapshot(listener: (snapshot: LiveSnapshot) => void): () => void;
  onEvent(listener: (event: EventFrame) => void): () => void;
  /** Ends this context's session deliberately: nothing is reconnected, and no other context is touched. */
  close(): void;
}

export function createLiveClient(options: LiveClientOptions): LiveClient {
  const { channel } = options;
  const clock = options.clock ?? ((): string => new Date().toISOString());
  const clientVersion = options.clientVersion ?? CLIENT_WINDOW.current;
  const retry = options.retry ?? afterDelay;
  let issued = 0;
  const ids = options.ids ?? ((): string => `command-${(issued += 1)}`);

  const statusListeners = new Set<(status: LiveStatus) => void>();
  const snapshotListeners = new Set<(snapshot: LiveSnapshot) => void>();
  const eventListeners = new Set<(event: EventFrame) => void>();
  /** Commands sent and not yet answered, by the identifier the acknowledgement will name them by. */
  const awaiting = new Map<string, (ack: AckFrame | undefined) => void>();

  let socket: WebSocketLike | undefined;
  /**
   * Which connection attempt this context is on. Every socket's listeners carry the generation they were
   * opened in, every armed reconnect carries the one that armed it, and a deliberate close moves it on.
   * A browser fires a close event *asynchronously*, sometimes after this context has already replaced or
   * abandoned the socket that fired it — and news from a generation that is no longer the live one is
   * not this context's news. Without this, a socket closed a moment ago can announce a dropped session
   * over a healthy one, or null out the connection that replaced it and leave a window silently holding
   * a socket nothing is written on.
   */
  let generation = 0;
  /** The generation part-way through opening, or 0 when none is. */
  let opening = 0;
  let state: LiveSessionState = 'closed';
  let failure: LiveFailure | undefined;
  let stateRevision = 0;
  let sequence = 0;
  /** Whether this context has ever been told where the server stands. What makes the next connection a
   *  resume rather than a first join. */
  let seen = false;
  /** How many snapshots to let past unadopted — one, on a resuming connection, for the snapshot the hub
   *  writes on join before it has read the resume this client sends. */
  let skipSnapshots = 0;
  let attempt = 0;
  let errored = false;

  const statusNow = (): LiveStatus =>
    Object.freeze({ state, stateRevision, sequence, ...(failure === undefined ? {} : { failure }) });

  // Copied before it is walked: a listener is free to unsubscribe itself, and a set being written to
  // while it is read is how a surface stops being told what the service is doing.
  const announce = (): void => {
    const current = statusNow();
    for (const listener of [...statusListeners]) listener(current);
  };

  const moveTo = (next: LiveSessionState, cause?: LiveFailure): void => {
    state = next;
    failure = cause;
    announce();
  };

  /** Where the server says this context is. Adopted exactly, including downwards. */
  const adopt = (at: { readonly stateRevision: number; readonly sequence: number }): void => {
    stateRevision = at.stateRevision;
    sequence = at.sequence;
    seen = true;
    attempt = 0;
  };

  const sendFrame = (frame: LiveFrame): boolean => {
    if (socket === undefined || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      // The connection is gone and said so by failing, which is what a network loss looks like from
      // here. The close event that follows is what reconnects it; there is nothing to do with it now.
      return false;
    }
  };

  /** Something arrived that this context cannot act on. Reported, never acted on, and never a reason to
   *  tear down a session a room is watching — the next readable frame clears it. */
  const unreadable = (message: string): void => {
    moveTo(state, { reason: 'unreadable-frame', message, recoverable: true });
  };

  const takeSnapshot = (frame: SnapshotFrame): void => {
    if (skipSnapshots > 0) {
      skipSnapshots -= 1;
      return;
    }
    const resynchronised = seen && (frame.sequence !== sequence || frame.stateRevision !== stateRevision);
    adopt(frame);
    moveTo('synchronised');
    const snapshot: LiveSnapshot = Object.freeze({ frame, resynchronised });
    for (const listener of [...snapshotListeners]) listener(snapshot);
  };

  const takeEvent = (frame: EventFrame): void => {
    adopt(frame);
    moveTo('synchronised');
    for (const listener of [...eventListeners]) listener(frame);
  };

  const takeAck = (frame: AckFrame): void => {
    // Forward only, unlike a snapshot. A `duplicate` acknowledgement names where that command landed
    // when it first ran, which is usually well behind where the server now stands; adopting it would
    // walk this context backwards and make the next resume ask for a replay of what it already has.
    if (frame.sequence >= sequence) {
      adopt(frame);
      moveTo('synchronised');
    }
    const settle = awaiting.get(frame.id);
    if (settle === undefined) return;
    awaiting.delete(frame.id);
    settle(frame);
  };

  const receive = (raw: unknown): void => {
    let sent: unknown;
    try {
      sent = JSON.parse(String(raw));
    } catch {
      unreadable('frame: must be JSON');
      return;
    }
    const parsed = parseFrame(sent);
    if (!parsed.ok) {
      unreadable(parsed.problems.map(({ path, message }) => `${path}: ${message}`).join('; '));
      return;
    }
    const frame = parsed.value;
    if (frame.channel !== channel) {
      unreadable(`${frame.kind}.channel: this context is connected to ${channel}`);
      return;
    }
    if (frame.kind === 'heartbeat') {
      // Answered immediately rather than on a timer of this module's own. A context that only watches
      // sends nothing else at all, and the hub drops a session that leaves three beats unanswered.
      sendFrame({ kind: 'heartbeat', channel, at: clock() });
      return;
    }
    if (frame.kind === 'snapshot') {
      takeSnapshot(frame);
      return;
    }
    if (frame.kind === 'event') {
      takeEvent(frame);
      return;
    }
    if (frame.kind === 'ack') {
      takeAck(frame);
      return;
    }
    // A command or a resume arriving from the server is not a frame to forgive quietly: it means the
    // two ends disagree about which of them is the server.
    unreadable(`${frame.kind}: a server does not send this frame`);
  };

  /** Nothing sent is ever left hanging on a caller: a session that ended answers every command it was
   *  still holding, with the one honest answer available — it does not know. */
  const settleAwaiting = (): void => {
    for (const settle of [...awaiting.values()]) settle(undefined);
    awaiting.clear();
  };

  const scheduleRetry = (from: number): void => {
    attempt += 1;
    retry(attempt, () => {
      // Armed against one connection and fired later, by which time this context may have been closed
      // or reconnected by hand. A timer does not get to reopen a session somebody ended.
      if (from !== generation) return;
      void connect();
    });
  };

  const opened = (): void => {
    errored = false;
    if (!seen) return;
    // The hub has already written this connection its join snapshot by now; the answer to this resume
    // is the second one, and the first is skipped rather than adopted.
    skipSnapshots = 1;
    moveTo('resuming');
    if (!sendFrame({ kind: 'resume', channel, fromSequence: sequence })) skipSnapshots = 0;
  };

  const ended = (from: WebSocketLike, code: number, reason: string): void => {
    // Only the connection that actually ended is let go of: this is reached for the live generation, and
    // the socket it holds is the one that fired.
    if (socket === from) socket = undefined;
    settleAwaiting();
    const said = reason !== '' ? reason : errored ? 'the live connection failed' : 'the live session ended';
    const recoverable = !FINAL_CLOSE.has(code);
    const cause: LiveFailure = { reason: 'closed', message: said, code, recoverable };
    if (!recoverable) {
      moveTo('closed', cause);
      return;
    }
    moveTo('degraded', cause);
    scheduleRetry(generation);
  };

  const connect = async (): Promise<LiveStatus> => {
    if (socket !== undefined || (opening !== 0 && opening === generation)) return statusNow();
    const mine = (generation += 1);
    opening = mine;
    errored = false;
    try {
      if (options.open === undefined) {
        moveTo('closed', {
          reason: 'unsupported',
          message: 'this browser has no WebSocket, so it cannot hold a live session',
          recoverable: false,
        });
        return statusNow();
      }

      moveTo('authorizing');
      let credentials: LiveCredentials | undefined;
      try {
        credentials = await options.credentials();
      } catch {
        credentials = undefined;
      }
      // Proving a context takes a round trip, and a person can close the window in the middle of one.
      // A socket opened here would be one no caller believes exists: nothing reads it, nothing answers
      // its heartbeats, and it sits in the connection counts an operator reads until the hub drops it.
      if (mine !== generation) return statusNow();
      if (credentials === undefined) {
        // Not retried on a timer: a context that cannot prove itself will not start being able to on its
        // own, and a person signing in again is the way back.
        moveTo('closed', {
          reason: 'unauthorized',
          message: 'this context could not prove itself well enough to open a live session',
          recoverable: false,
        });
        return statusNow();
      }

      moveTo('connecting');
      let fresh: WebSocketLike;
      try {
        fresh = options.open(liveSocketUrl(options.origin, channel, credentials, clientVersion));
      } catch (error: unknown) {
        moveTo('degraded', {
          reason: 'open-failed',
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        });
        scheduleRetry(mine);
        return statusNow();
      }

      socket = fresh;
      // Every one of these speaks only for the connection it was registered on. A browser delivers a
      // close — and occasionally an error — after this context has moved on, and an event from a socket
      // that is no longer the live one is dropped rather than acted on.
      fresh.addEventListener('open', () => {
        if (mine === generation) opened();
      });
      fresh.addEventListener('message', (event) => {
        if (mine === generation) receive(event.data);
      });
      fresh.addEventListener('error', () => {
        // A browser says only that something failed, never what; the close that follows carries the code.
        if (mine === generation) errored = true;
      });
      fresh.addEventListener('close', (event) => {
        if (mine !== generation) return;
        ended(fresh, event.code ?? NORMAL_CLOSE, event.reason ?? '');
      });
      return statusNow();
    } finally {
      if (opening === mine) opening = 0;
    }
  };

  return Object.freeze({
    channel,

    get status() {
      return statusNow();
    },

    connect,

    async command(type: string, idempotencyKey: string): Promise<AckFrame | undefined> {
      const frame: CommandFrame = {
        kind: 'command',
        channel,
        id: ids(),
        idempotencyKey,
        type,
        clientStateRevision: stateRevision,
      };
      // Held to the same contract the hub reads it by, before it is sent. A frame the hub cannot parse
      // ends the session, and a service does not lose its socket over a command this context could have
      // seen was malformed.
      const readable = parseCommandFrame(frame);
      if (!readable.ok) {
        unreadable(readable.problems.map(({ path, message }) => `${path}: ${message}`).join('; '));
        return undefined;
      }
      return new Promise<AckFrame | undefined>((resolve) => {
        // Registered before the frame goes out rather than after it: an acknowledgement is not something
        // this module is allowed to be too late to hear, and a frame that never left is answered at once.
        awaiting.set(frame.id, resolve);
        if (!sendFrame(frame)) {
          awaiting.delete(frame.id);
          resolve(undefined);
        }
      });
    },

    onStatus(listener: (status: LiveStatus) => void): () => void {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },

    onSnapshot(listener: (snapshot: LiveSnapshot) => void): () => void {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },

    onEvent(listener: (event: EventFrame) => void): () => void {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    close(): void {
      // A hard stop, not a request. Moving the generation on is what makes it one: the close event this
      // is about to cause, a credentials promise still in flight, and any reconnect already on a timer
      // all find themselves speaking for a connection this context no longer has, and are ignored.
      generation += 1;
      attempt = 0;
      const held = socket;
      socket = undefined;
      settleAwaiting();
      if (held !== undefined) {
        try {
          held.close(NORMAL_CLOSE, 'this context left the session');
        } catch {
          // Already gone. There is nothing left to close, and nothing a caller would do about it.
        }
      }
      moveTo('closed');
    },
  });
}
