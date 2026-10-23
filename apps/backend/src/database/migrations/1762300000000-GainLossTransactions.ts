import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the GAIN_LOSS transaction type: a signed value change (amount may be
 * negative) that is not a cash flow. DEPOSIT/WITHDRAWAL keep amount > 0.
 */
export class GainLossTransactions1762300000000 implements MigrationInterface {
  name = 'GainLossTransactions1762300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_type"`);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_type" CHECK ("type" IN
        ('DEPOSIT', 'WITHDRAWAL', 'GAIN_LOSS', 'FX_CONVERSION', 'BUY', 'SELL', 'DIVIDEND', 'TRANSFER_OUT', 'TRANSFER_IN'))`);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_gain_loss" CHECK (
        "type" <> 'GAIN_LOSS' OR ("currency" IS NOT NULL AND "amount" IS NOT NULL AND "amount" <> 0))`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "transactions" WHERE "type" = 'GAIN_LOSS'`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_gain_loss"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_type"`);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_type" CHECK ("type" IN
        ('DEPOSIT', 'WITHDRAWAL', 'FX_CONVERSION', 'BUY', 'SELL', 'DIVIDEND', 'TRANSFER_OUT', 'TRANSFER_IN'))`);
  }
}
