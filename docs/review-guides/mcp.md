# Review guide: MCP tools

- Tools represent **user journeys**, not 1:1 API mappings; journey tools orchestrate service calls in the service layer, not in the tool.
- Each tool calls the same service method as the matching REST route; the tool holds no business rules.
- Input schemas reuse the domain's zod shapes; extra tool-only fields (e.g. `accountId`) have minimal descriptions.
- Descriptions are **short** and token-efficient.
- Annotations are correct: `readOnlyHint` for reads, `destructiveHint` for deletes.
- Results go through `toResult`, returning `JSON.stringify()` text content and `isError: true` for `DomainError`s.
- The user is bound when the per-request server is built; no tool accepts a user ID.
- Descriptions of recording tools (deposits, trades, transfers, dividends) say or imply that they only record activity; no tool claims to move money or place trades.
- New tools are listed in `apps/backend/docs/api.md`.
