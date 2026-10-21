import { TabNav, type TabItem } from '../ui';
import './shell.css';

/**
 * A feature's in-app sections (docs/ui/guidelines.md §12). The feature
 * declares the items; the shell owns how they are presented: tabs under the
 * page header on desktop, a bottom tab bar on mobile (CSS in shell.css).
 * App-level destinations never go here.
 */
export function InAppNav({ label, items }: { label: string; items: TabItem[] }) {
  return (
    <div className="shell__inapp">
      <TabNav label={label} items={items} />
    </div>
  );
}
