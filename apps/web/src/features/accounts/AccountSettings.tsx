import type { Account, UpdateAccountRequest } from '@money/client';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Callout, Card, Checkbox, Form, Row, SelectField, Stack, Text, TextAreaField, TextField } from '../../ui';
import { useCategories } from '../categories/data';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { useAccountContext } from './AccountLayout';
import { ACCOUNT_TYPE_LABELS, accountTree, descendantIds, flattenTree, useDeleteAccount, useUpdateAccount } from './data';

const TYPES: Account['type'][] = ['INVESTMENT', 'CASH', 'SUPERANNUATION', 'OTHER'];

/** Edit an account (name, kind, parent, category) or delete it */
export function AccountSettings() {
  const { account, accounts } = useAccountContext();
  const categories = useCategories();
  const update = useUpdateAccount(account.id);
  const remove = useDeleteAccount(account.id);
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: account.name,
    type: account.type,
    reportingCurrency: account.reportingCurrency,
    parentAccountId: account.parentAccountId ?? '',
    categoryId: account.categoryId ?? '',
    description: account.description ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [deleteTransactions, setDeleteTransactions] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // An account cannot move under itself or its own subaccounts
  const blocked = descendantIds(account.id, accounts);
  const parentOptions = flattenTree(accountTree(accounts)).filter((n) => !blocked.has(n.account.id));

  const set = (key: keyof typeof form, value: string) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const save = () => {
    const found: Record<string, string> = {};
    if (!form.name.trim()) found.name = 'Give the account a name.';
    if (!/^[A-Za-z]{3}$/.test(form.reportingCurrency)) found.reportingCurrency = 'Use a 3-letter currency code.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body: UpdateAccountRequest = {};
    if (form.name.trim() !== account.name) body.name = form.name.trim();
    if (form.type !== account.type) body.type = form.type;
    if (form.reportingCurrency.toUpperCase() !== account.reportingCurrency) body.reportingCurrency = form.reportingCurrency.toUpperCase();
    if ((form.parentAccountId || null) !== account.parentAccountId) body.parentAccountId = form.parentAccountId || null;
    if ((form.categoryId || null) !== account.categoryId) body.categoryId = form.categoryId || null;
    if ((form.description.trim() || null) !== account.description) body.description = form.description.trim() || null;
    if (Object.keys(body).length === 0) {
      setSaved(true);
      return;
    }
    update.mutate(body, { onSuccess: () => setSaved(true) });
  };

  return (
    <Stack gap={5}>
      <Card title="Account details">
        <Form onSubmit={save} label="Account details">
          <Stack>
            <TextField label="Name" value={form.name} onChange={(e) => set('name', e.target.value)} error={errors.name} maxLength={120} />
            <SelectField label="Kind" value={form.type} onChange={(e) => set('type', e.target.value)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>
              ))}
            </SelectField>
            <TextField label="Reporting currency" value={form.reportingCurrency} onChange={(e) => set('reportingCurrency', e.target.value.toUpperCase())} error={errors.reportingCurrency} maxLength={3} />
            <SelectField label="Inside another account" value={form.parentAccountId} onChange={(e) => set('parentAccountId', e.target.value)} hint="Moving an account does not move money; record a transfer for that.">
              <option value="">No: a top-level account</option>
              {parentOptions.map((n) => (
                <option key={n.account.id} value={n.account.id}>{'— '.repeat(n.level)}{n.account.name}</option>
              ))}
            </SelectField>
            <SelectField label="Category" value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)} hint="Without one, the account inherits its parent's category.">
              <option value="">{form.parentAccountId ? 'Inherit from parent' : 'None'}</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </SelectField>
            <TextAreaField label="Notes" value={form.description} onChange={(e) => set('description', e.target.value)} />
            <ApiErrorCallout error={update.error} title="Could not save" />
            {saved && !update.isPending && <Callout tone="success">Saved.</Callout>}
            <Row justify="end">
              <Button type="submit" variant="primary" disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save changes'}</Button>
            </Row>
          </Stack>
        </Form>
      </Card>

      <Card title="Delete account">
        <Stack gap={3}>
          <Text size="sm" tone="muted">
            Deleting removes the account and, if you allow it, every transaction recorded in it. Accounts with subaccounts or transfers cannot be deleted until those are moved or deleted.
          </Text>
          <Checkbox label="Also delete its transactions" checked={deleteTransactions} onChange={(e) => setDeleteTransactions(e.target.checked)} />
          <ApiErrorCallout error={remove.error} title="Could not delete the account" />
          {confirmDelete ? (
            <Row gap={2}>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(deleteTransactions, { onSuccess: () => navigate('/accounts') })}>
                {remove.isPending ? 'Deleting…' : `Delete ${account.name}`}
              </Button>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </Row>
          ) : (
            <div>
              <Button variant="ghost" onClick={() => { remove.reset(); setConfirmDelete(true); }}>Delete account…</Button>
            </div>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
