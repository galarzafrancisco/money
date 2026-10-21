import type { Account, CreateAccountRequest } from '@money/client';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Button,
  ButtonLink,
  Callout,
  Card,
  DescriptionList,
  Form,
  Loading,
  Row,
  SegmentedControl,
  SelectField,
  Stack,
  Steps,
  Text,
  TextAreaField,
  TextField,
} from '../../ui';
import { useCategories } from '../categories/data';
import { ApiErrorCallout, errorCode } from '../shared/ApiErrorCallout';
import { PageHeader } from '../shared/PageHeader';
import { ACCOUNT_TYPE_HELP, ACCOUNT_TYPE_LABELS, accountTree, flattenTree, useAccounts, useCreateAccount } from './data';

const STEPS = ['Name and kind', 'Details', 'Review'];
const TYPES: Account['type'][] = ['INVESTMENT', 'CASH', 'OTHER'];
const MAX_DEPTH = 5;

type Draft = {
  name: string;
  type: Account['type'];
  /** null until the user types one: follows the parent's currency (or AUD) */
  reportingCurrency: string | null;
  parentAccountId: string;
  categoryId: string;
  description: string;
};

type Errors = Partial<Record<keyof Draft, string>>;

function validateStep(step: number, draft: Draft & { reportingCurrency: string }): Errors {
  const errors: Errors = {};
  if (step === 0) {
    const name = draft.name.trim();
    if (!name) errors.name = 'Give the account a name.';
    else if (name.length > 120) errors.name = 'Use at most 120 characters.';
  }
  if (step === 1) {
    if (!/^[A-Za-z]{3}$/.test((draft.reportingCurrency ?? '').trim())) errors.reportingCurrency = 'Use a 3-letter currency code, e.g. AUD or USD.';
    if (draft.description.length > 2000) errors.description = 'Use at most 2000 characters.';
  }
  return errors;
}

/** Step-by-step creation of an account or subaccount, with a review before anything is saved */
export function NewAccountPage() {
  const [params] = useSearchParams();
  const accounts = useAccounts();
  const categories = useCategories();
  const create = useCreateAccount();
  const presetParent = params.get('parent') ?? '';

  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Errors>({});
  const [draft, setDraft] = useState<Draft>({
    name: '',
    type: presetParent ? 'CASH' : 'INVESTMENT',
    reportingCurrency: null,
    parentAccountId: presetParent,
    categoryId: '',
    description: '',
  });
  const [created, setCreated] = useState<Account | null>(null);

  const all = accounts.data ?? [];
  const parent = all.find((a) => a.id === draft.parentAccountId);
  const reportingCurrency = draft.reportingCurrency ?? parent?.reportingCurrency ?? 'AUD';
  const category = (categories.data ?? []).find((c) => c.id === draft.categoryId);
  const parentOptions = flattenTree(accountTree(all)).filter((n) => n.level + 1 < MAX_DEPTH);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const withCurrency = { ...draft, reportingCurrency };

  const next = () => {
    const found = validateStep(step, withCurrency);
    setErrors(found);
    if (Object.keys(found).length === 0) setStep((s) => s + 1);
  };

  const submit = () => {
    const body: CreateAccountRequest = {
      name: draft.name.trim(),
      type: draft.type,
      reportingCurrency: reportingCurrency.trim().toUpperCase(),
      description: draft.description.trim() || undefined,
      parentAccountId: draft.parentAccountId || undefined,
      categoryId: draft.categoryId || undefined,
    };
    create.mutate(body, { onSuccess: (account) => setCreated(account) });
  };

  const header = <PageHeader title={presetParent ? 'New subaccount' : 'New account'} subtitle="Accounts hold the cash and shares you track. Nothing here opens a real account." />;

  if (created) {
    return (
      <>
        {header}
        <Card>
          <Stack>
            <Callout tone="success" title={`${created.name} is ready`}>
              Record what has already happened in it, such as the opening deposit.
            </Callout>
            <Row gap={2}>
              <ButtonLink to={`/accounts/${created.id}`} variant="primary">
                Open account
              </ButtonLink>
              <ButtonLink to={`/accounts/${created.id}/record?type=DEPOSIT`}>Record a deposit</ButtonLink>
              <Button
                variant="ghost"
                onClick={() => {
                  setCreated(null);
                  create.reset();
                  setStep(0);
                  setDraft((d) => ({ ...d, name: '', description: '' }));
                }}
              >
                Create another
              </Button>
            </Row>
          </Stack>
        </Card>
      </>
    );
  }

  return (
    <>
      {header}
      <Steps steps={STEPS} current={step} />
      <Card>
        {accounts.isPending ? (
          <Loading />
        ) : (
          <Form onSubmit={step < 2 ? next : submit} label={STEPS[step]}>
            <Stack>
              {step === 0 && (
                <>
                  <TextField label="Name" value={draft.name} onChange={(e) => set('name', e.target.value)} error={errors.name} hint='For example "Stake US shares" or "Emergency fund".' maxLength={120} autoFocus />
                  <SegmentedControl legend="Kind of account" name="account-type" value={draft.type} onChange={(v) => set('type', v)} options={TYPES.map((t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] }))} />
                  <Text tone="muted" size="sm">{ACCOUNT_TYPE_HELP[draft.type]}</Text>
                </>
              )}
              {step === 1 && (
                <>
                  <SelectField label="Inside another account" value={draft.parentAccountId} onChange={(e) => set('parentAccountId', e.target.value)} hint="Subaccounts (buckets) have their own ledger; their values roll up into the parent's totals.">
                    <option value="">No: a top-level account</option>
                    {parentOptions.map((n) => (
                      <option key={n.account.id} value={n.account.id}>
                        {'— '.repeat(n.level)}
                        {n.account.name}
                      </option>
                    ))}
                  </SelectField>
                  <TextField
                    label="Reporting currency"
                    value={reportingCurrency}
                    onChange={(e) => set('reportingCurrency', e.target.value.toUpperCase())}
                    error={errors.reportingCurrency}
                    hint="The currency you usually think of this account in. It can still hold cash in other currencies."
                    maxLength={3}
                    autoCapitalize="characters"
                  />
                  <SelectField label="Category" value={draft.categoryId} onChange={(e) => set('categoryId', e.target.value)} hint={categories.isError ? 'Categories could not be loaded; you can set one later.' : 'Optional. Without one, the account inherits its parent’s category.'}>
                    <option value="">{parent ? 'Inherit from parent' : 'None'}</option>
                    {(categories.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </SelectField>
                  <TextAreaField label="Notes" value={draft.description} onChange={(e) => set('description', e.target.value)} error={errors.description} hint="Optional." />
                </>
              )}
              {step === 2 && (
                <>
                  <DescriptionList
                    items={[
                      { term: 'Name', detail: draft.name.trim() },
                      { term: 'Kind', detail: ACCOUNT_TYPE_LABELS[draft.type] },
                      { term: 'Inside', detail: parent ? parent.name : 'Top level' },
                      { term: 'Reporting currency', detail: reportingCurrency.toUpperCase() },
                      { term: 'Category', detail: category ? category.name : parent ? 'Inherited from parent' : 'None' },
                      { term: 'Notes', detail: draft.description.trim() || '—' },
                    ]}
                  />
                  <ApiErrorCallout error={create.error} title={errorCode(create.error) === 'conflict' ? 'Could not create the account' : undefined}>
                    {errorCode(create.error) === 'conflict' && (
                      <div>
                        <Button variant="ghost" size="sm" onClick={() => setStep(0)}>
                          Change the name
                        </Button>
                      </div>
                    )}
                  </ApiErrorCallout>
                </>
              )}
              <Row justify="between">
                {step > 0 ? (
                  <Button onClick={() => setStep((s) => s - 1)} disabled={create.isPending}>
                    Back
                  </Button>
                ) : (
                  <ButtonLink to={presetParent ? `/accounts/${presetParent}/subaccounts` : '/accounts'} variant="ghost">
                    Cancel
                  </ButtonLink>
                )}
                <Button type="submit" variant="primary" disabled={create.isPending}>
                  {step < 2 ? 'Next' : create.isPending ? 'Creating…' : 'Create account'}
                </Button>
              </Row>
            </Stack>
          </Form>
        )}
      </Card>
    </>
  );
}
