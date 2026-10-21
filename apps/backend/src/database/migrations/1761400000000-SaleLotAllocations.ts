import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Specific identification of the purchase lots a sale consumes
 * (docs/lot-selection.md).
 *
 * - transactions.lot_selection: FIFO or SPECIFIC, set on SELLs only. Every
 *   existing SELL becomes FIFO, which is how it was always matched, so no
 *   historical result changes.
 * - sale_lot_allocations: per SPECIFIC sale, how many shares came from which
 *   lot. A lot is identified by its BUY transaction's ID. Composite foreign
 *   keys on (id, user_id, account_id) make the database itself guarantee
 *   that the sale and the lot belong to the same user and account.
 *   Deleting the sale removes its allocations; a purchase that allocations
 *   point at cannot be deleted on its own. That check is deferred to commit,
 *   because when a whole account or user is deleted the cascade may reach
 *   the purchase before the sale; by commit both are gone.
 * - A trigger asks the valuation job to recompute from the sale's date
 *   whenever allocations change, on top of the BUY/SELL trigger.
 */
export class SaleLotAllocations1761400000000 implements MigrationInterface {
  name = 'SaleLotAllocations1761400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "transactions" ADD COLUMN "lot_selection" varchar(10)`);
    await queryRunner.query(`UPDATE "transactions" SET "lot_selection" = 'FIFO' WHERE "type" = 'SELL'`);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_lot_selection" CHECK (
        ("type" = 'SELL') = ("lot_selection" IS NOT NULL)
        AND ("lot_selection" IS NULL OR "lot_selection" IN ('FIFO', 'SPECIFIC')))`);
    await queryRunner.query(`ALTER TABLE "transactions" ADD CONSTRAINT "UQ_transactions_id_user_account" UNIQUE ("id", "user_id", "account_id")`);

    await queryRunner.query(`
      CREATE TABLE "sale_lot_allocations" (
        "sale_transaction_id" uuid NOT NULL,
        "lot_transaction_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "position" integer NOT NULL,
        "quantity" numeric(30,10) NOT NULL,
        PRIMARY KEY ("sale_transaction_id", "lot_transaction_id"),
        CONSTRAINT "UQ_sale_lot_allocations_position" UNIQUE ("sale_transaction_id", "position"),
        CONSTRAINT "FK_sale_lot_allocations_sale" FOREIGN KEY ("sale_transaction_id", "user_id", "account_id")
          REFERENCES "transactions" ("id", "user_id", "account_id") ON DELETE CASCADE,
        CONSTRAINT "FK_sale_lot_allocations_lot" FOREIGN KEY ("lot_transaction_id", "user_id", "account_id")
          REFERENCES "transactions" ("id", "user_id", "account_id") DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT "CHK_sale_lot_allocations_quantity" CHECK ("quantity" > 0),
        CONSTRAINT "CHK_sale_lot_allocations_distinct" CHECK ("sale_transaction_id" <> "lot_transaction_id")
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_sale_lot_allocations_lot" ON "sale_lot_allocations" ("lot_transaction_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_sale_lot_allocations_account" ON "sale_lot_allocations" ("account_id")`);

    await queryRunner.query(`
      CREATE FUNCTION "money_request_allocation_recompute"() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        changed record;
        sale_date date;
      BEGIN
        IF TG_OP = 'DELETE' THEN changed := OLD; ELSE changed := NEW; END IF;
        SELECT "date" INTO sale_date FROM "transactions" WHERE "id" = changed."sale_transaction_id";
        -- When the sale itself is being deleted, its own trigger has already asked
        IF sale_date IS NOT NULL THEN
          INSERT INTO "valuation_recompute_requests" ("account_id", "user_id", "from_date", "requested_at")
          VALUES (changed."account_id", changed."user_id", sale_date, clock_timestamp())
          ON CONFLICT ("account_id") DO UPDATE
            SET "from_date" = LEAST("valuation_recompute_requests"."from_date", EXCLUDED."from_date"),
                "requested_at" = EXCLUDED."requested_at";
        END IF;
        RETURN NULL;
      END
      $$`);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_sale_lot_allocations_valuation_recompute"
        AFTER INSERT OR UPDATE OR DELETE ON "sale_lot_allocations"
        FOR EACH ROW EXECUTE FUNCTION "money_request_allocation_recompute"()`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Specific sales fall back to FIFO, the only method before this migration
    await queryRunner.query(`DROP TRIGGER "TRG_sale_lot_allocations_valuation_recompute" ON "sale_lot_allocations"`);
    await queryRunner.query(`DROP FUNCTION "money_request_allocation_recompute"()`);
    await queryRunner.query(`DROP TABLE "sale_lot_allocations"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "UQ_transactions_id_user_account"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_lot_selection"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "lot_selection"`);
  }
}
