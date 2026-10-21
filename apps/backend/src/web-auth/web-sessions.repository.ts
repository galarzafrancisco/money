import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { UnitOfWork } from '../database/unit-of-work';

export type LoginAttemptRow = {
  id: string;
  stateHash: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: Date;
};

export type WebSessionRow = {
  id: string;
  userId: string;
  csrfToken: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
  scope: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  expiresAt: Date;
};

/** A session with its user's token identity, which a refreshed token must match */
export type WebSessionWithIdentity = WebSessionRow & { userIssuer: string; userSubject: string };

const SESSION_COLUMNS = `
  s."id", s."user_id" AS "userId", s."csrf_token" AS "csrfToken", s."access_token" AS "accessToken",
  s."refresh_token" AS "refreshToken", s."access_token_expires_at" AS "accessTokenExpiresAt", s."scope",
  s."created_at" AS "createdAt", s."last_seen_at" AS "lastSeenAt", s."idle_expires_at" AS "idleExpiresAt", s."expires_at" AS "expiresAt",
  u."issuer" AS "userIssuer", u."subject" AS "userSubject"`;

/**
 * Sign-in attempts and browser sessions. IDs are SHA-256 digests of the
 * cookie values; token columns hold ciphertext (the service encrypts).
 */
@Injectable()
export class WebSessionsRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async insertLoginAttempt(attempt: LoginAttemptRow): Promise<void> {
    await this.uow.manager.query(
      `INSERT INTO "web_login_attempts" ("id", "state_hash", "code_verifier", "return_to", "expires_at") VALUES ($1, $2, $3, $4, $5)`,
      [attempt.id, attempt.stateHash, attempt.codeVerifier, attempt.returnTo, attempt.expiresAt],
    );
  }

  /** Removes and returns an attempt: a callback can use it once */
  async takeLoginAttempt(id: string): Promise<LoginAttemptRow | null> {
    const rows: LoginAttemptRow[] = await this.uow.manager.query(
      `DELETE FROM "web_login_attempts" WHERE "id" = $1
       RETURNING "id", "state_hash" AS "stateHash", "code_verifier" AS "codeVerifier", "return_to" AS "returnTo", "expires_at" AS "expiresAt"`,
      [id],
    );
    return normalizeRows<LoginAttemptRow>(rows)[0] ?? null;
  }

  async insertSession(session: Omit<WebSessionRow, 'createdAt' | 'lastSeenAt'>): Promise<void> {
    await this.uow.manager.query(
      `INSERT INTO "web_sessions" ("id", "user_id", "csrf_token", "access_token", "refresh_token", "access_token_expires_at", "scope", "idle_expires_at", "expires_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [session.id, session.userId, session.csrfToken, session.accessToken, session.refreshToken, session.accessTokenExpiresAt, session.scope, session.idleExpiresAt, session.expiresAt],
    );
  }

  async findSession(id: string, manager: EntityManager = this.uow.manager, forUpdate = false): Promise<WebSessionWithIdentity | null> {
    const rows: WebSessionWithIdentity[] = await manager.query(
      `SELECT ${SESSION_COLUMNS} FROM "web_sessions" s JOIN "users" u ON u."id" = s."user_id" WHERE s."id" = $1${forUpdate ? ' FOR UPDATE OF s' : ''}`,
      [id],
    );
    return normalizeRows<WebSessionWithIdentity>(rows)[0] ?? null;
  }

  async updateTokens(
    manager: EntityManager,
    id: string,
    tokens: { accessToken: string; refreshToken: string | null; accessTokenExpiresAt: Date; scope: string },
  ): Promise<void> {
    await manager.query(
      `UPDATE "web_sessions" SET "access_token" = $2, "refresh_token" = $3, "access_token_expires_at" = $4, "scope" = $5 WHERE "id" = $1`,
      [id, tokens.accessToken, tokens.refreshToken, tokens.accessTokenExpiresAt, tokens.scope],
    );
  }

  async touch(id: string, lastSeenAt: Date, idleExpiresAt: Date): Promise<void> {
    await this.uow.manager.query(`UPDATE "web_sessions" SET "last_seen_at" = $2, "idle_expires_at" = $3 WHERE "id" = $1`, [id, lastSeenAt, idleExpiresAt]);
  }

  async deleteSession(id: string, manager: EntityManager = this.uow.manager): Promise<void> {
    await manager.query(`DELETE FROM "web_sessions" WHERE "id" = $1`, [id]);
  }

  /** Housekeeping: drops expired attempts and sessions */
  async deleteExpired(now: Date): Promise<void> {
    await this.uow.manager.query(`DELETE FROM "web_login_attempts" WHERE "expires_at" < $1`, [now]);
    await this.uow.manager.query(`DELETE FROM "web_sessions" WHERE "expires_at" < $1 OR "idle_expires_at" < $1`, [now]);
  }
}

/** Drivers differ on whether timestamptz comes back as Date or string; DELETE ... RETURNING may come back as [rows, count] */
function normalizeRows<T extends object>(result: unknown): T[] {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as T[]) : (result as T[]);
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const key of ['expiresAt', 'accessTokenExpiresAt', 'createdAt', 'lastSeenAt', 'idleExpiresAt']) {
      if (typeof copy[key] === 'string') copy[key] = new Date(copy[key] as string);
    }
    return copy as T;
  });
}
