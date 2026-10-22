import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A Money category on an imported Up! account (`up_accounts.category_id`), so
 * the user can classify it like their own accounts. Deleting the category
 * clears it. It never touches the manual ledger.
 */
export class UpAccountCategory1761900000000 implements MigrationInterface {
  name = 'UpAccountCategory1761900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "up_accounts" ADD COLUMN "category_id" uuid REFERENCES "categories" ("id") ON DELETE SET NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "up_accounts" DROP COLUMN "category_id"`);
  }
}
