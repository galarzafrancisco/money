import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the SUPERANNUATION account type (retirement savings). The dashboard
 * puts everything held in a super account, or in any subaccount of one, in
 * the "super" asset class instead of cash or shares (docs/dashboard.md).
 *
 * The initial schema declared the type CHECK inline, so Postgres named it
 * `accounts_type_check`. It is replaced by a named constraint.
 */
export class SuperannuationAccounts1761600000000 implements MigrationInterface {
  name = 'SuperannuationAccounts1761600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_type_check"`);
    await queryRunner.query(
      `ALTER TABLE "accounts" ADD CONSTRAINT "CHK_accounts_type" CHECK ("type" IN ('INVESTMENT', 'CASH', 'SUPERANNUATION', 'OTHER'))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // The old constraint has no SUPERANNUATION; such accounts become OTHER
    await queryRunner.query(`UPDATE "accounts" SET "type" = 'OTHER' WHERE "type" = 'SUPERANNUATION'`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP CONSTRAINT "CHK_accounts_type"`);
    await queryRunner.query(`ALTER TABLE "accounts" ADD CONSTRAINT "accounts_type_check" CHECK ("type" IN ('INVESTMENT', 'CASH', 'OTHER'))`);
  }
}
