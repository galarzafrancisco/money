import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Transfers between two of a user's accounts. A transfer row holds what
 * happened (including any FX); its two legs are transactions of type
 * TRANSFER_OUT (source) and TRANSFER_IN (destination) that the ledger replays.
 *
 * Composite foreign keys on (id, user_id) keep both accounts, the transfer and
 * its legs within one user. Account foreign keys are NO ACTION: an account
 * that takes part in a transfer cannot be deleted on its own (the service
 * reports a 409 first), while deleting a user still cascades everything in
 * one statement.
 */
export class Transfers1761200000000 implements MigrationInterface {
  name = 'Transfers1761200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "transfers" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "from_account_id" uuid NOT NULL,
        "to_account_id" uuid NOT NULL,
        "date" date NOT NULL,
        "description" text,
        "from_currency" varchar(3) NOT NULL,
        "from_amount" numeric(30,10) NOT NULL,
        "to_currency" varchar(3) NOT NULL,
        "to_amount" numeric(30,10) NOT NULL,
        "fx_rate" numeric(30,10) NOT NULL,
        "fees" numeric(30,10) NOT NULL DEFAULT 0,
        "calculated_field" varchar(20),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_transfers_id_user" UNIQUE ("id", "user_id"),
        CONSTRAINT "FK_transfers_from_account" FOREIGN KEY ("from_account_id", "user_id") REFERENCES "accounts" ("id", "user_id"),
        CONSTRAINT "FK_transfers_to_account" FOREIGN KEY ("to_account_id", "user_id") REFERENCES "accounts" ("id", "user_id"),
        CONSTRAINT "CHK_transfers_accounts_differ" CHECK ("from_account_id" <> "to_account_id"),
        CONSTRAINT "CHK_transfers_amounts" CHECK ("from_amount" > 0 AND "to_amount" > 0 AND "fx_rate" > 0 AND "fees" >= 0),
        CONSTRAINT "CHK_transfers_same_currency" CHECK (
          "from_currency" <> "to_currency" OR ("from_amount" = "to_amount" AND "fx_rate" = 1))
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_transfers_user" ON "transfers" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_transfers_from_account" ON "transfers" ("from_account_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_transfers_to_account" ON "transfers" ("to_account_id")`);

    await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "transactions_type_check"`);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_type" CHECK ("type" IN
        ('DEPOSIT', 'WITHDRAWAL', 'FX_CONVERSION', 'BUY', 'SELL', 'DIVIDEND', 'TRANSFER_OUT', 'TRANSFER_IN'))`);
    await queryRunner.query(`ALTER TABLE "transactions" ADD COLUMN "transfer_id" uuid`);
    await queryRunner.query(`ALTER TABLE "transactions" ADD COLUMN "counterparty_account_id" uuid`);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "FK_transactions_transfer"
        FOREIGN KEY ("transfer_id", "user_id") REFERENCES "transfers" ("id", "user_id") ON DELETE CASCADE`);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "FK_transactions_counterparty"
        FOREIGN KEY ("counterparty_account_id", "user_id") REFERENCES "accounts" ("id", "user_id")`);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_transfer" CHECK (
        ("type" IN ('TRANSFER_OUT', 'TRANSFER_IN')) = ("transfer_id" IS NOT NULL AND "counterparty_account_id" IS NOT NULL)
        AND ("type" NOT IN ('TRANSFER_OUT', 'TRANSFER_IN') OR ("currency" IS NOT NULL AND "amount" > 0 AND "fees" >= 0)))`);
    // A transfer has exactly one leg of each kind
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_transactions_transfer_leg" ON "transactions" ("transfer_id", "type") WHERE "transfer_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_transactions_counterparty" ON "transactions" ("counterparty_account_id") WHERE "counterparty_account_id" IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_transactions_counterparty"`);
    await queryRunner.query(`DROP INDEX "UQ_transactions_transfer_leg"`);
    await queryRunner.query(`DELETE FROM "transactions" WHERE "type" IN ('TRANSFER_OUT', 'TRANSFER_IN')`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_transfer"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "FK_transactions_counterparty"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "FK_transactions_transfer"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "counterparty_account_id"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "transfer_id"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_type"`);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "transactions_type_check" CHECK ("type" IN
        ('DEPOSIT', 'WITHDRAWAL', 'FX_CONVERSION', 'BUY', 'SELL', 'DIVIDEND'))`);
    await queryRunner.query(`DROP TABLE "transfers"`);
  }
}
