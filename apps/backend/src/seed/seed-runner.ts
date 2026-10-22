import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccountsService } from '../accounts/accounts.service';
import { CategoriesService } from '../categories/categories.service';
import { addDays } from '../market-prices/market-calendar';
import { TransactionsService } from '../transactions/transactions.service';
import type { RecordTransactionInput } from '../transactions/transactions.schemas';
import { TransfersService } from '../transfers/transfers.service';
import { UsersRepository } from '../users/users.repository';
import type { CurrentUser } from '../users/users.service';
import { SEED_MARKER, SEED_SUBJECT_PREFIX, type SeedUser } from './seed-dataset';

/** Seeding was refused to protect records that are not synthetic */
export class SeedRefusedError extends Error {}

export type SeedTarget = {
  user: SeedUser;
  /** Seed this identity instead of the dataset's synthetic one (e.g. your own local Taico subject) */
  subject?: string;
};

export type SeededUser = {
  key: string;
  purpose: SeedUser['purpose'];
  userId: string;
  issuer: string;
  subject: string;
  accounts: Record<string, string>;
  categories: Record<string, string>;
  transactions: number;
  transfers: number;
};

/**
 * Writes the synthetic dataset through the same services REST and MCP use,
 * so every record passes the usual validation and ledger replay. Not part of
 * AppModule: only the seed CLI and tests build one, from an app context.
 *
 * Safety: a target identity is only reset or seeded when every account and
 * category it already has carries SEED_MARKER. Anything else is a real
 * user's record, and the runner refuses to touch it.
 */
export class SeedRunner {
  constructor(
    private readonly users: UsersRepository,
    private readonly accounts: AccountsService,
    private readonly categories: CategoriesService,
    private readonly transactions: TransactionsService,
    private readonly transfers: TransfersService,
    private readonly dataSource: DataSource,
  ) {}

  static fromApp(app: INestApplicationContext): SeedRunner {
    return new SeedRunner(
      app.get(UsersRepository),
      app.get(AccountsService),
      app.get(CategoriesService),
      app.get(TransactionsService),
      app.get(TransfersService),
      app.get(DataSource),
    );
  }

  /** Deletes the targets' synthetic records, then seeds them again. Same input, same data (IDs aside). */
  async reseed(issuer: string, anchor: string, targets: readonly SeedTarget[]): Promise<SeededUser[]> {
    await this.reset(issuer, targets);
    const seeded: SeededUser[] = [];
    for (const target of targets) seeded.push(await this.seedOne(issuer, anchor, target));
    return seeded;
  }

  /**
   * Removes the targets' synthetic records. A synthetic identity's user row
   * goes too (its derived valuations cascade). An identity given with
   * `subject` keeps its user row and sign-in sessions; its records and
   * derived valuations are deleted.
   */
  async reset(issuer: string, targets: readonly SeedTarget[]): Promise<{ subject: string; deleted: boolean }[]> {
    // Check every target before deleting anything
    const found: { subject: string; user: CurrentUser | null; synthetic: boolean }[] = [];
    for (const target of targets) {
      const subject = target.subject ?? target.user.subject;
      const user = await this.findUser(issuer, subject);
      if (user) await this.assertOnlySynthetic(user);
      found.push({ subject, user, synthetic: subject.startsWith(SEED_SUBJECT_PREFIX) });
    }
    const result: { subject: string; deleted: boolean }[] = [];
    for (const { subject, user, synthetic } of found) {
      if (!user) {
        result.push({ subject, deleted: false });
        continue;
      }
      if (synthetic) {
        await this.dataSource.query('DELETE FROM users WHERE id = $1', [user.id]);
      } else {
        await this.deleteRecords(user);
      }
      result.push({ subject, deleted: true });
    }
    return result;
  }

  private async seedOne(issuer: string, anchor: string, target: SeedTarget): Promise<SeededUser> {
    const { user: data } = target;
    const subject = target.subject ?? data.subject;
    const user = target.subject
      ? ((await this.findUser(issuer, subject)) ?? (await this.createUser(issuer, subject, null, null)))
      : await this.createUser(issuer, subject, data.displayName, data.email);
    await this.assertOnlySynthetic(user);

    const categoryIds: Record<string, string> = {};
    for (const category of data.categories) {
      const created = await this.categories.create(user, { name: category.name, description: marked(category.description), color: category.color });
      categoryIds[category.key] = created.id;
    }

    // Parents are listed before their subaccounts
    const accountIds: Record<string, string> = {};
    for (const account of data.accounts) {
      const created = await this.accounts.create(user, {
        name: account.name,
        type: account.type,
        reportingCurrency: account.reportingCurrency,
        description: marked(account.description),
        parentAccountId: account.parent ? required(accountIds, account.parent, 'account') : undefined,
        categoryId: account.category ? required(categoryIds, account.category, 'category') : undefined,
      });
      accountIds[account.key] = created.id;
    }

    for (const assignment of data.holdingCategories) {
      await this.categories.setHoldingCategory(user, required(accountIds, assignment.account, 'account'), {
        symbol: assignment.symbol,
        categoryId: required(categoryIds, assignment.category, 'category'),
      });
    }

    // Oldest first (stable within a day), so every write replays to a valid ledger
    const activity = data.activity.map((item, index) => ({ item, index })).sort((a, b) => b.item.daysAgo - a.item.daysAgo || a.index - b.index);
    const lotIds: Record<string, string> = {};
    let transactions = 0;
    let transfers = 0;
    for (const { item } of activity) {
      const date = addDays(anchor, -item.daysAgo);
      if (item.kind === 'transfer') {
        await this.transfers.record(user, {
          ...item.input,
          fromAccountId: required(accountIds, item.from, 'account'),
          toAccountId: required(accountIds, item.to, 'account'),
          date,
        });
        transfers++;
        continue;
      }
      const { allocations, ...input } = item.input as typeof item.input & { allocations?: { lot: string; quantity: string }[] };
      const body = {
        ...input,
        date,
        ...(allocations ? { allocations: allocations.map((a) => ({ lotId: required(lotIds, a.lot, 'lot'), quantity: a.quantity })) } : {}),
      } as RecordTransactionInput;
      const created = await this.transactions.record(user, required(accountIds, item.account, 'account'), body);
      if (item.key) lotIds[item.key] = created.id;
      transactions++;
    }

    return { key: data.key, purpose: data.purpose, userId: user.id, issuer, subject, accounts: accountIds, categories: categoryIds, transactions, transfers };
  }

  private async findUser(issuer: string, subject: string): Promise<CurrentUser | null> {
    const row = await this.users.findByIdentity(issuer, subject);
    return row ? { id: row.id, issuer, subject, displayName: row.displayName, email: row.email } : null;
  }

  private async createUser(issuer: string, subject: string, displayName: string | null, email: string | null): Promise<CurrentUser> {
    const row = await this.users.upsertIdentity({ issuer, subject, displayName, email });
    return { id: row.id, issuer, subject, displayName: row.displayName, email: row.email };
  }

  private async assertOnlySynthetic(user: CurrentUser): Promise<void> {
    const accounts = await this.accounts.list(user);
    const categories = await this.categories.list(user);
    const real = [
      ...accounts.filter((a) => !a.description?.startsWith(SEED_MARKER)).map((a) => `account "${a.name}"`),
      ...categories.filter((c) => !c.description?.startsWith(SEED_MARKER)).map((c) => `category "${c.name}"`),
    ];
    if (real.length > 0) {
      throw new SeedRefusedError(
        `Refusing to touch ${user.issuer} / ${user.subject}: it has records that are not synthetic seed data (${real.slice(0, 5).join(', ')}${real.length > 5 ? ', …' : ''}). Seed a different identity.`,
      );
    }
  }

  /**
   * Deletes all of an identity's records, keeping the user row (and so its
   * sign-in sessions). Called only after assertOnlySynthetic. Done in one
   * database transaction rather than record by record through the services:
   * deleting one transfer or deposit at a time would leave intermediate
   * ledgers that fail replay. Valuation snapshots are derived data; the job
   * rebuilds them.
   */
  private async deleteRecords(user: CurrentUser): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      for (const table of ['transfers', 'transactions', 'accounts', 'categories', 'valuation_days', 'valuation_recompute_requests']) {
        // Transfer legs, lot allocations, holding categories and valuation holdings cascade
        await manager.query(`DELETE FROM "${table}" WHERE user_id = $1`, [user.id]);
      }
    });
  }
}

function marked(description: string): string {
  return `${SEED_MARKER} ${description}`;
}

function required(ids: Record<string, string>, key: string, what: string): string {
  const id = ids[key];
  if (!id) throw new Error(`Seed dataset error: unknown ${what} key "${key}"`);
  return id;
}
