import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Several covered ranges per price series (docs/market-prices.md). Until now
 * market_price_series kept one contiguous range, so a symbol sold in 2019 and
 * bought back in 2026 made the history backfill fetch the years in between.
 *
 * - market_price_coverage: the disjoint ranges of trading dates whose closes
 *   are known to be stored. Existing ranges are copied over.
 * - market_price_series.covered_from/covered_to stay as the envelope of the
 *   ranges, for a quick look; the ranges are the truth.
 */
export class PriceCoverageRanges1762000000000 implements MigrationInterface {
  name = 'PriceCoverageRanges1762000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "market_price_coverage" (
        "symbol" varchar(32) NOT NULL,
        "source" varchar(32) NOT NULL,
        "covered_from" date NOT NULL,
        "covered_to" date NOT NULL,
        PRIMARY KEY ("symbol", "source", "covered_from"),
        CONSTRAINT "CHK_market_price_coverage_range" CHECK ("covered_from" <= "covered_to")
      )`);
    await queryRunner.query(
      `INSERT INTO "market_price_coverage" ("symbol", "source", "covered_from", "covered_to") SELECT "symbol", "source", "covered_from", "covered_to" FROM "market_price_series"`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Keep the envelope on the series rows (already maintained), drop the ranges
    await queryRunner.query(`DROP TABLE "market_price_coverage"`);
  }
}
