import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Store-first price history (docs/market-prices.md). Market data, shared by
 * all users; nothing here is personal.
 *
 * - market_price_series: one row per (symbol, source) with the series'
 *   currency, exchange time zone and the contiguous range of trading dates
 *   whose closes are known to be stored (covered_from..covered_to). A
 *   lookup inside that range is answered from the database alone; only the
 *   dates outside it are fetched from the provider.
 * - market_price_splits: split events reported with the closes, used to
 *   warn when a split falls inside a holding period (corporate actions are
 *   not modelled in the ledger).
 * - market_price_closes.adjustment: AS_TRADED for closes stored from now
 *   on. Rows written before this migration by the Yahoo adapter were
 *   split-adjusted; they are marked so and get replaced on the next fetch
 *   (no coverage row exists for them yet).
 * - market_price_closes.revised_at: when a stored close was last replaced
 *   with a different value (an explicit refresh found a correction).
 */
export class PriceHistoryCache1761700000000 implements MigrationInterface {
  name = 'PriceHistoryCache1761700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "market_price_series" (
        "symbol" varchar(32) NOT NULL,
        "source" varchar(32) NOT NULL,
        "currency" varchar(3) NOT NULL,
        "exchange_timezone" varchar(64) NOT NULL,
        "is_mock" boolean NOT NULL,
        "adjustment" varchar(16) NOT NULL,
        "covered_from" date NOT NULL,
        "covered_to" date NOT NULL,
        "fetched_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("symbol", "source"),
        CONSTRAINT "CHK_market_price_series_range" CHECK ("covered_from" <= "covered_to")
      )`);
    await queryRunner.query(`
      CREATE TABLE "market_price_splits" (
        "symbol" varchar(32) NOT NULL,
        "source" varchar(32) NOT NULL,
        "split_date" date NOT NULL,
        "numerator" numeric(30,10) NOT NULL,
        "denominator" numeric(30,10) NOT NULL,
        "fetched_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("symbol", "source", "split_date"),
        CONSTRAINT "CHK_market_price_splits_ratio" CHECK ("numerator" > 0 AND "denominator" > 0)
      )`);
    await queryRunner.query(`ALTER TABLE "market_price_closes" ADD COLUMN "adjustment" varchar(16) NOT NULL DEFAULT 'AS_TRADED'`);
    await queryRunner.query(`UPDATE "market_price_closes" SET "adjustment" = 'SPLIT_ADJUSTED' WHERE "source" = 'yahoo'`);
    await queryRunner.query(`ALTER TABLE "market_price_closes" ADD COLUMN "revised_at" timestamptz`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "market_price_closes" DROP COLUMN "revised_at"`);
    await queryRunner.query(`ALTER TABLE "market_price_closes" DROP COLUMN "adjustment"`);
    await queryRunner.query(`DROP TABLE "market_price_splits"`);
    await queryRunner.query(`DROP TABLE "market_price_series"`);
  }
}
