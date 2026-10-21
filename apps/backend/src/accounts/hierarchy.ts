/**
 * Pure helpers for the account hierarchy (accounts and their subaccounts, or
 * buckets). No I/O; the services load a user's accounts and call these.
 */

/** Top-level account = level 1. A subaccount of a subaccount of a top-level account = level 3. */
export const MAX_ACCOUNT_DEPTH = 5;

export type HierarchyNode = { id: string; parentAccountId: string | null };

/** The ancestors of an account, nearest first. Stops if the data already has a cycle. */
export function ancestorsOf<T extends HierarchyNode>(accountId: string, byId: ReadonlyMap<string, T>): T[] {
  const result: T[] = [];
  const seen = new Set<string>([accountId]);
  let parentId = byId.get(accountId)?.parentAccountId ?? null;
  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    result.push(parent);
    seen.add(parentId);
    parentId = parent.parentAccountId;
  }
  return result;
}

/** The account's level: 1 for a top-level account */
export function levelOf(accountId: string, byId: ReadonlyMap<string, HierarchyNode>): number {
  return ancestorsOf(accountId, byId).length + 1;
}

/** Children of every account */
export function childrenIndex<T extends HierarchyNode>(nodes: readonly T[]): Map<string, T[]> {
  const children = new Map<string, T[]>();
  for (const node of nodes) {
    if (!node.parentAccountId) continue;
    const list = children.get(node.parentAccountId) ?? [];
    list.push(node);
    children.set(node.parentAccountId, list);
  }
  return children;
}

/** All accounts below an account (not including it) */
export function descendantsOf<T extends HierarchyNode>(accountId: string, children: ReadonlyMap<string, T[]>): T[] {
  const result: T[] = [];
  const stack = [...(children.get(accountId) ?? [])];
  const seen = new Set<string>([accountId]);
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    result.push(node);
    stack.push(...(children.get(node.id) ?? []));
  }
  return result;
}

/** Levels in the subtree rooted at the account: 1 when it has no subaccounts */
export function subtreeHeight(accountId: string, children: ReadonlyMap<string, HierarchyNode[]>, seen = new Set<string>()): number {
  if (seen.has(accountId)) return 0;
  seen.add(accountId);
  const kids = children.get(accountId) ?? [];
  return 1 + kids.reduce((max, kid) => Math.max(max, subtreeHeight(kid.id, children, seen)), 0);
}

export type ParentCheck =
  | { ok: true }
  | { ok: false; reason: 'self' | 'cycle' | 'too_deep'; depth?: number };

/**
 * Whether `accountId` may be placed under `newParentId`: not itself, not one
 * of its own descendants (that would make a cycle), and the moved subtree must
 * still fit within MAX_ACCOUNT_DEPTH levels.
 */
export function checkNewParent(accountId: string, newParentId: string, nodes: readonly HierarchyNode[]): ParentCheck {
  if (accountId === newParentId) return { ok: false, reason: 'self' };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = childrenIndex(nodes);
  if (descendantsOf(accountId, children).some((d) => d.id === newParentId)) return { ok: false, reason: 'cycle' };
  const depth = levelOf(newParentId, byId) + subtreeHeight(accountId, children);
  if (depth > MAX_ACCOUNT_DEPTH) return { ok: false, reason: 'too_deep', depth };
  return { ok: true };
}
