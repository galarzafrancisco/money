import type { Category } from '@money/client';
import { moneyErrorOf } from '@money/client';
import { useState } from 'react';
import { Button, Callout, Card, EmptyState, Form, Grid, Loading, Row, Stack, Swatch, Table, Text, TextField } from '../../ui';
import { ApiErrorCallout, errorCode } from '../shared/ApiErrorCallout';
import { PageHeader } from '../shared/PageHeader';
import { useCategories, useCreateCategory, useDeleteCategory, useUpdateCategory } from './data';

const COLOR = /^#[0-9a-fA-F]{6}$/;

type Draft = { name: string; description: string; color: string };

function validate(draft: Draft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = 'Give the category a name.';
  else if (draft.name.trim().length > 80) errors.name = 'Use at most 80 characters.';
  if (draft.color.trim() && !COLOR.test(draft.color.trim())) errors.color = 'Use a #rrggbb colour, e.g. #4f9d69.';
  return errors;
}

function CategoryForm({ initial, submitLabel, pending, error, onSubmit, onCancel }: { initial: Draft; submitLabel: string; pending: boolean; error: unknown; onSubmit: (draft: Draft) => void; onCancel?: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof Draft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: e.target.value }));
  return (
    <Form
      label={submitLabel}
      onSubmit={() => {
        const found = validate(draft);
        setErrors(found);
        if (Object.keys(found).length === 0) onSubmit(draft);
      }}
    >
      <Stack gap={3}>
        <Grid size="narrow">
          <TextField label="Name" value={draft.name} onChange={set('name')} error={errors.name} maxLength={80} hint='e.g. "boring-etf" or "emergency"' />
          <TextField label="Colour" value={draft.color} onChange={set('color')} error={errors.color} placeholder="#4f9d69" hint="Optional, for dashboards." />
        </Grid>
        <TextField label="Description" value={draft.description} onChange={set('description')} />
        <ApiErrorCallout error={error} title="Not saved" />
        <Row justify="end" gap={2}>
          {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
          <Button type="submit" variant="primary" disabled={pending}>{pending ? 'Saving…' : submitLabel}</Button>
        </Row>
      </Stack>
    </Form>
  );
}

/** Your own labels for grouping accounts and holdings in reports */
export function CategoriesPage() {
  const categories = useCategories();
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const remove = useDeleteCategory();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [createKey, setCreateKey] = useState(0);

  const deleteConflict = errorCode(remove.error) === 'conflict' ? moneyErrorOf(remove.error)?.details : undefined;

  return (
    <>
      <PageHeader title="Categories" subtitle="Group accounts and holdings your own way. A holding uses its own category, else its account's, else the nearest parent account's." />
      <Card title="New category">
        <CategoryForm
          key={createKey}
          initial={{ name: '', description: '', color: '' }}
          submitLabel="Add category"
          pending={create.isPending}
          error={create.error}
          onSubmit={(d) =>
            create.mutate(
              { name: d.name.trim(), description: d.description.trim() || undefined, color: d.color.trim() || undefined },
              { onSuccess: () => setCreateKey((k) => k + 1) },
            )
          }
        />
      </Card>
      <Card title="Your categories" flush>
        {categories.isPending && <Loading />}
        {categories.isError && <ApiErrorCallout error={categories.error} />}
        {categories.data && categories.data.length === 0 && <EmptyState title="No categories yet">Add one above, then assign it to accounts or holdings.</EmptyState>}
        {categories.data && categories.data.length > 0 && (
          <Table<Category>
            label="Categories"
            rows={categories.data}
            rowKey={(c) => c.id}
            columns={[
              {
                key: 'name',
                header: 'Name',
                render: (c) =>
                  editing === c.id ? (
                    <CategoryForm
                      initial={{ name: c.name, description: c.description ?? '', color: c.color ?? '' }}
                      submitLabel="Save"
                      pending={update.isPending}
                      error={update.error}
                      onCancel={() => setEditing(null)}
                      onSubmit={(d) =>
                        update.mutate(
                          { categoryId: c.id, body: { name: d.name.trim(), description: d.description.trim() || null, color: d.color.trim() || null } },
                          { onSuccess: () => setEditing(null) },
                        )
                      }
                    />
                  ) : (
                    <Stack gap={1}>
                      <Row gap={2}><Swatch color={c.color} /> <Text strong as="span">{c.name}</Text></Row>
                      {c.description && <Text tone="muted" size="sm">{c.description}</Text>}
                    </Stack>
                  ),
              },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                render: (c) =>
                  editing === c.id ? null : deleting === c.id ? (
                    <Stack gap={2}>
                      {deleteConflict ? (
                        <Callout tone="warning">
                          Used by {String(deleteConflict.accounts)} account(s) and {String(deleteConflict.holdings)} holding(s). Deleting clears those, and they inherit their category again.
                        </Callout>
                      ) : (
                        <ApiErrorCallout error={remove.error} title="Not deleted" />
                      )}
                      <Row gap={1}>
                        <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate({ categoryId: c.id, unassign: Boolean(deleteConflict) }, { onSuccess: () => setDeleting(null) })}>
                          {deleteConflict ? 'Unassign and delete' : 'Confirm delete'}
                        </Button>
                        <Button size="sm" onClick={() => { setDeleting(null); remove.reset(); }}>Cancel</Button>
                      </Row>
                    </Stack>
                  ) : (
                    <Row gap={1}>
                      <Button size="sm" variant="ghost" onClick={() => { update.reset(); setEditing(c.id); }}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => { remove.reset(); setDeleting(c.id); }}>Delete</Button>
                    </Row>
                  ),
              },
            ]}
          />
        )}
      </Card>
    </>
  );
}
