import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A Money category on an imported Up! account (`up_accounts.category_id`), so
 * the user can classify it like their own accounts. Deleting the category
 * clears it. It never touches the manual ledger.
 */
export class UpAccountCategory1761900000000 implements MigrationInterface {
  name = 'UpAccountCategory1761900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "up_accounts" ADD COLUMN "category_id" uuid`);
    // Composite (id, user_id) key, like the other category references: the
    // database itself rejects another user's category.
    await queryRunner.query(`ALTER TABLE "up_accounts" ADD CONSTRAINT "FK_up_accounts_category"
        FOREIGN KEY ("category_id", "user_id") REFERENCES "categories" ("id", "user_id") ON DELETE SET NULL ("category_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "up_accounts" DROP CONSTRAINT "FK_up_accounts_category"`);
    await queryRunner.query(`ALTER TABLE "up_accounts" DROP COLUMN "category_id"`);
  }
}
