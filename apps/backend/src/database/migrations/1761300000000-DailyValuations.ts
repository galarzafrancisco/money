import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Daily closing-price valuations of holdings (docs/valuations.md).
 *
 * - market_price_closes: closing prices fetched from the provider, shared by
 *   all users (market data, not personal data). Audit trail and fallback when
 *   the provider is down.
 * - valuation_days / valuation_holdings: per user and date, what each
 *   account held at the end of that date and what it was worth at the
 *   close. Rows of a deleted account or user cascade away.
 * - valuation_recompute_requests: written by a trigger whenever a BUY or
 *   SELL is inserted, edited or deleted, so backdated changes are
 *   re-materialised by the job from the earliest affected date. No foreign
 *   keys, so cascading deletes of accounts and users can still write it.
 * - valuation_job_state: one row; a lease so only one instance runs the job
 *   at a time, and the last run's outcome.
 */
export class DailyValuations1761300000000 implements MigrationInterface {
  name = 'DailyValuations1761300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "market_price_closes" (
        "symbol" varchar(32) NOT NULL,
        "source" varchar(32) NOT NULL,
        "trading_date" date NOT NULL,
        "close" numeric(30,10) NOT NULL,
        "currency" varchar(3) NOT NULL,
        "exchange_timezone" varchar(64) NOT NULL,
        "close_time" timestamptz,
        "is_mock" boolean NOT NULL,
        "fetched_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("symbol", "source", "trading_date"),
        CONSTRAINT "CHK_market_price_closes_close" CHECK ("close" > 0)
      )`);

    await queryRunner.query(`
      CREATE TABLE "valuation_days" (
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "valuation_date" date NOT NULL,
        "status" varchar(16) NOT NULL,
        "price_provider" varchar(32) NOT NULL,
        "holdings_count" integer NOT NULL,
        "computed_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("user_id", "valuation_date"),
        CONSTRAINT "CHK_valuation_days_status" CHECK ("status" IN ('COMPLETE', 'PARTIAL'))
      )`);

    await queryRunner.query(`
      CREATE TABLE "valuation_holdings" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL,
        "valuation_date" date NOT NULL,
        "account_id" uuid NOT NULL,
        "symbol" varchar(32) NOT NULL,
        "currency" varchar(3) NOT NULL,
        "quantity" numeric(30,10) NOT NULL,
        "cost_base" numeric(30,10) NOT NULL,
        "price_status" varchar(20) NOT NULL,
        "close_price" numeric(30,10),
        "price_currency" varchar(3),
        "price_date" date,
        "price_close_time" timestamptz,
        "price_source" varchar(32),
        "price_is_mock" boolean,
        "exchange_timezone" varchar(64),
        "market_value" numeric(30,10),
        "price_note" text,
        "lots" jsonb NOT NULL,
        CONSTRAINT "UQ_valuation_holdings_key" UNIQUE ("user_id", "valuation_date", "account_id", "symbol"),
        CONSTRAINT "FK_valuation_holdings_day" FOREIGN KEY ("user_id", "valuation_date")
          REFERENCES "valuation_days" ("user_id", "valuation_date") ON DELETE CASCADE,
        CONSTRAINT "FK_valuation_holdings_account" FOREIGN KEY ("account_id", "user_id")
          REFERENCES "accounts" ("id", "user_id") ON DELETE CASCADE,
        CONSTRAINT "CHK_valuation_holdings_status" CHECK ("price_status" IN
          ('CLOSE', 'NON_TRADING_DAY', 'PRICE_PENDING', 'MISSING', 'CURRENCY_MISMATCH')),
        CONSTRAINT "CHK_valuation_holdings_quantity" CHECK ("quantity" > 0),
        CONSTRAINT "CHK_valuation_holdings_value" CHECK (
          ("market_value" IS NULL) = ("price_status" IN ('MISSING', 'CURRENCY_MISMATCH')))
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_valuation_holdings_account" ON "valuation_holdings" ("account_id", "valuation_date")`);

    await queryRunner.query(`
      CREATE TABLE "valuation_recompute_requests" (
        "account_id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL,
        "from_date" date NOT NULL,
        "requested_at" timestamptz NOT NULL
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_valuation_recompute_user" ON "valuation_recompute_requests" ("user_id")`);

    await queryRunner.query(`
      CREATE FUNCTION "money_request_valuation_recompute"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."type" IN ('BUY', 'SELL') THEN
          INSERT INTO "valuation_recompute_requests" ("account_id", "user_id", "from_date", "requested_at")
          VALUES (OLD."account_id", OLD."user_id", OLD."date", clock_timestamp())
          ON CONFLICT ("account_id") DO UPDATE
            SET "from_date" = LEAST("valuation_recompute_requests"."from_date", EXCLUDED."from_date"),
                "requested_at" = EXCLUDED."requested_at";
        END IF;
        IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."type" IN ('BUY', 'SELL') THEN
          INSERT INTO "valuation_recompute_requests" ("account_id", "user_id", "from_date", "requested_at")
          VALUES (NEW."account_id", NEW."user_id", NEW."date", clock_timestamp())
          ON CONFLICT ("account_id") DO UPDATE
            SET "from_date" = LEAST("valuation_recompute_requests"."from_date", EXCLUDED."from_date"),
                "requested_at" = EXCLUDED."requested_at";
        END IF;
        RETURN NULL;
      END
      $$`);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_transactions_valuation_recompute"
        AFTER INSERT OR UPDATE OR DELETE ON "transactions"
        FOR EACH ROW EXECUTE FUNCTION "money_request_valuation_recompute"()`);

    await queryRunner.query(`
      CREATE TABLE "valuation_job_state" (
        "id" integer PRIMARY KEY CHECK ("id" = 1),
        "lease_owner" varchar(100),
        "lease_expires_at" timestamptz,
        "last_started_at" timestamptz,
        "last_finished_at" timestamptz,
        "last_status" varchar(16),
        "last_error" text,
        "last_summary" jsonb
      )`);
    await queryRunner.query(`INSERT INTO "valuation_job_state" ("id") VALUES (1)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "valuation_job_state"`);
    await queryRunner.query(`DROP TRIGGER "TRG_transactions_valuation_recompute" ON "transactions"`);
    await queryRunner.query(`DROP FUNCTION "money_request_valuation_recompute"()`);
    await queryRunner.query(`DROP TABLE "valuation_recompute_requests"`);
    await queryRunner.query(`DROP TABLE "valuation_holdings"`);
    await queryRunner.query(`DROP TABLE "valuation_days"`);
    await queryRunner.query(`DROP TABLE "market_price_closes"`);
  }
}
