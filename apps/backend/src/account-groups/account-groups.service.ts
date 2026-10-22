import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { AccountsRepository } from '../accounts/accounts.repository';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { dec, fmt } from '../common/decimal';
import { isUuid, parseInput } from '../common/validation';
import { UnitOfWork } from '../database/unit-of-work';
import { assertRatesCover, totalsOf, type FxPolicy, type TotalsView, type ValuationItem } from '../reports/aggregation';
import { reportOptionsSchema, type ReportOptionsInput } from '../reports/reports.schemas';
import { ReportsService, type AccountReportNode } from '../reports/reports.service';
import { UpRepository } from '../up/up.repository';
import type { CurrentUser } from '../users/users.service';
import { AccountGroupEntity, AccountGroupMemberEntity } from './account-group.entity';
import { AccountGroupsRepository } from './account-groups.repository';
import {
  createAccountGroupSchema,
  updateAccountGroupSchema,
  type CreateAccountGroupInput,
  type MemberRef,
  type UpdateAccountGroupInput,
} from './account-groups.schemas';

export type GroupMemberView = {
  kind: 'account' | 'up';
  id: string;
  name: string;
  source: 'manual' | 'up';
  accountType: string;
  counted: boolean;
  excludedReason: 'hidden' | 'removed' | 'linked-duplicate' | null;
  totals: TotalsView;
};

export type AccountGroupView = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  members: GroupMemberView[];
  totals: TotalsView;
  composition: { cash: string; investments: string; superannuation: string; other: string } | null;
};

export type AccountGroupsView = {
  asOf: string;
  valuation: 'market' | 'cost';
  groups: AccountGroupView[];
  ungrouped: GroupMemberView[];
  totals: TotalsView;
  warnings: string[];
  notes: string[];
};

const NOTES = [
  'Groups are your own tracking buckets over physical accounts. They are not categories and not the account hierarchy, and they never change an account.',
  'A physical account is in at most one group, and each counted account is counted once. A Money account counts with its own ledger only; its subaccounts are separate accounts you group on their own.',
  'Up accounts count as cash at their last imported balance. Hidden or removed Up accounts, and an Up account whose linked Money account is in the same group, are listed but not counted.',
  'Amounts are per currency. Converted totals only appear with baseCurrency and fxRates; the rates are yours, not looked up.',
  'Personal tracking only, not financial or tax advice.',
];

/**
 * User-defined logical groups over physical accounts (Money accounts and
 * imported Up accounts). See docs/account-groups.md for the rules.
 */
@Injectable()
export class AccountGroupsService {
  constructor(
    private readonly groups: AccountGroupsRepository,
    private readonly accounts: AccountsRepository,
    private readonly up: UpRepository,
    private readonly reports: ReportsService,
    private readonly uow: UnitOfWork,
  ) {}

  /** Every group with its members and totals, plus the physical accounts in no group */
  async list(user: CurrentUser, input: ReportOptionsInput = {}): Promise<AccountGroupsView> {
    const options = parseInput(reportOptionsSchema, input);
    if (options.rootAccountId !== undefined) throw new ValidationError('rootAccountId does not apply to groups');
    return this.build(user, options);
  }

  async get(user: CurrentUser, groupId: string, input: ReportOptionsInput = {}): Promise<AccountGroupView> {
    if (!isUuid(groupId) || !(await this.groups.find(user.id, groupId))) throw new NotFoundError(`Account group ${groupId} not found`);
    const view = await this.list(user, input);
    return view.groups.find((g) => g.id === groupId) as AccountGroupView;
  }

  async create(user: CurrentUser, input: CreateAccountGroupInput): Promise<AccountGroupView> {
    const data = parseInput(createAccountGroupSchema, input);
    const id = await this.uow.run(async (manager) => {
      if (await this.groups.nameTaken(user.id, data.name, null, manager)) throw new ConflictError(`You already have a group named "${data.name}"`);
      const group = Object.assign(new AccountGroupEntity(), { id: randomUUID(), userId: user.id, name: data.name, description: data.description ?? null });
      await this.groups.save(group, manager);
      if (data.members) await this.setMembers(user, group.id, data.members, data.move ?? false, manager);
      return group.id;
    });
    return this.get(user, id);
  }

  async update(user: CurrentUser, groupId: string, input: UpdateAccountGroupInput): Promise<AccountGroupView> {
    const data = parseInput(updateAccountGroupSchema, input);
    await this.uow.run(async (manager) => {
      const group = isUuid(groupId) ? await this.groups.findForUpdate(user.id, groupId, manager) : null;
      if (!group) throw new NotFoundError(`Account group ${groupId} not found`);
      if (data.name !== undefined && (await this.groups.nameTaken(user.id, data.name, group.id, manager))) {
        throw new ConflictError(`You already have a group named "${data.name}"`);
      }
      if (data.name !== undefined) group.name = data.name;
      if (data.description !== undefined) group.description = data.description ?? null;
      await this.groups.save(group, manager);
      if (data.members) await this.setMembers(user, group.id, data.members, data.move ?? false, manager);
    });
    return this.get(user, groupId);
  }

  /** Deleting a group releases its accounts; the accounts themselves are untouched */
  async delete(user: CurrentUser, groupId: string): Promise<{ deleted: true; membersReleased: number }> {
    return this.uow.run(async (manager) => {
      const group = isUuid(groupId) ? await this.groups.findForUpdate(user.id, groupId, manager) : null;
      if (!group) throw new NotFoundError(`Account group ${groupId} not found`);
      const released = (await this.groups.listMembers(user.id, manager)).filter((m) => m.groupId === group.id).length;
      await this.groups.delete(user.id, group.id, manager);
      return { deleted: true as const, membersReleased: released };
    });
  }

  /** Replaces the group's membership. Runs inside the caller's transaction, with the group row locked */
  private async setMembers(user: CurrentUser, groupId: string, refs: MemberRef[], move: boolean, manager: EntityManager): Promise<void> {
    const seen = new Set<string>();
    const unique = refs.filter((r) => !seen.has(`${r.kind}:${r.id}`) && seen.add(`${r.kind}:${r.id}`));
    const rows: AccountGroupMemberEntity[] = [];
    for (const ref of unique) {
      const exists = isUuid(ref.id)
        ? ref.kind === 'account'
          ? await this.accounts.find(user.id, ref.id, manager)
          : await this.up.findAccount(user.id, ref.id, manager)
        : null;
      if (!exists) throw new NotFoundError(`${ref.kind === 'account' ? 'Account' : 'Up account'} ${ref.id} not found`);
      rows.push(
        Object.assign(new AccountGroupMemberEntity(), {
          id: randomUUID(),
          groupId,
          userId: user.id,
          accountId: ref.kind === 'account' ? ref.id : null,
          upAccountId: ref.kind === 'up' ? ref.id : null,
        }),
      );
    }
    const taken = (await this.groups.listMembers(user.id, manager)).filter((m) => m.groupId !== groupId);
    const takenIds = new Map(taken.map((m) => [m.accountId ?? m.upAccountId, m.groupId]));
    const clashes = rows.filter((r) => takenIds.has(r.accountId ?? r.upAccountId));
    if (clashes.length > 0 && !move) {
      throw new ConflictError('Some accounts are already in another group. An account can be in only one group; pass move: true to move them.', {
        accounts: clashes.map((r) => ({ kind: r.accountId ? 'account' : 'up', id: r.accountId ?? r.upAccountId, groupId: takenIds.get(r.accountId ?? r.upAccountId) })),
      });
    }
    for (const r of clashes) {
      await this.groups.removeAccountFromAnyGroup(user.id, r.accountId ? { accountId: r.accountId } : { upAccountId: r.upAccountId as string }, manager);
    }
    await this.groups.removeMembers(user.id, groupId, manager);
    try {
      for (const row of rows) await this.groups.addMember(row, manager);
    } catch (error) {
      // A concurrent request put the same account in another group first (UQ_account_group_members_*)
      if (String((error as { code?: string }).code) === '23505') throw new ConflictError('An account was just added to another group. Try again.');
      throw error;
    }
  }

  private async build(user: CurrentUser, options: ReturnType<typeof reportOptionsSchema.parse>): Promise<AccountGroupsView> {
    const [report, groups, members, upAccounts, accounts] = await Promise.all([
      this.reports.accountsReport(user, { valuation: options.valuation, baseCurrency: options.baseCurrency, fxRates: options.fxRates }),
      this.groups.list(user.id),
      this.groups.listMembers(user.id),
      this.up.listAccounts(user.id, null),
      this.accounts.list(user.id),
    ]);
    const fx: FxPolicy | null = options.baseCurrency ? { baseCurrency: options.baseCurrency, rates: options.fxRates ?? {} } : null;
    const nodes = new Map<string, AccountReportNode>();
    const walk = (list: AccountReportNode[]) => list.forEach((n) => (nodes.set(n.id, n), walk(n.children)));
    walk(report.accounts);

    type Physical = { view: GroupMemberView; items: ValuationItem[]; upLinked: string | null };
    const physical = new Map<string, Physical>();
    for (const account of accounts) {
      const node = nodes.get(account.id);
      const items: ValuationItem[] = (node?.items ?? []).map((i) => ({
        accountId: account.id,
        kind: i.kind,
        symbol: i.symbol,
        currency: i.currency,
        value: dec(i.value),
        basis: i.basis,
      }));
      physical.set(`account:${account.id}`, {
        view: { kind: 'account', id: account.id, name: account.name, source: 'manual', accountType: account.type, counted: true, excludedReason: null, totals: totalsOf(items, fx) },
        items,
        upLinked: null,
      });
    }
    for (const up of upAccounts) {
      const items: ValuationItem[] = [{ accountId: up.id, kind: 'cash', symbol: null, currency: up.currency, value: dec(up.balance), basis: 'cash' }];
      const reason = up.removedAt ? 'removed' : !up.visible ? 'hidden' : null;
      physical.set(`up:${up.id}`, {
        view: { kind: 'up', id: up.id, name: up.displayName, source: 'up', accountType: up.accountType, counted: reason === null, excludedReason: reason, totals: totalsOf(items, fx) },
        items,
        upLinked: up.linkedAccountId,
      });
    }

    const groupOf = new Map<string, string>();
    const byGroup = new Map<string, Physical[]>();
    for (const m of members) {
      const key = m.accountId ? `account:${m.accountId}` : `up:${m.upAccountId}`;
      const p = physical.get(key);
      if (!p) continue;
      groupOf.set(key, m.groupId);
      byGroup.set(m.groupId, [...(byGroup.get(m.groupId) ?? []), p]);
    }

    const counted = (list: Physical[]) => list.filter((p) => p.view.counted);
    const groupViews = groups.map((g): AccountGroupView => {
      const list = byGroup.get(g.id) ?? [];
      const manualIds = new Set(list.filter((p) => p.view.kind === 'account').map((p) => p.view.id));
      for (const p of list) {
        if (p.view.kind === 'up' && p.view.counted && p.upLinked && manualIds.has(p.upLinked)) {
          p.view = { ...p.view, counted: false, excludedReason: 'linked-duplicate' };
        }
      }
      const items = counted(list).flatMap((p) => p.items);
      assertRatesCover(items, fx);
      const composition = fx
        ? {
            cash: kindTotal(list, 'CASH', fx),
            investments: kindTotal(list, 'INVESTMENT', fx),
            superannuation: kindTotal(list, 'SUPERANNUATION', fx),
            other: kindTotal(list, 'OTHER', fx),
          }
        : null;
      return {
        id: g.id,
        name: g.name,
        description: g.description,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        members: list.map((p) => p.view).sort((a, b) => a.name.localeCompare(b.name)),
        totals: totalsOf(items, fx),
        composition,
      };
    });
    const ungrouped = [...physical.entries()].filter(([key]) => !groupOf.has(key)).map(([, p]) => p);
    const allItems = [...groupViews.flatMap((g) => (byGroup.get(g.id) ?? []).filter((p) => p.view.counted).flatMap((p) => p.items)), ...counted(ungrouped).flatMap((p) => p.items)];
    assertRatesCover(allItems, fx);
    return {
      asOf: report.asOf,
      valuation: report.valuation,
      groups: groupViews,
      ungrouped: ungrouped.map((p) => p.view).sort((a, b) => a.name.localeCompare(b.name)),
      totals: totalsOf(allItems, fx),
      warnings: report.warnings,
      notes: NOTES,
    };
  }
}

/** Converted total of the counted members of one kind (Up accounts are cash) */
function kindTotal(list: { view: GroupMemberView; items: ValuationItem[] }[], kind: 'CASH' | 'INVESTMENT' | 'SUPERANNUATION' | 'OTHER', fx: FxPolicy): string {
  const items = list
    .filter((p) => p.view.counted && (p.view.kind === 'up' ? kind === 'CASH' : p.view.accountType === kind))
    .flatMap((p) => p.items);
  return totalsOf(items, fx).converted?.total ?? fmt(dec(0));
}
