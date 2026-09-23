// Account security (spec v1c-09, COLAB-03): the authenticator app, passkeys and signed-in slots an
// account manages for itself. Every route here needs only a signed-in session — there is no permission
// to gate on, because an account is always allowed to see and change how it signs itself in.

import { SIGN_IN_REFUSED } from '@holydeck/contracts/sessions';
import { TOTP_DIGITS, TOTP_PATH, TOTP_RECOVERY_PATH, TOTP_VERIFICATION_PATH } from '@holydeck/contracts/totp';
import {
  PASSKEY_OPTIONS_PATH,
  PASSKEY_PATH,
  TRANSPORTS,
  passkeyPath,
  type PasskeySummary,
  type PasskeyTransport,
  type RegistrationCredential,
} from '@holydeck/contracts/webauthn';
import { useEffect, useState } from 'preact/hooks';

import { switchAccount } from '../account-switch.js';
import { csrf, session } from '../app-state.js';
import { FormField } from '../components/form-field.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import {
  PASSKEY_CANCELLED,
  PASSKEY_UNAVAILABLE,
  passkeyCapabilities,
  startRegistration,
  type PasskeyCapabilities,
  type RegistrationOptions,
  type WebAuthnLike,
} from '../passkey.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';
import { say } from '../status.js';

import type { JSX } from 'preact';

// Not exported from `@holydeck/contracts` because they are `apps/app`-internal route refusals, spelled
// here exactly as `totp-routes.ts` and `passkey-routes.ts` answer them.
const TOTP_ENROLLED = 'auth.totp_enrolled';
const TOTP_MISSING = 'auth.totp_missing';
const TOTP_REFUSED = 'auth.totp_refused';
const PASSKEY_REGISTERED = 'auth.passkey_registered';
const PASSKEY_LIMIT_REACHED = 'auth.passkey_limit';

type TotpPhase = 'offer' | 'verify' | 'enrolled';

const defaultBrowser = (): WebAuthnLike => ({
  publicKeyCredential: globalThis.PublicKeyCredential as unknown as WebAuthnLike['publicKeyCredential'],
  credentials: globalThis.navigator?.credentials as unknown as WebAuthnLike['credentials'],
});

const asPasskeys = (data: unknown): readonly PasskeySummary[] => {
  const list = (data as { readonly passkeys?: unknown } | undefined)?.passkeys;
  return Array.isArray(list) ? (list as PasskeySummary[]) : [];
};

export interface SecurityPageProps {
  /** Stands in for the browser's WebAuthn halves in a test; defaults to the real ones outside one. */
  readonly browser?: WebAuthnLike;
}

/** The authenticator app, passkeys and other signed-in slots this account can manage for itself. */
export function SecurityPage({ browser = defaultBrowser() }: SecurityPageProps): JSX.Element {
  const currentSession = session.value;
  const permitted = currentSession != null;

  const [totpPhase, setTotpPhase] = useState<TotpPhase>('offer');
  const [totpSecret, setTotpSecret] = useState<{ readonly secret: string; readonly uri: string }>();
  const [totpCode, setTotpCode] = useState('');
  const [totpCodeError, setTotpCodeError] = useState<string>();
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>();
  const [totpBusy, setTotpBusy] = useState(false);
  const [totpOther, setTotpOther] = useState<string>();
  const [removingTotp, setRemovingTotp] = useState(false);
  const [removeTotpPassword, setRemoveTotpPassword] = useState('');
  const [removeTotpError, setRemoveTotpError] = useState<string>();

  const [passkeys, setPasskeys] = useState<readonly PasskeySummary[]>([]);
  const [passkeysLoading, setPasskeysLoading] = useState(permitted);
  const [passkeysLoadFailed, setPasskeysLoadFailed] = useState(false);
  const [capabilities, setCapabilities] = useState<PasskeyCapabilities>();
  const [passkeyName, setPasskeyName] = useState('');
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [addPasskeyError, setAddPasskeyError] = useState<string>();
  const [renamingId, setRenamingId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string>();
  const [removingPasskeyId, setRemovingPasskeyId] = useState<string>();
  const [removePasskeyPassword, setRemovePasskeyPassword] = useState('');
  const [removePasskeyBusy, setRemovePasskeyBusy] = useState(false);
  const [removePasskeyError, setRemovePasskeyError] = useState<string>();

  const [slotBusyId, setSlotBusyId] = useState<string>();
  const [slotError, setSlotError] = useState<string>();

  const loadPasskeys = async (): Promise<void> => {
    setPasskeysLoading(true);
    setPasskeysLoadFailed(false);
    const result = await request(PASSKEY_PATH);
    if (!result.ok) {
      setPasskeysLoadFailed(true);
      setPasskeys([]);
    } else {
      setPasskeys(asPasskeys(result.data));
    }
    setPasskeysLoading(false);
  };

  useEffect(() => {
    if (!permitted) return;
    void loadPasskeys();
    void passkeyCapabilities(browser).then(setCapabilities);
    // Only whether there is a session to act for should restart these; the browser stands are fixed per mount.
  }, [permitted]);

  if (currentSession == null) return <NotFoundPage />;

  const otherSlots = currentSession.slots.filter((slot) => slot.actor !== currentSession.actor);

  const startTotpEnroll = async (): Promise<void> => {
    setTotpBusy(true);
    setTotpOther(undefined);
    try {
      const result = await request(TOTP_PATH, { method: 'POST', csrf: csrf() ?? '' });
      if (!result.ok) {
        if (result.code === TOTP_ENROLLED) setTotpPhase('enrolled');
        else setTotpOther(fieldErrors(result, []).other);
        return;
      }
      const data = result.data as { readonly secret: string; readonly uri: string };
      setTotpSecret({ secret: data.secret, uri: data.uri });
      setTotpPhase('verify');
    } finally {
      setTotpBusy(false);
    }
  };

  const verifyTotp = async (event: JSX.TargetedEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    setTotpBusy(true);
    setTotpCodeError(undefined);
    try {
      const result = await request(TOTP_VERIFICATION_PATH, { method: 'POST', csrf: csrf() ?? '', body: { code: totpCode } });
      if (!result.ok) {
        if (result.code === TOTP_REFUSED) setTotpCodeError(t('security.totp.refused'));
        else if (result.code === TOTP_MISSING) {
          setTotpPhase('offer');
          setTotpSecret(undefined);
        } else {
          setTotpCodeError(fieldErrors(result, []).other);
        }
        return;
      }
      const data = result.data as { readonly recoveryCodes: readonly string[] };
      setRecoveryCodes(data.recoveryCodes);
      setTotpCode('');
      setTotpPhase('enrolled');
      say('polite', t('security.totp.announce.enrolled'));
    } finally {
      setTotpBusy(false);
    }
  };

  const regenerateRecovery = async (): Promise<void> => {
    setTotpBusy(true);
    setTotpOther(undefined);
    try {
      const result = await request(TOTP_RECOVERY_PATH, { method: 'POST', csrf: csrf() ?? '' });
      if (!result.ok) {
        setTotpOther(fieldErrors(result, []).other);
        return;
      }
      const data = result.data as { readonly recoveryCodes: readonly string[] };
      setRecoveryCodes(data.recoveryCodes);
      say('polite', t('security.totp.announce.regenerated'));
    } finally {
      setTotpBusy(false);
    }
  };

  const removeTotp = async (event: JSX.TargetedEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    setTotpBusy(true);
    setRemoveTotpError(undefined);
    try {
      const result = await request(TOTP_PATH, { method: 'DELETE', csrf: csrf() ?? '', body: { password: removeTotpPassword } });
      if (!result.ok) {
        setRemoveTotpError(result.code === SIGN_IN_REFUSED ? t('security.totp.removeWrongPassword') : fieldErrors(result, []).other);
        return;
      }
      setTotpPhase('offer');
      setTotpSecret(undefined);
      setRecoveryCodes(undefined);
      setRemovingTotp(false);
      setRemoveTotpPassword('');
      say('polite', t('security.totp.announce.removed'));
    } finally {
      setTotpBusy(false);
    }
  };

  const mappedCredential = (credential: {
    readonly id: string;
    readonly rawId: string;
    readonly response: { readonly clientDataJSON: string; readonly attestationObject: string; readonly transports: readonly string[] };
  }): RegistrationCredential => ({
    id: credential.id,
    rawId: credential.rawId,
    type: 'public-key',
    clientDataJSON: credential.response.clientDataJSON,
    attestationObject: credential.response.attestationObject,
    transports: credential.response.transports.filter(
      (transport): transport is PasskeyTransport => (TRANSPORTS as readonly string[]).includes(transport),
    ),
  });

  const addPasskey = async (event: JSX.TargetedEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    setAddingPasskey(true);
    setAddPasskeyError(undefined);
    try {
      const optionsResult = await request(PASSKEY_OPTIONS_PATH, { method: 'POST', csrf: csrf() ?? '' });
      if (!optionsResult.ok) {
        const message = fieldErrors(optionsResult, []).other ?? optionsResult.message;
        setAddPasskeyError(message);
        say('assertive', message);
        return;
      }
      const ceremony = await startRegistration(browser, optionsResult.data as RegistrationOptions);
      if (!ceremony.ok) {
        if (ceremony.code === PASSKEY_CANCELLED) {
          say('polite', t('security.passkeys.cancelled'));
          return;
        }
        const message = ceremony.code === PASSKEY_UNAVAILABLE ? t('security.passkeyUnsupported') : t('security.passkeys.failed');
        setAddPasskeyError(message);
        say('assertive', message);
        return;
      }
      const credential = mappedCredential(ceremony.credential);
      const created = await request(PASSKEY_PATH, { method: 'POST', csrf: csrf() ?? '', body: { name: passkeyName, credential } });
      if (!created.ok) {
        const message = created.code === PASSKEY_REGISTERED || created.code === PASSKEY_LIMIT_REACHED
          ? created.message
          : fieldErrors(created, []).other ?? t('security.passkeys.failed');
        setAddPasskeyError(message);
        say('assertive', message);
        return;
      }
      const name = passkeyName;
      setPasskeyName('');
      await loadPasskeys();
      say('polite', t('security.passkeys.announce.added', { name }));
    } finally {
      setAddingPasskey(false);
    }
  };

  const startRename = (passkey: PasskeySummary): void => {
    setRenamingId(passkey.id);
    setRenameDraft(passkey.name);
    setRenameError(undefined);
  };

  const saveRename = async (passkey: PasskeySummary): Promise<void> => {
    setRenameBusy(true);
    setRenameError(undefined);
    try {
      const result = await request(passkeyPath(passkey.id), { method: 'PATCH', csrf: csrf() ?? '', body: { name: renameDraft } });
      if (!result.ok) {
        setRenameError(fieldErrors(result, []).other);
        return;
      }
      setRenamingId(undefined);
      await loadPasskeys();
      say('polite', t('security.passkeys.announce.renamed'));
    } finally {
      setRenameBusy(false);
    }
  };

  const startRemovePasskey = (id: string): void => {
    setRemovingPasskeyId(id);
    setRemovePasskeyPassword('');
    setRemovePasskeyError(undefined);
  };

  const confirmRemovePasskey = async (id: string): Promise<void> => {
    setRemovePasskeyBusy(true);
    setRemovePasskeyError(undefined);
    try {
      const result = await request(passkeyPath(id), { method: 'DELETE', csrf: csrf() ?? '', body: { password: removePasskeyPassword } });
      if (!result.ok) {
        setRemovePasskeyError(
          result.code === SIGN_IN_REFUSED ? t('security.passkeys.removeWrongPassword') : fieldErrors(result, []).other,
        );
        return;
      }
      setRemovingPasskeyId(undefined);
      setRemovePasskeyPassword('');
      await loadPasskeys();
      say('polite', t('security.passkeys.announce.removed'));
    } finally {
      setRemovePasskeyBusy(false);
    }
  };

  // A switch ends in a full reload (see account-switch.ts), so only a refusal is ever shown here.
  const switchSlot = async (slotId: string): Promise<void> => {
    setSlotBusyId(slotId);
    setSlotError(undefined);
    try {
      setSlotError(await switchAccount(slotId));
    } finally {
      setSlotBusyId(undefined);
    }
  };

  return (
    <>
      <h1>{t('security.title')}</h1>

      <section>
        <h2>{t('security.totp.heading')}</h2>
        {totpOther === undefined ? null : <p role="alert">{totpOther}</p>}
        {totpPhase === 'offer' ? (
          <button type="button" onClick={() => void startTotpEnroll()} disabled={totpBusy}>
            {t('security.totp.setup')}
          </button>
        ) : null}

        {totpPhase === 'verify' && totpSecret !== undefined ? (
          <form noValidate onSubmit={verifyTotp}>
            <p>
              {t('security.totp.secretLabel')}: <code>{totpSecret.secret}</code>
            </p>
            <p>
              <a href={totpSecret.uri}>{t('security.totp.uriLabel')}</a>
            </p>
            {totpCodeError === undefined ? null : <p role="alert">{totpCodeError}</p>}
            <FormField
              id="security-totp-code"
              label={t('security.totp.codeLabel')}
              value={totpCode}
              onInput={setTotpCode}
              required
              inputMode="numeric"
              maxLength={TOTP_DIGITS}
            />
            <button type="submit" disabled={totpBusy}>{t('security.totp.verify')}</button>
          </form>
        ) : null}

        {totpPhase === 'enrolled' ? (
          <>
            <p>{t('security.totp.enrolledStatus')}</p>
            {recoveryCodes === undefined ? null : (
              <>
                <h3>{t('security.totp.recoveryHeading')}</h3>
                <p>{t('security.totp.recoveryHint')}</p>
                <ul>
                  {recoveryCodes.map((code) => <li key={code}>{code}</li>)}
                </ul>
              </>
            )}
            <button type="button" onClick={() => void regenerateRecovery()} disabled={totpBusy}>
              {t('security.totp.regenerate')}
            </button>
            {removingTotp ? (
              <form noValidate onSubmit={removeTotp}>
                {removeTotpError === undefined ? null : <p role="alert">{removeTotpError}</p>}
                <FormField
                  id="security-totp-remove-password"
                  label={t('welcome.password')}
                  type="password"
                  value={removeTotpPassword}
                  onInput={setRemoveTotpPassword}
                  autoComplete="current-password"
                  required
                />
                <button type="submit" disabled={totpBusy}>{t('history.confirm')}</button>
                <button
                  type="button"
                  onClick={() => {
                    setRemovingTotp(false);
                    setRemoveTotpPassword('');
                    setRemoveTotpError(undefined);
                  }}
                >
                  {t('history.cancel')}
                </button>
              </form>
            ) : (
              <button type="button" onClick={() => setRemovingTotp(true)}>{t('security.totp.remove')}</button>
            )}
          </>
        ) : null}
      </section>

      <section>
        <h2>{t('security.passkeys.heading')}</h2>
        {passkeysLoadFailed ? <p role="alert">{t('security.passkeys.loadFailed')}</p> : null}
        {passkeysLoading ? <p role="status">{t('app.loading')}</p> : passkeys.length === 0 ? (
          <p>{t('security.passkeys.empty')}</p>
        ) : (
          <ul>
            {passkeys.map((passkey) => (
              <li key={passkey.id}>
                {renamingId === passkey.id ? (
                  <>
                    {renameError === undefined ? null : <p role="alert">{renameError}</p>}
                    <FormField
                      id={`security-passkey-rename-${passkey.id}`}
                      label={t('security.passkeys.nameLabel')}
                      value={renameDraft}
                      onInput={setRenameDraft}
                      required
                    />
                    <button type="button" onClick={() => void saveRename(passkey)} disabled={renameBusy}>
                      {t('security.passkeys.save')}
                    </button>
                    <button type="button" onClick={() => setRenamingId(undefined)}>{t('history.cancel')}</button>
                  </>
                ) : (
                  <>
                    <span>{passkey.name}</span>{' '}
                    <span>{t('security.passkeys.registeredAt', { date: passkey.registeredAt })}</span>
                    {passkey.synced ? <span> {t('security.passkeys.synced')}</span> : null}
                    <button type="button" onClick={() => startRename(passkey)}>
                      {t('security.passkeys.rename', { name: passkey.name })}
                    </button>
                  </>
                )}

                {removingPasskeyId === passkey.id ? (
                  <>
                    {removePasskeyError === undefined ? null : <p role="alert">{removePasskeyError}</p>}
                    <FormField
                      id={`security-passkey-remove-${passkey.id}`}
                      label={t('welcome.password')}
                      type="password"
                      value={removePasskeyPassword}
                      onInput={setRemovePasskeyPassword}
                      autoComplete="current-password"
                      required
                    />
                    <button type="button" onClick={() => void confirmRemovePasskey(passkey.id)} disabled={removePasskeyBusy}>
                      {t('history.confirm')}
                    </button>
                    <button type="button" onClick={() => setRemovingPasskeyId(undefined)}>{t('history.cancel')}</button>
                  </>
                ) : (
                  <button type="button" onClick={() => startRemovePasskey(passkey.id)}>
                    {t('security.passkeys.remove', { name: passkey.name })}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {capabilities?.supported === false ? <p>{t('security.passkeyUnsupported')}</p> : null}
        {addPasskeyError === undefined ? null : <p role="alert">{addPasskeyError}</p>}
        {capabilities === undefined || capabilities.supported ? (
          <form noValidate onSubmit={addPasskey}>
            <FormField
              id="security-passkey-name"
              label={t('security.passkeys.nameLabel')}
              value={passkeyName}
              onInput={setPasskeyName}
              required
            />
            <button type="submit" disabled={addingPasskey}>{t('security.passkeys.add')}</button>
          </form>
        ) : null}
      </section>

      <section>
        <h2>{t('security.slots.heading')}</h2>
        {slotError === undefined ? null : <p role="alert">{slotError}</p>}
        {otherSlots.length === 0 ? (
          <p>{t('security.slots.none')}</p>
        ) : (
          <ul>
            {otherSlots.map((slot) => (
              <li key={slot.slotId}>
                <button type="button" onClick={() => void switchSlot(slot.slotId)} disabled={slotBusyId === slot.slotId}>
                  {t('security.slots.switch', { actor: slot.displayName ?? slot.actor })}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
