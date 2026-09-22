// Sign-in accepts the credentials every account has and the optional second-factor code an account may
// have enabled. It intentionally gives one response to ordinary authentication refusal: separating a
// handle, password or code error would reveal more about an account than a sign-in screen should know.

import { type SignIn } from '@holydeck/contracts/accounts';
import { SESSION_PATH, SIGN_IN_REFUSED } from '@holydeck/contracts/sessions';
import { useState } from 'preact/hooks';

import { session } from '../app-state.js';
import { FormField } from '../components/form-field.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import { boot, request } from '../request.js';

import type { JSX } from 'preact';

/** The session-opening form, with an optional safe destination supplied by the router. */
export function SignInPage({ next }: { readonly next: string | undefined }): JSX.Element {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: JSX.TargetedEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const credentials: SignIn = code === '' ? { name, password } : { name, password, code };
      const result = await request(SESSION_PATH, { method: 'POST', csrf: '', body: credentials });
      if (!result.ok) {
        if (result.code === SIGN_IN_REFUSED) {
          setPassword('');
          setError(t('signIn.refused'));
        } else {
          setError(fieldErrors(result, ['name', 'password', 'code']).other);
        }
        return;
      }
      await boot();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form noValidate onSubmit={submit}>
      <h1>{t('signIn.title')}</h1>
      {session.value === null && next !== undefined ? <p role="status">{t('signIn.expired')}</p> : null}
      {error === undefined ? null : <p role="alert">{error}</p>}
      <FormField id="sign-in-name" label={t('signIn.name')} value={name} onInput={setName} autoComplete="username" required />
      <FormField
        id="sign-in-password"
        label={t('signIn.password')}
        type="password"
        value={password}
        onInput={setPassword}
        autoComplete="current-password"
        required
      />
      <FormField
        id="sign-in-code"
        label={t('signIn.code')}
        value={code}
        onInput={setCode}
        autoComplete="one-time-code"
        inputMode="numeric"
      />
      <button type="submit" disabled={submitting}>{t('signIn.submit')}</button>
    </form>
  );
}
