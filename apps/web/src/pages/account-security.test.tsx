// @vitest-environment happy-dom
import { Buffer } from 'node:buffer';

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { SESSION_PATH, SIGN_IN_REFUSED, type SessionView } from '@holydeck/contracts/sessions';
import { TOTP_PATH, TOTP_RECOVERY_PATH, TOTP_VERIFICATION_PATH } from '@holydeck/contracts/totp';
import { PASSKEY_OPTIONS_PATH, PASSKEY_PATH, passkeyPath, type PasskeySummary } from '@holydeck/contracts/webauthn';

import type { FetchLike } from '../api.js';
import type { AttestationCredentialLike, CredentialsContainerLike, WebAuthnLike } from '../passkey.js';

import { pageReload } from '../account-switch.js';
import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { SecurityPage } from './account-security.js';

// Mirrors the unexported refusal codes `account-security.tsx` matches against.
const TOTP_ENROLLED = 'auth.totp_enrolled';
const TOTP_REFUSED = 'auth.totp_refused';

const csrf = 'c'.repeat(43);

const signedIn = (slots: SessionView['slots'] = []): SessionView => ({
  actor: 'account:me',
  permissions: [],
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf,
  slots,
});

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const emptyPasskeys = (): ReturnType<typeof reply> => reply(200, successEnvelope({ passkeys: [] }, 'request-passkeys'));

const withLiveRegions = (browser?: WebAuthnLike): ReturnType<typeof render> =>
  render(
    <>
      <p id="announce-polite" aria-live="polite"></p>
      <p id="announce-assertive" aria-live="assertive"></p>
      <SecurityPage browser={browser} />
    </>,
  );

const credentialsThat = (answers: Partial<CredentialsContainerLike>): CredentialsContainerLike => ({
  create: vi.fn(async () => {
    throw new Error('no registration was expected');
  }),
  get: vi.fn(async () => {
    throw new Error('no assertion was expected');
  }),
  ...answers,
});

const unsupportedBrowser: WebAuthnLike = { credentials: credentialsThat({}) };

const supportedBrowser = (create: CredentialsContainerLike['create']): WebAuthnLike => ({
  publicKeyCredential: {},
  credentials: credentialsThat({ create }),
});

const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;

const encoded = (...values: number[]): string => Buffer.from(values).toString('base64url');

const registrationOptions = {
  challenge: encoded(1, 2, 3),
  rp: { id: 'holydeck.example', name: 'HolyDeck' },
  user: { id: encoded(9, 9), name: 'ruth', displayName: 'Ruth Example' },
  pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
};

const attestationCredential: AttestationCredentialLike = {
  id: encoded(9, 9, 9),
  rawId: bytes(9, 9, 9),
  type: 'public-key',
  getClientExtensionResults: () => ({}),
  response: {
    clientDataJSON: bytes(1, 2, 3),
    attestationObject: bytes(4, 5),
    getTransports: () => ['internal'],
  },
};

const alicePasskey: PasskeySummary = {
  id: 'pk-1',
  name: 'Laptop',
  registeredAt: '2026-08-01T10:00:00.000Z',
  transports: ['internal'],
  synced: false,
};

const phonePasskey: PasskeySummary = {
  id: 'pk-2',
  name: 'Phone',
  registeredAt: '2026-08-02T11:00:00.000Z',
  transports: ['hybrid'],
  synced: true,
};

describe('SecurityPage', () => {
  beforeEach(() => {
    resetAppState();
  });

  it('renders the not-found page when there is no session', () => {
    session.value = null;
    withLiveRegions();

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
  });

  it('walks through authenticator-app enrollment, regenerating codes and removal', async () => {
    session.value = signedIn();
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (path === PASSKEY_PATH && init.method === undefined) return emptyPasskeys();
      if (path === TOTP_PATH && init.method === 'POST') {
        return reply(201, successEnvelope({ secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/HolyDeck' }, 'r-start'));
      }
      if (path === TOTP_VERIFICATION_PATH && init.method === 'POST') {
        return reply(200, successEnvelope({ recoveryCodes: ['aaaa-bbbb', 'cccc-dddd'] }, 'r-verify'));
      }
      if (path === TOTP_RECOVERY_PATH && init.method === 'POST') {
        return reply(200, successEnvelope({ recoveryCodes: ['eeee-ffff'] }, 'r-regen'));
      }
      if (path === TOTP_PATH && init.method === 'DELETE') {
        const body = JSON.parse(init.body ?? '{}') as { password?: string };
        if (body.password !== 'right password') return reply(401, errorEnvelope(SIGN_IN_REFUSED, 'Wrong password', 'r-wrong'));
        return reply(200, successEnvelope({}, 'r-removed'));
      }
      throw new Error(`unexpected request ${String(init.method)} ${path}`);
    });
    setFetching(fetching);
    withLiveRegions();

    fireEvent.click(await screen.findByRole('button', { name: 'Set up an authenticator app' }));
    await screen.findByText('JBSWY3DPEHPK3PXP');
    fireEvent.input(screen.getByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Verify' }).closest('form') as HTMLFormElement);

    await screen.findByText('aaaa-bbbb');
    expect(screen.getByText('An authenticator app is set up for this account.')).toBeTruthy();
    expect(document.getElementById('announce-polite')?.textContent).toBe('Authenticator app set up.');

    fireEvent.click(screen.getByRole('button', { name: 'Generate new recovery codes' }));
    await screen.findByText('eeee-ffff');
    expect(document.getElementById('announce-polite')?.textContent).toBe('New recovery codes generated.');

    fireEvent.click(screen.getByRole('button', { name: 'Remove authenticator app' }));
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Confirm' }).closest('form') as HTMLFormElement);
    expect((await screen.findByRole('alert')).textContent).toBe('That password was not accepted.');

    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'right password' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Confirm' }).closest('form') as HTMLFormElement);
    await screen.findByRole('button', { name: 'Set up an authenticator app' });
    expect(document.getElementById('announce-polite')?.textContent).toBe('Authenticator app removed.');

    const verifyCall = fetching.mock.calls.find(([path, init]) => path === TOTP_VERIFICATION_PATH && init.method === 'POST');
    expect(JSON.parse(verifyCall?.[1].body ?? '{}')).toEqual({ code: '123456' });
  });

  it('treats an already-enrolled refusal on setup as already set up', async () => {
    session.value = signedIn();
    setFetching(vi.fn<FetchLike>(async (path, init) => {
      if (path === PASSKEY_PATH && init.method === undefined) return emptyPasskeys();
      if (path === TOTP_PATH && init.method === 'POST') return reply(409, errorEnvelope(TOTP_ENROLLED, 'Already enrolled', 'r-enrolled'));
      throw new Error(`unexpected request ${String(init.method)} ${path}`);
    }));
    withLiveRegions();

    fireEvent.click(await screen.findByRole('button', { name: 'Set up an authenticator app' }));

    await screen.findByText('An authenticator app is set up for this account.');
    expect(screen.queryByLabelText('Code')).toBeNull();
  });

  it('shows an alert for a wrong verification code without losing the pending secret', async () => {
    session.value = signedIn();
    setFetching(vi.fn<FetchLike>(async (path, init) => {
      if (path === PASSKEY_PATH && init.method === undefined) return emptyPasskeys();
      if (path === TOTP_PATH && init.method === 'POST') return reply(201, successEnvelope({ secret: 'SECRET1', uri: 'otpauth://x' }, 'r-start'));
      if (path === TOTP_VERIFICATION_PATH && init.method === 'POST') return reply(401, errorEnvelope(TOTP_REFUSED, 'Refused', 'r-verify'));
      throw new Error(`unexpected request ${String(init.method)} ${path}`);
    }));
    withLiveRegions();

    fireEvent.click(await screen.findByRole('button', { name: 'Set up an authenticator app' }));
    await screen.findByText('SECRET1');
    fireEvent.input(screen.getByLabelText('Code'), { target: { value: '000000' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Verify' }).closest('form') as HTMLFormElement);

    expect((await screen.findByRole('alert')).textContent).toBe('That code was not accepted. Check the app and try again.');
    expect(screen.getByText('SECRET1')).toBeTruthy();
  });

  it('lists passkeys, renames one and removes another after a wrong password', async () => {
    session.value = signedIn();
    let removed = false;
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (path === PASSKEY_PATH && init.method === undefined) {
        return reply(200, successEnvelope({ passkeys: removed ? [alicePasskey] : [alicePasskey, phonePasskey] }, 'r-list'));
      }
      if (path === passkeyPath(alicePasskey.id) && init.method === 'PATCH') return reply(200, successEnvelope({}, 'r-rename'));
      if (path === passkeyPath(phonePasskey.id) && init.method === 'DELETE') {
        const body = JSON.parse(init.body ?? '{}') as { password?: string };
        if (body.password !== 'right password') return reply(401, errorEnvelope(SIGN_IN_REFUSED, 'Wrong password', 'r-wrong'));
        removed = true;
        return reply(200, successEnvelope({}, 'r-removed'));
      }
      throw new Error(`unexpected request ${String(init.method)} ${path}`);
    });
    setFetching(fetching);
    withLiveRegions();

    await screen.findByText('Laptop');
    expect(screen.getByText('(synced)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Rename Laptop' }));
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Work laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(document.getElementById('announce-polite')?.textContent).toBe('Passkey renamed.'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Phone' }));
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That password was not accepted.');

    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'right password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByText('Phone')).toBeNull());
    await waitFor(() => expect(document.getElementById('announce-polite')?.textContent).toBe('Passkey removed.'));
  });

  it('shows an alert when the passkey list fails to load', async () => {
    session.value = signedIn();
    setFetching(vi.fn<FetchLike>(async (path, init) => {
      if (path === PASSKEY_PATH && init.method === undefined) return reply(500, errorEnvelope('server.failed', 'Boom', 'r-list'));
      throw new Error(`unexpected request ${String(init.method)} ${path}`);
    }));
    withLiveRegions();

    expect((await screen.findByRole('alert')).textContent).toBe('The passkeys could not be loaded.');
  });

  it('adds a passkey after a full ceremony and reloads the list', async () => {
    session.value = signedIn();
    const create = vi.fn(async () => attestationCredential);
    let added = false;
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (path === PASSKEY_PATH && init.method === undefined) {
        return reply(200, successEnvelope({ passkeys: added ? [alicePasskey] : [] }, 'r-list'));
      }
      if (path === PASSKEY_OPTIONS_PATH && init.method === 'POST') return reply(201, successEnvelope(registrationOptions, 'r-options'));
      if (path === PASSKEY_PATH && init.method === 'POST') {
        added = true;
        return reply(201, successEnvelope({}, 'r-created'));
      }
      throw new Error(`unexpected request ${String(init.method)} ${path}`);
    });
    setFetching(fetching);
    withLiveRegions(supportedBrowser(create));

    await screen.findByText('No passkeys are registered yet.');
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'New key' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Add a passkey' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(document.getElementById('announce-polite')?.textContent).toBe('Passkey New key added.'));
    expect(create).toHaveBeenCalledOnce();
    const created = fetching.mock.calls.find(([path, init]) => path === PASSKEY_PATH && init.method === 'POST');
    expect(JSON.parse(created?.[1].body ?? '{}')).toMatchObject({ name: 'New key' });
  });

  it('announces a cancelled passkey prompt without creating anything', async () => {
    session.value = signedIn();
    const create = vi.fn(async () => {
      throw Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' });
    });
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (path === PASSKEY_PATH && init.method === undefined) return emptyPasskeys();
      if (path === PASSKEY_OPTIONS_PATH && init.method === 'POST') return reply(201, successEnvelope(registrationOptions, 'r-options'));
      throw new Error(`unexpected request ${String(init.method)} ${path}`);
    });
    setFetching(fetching);
    withLiveRegions(supportedBrowser(create));

    await screen.findByText('No passkeys are registered yet.');
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'New key' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Add a passkey' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(document.getElementById('announce-polite')?.textContent).toBe('The passkey prompt was dismissed.'));
    expect(fetching.mock.calls.some(([path, init]) => path === PASSKEY_PATH && init.method === 'POST')).toBe(false);
  });

  it('hides the add form and explains when this browser cannot use passkeys', async () => {
    session.value = signedIn();
    setFetching(vi.fn<FetchLike>(async (path, init) => {
      if (path === PASSKEY_PATH && init.method === undefined) return emptyPasskeys();
      throw new Error(`unexpected request ${String(init.method)} ${path}`);
    }));
    withLiveRegions(unsupportedBrowser);

    await screen.findByText('This browser cannot use passkeys.');
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull();
  });

  it('says no other slots are signed in when this is the only one', async () => {
    session.value = signedIn([{ slotId: 's1', actor: 'account:me' }]);
    setFetching(vi.fn<FetchLike>(async (path, init) => {
      if (path === PASSKEY_PATH && init.method === undefined) return emptyPasskeys();
      throw new Error(`unexpected request ${String(init.method)} ${path}`);
    }));
    withLiveRegions();

    await screen.findByText('No other slots are signed in.');
  });

  it('switches to another slot by its account name, then starts the tab over as it', async () => {
    session.value = signedIn([
      { slotId: 's1', actor: 'account:me' },
      { slotId: 's2', actor: 'account:ruth', displayName: 'Ruth Example' },
    ]);
    const reload = vi.spyOn(pageReload, 'to').mockImplementation(() => undefined);
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (path === PASSKEY_PATH && init.method === undefined) return emptyPasskeys();
      if (path === SESSION_PATH && init.method === 'PATCH') return reply(200, successEnvelope({}, 'r-switch'));
      throw new Error(`unexpected request ${String(init.method)} ${path}`);
    });
    setFetching(fetching);
    withLiveRegions();

    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Ruth Example' }));

    await waitFor(() => expect(reload).toHaveBeenCalledWith('/services'));
    const patchCall = fetching.mock.calls.find(([path, init]) => path === SESSION_PATH && init.method === 'PATCH');
    expect(JSON.parse(patchCall?.[1].body ?? '{}')).toEqual({ active: 's2' });
    reload.mockRestore();
  });

  it('shows an alert when a slot switch is refused', async () => {
    session.value = signedIn([
      { slotId: 's1', actor: 'account:me' },
      { slotId: 's2', actor: 'account:ruth' },
    ]);
    setFetching(vi.fn<FetchLike>(async (path, init) => {
      if (path === PASSKEY_PATH && init.method === undefined) return emptyPasskeys();
      if (path === SESSION_PATH && init.method === 'PATCH') return reply(403, errorEnvelope('auth.forbidden', 'No such slot', 'r-refused'));
      throw new Error(`unexpected request ${String(init.method)} ${path}`);
    }));
    withLiveRegions();

    fireEvent.click(await screen.findByRole('button', { name: 'Switch to account:ruth' }));

    await screen.findByRole('alert');
  });
});
