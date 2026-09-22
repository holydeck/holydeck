// A new installation has exactly one first-run account to claim. The form deliberately keeps its draft
// in component memory: a reload must ask the server whether the offer still exists, and passwords must
// never become browser-storage data merely to make a form more convenient after that answer changes.

import { DISPLAY_NAME, ONBOARDING_PATH, type InstanceClaim, type OnboardingOffer, type SignIn } from '@holydeck/contracts/accounts';
import { NOT_FOUND } from '@holydeck/contracts/http';
import { SESSION_PATH } from '@holydeck/contracts/sessions';
import { useState } from 'preact/hooks';

import { onboarding } from '../app-state.js';
import { FormField } from '../components/form-field.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import { boot, request } from '../request.js';
import { navigate } from '../router.js';

import type { JSX } from 'preact';

type FieldName = 'name' | 'displayName' | 'password' | 'confirm';

type Draft = Record<FieldName, string>;

const emptyDraft = (): Draft => ({ name: '', displayName: '', password: '', confirm: '' });

const characters = (value: string): number => [...value].length;

const lengthError = (value: string, bounds: { readonly minimum: number; readonly maximum: number }): string | undefined =>
  characters(value) < bounds.minimum || characters(value) > bounds.maximum
    ? t('form.error.length', { minimum: bounds.minimum, maximum: bounds.maximum })
    : undefined;

const validationFor = (draft: Draft, offer: OnboardingOffer): Partial<Record<FieldName, string>> => {
  const errors: Partial<Record<FieldName, string>> = {};
  const fields: readonly [FieldName, { readonly minimum: number; readonly maximum: number }][] = [
    ['name', offer.name],
    ['displayName', DISPLAY_NAME],
    ['password', offer.password],
  ];

  for (const [field, bounds] of fields) {
    const value = draft[field];
    if (value === '') errors[field] = t('form.error.required');
    else {
      const error = lengthError(value, bounds);
      if (error !== undefined) errors[field] = error;
    }
  }

  if (draft.confirm === '') errors.confirm = t('form.error.required');
  else if (draft.confirm !== draft.password) errors.confirm = t('welcome.error.mismatch');
  return errors;
};

const focusFirst = (errors: Partial<Record<FieldName, string>>): void => {
  const field = (['name', 'displayName', 'password', 'confirm'] as const).find((name) => errors[name] !== undefined);
  if (field !== undefined) document.getElementById(`welcome-${field}`)?.focus();
};

/** The first-run claim form, or the route away once another administrator has already claimed it. */
export function WelcomePage(): JSX.Element {
  const offer = onboarding.value;
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [other, setOther] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  if (offer === 'claimed') {
    return <p>{t('welcome.error.claimed')} <a href="/sign-in">{t('signIn.title')}</a></p>;
  }
  if (offer === undefined) return <p role="status">{t('app.loading')}</p>;

  const change = (field: FieldName) => (value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setOther(undefined);
  };

  const submit = async (event: JSX.TargetedEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    const nextErrors = validationFor(draft, offer);
    if (Object.keys(nextErrors).length !== 0) {
      setErrors(nextErrors);
      setOther(t('form.error.summary'));
      focusFirst(nextErrors);
      return;
    }

    setSubmitting(true);
    setErrors({});
    setOther(undefined);
    try {
      const claim: InstanceClaim = { name: draft.name, displayName: draft.displayName, password: draft.password };
      const result = await request(ONBOARDING_PATH, { method: 'POST', csrf: '', body: claim });
      if (!result.ok) {
        if (result.code === NOT_FOUND) {
          onboarding.value = 'claimed';
          return;
        }
        const mapped = fieldErrors(result, ['name', 'displayName', 'password']);
        setErrors(mapped.byField);
        setOther(mapped.other);
        return;
      }

      const credentials: SignIn = { name: draft.name, password: draft.password };
      const signedIn = await request(SESSION_PATH, { method: 'POST', csrf: '', body: credentials });
      if (!signedIn.ok) {
        navigate('/sign-in?notice=claim-sign-in-refused', { replace: true });
        return;
      }
      await boot();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form noValidate onSubmit={submit}>
      <h1>{t('welcome.title')}</h1>
      <p>{t('welcome.intro')}</p>
      {other === undefined ? null : <p role="alert">{other}</p>}
      <FormField
        id="welcome-name"
        label={t('welcome.name')}
        value={draft.name}
        onInput={change('name')}
        hint={t('welcome.name.hint', { minimum: offer.name.minimum, maximum: offer.name.maximum })}
        error={errors.name}
        autoComplete="username"
        required
        minLength={offer.name.minimum}
        maxLength={offer.name.maximum}
      />
      <FormField
        id="welcome-displayName"
        label={t('welcome.displayName')}
        value={draft.displayName}
        onInput={change('displayName')}
        error={errors.displayName}
        required
        minLength={DISPLAY_NAME.minimum}
        maxLength={DISPLAY_NAME.maximum}
      />
      <FormField
        id="welcome-password"
        label={t('welcome.password')}
        type="password"
        value={draft.password}
        onInput={change('password')}
        hint={t('welcome.password.hint', { minimum: offer.password.minimum, maximum: offer.password.maximum })}
        error={errors.password}
        autoComplete="new-password"
        required
        minLength={offer.password.minimum}
        maxLength={offer.password.maximum}
      />
      <FormField
        id="welcome-confirm"
        label={t('welcome.confirm')}
        type="password"
        value={draft.confirm}
        onInput={change('confirm')}
        error={errors.confirm}
        autoComplete="new-password"
        required
      />
      <button type="submit" disabled={submitting}>{t('welcome.submit')}</button>
    </form>
  );
}
