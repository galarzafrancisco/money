import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Logical account groups (docs: apps/backend/docs/account-groups.md). A group
 * is the user's own tracking bucket over physical accounts (Money accounts and
 * imported Up accounts). It is not a category and not part of the account
 * hierarchy, and it never changes a physical account.
 *
 * - A physical account belongs to at most ONE group (partial unique indexes),
 *   so groups partition the accounts and cannot double count.
 * - A member is exactly one of a Money account or an Up account (CHECK).
 * - Composite (id, user_id) foreign keys make a cross-user reference impossible.
 * - Deleting a group, a Money account, or an Up account (purge) removes the
 *   membership rows only.
 */
export class AccountGroups1762200000000 implements MigrationInterface {
  name = 'AccountGroups1762200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "up_accounts" ADD CONSTRAINT "UQ_up_accounts_id_user" UNIQUE ("id", "user_id")`);
    await queryRunner.query(`
      CREATE TABLE "account_groups" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "name" varchar(80) NOT NULL,
        "description" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_account_groups_id_user" UNIQUE ("id", "user_id")
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_account_groups_user_name" ON "account_groups" ("user_id", lower("name"))`);
    await queryRunner.query(`
      CREATE TABLE "account_group_members" (
        "id" uuid PRIMARY KEY,
        "group_id" uuid NOT NULL,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "account_id" uuid,
        "up_account_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CK_account_group_members_one_kind" CHECK (("account_id" IS NOT NULL AND "up_account_id" IS NULL) OR ("account_id" IS NULL AND "up_account_id" IS NOT NULL)),
        CONSTRAINT "FK_account_group_members_group" FOREIGN KEY ("group_id", "user_id") REFERENCES "account_groups" ("id", "user_id") ON DELETE CASCADE,
        CONSTRAINT "FK_account_group_members_account" FOREIGN KEY ("account_id", "user_id") REFERENCES "accounts" ("id", "user_id") ON DELETE CASCADE,
        CONSTRAINT "FK_account_group_members_up_account" FOREIGN KEY ("up_account_id", "user_id") REFERENCES "up_accounts" ("id", "user_id") ON DELETE CASCADE
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_account_group_members_account" ON "account_group_members" ("account_id") WHERE "account_id" IS NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_account_group_members_up_account" ON "account_group_members" ("up_account_id") WHERE "up_account_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_account_group_members_group" ON "account_group_members" ("group_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "account_group_members"`);
    await queryRunner.query(`DROP TABLE "account_groups"`);
    await queryRunner.query(`ALTER TABLE "up_accounts" DROP CONSTRAINT "UQ_up_accounts_id_user"`);
  }
}
