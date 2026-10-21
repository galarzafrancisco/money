import type { Account } from '@money/client';
import { Link, Outlet, useOutletContext, useParams } from 'react-router';
import { InAppNav } from '../../app/InAppNav';
import { Badge, ButtonLink, EmptyState, Loading, Row, Text } from '../../ui';
import { ApiErrorCallout, errorCode } from '../shared/ApiErrorCallout';
import { PageHeader } from '../shared/PageHeader';
import { ACCOUNT_TYPE_LABELS, accountPath, useAccount, useAccounts } from './data';

export type AccountContext = { account: Account; accounts: Account[] };

export function useAccountContext(): AccountContext {
  return useOutletContext<AccountContext>();
}

/** One account: header, in-app sections, and the selected section */
export function AccountLayout() {
  const { accountId = '' } = useParams();
  const account = useAccount(accountId);
  const accounts = useAccounts();

  if (account.isPending) return <Loading label="Loading account…" />;
  if (account.isError) {
    if (errorCode(account.error) === 'not_found') {
      return (
        <EmptyState title="Account not found" action={<ButtonLink to="/accounts">Back to accounts</ButtonLink>}>
          It may have been deleted.
        </EmptyState>
      );
    }
    return <ApiErrorCallout error={account.error} title="Could not load this account" />;
  }

  const all = accounts.data ?? [account.data];
  const path = accountPath(account.data.id, all).slice(0, -1);
  const base = `/accounts/${account.data.id}`;

  return (
    <>
      <PageHeader
        eyebrow={
          <nav aria-label="Breadcrumb">
            <Row gap={1}>
              <Link to="/accounts">Accounts</Link>
              {path.map((a) => (
                <span key={a.id}>
                  {' / '}
                  <Link to={`/accounts/${a.id}`}>{a.name}</Link>
                </span>
              ))}
            </Row>
          </nav>
        }
        title={account.data.name}
        subtitle={
          <Row gap={2} as="span">
            <Badge>{ACCOUNT_TYPE_LABELS[account.data.type]}</Badge>
            <Text tone="muted" size="sm" as="span">
              Reports in {account.data.reportingCurrency}
            </Text>
            {account.data.description && (
              <Text tone="muted" size="sm" as="span">
                · {account.data.description}
              </Text>
            )}
          </Row>
        }
        actions={
          <ButtonLink to={`${base}/record`} variant="primary">
            Record activity
          </ButtonLink>
        }
      />
      <InAppNav
        label="Account sections"
        items={[
          { to: base, label: 'Overview', end: true },
          { to: `${base}/transactions`, label: 'Transactions' },
          { to: `${base}/lots`, label: 'Lots' },
          { to: `${base}/subaccounts`, label: 'Subaccounts' },
          { to: `${base}/transfers`, label: 'Transfers' },
          { to: `${base}/settings`, label: 'Settings' },
        ]}
      />
      <Outlet context={{ account: account.data, accounts: all } satisfies AccountContext} />
    </>
  );
}
