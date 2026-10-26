import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tax ledger and depreciating assets (docs: apps/backend/docs/tax.md).
 *
 * - tax_items: the user's proposed tax positions (claim intent), each in one
 *   Australian financial year (start_year 2026 = FY 2026-27).
 * - tax_assets / tax_asset_years: the depreciating asset register and its
 *   per-year use percentage, review state and claimed figure. Depreciation
 *   itself is derived from these inputs and never stored.
 * - tax_source_links: an item or asset linked to a Money transaction or an
 *   imported Up transaction, without copying it. The transaction's deletion
 *   removes the link (the item then shows as unmatched).
 * - tax_evidence_links: labelled URLs only; there is no file storage.
 * - tax_returns / tax_return_filings: per-year preparation and filing state,
 *   with immutable jsonb snapshots of what was filed (original, amendments).
 *
 * Every table is user-owned with ON DELETE CASCADE from users, and every
 * cross-row reference is a composite (id, user_id) foreign key.
 */
export class TaxLedger1762500000000 implements MigrationInterface {
  name = 'TaxLedger1762500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "transactions" ADD CONSTRAINT "UQ_transactions_id_user" UNIQUE ("id", "user_id")`);
    await queryRunner.query(`ALTER TABLE "up_transactions" ADD CONSTRAINT "UQ_up_transactions_id_user" UNIQUE ("id", "user_id")`);

    await queryRunner.query(`
      CREATE TABLE "tax_returns" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "jurisdiction" varchar(4) NOT NULL DEFAULT 'AU',
        "start_year" integer NOT NULL,
        "status" varchar(12) NOT NULL DEFAULT 'PREPARING',
        "notes" text,
        "amending_reason" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_tax_returns_id_user" UNIQUE ("id", "user_id"),
        CONSTRAINT "UQ_tax_returns_user_year" UNIQUE ("user_id", "jurisdiction", "start_year"),
        CONSTRAINT "CK_tax_returns_status" CHECK ("status" IN ('PREPARING', 'FILED', 'AMENDING'))
      )`);

    await queryRunner.query(`
      CREATE TABLE "tax_return_filings" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "return_id" uuid NOT NULL,
        "version" integer NOT NULL,
        "kind" varchar(12) NOT NULL,
        "filed_on" date NOT NULL,
        "reference" varchar(120),
        "note" text,
        "snapshot" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_tax_return_filings_version" UNIQUE ("return_id", "version"),
        CONSTRAINT "CK_tax_return_filings_kind" CHECK ("kind" IN ('ORIGINAL', 'AMENDMENT')),
        CONSTRAINT "FK_tax_return_filings_return" FOREIGN KEY ("return_id", "user_id") REFERENCES "tax_returns" ("id", "user_id") ON DELETE CASCADE
      )`);

    await queryRunner.query(`
      CREATE TABLE "tax_items" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "start_year" integer NOT NULL,
        "kind" varchar(12) NOT NULL,
        "category" varchar(60) NOT NULL,
        "description" varchar(500) NOT NULL,
        "incurred_on" date,
        "currency" varchar(3) NOT NULL DEFAULT 'AUD',
        "amount" numeric(30,10),
        "claim_percent" numeric(30,10) NOT NULL DEFAULT 100,
        "status" varchar(12) NOT NULL DEFAULT 'TO_REVIEW',
        "rationale" text,
        "notes" text,
        "claimed_amount" numeric(30,10),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_tax_items_id_user" UNIQUE ("id", "user_id"),
        CONSTRAINT "CK_tax_items_kind" CHECK ("kind" IN ('DEDUCTION', 'INCOME', 'OFFSET', 'OTHER')),
        CONSTRAINT "CK_tax_items_status" CHECK ("status" IN ('TO_REVIEW', 'CONFIRMED', 'EXCLUDED')),
        CONSTRAINT "CK_tax_items_claim_percent" CHECK ("claim_percent" >= 0 AND "claim_percent" <= 100),
        CONSTRAINT "CK_tax_items_amount" CHECK ("amount" IS NULL OR "amount" >= 0),
        CONSTRAINT "CK_tax_items_claimed" CHECK ("claimed_amount" IS NULL OR "claimed_amount" >= 0)
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_tax_items_user_year" ON "tax_items" ("user_id", "start_year")`);

    await queryRunner.query(`
      CREATE TABLE "tax_assets" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "name" varchar(200) NOT NULL,
        "description" text,
        "category" varchar(60) NOT NULL,
        "currency" varchar(3) NOT NULL DEFAULT 'AUD',
        "cost" numeric(30,10) NOT NULL,
        "acquired_on" date NOT NULL,
        "first_used_on" date,
        "method" varchar(20) NOT NULL,
        "effective_life_years" numeric(30,10),
        "rate_percent" numeric(30,10),
        "default_use_percent" numeric(30,10) NOT NULL DEFAULT 100,
        "ownership" text,
        "disposed_on" date,
        "disposal_proceeds" numeric(30,10),
        "notes" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_tax_assets_id_user" UNIQUE ("id", "user_id"),
        CONSTRAINT "CK_tax_assets_method" CHECK ("method" IN ('PRIME_COST', 'DIMINISHING_VALUE', 'IMMEDIATE')),
        CONSTRAINT "CK_tax_assets_rate_source" CHECK ("method" = 'IMMEDIATE' OR "effective_life_years" IS NOT NULL OR "rate_percent" IS NOT NULL),
        CONSTRAINT "CK_tax_assets_cost" CHECK ("cost" > 0),
        CONSTRAINT "CK_tax_assets_life" CHECK ("effective_life_years" IS NULL OR "effective_life_years" > 0),
        CONSTRAINT "CK_tax_assets_rate" CHECK ("rate_percent" IS NULL OR ("rate_percent" > 0 AND "rate_percent" <= 100)),
        CONSTRAINT "CK_tax_assets_use" CHECK ("default_use_percent" >= 0 AND "default_use_percent" <= 100),
        CONSTRAINT "CK_tax_assets_first_used" CHECK ("first_used_on" IS NULL OR "first_used_on" >= "acquired_on"),
        CONSTRAINT "CK_tax_assets_disposed" CHECK ("disposed_on" IS NULL OR "disposed_on" >= coalesce("first_used_on", "acquired_on")),
        CONSTRAINT "CK_tax_assets_proceeds" CHECK ("disposal_proceeds" IS NULL OR "disposal_proceeds" >= 0)
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_tax_assets_user" ON "tax_assets" ("user_id")`);

    await queryRunner.query(`
      CREATE TABLE "tax_asset_years" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "asset_id" uuid NOT NULL,
        "start_year" integer NOT NULL,
        "use_percent" numeric(30,10),
        "status" varchar(12) NOT NULL DEFAULT 'TO_REVIEW',
        "claimed_amount" numeric(30,10),
        "note" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_tax_asset_years_asset_year" UNIQUE ("asset_id", "start_year"),
        CONSTRAINT "CK_tax_asset_years_status" CHECK ("status" IN ('TO_REVIEW', 'CONFIRMED', 'EXCLUDED')),
        CONSTRAINT "CK_tax_asset_years_use" CHECK ("use_percent" IS NULL OR ("use_percent" >= 0 AND "use_percent" <= 100)),
        CONSTRAINT "CK_tax_asset_years_claimed" CHECK ("claimed_amount" IS NULL OR "claimed_amount" >= 0),
        CONSTRAINT "FK_tax_asset_years_asset" FOREIGN KEY ("asset_id", "user_id") REFERENCES "tax_assets" ("id", "user_id") ON DELETE CASCADE
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_tax_asset_years_user" ON "tax_asset_years" ("user_id")`);

    await queryRunner.query(`
      CREATE TABLE "tax_source_links" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "item_id" uuid,
        "asset_id" uuid,
        "transaction_id" uuid,
        "up_transaction_id" uuid,
        "note" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CK_tax_source_links_owner" CHECK (("item_id" IS NULL) <> ("asset_id" IS NULL)),
        CONSTRAINT "CK_tax_source_links_source" CHECK (("transaction_id" IS NULL) <> ("up_transaction_id" IS NULL)),
        CONSTRAINT "FK_tax_source_links_item" FOREIGN KEY ("item_id", "user_id") REFERENCES "tax_items" ("id", "user_id") ON DELETE CASCADE,
        CONSTRAINT "FK_tax_source_links_asset" FOREIGN KEY ("asset_id", "user_id") REFERENCES "tax_assets" ("id", "user_id") ON DELETE CASCADE,
        CONSTRAINT "FK_tax_source_links_transaction" FOREIGN KEY ("transaction_id", "user_id") REFERENCES "transactions" ("id", "user_id") ON DELETE CASCADE,
        CONSTRAINT "FK_tax_source_links_up_transaction" FOREIGN KEY ("up_transaction_id", "user_id") REFERENCES "up_transactions" ("id", "user_id") ON DELETE CASCADE
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_tax_source_links_user" ON "tax_source_links" ("user_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_tax_source_links_item_tx" ON "tax_source_links" ("item_id", "transaction_id") WHERE "item_id" IS NOT NULL AND "transaction_id" IS NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_tax_source_links_item_up" ON "tax_source_links" ("item_id", "up_transaction_id") WHERE "item_id" IS NOT NULL AND "up_transaction_id" IS NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_tax_source_links_asset_tx" ON "tax_source_links" ("asset_id", "transaction_id") WHERE "asset_id" IS NOT NULL AND "transaction_id" IS NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_tax_source_links_asset_up" ON "tax_source_links" ("asset_id", "up_transaction_id") WHERE "asset_id" IS NOT NULL AND "up_transaction_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_tax_source_links_transaction" ON "tax_source_links" ("transaction_id") WHERE "transaction_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_tax_source_links_up_transaction" ON "tax_source_links" ("up_transaction_id") WHERE "up_transaction_id" IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE "tax_evidence_links" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "item_id" uuid,
        "asset_id" uuid,
        "label" varchar(200) NOT NULL,
        "url" varchar(2048) NOT NULL,
        "kind" varchar(20) NOT NULL DEFAULT 'OTHER',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CK_tax_evidence_links_owner" CHECK (("item_id" IS NULL) <> ("asset_id" IS NULL)),
        CONSTRAINT "CK_tax_evidence_links_kind" CHECK ("kind" IN ('RECEIPT', 'INVOICE', 'CALCULATION', 'STATEMENT', 'OTHER')),
        CONSTRAINT "FK_tax_evidence_links_item" FOREIGN KEY ("item_id", "user_id") REFERENCES "tax_items" ("id", "user_id") ON DELETE CASCADE,
        CONSTRAINT "FK_tax_evidence_links_asset" FOREIGN KEY ("asset_id", "user_id") REFERENCES "tax_assets" ("id", "user_id") ON DELETE CASCADE
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_tax_evidence_links_user" ON "tax_evidence_links" ("user_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "tax_evidence_links"`);
    await queryRunner.query(`DROP TABLE "tax_source_links"`);
    await queryRunner.query(`DROP TABLE "tax_asset_years"`);
    await queryRunner.query(`DROP TABLE "tax_assets"`);
    await queryRunner.query(`DROP TABLE "tax_items"`);
    await queryRunner.query(`DROP TABLE "tax_return_filings"`);
    await queryRunner.query(`DROP TABLE "tax_returns"`);
    await queryRunner.query(`ALTER TABLE "up_transactions" DROP CONSTRAINT "UQ_up_transactions_id_user"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "UQ_transactions_id_user"`);
  }
}
