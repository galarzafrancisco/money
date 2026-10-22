import { InAppNav } from '../../app/InAppNav';

/** The two ways to look at accounts: as they really exist, or as the user's own groups */
export function AccountViewNav() {
  return (
    <InAppNav
      label="Account views"
      items={[
        { to: '/accounts', label: 'Physical accounts', end: true },
        { to: '/accounts/groups', label: 'Logical groups' },
      ]}
    />
  );
}
