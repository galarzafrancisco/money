import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Read-only Up! import (docs/up-integration.md). Imported records live in
 * their own tables and never in `accounts`/`transactions`: the manual ledger
 * keeps its types and invariants, and provenance stays explicit.
 *
 * - `up_integrations`: one per user. Holds the Up personal access token and
 *   the webhook secret, both AES-256-GCM encrypted (never plaintext), and the
 *   Up webhook ID that locates the integration for an inbound event.
 * - `up_accounts`: Up accounts. `visible` defaults to false: imported and
 *   tracked, but hidden from default views. `linked_account_id` optionally
 *   maps one to a Money account.
 * - `up_transactions`: Up transactions, unique per (integration, Up ID).
 *   `deleted_at` marks one Up removed (kept for provenance, not shown by default).
 *   `matched_transaction_id` marks it as the same event as a manual record.
 * - `up_webhook_events`: every authentic inbound event, unique per
 *   (integration, Up event ID): replay protection and idempotency.
 * - `up_sync_runs`: audit trail of syncs.
 */
export class UpIntegration1761800000000 implements MigrationInterface {
  name = 'UpIntegration1761800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "up_integrations" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "status" varchar(20) NOT NULL,
        "token_ciphertext" text,
        "webhook_id" varchar(64),
        "webhook_secret_ciphertext" text,
        "webhook_status" varchar(20) NOT NULL DEFAULT 'none',
        "last_error_code" varchar(40),
        "last_error_at" timestamptz,
        "connected_at" timestamptz NOT NULL,
        "disconnected_at" timestamptz,
        "last_sync_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CK_up_integrations_status" CHECK ("status" IN ('active', 'rejected', 'disconnected')),
        CONSTRAINT "CK_up_integrations_webhook_status" CHECK ("webhook_status" IN ('none', 'registered', 'failed'))
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_up_integrations_user" ON "up_integrations" ("user_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_up_integrations_webhook" ON "up_integrations" ("webhook_id") WHERE "webhook_id" IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE "up_accounts" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "integration_id" uuid NOT NULL REFERENCES "up_integrations" ("id") ON DELETE CASCADE,
        "up_id" varchar(64) NOT NULL,
        "display_name" varchar(255) NOT NULL,
        "account_type" varchar(30) NOT NULL,
        "ownership_type" varchar(30) NOT NULL,
        "currency" varchar(3) NOT NULL,
        "balance" numeric(30, 10) NOT NULL,
        "up_created_at" timestamptz NOT NULL,
        "visible" boolean NOT NULL DEFAULT false,
        "linked_account_id" uuid REFERENCES "accounts" ("id") ON DELETE SET NULL,
        "tx_cursor" timestamptz,
        "first_imported_at" timestamptz NOT NULL DEFAULT now(),
        "last_synced_at" timestamptz,
        "removed_at" timestamptz,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_up_accounts_up_id" UNIQUE ("integration_id", "up_id")
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_up_accounts_user" ON "up_accounts" ("user_id")`);

    await queryRunner.query(`
      CREATE TABLE "up_transactions" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "integration_id" uuid NOT NULL REFERENCES "up_integrations" ("id") ON DELETE CASCADE,
        "up_account_id" uuid NOT NULL REFERENCES "up_accounts" ("id") ON DELETE CASCADE,
        "up_id" varchar(64) NOT NULL,
        "status" varchar(10) NOT NULL,
        "description" text NOT NULL,
        "raw_text" text,
        "message" text,
        "transaction_type" varchar(100),
        "currency" varchar(3) NOT NULL,
        "amount" numeric(30, 10) NOT NULL,
        "foreign_currency" varchar(3),
        "foreign_amount" numeric(30, 10),
        "category_id" varchar(100),
        "transfer_up_account_id" varchar(64),
        "up_created_at" timestamptz NOT NULL,
        "settled_at" timestamptz,
        "deleted_at" timestamptz,
        "matched_transaction_id" uuid REFERENCES "transactions" ("id") ON DELETE SET NULL,
        "first_imported_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_up_transactions_up_id" UNIQUE ("integration_id", "up_id"),
        CONSTRAINT "CK_up_transactions_status" CHECK ("status" IN ('HELD', 'SETTLED'))
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_up_transactions_account_time" ON "up_transactions" ("up_account_id", "up_created_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_up_transactions_user" ON "up_transactions" ("user_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_up_transactions_matched" ON "up_transactions" ("matched_transaction_id") WHERE "matched_transaction_id" IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE "up_webhook_events" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "integration_id" uuid NOT NULL REFERENCES "up_integrations" ("id") ON DELETE CASCADE,
        "event_id" varchar(64) NOT NULL,
        "event_type" varchar(40) NOT NULL,
        "up_transaction_id" varchar(64),
        "outcome" varchar(20),
        "attempts" integer NOT NULL DEFAULT 1,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        "processed_at" timestamptz,
        CONSTRAINT "UQ_up_webhook_events_event" UNIQUE ("integration_id", "event_id")
      )`);

    await queryRunner.query(`
      CREATE TABLE "up_sync_runs" (
        "id" uuid PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "integration_id" uuid NOT NULL REFERENCES "up_integrations" ("id") ON DELETE CASCADE,
        "trigger" varchar(20) NOT NULL,
        "status" varchar(20) NOT NULL,
        "accounts_seen" integer NOT NULL DEFAULT 0,
        "transactions_created" integer NOT NULL DEFAULT 0,
        "transactions_updated" integer NOT NULL DEFAULT 0,
        "transactions_deleted" integer NOT NULL DEFAULT 0,
        "error_code" varchar(40),
        "started_at" timestamptz NOT NULL,
        "finished_at" timestamptz
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_up_sync_runs_integration" ON "up_sync_runs" ("integration_id", "started_at")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "up_sync_runs"`);
    await queryRunner.query(`DROP TABLE "up_webhook_events"`);
    await queryRunner.query(`DROP TABLE "up_transactions"`);
    await queryRunner.query(`DROP TABLE "up_accounts"`);
    await queryRunner.query(`DROP TABLE "up_integrations"`);
  }
}
