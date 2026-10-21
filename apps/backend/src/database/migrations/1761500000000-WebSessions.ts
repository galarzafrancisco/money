import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Browser sign-in (docs/web-auth.md). Money keeps the Taico tokens of a
 * browser session on the server; the browser only holds an opaque cookie.
 *
 * - `web_login_attempts`: a sign-in that was sent to Taico and has not come
 *   back yet. Keyed by the SHA-256 of the login cookie; holds the hashed
 *   `state`, the encrypted PKCE verifier and where to return. Single use.
 * - `web_sessions`: a signed-in browser. Keyed by the SHA-256 of the session
 *   cookie, so a database leak does not reveal usable cookies. Tokens are
 *   AES-256-GCM encrypted. Deleting the user removes their sessions.
 */
export class WebSessions1761500000000 implements MigrationInterface {
  name = 'WebSessions1761500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "web_login_attempts" (
        "id" varchar(64) PRIMARY KEY,
        "state_hash" varchar(64) NOT NULL,
        "code_verifier" text NOT NULL,
        "return_to" text NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_web_login_attempts_expires" ON "web_login_attempts" ("expires_at")`);

    await queryRunner.query(`
      CREATE TABLE "web_sessions" (
        "id" varchar(64) PRIMARY KEY,
        "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "csrf_token" varchar(64) NOT NULL,
        "access_token" text NOT NULL,
        "refresh_token" text,
        "access_token_expires_at" timestamptz NOT NULL,
        "scope" text NOT NULL DEFAULT '',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "last_seen_at" timestamptz NOT NULL DEFAULT now(),
        "idle_expires_at" timestamptz NOT NULL,
        "expires_at" timestamptz NOT NULL
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_web_sessions_user" ON "web_sessions" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_web_sessions_expires" ON "web_sessions" ("expires_at")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "web_sessions"`);
    await queryRunner.query(`DROP TABLE "web_login_attempts"`);
  }
}
