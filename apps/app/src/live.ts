// The live socket, at the smallest size a client can actually reach. The protocol itself — resume
// semantics, backpressure, per-channel authorization, command execution — is settled by the WebSocket
// contract and implemented by the task that owns it. What exists here is the endpoint an integration
// and end-to-end harness can connect to, the channel it is connected to, and refusals that name what
// this build will not do, so nothing later has to guess whether a frame was served or swallowed.

import { decideClient } from '@holydeck/contracts/clients';
import { LIVE_CHANNELS, type LiveChannel, type SnapshotFrame, parseFrame } from '@holydeck/contracts/live';
import websocket from '@fastify/websocket';

import type { FastifyInstance } from 'fastify';

export const LIVE_PATH = '/api/v1/live';

export const CHANNEL_QUERY = 'channel';

/**
 * A browser WebSocket cannot set a request header, so the version a client declares on an upgrade has
 * to travel in the query string. Only on an upgrade: an ordinary request keeps one way to state it.
 */
export const CLIENT_VERSION_QUERY = 'clientVersion';

/** 1003 is unsupported data and 1008 a policy refusal, which is the difference these two names carry. */
export const LIVE_CLOSE = { unreadable: 1003, refused: 1008 } as const;

export const NOT_IN_THIS_BUILD = 'this build serves snapshots and resumes only';

/** A close frame carries at most 123 bytes of reason, so a reason longer than that is cut, not dropped. */
export const MAX_CLOSE_REASON = 120;

/** Nothing here advances state, so every frame this build sends carries the revision a session opens at. */
export const OPENING_STATE_REVISION = 0;

// Only the query string is read from it, and a relative URL needs some origin to be read against.
const INTERNAL = 'http://application.invalid';

const queryOf = (url: string, name: string): string | undefined =>
  new URL(url, INTERNAL).searchParams.get(name) ?? undefined;

/** Whether the request is asking to stop being an HTTP request. */
export function isUpgrade(headers: Record<string, unknown>): boolean {
  return String(headers['upgrade'] ?? '').toLowerCase() === 'websocket';
}

/** The version a socket client declares, which for a socket is the only place it can declare it. */
export function declaredVersion(url: string): unknown {
  return queryOf(url, CLIENT_VERSION_QUERY);
}

const isChannel = (value: string | undefined): value is LiveChannel =>
  LIVE_CHANNELS.includes(value as LiveChannel);

export interface LiveOptions {
  /** Explicit, so a frame's time is the session's time and a test does not have to read a clock. */
  readonly clock?: () => string;
}

export async function serveLive(app: FastifyInstance, { clock = () => new Date().toISOString() }: LiveOptions = {}): Promise<void> {
  await app.register(websocket);

  app.get(LIVE_PATH, { websocket: true }, (socket, request) => {
    // Graded here rather than by the versioned-surface hook, for two reasons that point the same way: a
    // refused handshake tells a browser client nothing it can read, and an HTTP refusal written onto a
    // connection that asked to stop being HTTP is a socket both ends then wait on.
    const decision = decideClient(declaredVersion(request.url));
    if (!decision.accepted) {
      socket.close(
        LIVE_CLOSE.refused,
        `${CLIENT_VERSION_QUERY}: ${decision.message} — supported: ${decision.supported.join(', ')}`,
      );
      return;
    }

    const channel = queryOf(request.url, CHANNEL_QUERY);
    if (!isChannel(channel)) {
      socket.close(LIVE_CLOSE.refused, `${CHANNEL_QUERY}: must be one of ${LIVE_CHANNELS.join(', ')}`);
      return;
    }

    const snapshot = (sequence: number): SnapshotFrame => ({
      kind: 'snapshot',
      channel,
      stateRevision: OPENING_STATE_REVISION,
      sequence,
      at: clock(),
    });

    socket.send(JSON.stringify(snapshot(0)));

    socket.on('message', (data: unknown) => {
      let sent: unknown;
      try {
        sent = JSON.parse(String(data));
      } catch {
        socket.close(LIVE_CLOSE.unreadable, 'frame: must be JSON');
        return;
      }
      const parsed = parseFrame(sent);
      if (!parsed.ok) {
        // Every problem the parser found, in the order it found them, because a client fixing a frame
        // wants the whole list and not the first item of it.
        const reason = parsed.problems.map(({ path, message }) => `${path}: ${message}`).join('; ');
        socket.close(LIVE_CLOSE.unreadable, reason.slice(0, MAX_CLOSE_REASON));
        return;
      }
      const frame = parsed.value;
      // Said out loud rather than ignored: a client that sends a command to this build learns that
      // nothing ran it, instead of waiting for an effect that is never coming.
      if (frame.kind !== 'resume') {
        socket.close(LIVE_CLOSE.refused, `${frame.kind}: ${NOT_IN_THIS_BUILD}`);
        return;
      }
      if (frame.channel !== channel) {
        socket.close(LIVE_CLOSE.refused, `resume.channel: this session is connected to ${channel}`);
        return;
      }
      socket.send(JSON.stringify(snapshot(frame.fromSequence)));
    });
  });
}
