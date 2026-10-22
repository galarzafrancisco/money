# Logical account groups

Money shows accounts two ways.

| Concept | What it is | Where it lives |
|---|---|---|
| **Physical account** | An account that really exists: a Money account you record (`accounts`, with subaccounts), or an account imported read-only from Up (`up_accounts`). | Accounts page, "Physical accounts" |
| **Category** | A label on money, for slicing reports (`docs/categories.md`). | Categories page |
| **Logical group** | Your own bucket over physical accounts, e.g. `Cash` = two Up accounts + cash in hand. | Accounts page, "Logical groups" |

A group never changes a physical account: not its name, hierarchy, category, balance, provenance or Up identity. Groups are tracking only; no banking action exists anywhere.

## Rules

- **One group per account.** A physical account is in at most one group, enforced by partial unique indexes (`UQ_account_group_members_account`, `UQ_account_group_members_up_account`). Groups therefore partition the accounts, so no total can count an account twice. Adding an account that is already in another group answers `409` with the clash in `details.accounts`; pass `move: true` to take it from the other group.
- **Member kinds.** A member is exactly one of a Money account (`kind: "account"`) or an imported Up account (`kind: "up"`, Money's own UUID, never Up's ID); a CHECK enforces it.
- **A Money account counts with its own ledger only.** Its subaccounts are separate accounts you group on their own, so grouping a parent and its subaccount never overlaps.
- **Up accounts are cash** at the last imported balance (Up data stays in `up_*` and is never written into the ledger).
- **Counted vs listed.** Every member is listed, with `counted` and `excludedReason`:
  - `hidden`: a hidden Up account (the default for imports) is in the group but not in its totals until shown, matching the Accounts table.
  - `removed`: Up stopped listing it.
  - `linked-duplicate`: the Up account's `linkedAccountId` points at a Money account in the same group, so it records the same money; the Money ledger is counted, the Up balance is not.
- **Currencies.** Totals are per currency. `baseCurrency` + `fxRates` (the caller's own rates, same as the reports) add `converted` totals, and for groups a `composition` split (cash / investments / super / other). A missing rate is a `400`, never silently left out.
- **Names** are unique per user, ignoring case, in their own namespace (a group may share a name with an account or category).
- **Everything is user scoped.** Another user's group, account or Up account answers `404`. Composite `(id, user_id)` foreign keys make a cross-user member impossible even in SQL.

## Lifecycle

| Event | Result |
|---|---|
| Rename / edit notes / replace members (`PATCH`) | Atomic; the member list replaces the whole membership. |
| Delete a group | Its accounts become ungrouped. Nothing else is deleted. |
| Empty group | Valid; totals are empty. |
| Delete a Money account | Its membership row cascades away; the group remains. |
| Hide / show an Up account | Membership kept; only `counted` changes. |
| Disconnect Up (no purge) | Imported data and memberships stay. |
| Disconnect Up with `purge` | Imported accounts are deleted; their memberships cascade away. |
| Up stops listing an account | Stays a member, `excludedReason: "removed"`. |

## Reporting and dashboard

`GET /api/account-groups` returns `groups`, `ungrouped` and a grand `totals` (groups + ungrouped, everything counted once). Grouping moves money between buckets, never into or out of the total. The dashboard and `/api/reports/*` stay **physical**: they are not affected by groups, and (a known gap, see `up-integration.md`) do not include Up accounts. Do not add dashboard totals and group totals together.

## API / MCP handoff

REST (`@money/client` resource `accountGroups`):

| Operation | Route |
|---|---|
| `listAccountGroups` | `GET /api/account-groups?valuation&baseCurrency&fxRates` |
| `createAccountGroup` | `POST /api/account-groups` `{ name, description?, members?: [{kind, id}], move? }` |
| `getAccountGroup` | `GET /api/account-groups/:groupId` |
| `updateAccountGroup` | `PATCH /api/account-groups/:groupId` `{ name?, description?, members?, move? }` |
| `deleteAccountGroup` | `DELETE /api/account-groups/:groupId` |

MCP: `list_account_groups`, `get_account_group`, `create_account_group`, `update_account_group`, `delete_account_group` call the same service.

UI: `/accounts` (physical, with a "Logical group" column) and `/accounts/groups` (logical: create, edit, delete, ungrouped list). The web app uses only the generated client with the existing session/CSRF path.

## Validation status

Tested with the offline up-bank-mock and synthetic data only (`account-groups.e2e.spec.ts`, web tests). Nothing here has been run against the real Up API or the live deployment.
