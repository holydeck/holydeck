// Account administration keeps the list and its creation form together because every completed change
// returns through the same fresh read. The server remains the authority for permissions and its safety
// refusals; this page only omits choices it already knows the current account cannot make.

import {
  ACCOUNT_NAME,
  ACCOUNT_ROLES,
  ACCOUNTS_PATH,
  DISPLAY_NAME,
  PASSWORD,
  parseAccountRecord,
  type AccountRecord,
  type AccountRole,
  type CreateAccount,
} from '@holydeck/contracts/accounts';
import { useEffect, useState } from 'preact/hooks';

import { can, csrf, session } from '../app-state.js';
import { FormField } from '../components/form-field.js';
import { useDraft } from '../drafts.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';
import { say } from '../status.js';

import type { JSX } from 'preact';

type FieldName = 'name' | 'displayName' | 'password';

type Draft = Record<FieldName, string> & { role: AccountRole };

const emptyDraft = (): Draft => ({ name: '', displayName: '', password: '', role: 'editor' });

const characters = (value: string): number => [...value].length;

const lengthError = (value: string, bounds: { readonly minimum: number; readonly maximum: number }): string | undefined =>
  characters(value) < bounds.minimum || characters(value) > bounds.maximum
    ? t('form.error.length', { minimum: bounds.minimum, maximum: bounds.maximum })
    : undefined;

const validationFor = (draft: Draft): Partial<Record<FieldName, string>> => {
  const errors: Partial<Record<FieldName, string>> = {};
  const fields: readonly [FieldName, { readonly minimum: number; readonly maximum: number }][] = [
    ['name', ACCOUNT_NAME],
    ['displayName', DISPLAY_NAME],
    ['password', PASSWORD],
  ];

  for (const [field, bounds] of fields) {
    const value = draft[field];
    if (value === '') errors[field] = t('form.error.required');
    else {
      const error = lengthError(value, bounds);
      if (error !== undefined) errors[field] = error;
    }
  }

  return errors;
};

const focusFirst = (errors: Partial<Record<FieldName, string>>): void => {
  const field = (['name', 'displayName', 'password'] as const).find((name) => errors[name] !== undefined);
  if (field !== undefined) document.getElementById(`users-${field}`)?.focus();
};

const parsedAccounts = (value: unknown): { readonly accounts: AccountRecord[]; readonly failed: boolean } => {
  if (!Array.isArray(value)) return { accounts: [], failed: true };
  let failed = false;
  const accounts = value.flatMap((row) => {
    const parsed = parseAccountRecord(row);
    if (parsed.ok) return [parsed.value];
    failed = true;
    return [];
  }).sort((left, right) => left.name.localeCompare(right.name));
  return { accounts, failed };
};

/** The permitted account list, its administration actions, and the form that creates another account. */
export function AdminUsersPage(): JSX.Element {
  const permitted = can('accounts.manage');
  const ownId = session.value?.account?.id;
  const [accounts, setAccounts] = useState<readonly AccountRecord[]>([]);
  const [loading, setLoading] = useState(permitted);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft, clearDraft] = useDraft('admin-users:create', emptyDraft());
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [other, setOther] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [changing, setChanging] = useState<string>();

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadFailed(false);
    const result = await request(ACCOUNTS_PATH);
    if (!result.ok || !Array.isArray(result.data)) {
      setLoadFailed(true);
      setAccounts([]);
    } else {
      const parsed = parsedAccounts(result.data);
      setAccounts(parsed.accounts);
      setLoadFailed(parsed.failed);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (permitted) void load();
  }, [permitted]);

  if (!permitted) return <NotFoundPage />;

  const change = (field: FieldName) => (value: string): void => {
    setDraft({ ...draft, [field]: value });
    setErrors((current) => ({ ...current, [field]: undefined }));
    setOther(undefined);
  };

  const refuse = (message: string): void => {
    const text = t('users.refused', { message });
    setOther(text);
    say('assertive', text);
  };

  const update = async (account: AccountRecord, path: string, body: unknown): Promise<void> => {
    setChanging(account.id);
    setOther(undefined);
    try {
      const result = await request(path, { method: 'PATCH', csrf: csrf() ?? '', body });
      if (!result.ok) {
        refuse(fieldErrors(result, []).other ?? result.message);
        return;
      }
      await load();
      say('polite', t('users.announce.updated', { name: account.displayName }));
    } finally {
      setChanging(undefined);
    }
  };

  const submit = async (event: JSX.TargetedEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    const nextErrors = validationFor(draft);
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
      const created: CreateAccount = { name: draft.name, displayName: draft.displayName, password: draft.password, role: draft.role };
      const result = await request(ACCOUNTS_PATH, { method: 'POST', csrf: csrf() ?? '', body: created });
      if (!result.ok) {
        const mapped = fieldErrors(result, ['name', 'displayName', 'password']);
        setErrors(mapped.byField);
        if (mapped.other !== undefined) refuse(mapped.other);
        return;
      }
      const displayName = draft.displayName;
      clearDraft();
      await load();
      say('polite', t('users.announce.created', { name: displayName }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <h1>{t('users.title')}</h1>
      {loadFailed ? <p role="alert">{t('users.loadFailed')}</p> : null}
      {other === undefined ? null : <p role="alert">{other}</p>}
      {loading ? <p role="status">{t('app.loading')}</p> : (
        <div class="table-scroll">
          <table class="users-table">
            <caption>{t('users.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('users.column.name')}</th>
                <th scope="col">{t('users.column.displayName')}</th>
                <th scope="col">{t('users.column.role')}</th>
                <th scope="col">{t('users.column.status')}</th>
                <th scope="col">{t('users.column.control')}</th>
                <th scope="col">{t('users.column.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const own = account.id === ownId;
                const busy = changing === account.id;
                return (
                  <tr key={account.id}>
                    <th scope="row">{account.name}{own ? <> <span>{t('users.you')}</span></> : null}</th>
                    <td>{account.displayName}</td>
                    <td>{t(`app.role.${account.role}`)}</td>
                    <td>{t(account.disabled ? 'users.status.disabled' : 'users.status.active')}</td>
                    <td>{t(account.controlPresentation ? 'users.control.granted' : 'users.control.none')}</td>
                    <td>
                      <fieldset disabled={busy}>
                        {own ? null : (
                          <label>
                            {t('users.action.role', { name: account.displayName })}
                            <select
                              value={account.role}
                              onChange={(event) => void update(
                                account,
                                `${ACCOUNTS_PATH}/${encodeURIComponent(account.id)}/role`,
                                { role: event.currentTarget.value as AccountRole },
                              )}
                            >
                              {ACCOUNT_ROLES.map((role) => <option value={role}>{t(`app.role.${role}`)}</option>)}
                            </select>
                          </label>
                        )}
                        {own ? null : (
                          <button
                            type="button"
                            onClick={() => void update(account, `${ACCOUNTS_PATH}/${encodeURIComponent(account.id)}/status`, { disabled: !account.disabled })}
                          >
                            {t(account.disabled ? 'users.action.restore' : 'users.action.disable', { name: account.displayName })}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void update(
                            account,
                            `${ACCOUNTS_PATH}/${encodeURIComponent(account.id)}/control-presentation`,
                            { granted: !account.controlPresentation },
                          )}
                        >
                          {t(
                            account.controlPresentation ? 'users.action.revokeControl' : 'users.action.grantControl',
                            { name: account.displayName },
                          )}
                        </button>
                      </fieldset>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <form noValidate onSubmit={submit}>
        <h2>{t('users.create.title')}</h2>
        <FormField
          id="users-name"
          label={t('users.column.name')}
          value={draft.name}
          onInput={change('name')}
          error={errors.name}
          autoComplete="username"
          required
          minLength={ACCOUNT_NAME.minimum}
          maxLength={ACCOUNT_NAME.maximum}
        />
        <FormField
          id="users-displayName"
          label={t('users.column.displayName')}
          value={draft.displayName}
          onInput={change('displayName')}
          error={errors.displayName}
          required
          minLength={DISPLAY_NAME.minimum}
          maxLength={DISPLAY_NAME.maximum}
        />
        <FormField
          id="users-password"
          label={t('welcome.password')}
          type="password"
          value={draft.password}
          onInput={change('password')}
          error={errors.password}
          autoComplete="new-password"
          required
          minLength={PASSWORD.minimum}
          maxLength={PASSWORD.maximum}
        />
        <div class="form-field">
          <label for="users-role">{t('users.column.role')}</label>
          <select id="users-role" value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.currentTarget.value as AccountRole })}>
            {ACCOUNT_ROLES.map((role) => <option value={role}>{t(`app.role.${role}`)}</option>)}
          </select>
        </div>
        <button type="submit" disabled={submitting}>{t('users.create.submit')}</button>
      </form>
    </>
  );
}
