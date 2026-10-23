import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable stock splits (docs/stock-splits.md):
 *
 * - security_splits: one row per (instrument, effective date) with the
 *   ratio, provenance (VERIFIED by hand, or reported by a PROVIDER) and
 *   where it came from. Market data, shared by every user.
 * - security_symbol_aliases: ticker changes. A holding recorded under an old
 *   symbol uses the instrument's splits.
 * - valuation_holdings gets the split basis of each snapshot row:
 *   split_factor (from the valuation date's share basis to the present one),
 *   split_adjusted_quantity and split_adjusted_close.
 *
 * Seeds the verified TSLA splits and asks for every account that traded a
 * split symbol to be re-valued from its first trade, so snapshots computed
 * without split adjustment are replaced.
 */
export class StockSplits1762400000000 implements MigrationInterface {
  name = 'StockSplits1762400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "security_splits" (
        "instrument" varchar(32) NOT NULL,
        "effective_date" date NOT NULL,
        "numerator" numeric(30,10) NOT NULL,
        "denominator" numeric(30,10) NOT NULL,
        "provenance" varchar(16) NOT NULL,
        "source" varchar(64) NOT NULL,
        "note" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("instrument", "effective_date"),
        CONSTRAINT "CHK_security_splits_ratio" CHECK ("numerator" > 0 AND "denominator" > 0),
        CONSTRAINT "CHK_security_splits_provenance" CHECK ("provenance" IN ('VERIFIED', 'PROVIDER'))
      )`);
    await queryRunner.query(`
      CREATE TABLE "security_symbol_aliases" (
        "symbol" varchar(32) PRIMARY KEY,
        "instrument" varchar(32) NOT NULL,
        "note" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_security_symbol_aliases_distinct" CHECK ("symbol" <> "instrument")
      )`);
    await queryRunner.query(`
      INSERT INTO "security_splits" ("instrument", "effective_date", "numerator", "denominator", "provenance", "source", "note") VALUES
        ('TSLA', '2020-08-31', 5, 1, 'VERIFIED', 'migration', 'Tesla 5-for-1 stock split; split-adjusted trading began 2020-08-31'),
        ('TSLA', '2022-08-25', 3, 1, 'VERIFIED', 'migration', 'Tesla 3-for-1 stock split; split-adjusted trading began 2022-08-25')
      ON CONFLICT ("instrument", "effective_date") DO UPDATE SET
        "numerator" = EXCLUDED."numerator", "denominator" = EXCLUDED."denominator", "provenance" = 'VERIFIED',
        "source" = EXCLUDED."source", "note" = EXCLUDED."note", "updated_at" = now()`);
    // Splits a provider already reported become PROVIDER rows (verified rows win)
    await queryRunner.query(`
      INSERT INTO "security_splits" ("instrument", "effective_date", "numerator", "denominator", "provenance", "source")
      SELECT DISTINCT ON ("symbol", "split_date") "symbol", "split_date", "numerator", "denominator", 'PROVIDER', "source"
        FROM "market_price_splits" ORDER BY "symbol", "split_date", "fetched_at" DESC
      ON CONFLICT ("instrument", "effective_date") DO NOTHING`);
    await queryRunner.query(`ALTER TABLE "valuation_holdings" ADD COLUMN "split_factor" numeric(30,10)`);
    await queryRunner.query(`ALTER TABLE "valuation_holdings" ADD COLUMN "split_adjusted_quantity" numeric(30,10)`);
    await queryRunner.query(`ALTER TABLE "valuation_holdings" ADD COLUMN "split_adjusted_close" numeric(30,10)`);
    // Snapshots of split symbols were valued with unadjusted quantities: re-value them from each account's first trade
    await queryRunner.query(`
      INSERT INTO "valuation_recompute_requests" ("account_id", "user_id", "from_date", "requested_at")
      SELECT t."account_id", t."user_id", MIN(t."date"), clock_timestamp()
        FROM "transactions" t
       WHERE t."type" IN ('BUY', 'SELL') AND t."symbol" IN (SELECT "instrument" FROM "security_splits")
       GROUP BY t."account_id", t."user_id"
      ON CONFLICT ("account_id") DO UPDATE SET
        "from_date" = LEAST("valuation_recompute_requests"."from_date", EXCLUDED."from_date"), "requested_at" = EXCLUDED."requested_at"`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "valuation_holdings" DROP COLUMN "split_adjusted_close"`);
    await queryRunner.query(`ALTER TABLE "valuation_holdings" DROP COLUMN "split_adjusted_quantity"`);
    await queryRunner.query(`ALTER TABLE "valuation_holdings" DROP COLUMN "split_factor"`);
    await queryRunner.query(`DROP TABLE "security_symbol_aliases"`);
    await queryRunner.query(`DROP TABLE "security_splits"`);
  }
}
