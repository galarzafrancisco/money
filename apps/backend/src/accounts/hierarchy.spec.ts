import { MAX_ACCOUNT_DEPTH, ancestorsOf, checkNewParent, childrenIndex, descendantsOf, levelOf, subtreeHeight } from './hierarchy';

//  bank ─┬─ emergency
//        └─ deposits ── td1
//  broker
const nodes = [
  { id: 'bank', parentAccountId: null },
  { id: 'emergency', parentAccountId: 'bank' },
  { id: 'deposits', parentAccountId: 'bank' },
  { id: 'td1', parentAccountId: 'deposits' },
  { id: 'broker', parentAccountId: null },
];
const byId = new Map(nodes.map((n) => [n.id, n]));
const children = childrenIndex(nodes);

describe('account hierarchy', () => {
  it('finds ancestors nearest first, and levels from 1', () => {
    expect(ancestorsOf('td1', byId).map((n) => n.id)).toEqual(['deposits', 'bank']);
    expect(levelOf('bank', byId)).toBe(1);
    expect(levelOf('td1', byId)).toBe(3);
  });

  it('finds every descendant and the subtree height', () => {
    expect(descendantsOf('bank', children).map((n) => n.id).sort()).toEqual(['deposits', 'emergency', 'td1']);
    expect(subtreeHeight('bank', children)).toBe(3);
    expect(subtreeHeight('broker', children)).toBe(1);
  });

  it('refuses making an account its own parent or a child of its descendant', () => {
    expect(checkNewParent('bank', 'bank', nodes)).toEqual({ ok: false, reason: 'self' });
    expect(checkNewParent('bank', 'td1', nodes)).toEqual({ ok: false, reason: 'cycle' });
    expect(checkNewParent('deposits', 'td1', nodes)).toEqual({ ok: false, reason: 'cycle' });
  });

  it('allows a move that keeps the tree within the depth limit', () => {
    expect(checkNewParent('bank', 'broker', nodes)).toEqual({ ok: true }); // broker → bank → deposits → td1 = 4 levels
    expect(checkNewParent('emergency', 'td1', nodes)).toEqual({ ok: true });
  });

  it(`refuses a move that would nest deeper than ${MAX_ACCOUNT_DEPTH} levels`, () => {
    const chain = [
      ...nodes,
      { id: 'a', parentAccountId: null },
      { id: 'b', parentAccountId: 'a' },
      { id: 'c', parentAccountId: 'b' },
    ];
    // a → b → c → bank → deposits → td1 = 6 levels
    expect(checkNewParent('bank', 'c', chain)).toEqual({ ok: false, reason: 'too_deep', depth: 6 });
  });

  it('does not loop forever on data that already has a cycle', () => {
    const broken = new Map([
      ['x', { id: 'x', parentAccountId: 'y' }],
      ['y', { id: 'y', parentAccountId: 'x' }],
    ]);
    expect(ancestorsOf('x', broken).map((n) => n.id)).toEqual(['y']);
    expect(descendantsOf('x', childrenIndex([...broken.values()])).map((n) => n.id)).toEqual(['y']);
  });
});
