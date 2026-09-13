import { describe, expect, it } from 'vitest';

import {
  CLIENT_VERSION_HEADER,
  CLIENT_WINDOW,
  UPDATE_REQUIRED_MESSAGE,
  clientCompatibilityProblems,
  decideClient,
  supportedClientVersions,
} from './clients.js';
import { UPDATE_REQUIRED, statusForCode } from './http.js';

const window12 = { current: 12, previous: 11 };

// The recording in contracts/fixtures/client-compatibility.v1.json, written out here because the
// product repository holds no phase artifacts.
const packet = () => ({
  currentVersion: 12,
  previousVersion: 11,
  clients: [
    { version: 12, outcome: 'accepted' },
    { version: 11, outcome: 'accepted' },
    { version: 10, outcome: 'Update required' },
    { version: 3, outcome: 'Update required' },
  ],
  releasedInterfaces: {
    cli: { intact: true, documentedIn: 'contracts/client-compatibility.md' },
    corpusApi: { intact: true, documentedIn: 'contracts/corpus-boundary.md' },
  },
});

describe('the window this build serves', () => {
  it('is the current version and the one before it, and says so in a header clients can send', () => {
    expect(CLIENT_WINDOW).toEqual({ current: 1 });
    expect(CLIENT_VERSION_HEADER).toBe('x-holydeck-client-version');
    expect(UPDATE_REQUIRED_MESSAGE).toBe('Update required');
  });

  it('offers one version while nothing has been released before it, and two once something has', () => {
    expect(supportedClientVersions()).toEqual([1]);
    expect(supportedClientVersions(window12)).toEqual([11, 12]);
  });
});

describe('deciding about one client', () => {
  it('accepts the current version and the one before it', () => {
    expect(decideClient(12, window12)).toEqual({ accepted: true, version: 12 });
    expect(decideClient('11', window12)).toEqual({ accepted: true, version: 11 });
    expect(decideClient(1)).toEqual({ accepted: true, version: 1 });
  });

  it('tells an older client to update, with the stable code and the words the contract names', () => {
    expect(decideClient(10, window12)).toEqual({
      accepted: false,
      code: UPDATE_REQUIRED,
      status: 426,
      message: UPDATE_REQUIRED_MESSAGE,
      supported: [11, 12],
    });
  });

  it('tells a client that sends no version, or nonsense, to update rather than guessing for it', () => {
    expect(decideClient(undefined, window12).accepted).toBe(false);
    expect(decideClient('twelve', window12).accepted).toBe(false);
    expect(decideClient(11.5, window12).accepted).toBe(false);
  });

  it('refuses a client newer than the server, because a server cannot serve a protocol it does not have', () => {
    expect(decideClient(13, window12).accepted).toBe(false);
  });

  it('refuses with the status the released registry gives this code', () => {
    const decision = decideClient(10, window12);
    expect(decision.accepted).toBe(false);
    expect(decision.accepted === false && decision.status).toBe(statusForCode(UPDATE_REQUIRED));
  });

  it('has one version inside the window while nothing older has been released', () => {
    expect(decideClient(0).accepted).toBe(false);
    expect(decideClient(2).accepted).toBe(false);
  });
});

describe('the contract itself', () => {
  it('accepts the recording the contract was written from', () => {
    expect(clientCompatibilityProblems(packet())).toEqual([]);
  });

  const refuses = (name: string, defect: (value: ReturnType<typeof packet>) => void, diagnostics: readonly string[]) => {
    it(`refuses ${name}`, () => {
      const value = packet();
      defect(value);
      expect(clientCompatibilityProblems(value)).toEqual(diagnostics);
    });
  };

  refuses('the previous client version refused', (value) => {
    value.clients[1] = { version: 11, outcome: 'Update required' };
  }, ['client 11: a supported client received Update required']);

  refuses('the current client version refused', (value) => {
    value.clients[0] = { version: 12, outcome: 'Update required' };
  }, ['client 12: a supported client received Update required']);

  refuses('an older client accepted anyway', (value) => {
    value.clients[2] = { version: 10, outcome: 'accepted' };
  }, ['client 10: an unsupported client received accepted instead of Update required']);

  refuses('an older client refused with an unrecognisable message', (value) => {
    value.clients[3] = { version: 3, outcome: 'rejected' };
  }, ['client 3: an unsupported client received rejected instead of Update required']);

  refuses('a previous version that is not older than the current one', (value) => {
    value.previousVersion = 12;
  }, [
    'compatibility: the previous version is not older than the current one',
    'client 11: an unsupported client received accepted instead of Update required',
  ]);

  refuses('released CLI compatibility broken', (value) => {
    value.releasedInterfaces.cli.intact = false;
  }, ['cli: released compatibility was broken']);

  refuses('corpus API compatibility documented nowhere', (value) => {
    delete (value.releasedInterfaces.corpusApi as { documentedIn?: string }).documentedIn;
  }, ['corpusApi: compatibility is not documented separately']);

  refuses('a client entry that is not an entry, because an unreadable client was not accepted', (value) => {
    value.clients.push(null as unknown as { version: number; outcome: string });
  }, ['client undefined: an unsupported client received undefined instead of Update required']);

  refuses('released interfaces recorded nowhere at all', (value) => {
    delete (value as { releasedInterfaces?: unknown }).releasedInterfaces;
  }, [
    'cli: released compatibility was broken',
    'cli: compatibility is not documented separately',
    'corpusApi: released compatibility was broken',
    'corpusApi: compatibility is not documented separately',
  ]);

  refuses('a documentation path that is only blank space', (value) => {
    value.releasedInterfaces.cli.documentedIn = '   ';
  }, ['cli: compatibility is not documented separately']);

  refuses('a window with no versions in it', (value) => {
    value.clients = [];
  }, ['compatibility: no client versions exercised']);

  refuses('clients recorded as anything other than a list of them', (value) => {
    (value as { clients: unknown }).clients = { 12: 'accepted' };
  }, ['compatibility: no client versions exercised']);

  refuses('a window whose versions are not versions', (value) => {
    (value as { currentVersion: unknown }).currentVersion = 'twelve';
  }, [
    'compatibility: no current and previous client version',
    'client 12: an unsupported client received accepted instead of Update required',
  ]);

  it('refuses a packet that is not a packet', () => {
    expect(clientCompatibilityProblems(7)).toEqual(['client compatibility: must be an object']);
  });

  it('grades a decision this build makes, so the code and the contract cannot drift apart', () => {
    // The window of a first release has one version in it, which no recording of two versions can
    // describe; this grades the next window instead, decided by the same function the server uses.
    const next = { current: 2, previous: 1 };
    const outcomeOf = (version: number) =>
      decideClient(version, next).accepted ? 'accepted' : UPDATE_REQUIRED_MESSAGE;
    expect(
      clientCompatibilityProblems({
        currentVersion: next.current,
        previousVersion: next.previous,
        clients: [2, 1, 0].map((version) => ({ version, outcome: outcomeOf(version) })),
        releasedInterfaces: {
          cli: { intact: true, documentedIn: 'docs/cli.md' },
          corpusApi: { intact: true, documentedIn: 'docs/corpus.md' },
        },
      }),
    ).toEqual([]);
  });
});
