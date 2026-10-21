import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subaccounts (an account's optional parent) and user-defined categories that
 * can be assigned to accounts and to holdings (account + symbol).
 *
 * Composite foreign keys on (id, user_id) make a reference to another user's
 * account or category impossible in the database, not only in the services.
 */
export class SubaccountsAndCategories1761100000000 implements MigrationInterface {
  name = 'SubaccountsAndCategories1761100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounts" ADD CONSTRAINT "UQ_accounts_id_user" UNIQUE ("id", "user_id")`);

    await queryRunner.query(`
      CREATE TABLE "categories" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "name" varchar(80) NOT NULL,
        "description" text,
        "color" varchar(7),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_categories_id_user" UNIQUE ("id", "user_id"),
        CONSTRAINT "CHK_categories_color" CHECK ("color" IS NULL OR "color" ~ '^#[0-9a-fA-F]{6}$')
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_categories_user_name" ON "categories" ("user_id", lower("name"))`);

    await queryRunner.query(`ALTER TABLE "accounts" ADD COLUMN "parent_account_id" uuid`);
    await queryRunner.query(`ALTER TABLE "accounts" ADD COLUMN "category_id" uuid`);
    await queryRunner.query(`
      ALTER TABLE "accounts" ADD CONSTRAINT "FK_accounts_parent"
        FOREIGN KEY ("parent_account_id", "user_id") REFERENCES "accounts" ("id", "user_id")`);
    await queryRunner.query(`
      ALTER TABLE "accounts" ADD CONSTRAINT "FK_accounts_category"
        FOREIGN KEY ("category_id", "user_id") REFERENCES "categories" ("id", "user_id") ON DELETE SET NULL ("category_id")`);
    await queryRunner.query(`ALTER TABLE "accounts" ADD CONSTRAINT "CHK_accounts_not_own_parent" CHECK ("parent_account_id" IS NULL OR "parent_account_id" <> "id")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounts_parent" ON "accounts" ("parent_account_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_accounts_category" ON "accounts" ("category_id")`);

    // Names are unique among siblings: two banks can each have a "Term Deposit 1"
    await queryRunner.query(`DROP INDEX "UQ_accounts_user_name"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_accounts_user_parent_name" ON "accounts"
        ("user_id", COALESCE("parent_account_id", '00000000-0000-0000-0000-000000000000'::uuid), lower("name"))`);

    await queryRunner.query(`
      CREATE TABLE "holding_categories" (
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "account_id" uuid NOT NULL,
        "symbol" varchar(32) NOT NULL,
        "category_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_holding_categories" PRIMARY KEY ("account_id", "symbol"),
        CONSTRAINT "FK_holding_categories_account" FOREIGN KEY ("account_id", "user_id") REFERENCES "accounts" ("id", "user_id") ON DELETE CASCADE,
        CONSTRAINT "FK_holding_categories_category" FOREIGN KEY ("category_id", "user_id") REFERENCES "categories" ("id", "user_id") ON DELETE CASCADE
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_holding_categories_user" ON "holding_categories" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_holding_categories_category" ON "holding_categories" ("category_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "holding_categories"`);
    await queryRunner.query(`DROP INDEX "UQ_accounts_user_parent_name"`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_accounts_user_name" ON "accounts" ("user_id", lower("name"))`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP CONSTRAINT "CHK_accounts_not_own_parent"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP CONSTRAINT "FK_accounts_category"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP CONSTRAINT "FK_accounts_parent"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "category_id"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "parent_account_id"`);
    await queryRunner.query(`DROP TABLE "categories"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP CONSTRAINT "UQ_accounts_id_user"`);
  }
}
