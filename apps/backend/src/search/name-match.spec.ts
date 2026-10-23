import { matchName, merchantKeyOf, prepareQuery } from './name-match';

const m = (q: string, name: string) => matchName(prepareQuery(q), name);

describe('merchantKeyOf', () => {
  it('folds case, accents, punctuation, legal suffixes and store numbers into one identity', () => {
    const key = merchantKeyOf('Guzman y Gomez');
    expect(key).toBe('up:guzman-y-gomez');
    for (const variant of ['GUZMAN Y GOMEZ', 'Guzmán y Gómez Pty Ltd', 'guzman  y  gomez 1234']) expect(merchantKeyOf(variant)).toBe(key);
    expect(merchantKeyOf("Hungry Jack's")).toBe(merchantKeyOf('HUNGRY JACKS'));
    expect(merchantKeyOf('Fish & Chips')).toBe(merchantKeyOf('fish and chips'));
  });
  it('keeps different merchants apart, including similar ones', () => {
    expect(merchantKeyOf('BBQs In The Hills')).not.toBe(merchantKeyOf('Barbeques Galore'));
    expect(merchantKeyOf('Coles Express')).not.toBe(merchantKeyOf('Coles'));
  });
  it('is empty when there is nothing to identify', () => expect(merchantKeyOf('***')).toBe(''));
});

describe('matchName', () => {
  it('matches partial names case-insensitively', () => {
    expect(m('guzman', 'Guzman y Gomez')).toBe('prefix');
    expect(m('GOMEZ', 'Guzman y Gomez')).toBe('partial');
    expect(m('guzman y gomez', 'GUZMAN Y GOMEZ')).toBe('exact');
  });
  it('treats spelling variants as aliases without conflating retailers', () => {
    expect(m('BBQ Galore', 'Barbeques Galore')).toBe('alias');
    expect(m('BBQ Galore', 'BBQs In The Hills')).toBeNull();
    expect(m('BBQ', 'BBQs In The Hills')).toBe('prefix');
    expect(m('BBQ', 'Barbeques Galore')).toBe('prefix');
  });
  it('tolerates small typos but not unrelated names', () => {
    expect(m('guzmann', 'Guzman y Gomez')).toBe('approximate');
    expect(m('woolwurths', 'Woolworths')).toBe('approximate');
    expect(m('cat', 'Cot')).toBeNull();
    expect(m('xyz', 'Guzman y Gomez')).toBeNull();
  });
  it('never matches an empty query', () => expect(m('  ', 'Anything')).toBeNull());
});
