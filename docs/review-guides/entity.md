# Review guide: entities and migrations

- File: `apps/backend/src/<domain>/<name>.entity.ts`; class name `<Name>Entity`.
- Table and column names are snake_case.
- Primary key is a `uuid` column.
- User-editable records have `created_at` and `updated_at`; join, allocation and materialised tables may omit them only if the PR says why.
- User-owned tables have a `user_id` column, an index on it, and `ON DELETE CASCADE` from `users`.
- Cross-row references between user-owned tables use composite `(id, user_id)` foreign keys so a row cannot point at another user's row.
- Money amounts, quantities, prices and rates are Postgres `numeric(30,10)` mapped to strings; never floats and never integer cents.
- No eager relations; no cross-domain relations loaded implicitly.
- Derived state (balances, lots, holdings, gains) is not stored as a source of truth; materialised data (e.g. valuations) is recomputable and documented as such.
- A migration exists, is registered in `src/database/entities.ts` in chronological order, has a working `down`, and runs on both Postgres and PGlite.
- Schema synchronization is not enabled.
- Entities are not returned to clients.
- `apps/backend/docs/data-model.md` is updated for new tables, constraints and locks.
