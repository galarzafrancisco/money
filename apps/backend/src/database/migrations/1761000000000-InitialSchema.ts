import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1761000000000 implements MigrationInterface {
  name = 'InitialSchema1761000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid PRIMARY KEY,
        "issuer" varchar(500) NOT NULL,
        "subject" varchar(255) NOT NULL,
        "display_name" varchar(255),
        "email" varchar(320),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_users_issuer_subject" ON "users" ("issuer", "subject")`);

    await queryRunner.query(`
      CREATE TABLE "accounts" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "name" varchar(120) NOT NULL,
        "type" varchar(20) NOT NULL CHECK ("type" IN ('INVESTMENT', 'CASH', 'OTHER')),
        "reporting_currency" varchar(3) NOT NULL,
        "description" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_accounts_user" ON "accounts" ("user_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_accounts_user_name" ON "accounts" ("user_id", lower("name"))`);

    await queryRunner.query(`
      CREATE TABLE "transactions" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "account_id" uuid NOT NULL REFERENCES "accounts" ("id") ON DELETE CASCADE,
        "type" varchar(20) NOT NULL CHECK ("type" IN ('DEPOSIT', 'WITHDRAWAL', 'FX_CONVERSION', 'BUY', 'SELL', 'DIVIDEND')),
        "date" date NOT NULL,
        "sequence" integer NOT NULL,
        "description" text,
        "currency" varchar(3),
        "amount" numeric(30,10),
        "external_currency" varchar(3),
        "external_amount" numeric(30,10),
        "symbol" varchar(32),
        "quantity" numeric(30,10),
        "unit_price" numeric(30,10),
        "fees" numeric(30,10),
        "total" numeric(30,10),
        "from_currency" varchar(3),
        "from_amount" numeric(30,10),
        "to_currency" varchar(3),
        "to_amount" numeric(30,10),
        "fx_rate" numeric(30,10),
        "gross_amount" numeric(30,10),
        "withholding_tax" numeric(30,10),
        "net_amount" numeric(30,10),
        "franking_credits" numeric(30,10),
        "calculated_field" varchar(20),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_transactions_account_sequence" UNIQUE ("account_id", "sequence"),
        CONSTRAINT "CHK_transactions_cash" CHECK (
          "type" NOT IN ('DEPOSIT', 'WITHDRAWAL') OR ("currency" IS NOT NULL AND "amount" > 0)),
        CONSTRAINT "CHK_transactions_fx" CHECK (
          "type" <> 'FX_CONVERSION' OR ("from_currency" IS NOT NULL AND "to_currency" IS NOT NULL
            AND "from_currency" <> "to_currency" AND "from_amount" > 0 AND "to_amount" > 0 AND "fees" >= 0)),
        CONSTRAINT "CHK_transactions_trade" CHECK (
          "type" NOT IN ('BUY', 'SELL') OR ("symbol" IS NOT NULL AND "currency" IS NOT NULL AND "quantity" > 0
            AND "unit_price" >= 0 AND "fees" >= 0 AND "total" >= 0)),
        CONSTRAINT "CHK_transactions_dividend" CHECK (
          "type" <> 'DIVIDEND' OR ("symbol" IS NOT NULL AND "currency" IS NOT NULL AND "gross_amount" > 0
            AND "withholding_tax" >= 0 AND "net_amount" >= 0 AND "franking_credits" >= 0))
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_transactions_account_order" ON "transactions" ("account_id", "date", "sequence")`);
    await queryRunner.query(`CREATE INDEX "IDX_transactions_user" ON "transactions" ("user_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "transactions"`);
    await queryRunner.query(`DROP TABLE "accounts"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
