import type { AccountGroup, AccountGroupMember } from '@money/client';
import { useState } from 'react';
import { Badge, Button, Callout, Card, Checkbox, EmptyState, Fieldset, Form, Loading, Row, Stack, Table, Text, TextField, type Column } from '../../ui';
import { ApiErrorCallout } from '../shared/ApiErrorCallout';
import { CurrencyLines } from '../shared/CurrencyTotals';
import { PageHeader } from '../shared/PageHeader';
import { AccountViewNav } from './AccountViewNav';
import { useAccountGroups, useCreateAccountGroup, useDeleteAccountGroup, useUpdateAccountGroup } from './data';

type Ref = { kind: 'account' | 'up'; id: string };
const keyOf = (m: Ref) => `${m.kind}:${m.id}`;
const lines = (m: { totals: { byCurrency: { currency: string; total: string }[] } }) => m.totals.byCurrency.map((c) => ({ currency: c.currency, amount: c.total }));

const REASONS: Record<string, string> = {
  hidden: 'Hidden Up account: not counted',
  removed: 'Removed at Up: not counted',
  'linked-duplicate': 'Linked to a Money account in this group: not counted twice',
};

function SourceBadges({ m }: { m: AccountGroupMember }) {
  return (
    <span className="account-name">
      {m.name}
      <Badge>{m.source === 'up' ? 'Up (imported)' : 'Money'}</Badge>
      {m.excludedReason && <Badge tone="warning">{REASONS[m.excludedReason]}</Badge>}
    </span>
  );
}

const memberColumns: Column<AccountGroupMember>[] = [
  { key: 'name', header: 'Physical account', render: (m) => <SourceBadges m={m} /> },
  { key: 'value', header: 'Value per currency', numeric: true, render: (m) => <CurrencyLines lines={lines(m)} /> },
];

function GroupEditor({
  initial,
  groups,
  ungrouped,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: { id: string | null; name: string; description: string; members: Ref[] };
  groups: AccountGroup[];
  ungrouped: AccountGroupMember[];
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (draft: { name: string; description: string; members: Ref[]; move: boolean }) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [selected, setSelected] = useState(new Set(initial.members.map(keyOf)));
  const [nameError, setNameError] = useState<string>();

  // Every physical account, with the group it is in now (if any)
  const options = [
    ...groups.flatMap((g) => g.members.map((m) => ({ m, inGroup: g }))),
    ...ungrouped.map((m) => ({ m, inGroup: null as AccountGroup | null })),
  ].sort((a, b) => a.m.name.localeCompare(b.m.name));
  const otherGroupOf = (opt: (typeof options)[number]) => (opt.inGroup && opt.inGroup.id !== initial.id ? opt.inGroup : null);
  const moving = options.filter((o) => selected.has(keyOf(o.m)) && otherGroupOf(o));

  return (
    <Form
      label={submitLabel}
      onSubmit={() => {
        if (!name.trim()) return setNameError('Give the group a name.');
        setNameError(undefined);
        onSubmit({ name: name.trim(), description: description.trim(), members: options.filter((o) => selected.has(keyOf(o.m))).map((o) => ({ kind: o.m.kind, id: o.m.id })), move: moving.length > 0 });
      }}
    >
      <Stack gap={3}>
        <TextField label="Group name" value={name} onChange={(e) => setName(e.target.value)} error={nameError} maxLength={80} hint='Your own bucket over real accounts, e.g. "Cash". Not a category.' />
        <TextField label="Notes" value={description} onChange={(e) => setDescription(e.target.value)} />
        <Fieldset legend="Physical accounts in this group">
          <Stack gap={2}>
            {options.length === 0 && <Text tone="muted" size="sm">No accounts yet.</Text>}
            {options.map((o) => {
              const other = otherGroupOf(o);
              return (
                <Checkbox
                  key={keyOf(o.m)}
                  label={
                    <span>
                      {o.m.name} <Badge>{o.m.source === 'up' ? 'Up (imported)' : 'Money'}</Badge>
                      {other && <Text tone="muted" size="xs" as="span"> · currently in “{other.name}”</Text>}
                    </span>
                  }
                  checked={selected.has(keyOf(o.m))}
                  onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(keyOf(o.m)); else n.delete(keyOf(o.m)); return n; })}
                />
              );
            })}
          </Stack>
        </Fieldset>
        {moving.length > 0 && (
          <Callout tone="warning">An account can be in only one group. {moving.map((o) => o.m.name).join(', ')} will move out of {[...new Set(moving.map((o) => otherGroupOf(o)?.name))].join(', ')}.</Callout>
        )}
        <ApiErrorCallout error={error} title="Not saved" />
        <Row justify="end" gap={2}>
          {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
          <Button type="submit" variant="primary" disabled={pending}>{pending ? 'Saving…' : submitLabel}</Button>
        </Row>
      </Stack>
    </Form>
  );
}

/** The logical view: the user's own groups over physical accounts. Reads and edits only Money's grouping; accounts are never changed. */
export function AccountGroupsPage() {
  const view = useAccountGroups();
  const create = useCreateAccountGroup();
  const update = useUpdateAccountGroup();
  const remove = useDeleteAccountGroup();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const header = (
    <>
      <PageHeader
        title="Logical groups"
        subtitle="Your own groupings across real accounts, such as one Cash group made of Up accounts and cash in hand. These are not categories and do not change any account."
        actions={<Button variant="primary" onClick={() => { create.reset(); setCreating(true); }}>New group</Button>}
      />
      <AccountViewNav />
    </>
  );
  if (view.isPending) return <>{header}<Loading label="Loading groups…" /></>;
  if (view.isError) return <>{header}<ApiErrorCallout error={view.error} title="Could not load your groups" /></>;
  const { groups, ungrouped } = view.data;
  const blank = { id: null, name: '', description: '', members: [] };

  return (
    <>
      {header}
      {creating && (
        <Card title="New group">
          <GroupEditor
            initial={blank}
            groups={groups}
            ungrouped={ungrouped}
            submitLabel="Create group"
            pending={create.isPending}
            error={create.error}
            onCancel={() => setCreating(false)}
            onSubmit={(d) => create.mutate({ name: d.name, description: d.description || undefined, members: d.members, move: d.move }, { onSuccess: () => setCreating(false) })}
          />
        </Card>
      )}
      {groups.length === 0 && !creating && (
        <EmptyState title="No groups yet" action={<Button variant="primary" onClick={() => setCreating(true)}>Create your first group</Button>}>
          Group physical accounts your way, for example all your cash. Each account can be in one group, so totals never count it twice.
        </EmptyState>
      )}
      {groups.map((g) => (
        <Card key={g.id} title={g.name}>
          {editing === g.id ? (
            <GroupEditor
              initial={{ id: g.id, name: g.name, description: g.description ?? '', members: g.members }}
              groups={groups}
              ungrouped={ungrouped}
              submitLabel="Save group"
              pending={update.isPending}
              error={update.error}
              onCancel={() => setEditing(null)}
              onSubmit={(d) => update.mutate({ groupId: g.id, body: { name: d.name, description: d.description || null, members: d.members, move: d.move } }, { onSuccess: () => setEditing(null) })}
            />
          ) : (
            <Stack gap={3}>
              <Row justify="between" align="start" gap={3}>
                <Stack gap={1}>
                  {g.description && <Text tone="muted" size="sm">{g.description}</Text>}
                  <Text tone="muted" size="xs">Group total, counted accounts only</Text>
                  <CurrencyLines lines={lines(g)} empty="Empty group" />
                </Stack>
                <Row gap={1}>
                  <Button size="sm" variant="ghost" onClick={() => { update.reset(); setEditing(g.id); }}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => { remove.reset(); setDeleting(g.id); }}>Delete</Button>
                </Row>
              </Row>
              {deleting === g.id && (
                <Callout tone="warning" title={`Delete “${g.name}”?`}>
                  <Stack gap={2}>
                    <Text size="sm">Its {g.members.length} account(s) go back to Ungrouped. No account or transaction is deleted.</Text>
                    <ApiErrorCallout error={remove.error} title="Not deleted" />
                    <Row gap={1}>
                      <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(g.id, { onSuccess: () => setDeleting(null) })}>Delete group</Button>
                      <Button size="sm" onClick={() => setDeleting(null)}>Cancel</Button>
                    </Row>
                  </Stack>
                </Callout>
              )}
              {g.members.length > 0 ? (
                <Table<AccountGroupMember> label={`${g.name} accounts`} columns={memberColumns} rows={g.members} rowKey={keyOf} />
              ) : (
                <Text tone="muted" size="sm">No accounts in this group yet. Edit it to add some.</Text>
              )}
            </Stack>
          )}
        </Card>
      ))}
      {ungrouped.length > 0 && (
        <Card title="Ungrouped" flush>
          <Table<AccountGroupMember> label="Ungrouped accounts" columns={memberColumns} rows={ungrouped} rowKey={keyOf} />
        </Card>
      )}
      <Card title="Everything, counted once">
        <CurrencyLines lines={lines(view.data)} />
      </Card>
      {view.data.warnings.length > 0 && (
        <Callout tone="warning" title="Some holdings are valued at cost">
          <ul>{view.data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </Callout>
      )}
      <Text tone="muted" size="sm">
        A physical account is one that really exists: a Money account you record, or an account imported read-only from Up. A category is a label on money. A group is your own bucket over physical accounts. An account sits in one group, and a Money account counts with its own ledger only (subaccounts are separate accounts). Amounts stay per currency. Personal tracking only, not tax advice.
      </Text>
    </>
  );
}
