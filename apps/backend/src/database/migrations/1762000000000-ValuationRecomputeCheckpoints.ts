import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Checkpoints for valuation recompute requests (docs/valuations.md), so a
 * request covering more dates than one run computes (a backdated trade years
 * ago, with lifetime history) progresses run by run instead of starting over.
 *
 * - recomputed_from: dates from here onwards are already re-valued for the
 *   request.
 * - checkpoint_for: the requested_at the checkpoint belongs to. The triggers
 *   and the API renew requested_at when a request is renewed, which makes an
 *   older checkpoint void without the triggers having to know about it.
 */
export class ValuationRecomputeCheckpoints1762000000000 implements MigrationInterface {
  name = 'ValuationRecomputeCheckpoints1762000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "valuation_recompute_requests" ADD COLUMN "recomputed_from" date`);
    await queryRunner.query(`ALTER TABLE "valuation_recompute_requests" ADD COLUMN "checkpoint_for" timestamptz`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "valuation_recompute_requests" DROP COLUMN "checkpoint_for"`);
    await queryRunner.query(`ALTER TABLE "valuation_recompute_requests" DROP COLUMN "recomputed_from"`);
  }
}
