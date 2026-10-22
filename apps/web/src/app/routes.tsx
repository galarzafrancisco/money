import { Navigate, Route, Routes } from 'react-router';
import { AccountLayout } from '../features/accounts/AccountLayout';
import { AccountOverview } from '../features/accounts/AccountOverview';
import { AccountSettings } from '../features/accounts/AccountSettings';
import { AccountsPage } from '../features/accounts/AccountsPage';
import { AccountSubaccounts } from '../features/accounts/AccountSubaccounts';
import { NewAccountPage } from '../features/accounts/NewAccountPage';
import { ConnectionsPage } from '../features/connections/ConnectionsPage';
import { CategoriesPage } from '../features/categories/CategoriesPage';
import { DashboardCategories } from '../features/dashboard/DashboardCategories';
import { DashboardLayout } from '../features/dashboard/DashboardLayout';
import { DashboardOverview } from '../features/dashboard/DashboardOverview';
import { DashboardShares } from '../features/dashboard/DashboardShares';
import { AccountLots } from '../features/transactions/AccountLots';
import { AccountTransactions } from '../features/transactions/AccountTransactions';
import { RecordActivityPage } from '../features/transactions/RecordActivityPage';
import { TransactionDetail } from '../features/transactions/TransactionDetail';
import { AccountTransfers } from '../features/transfers/AccountTransfers';
import { ButtonLink, EmptyState } from '../ui';

/** One route tree for every screen size (guidelines §3.1). Every section is a URL. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<DashboardLayout />}>
        <Route index element={<DashboardOverview />} />
        <Route path="categories" element={<DashboardCategories />} />
        <Route path="shares" element={<DashboardShares />} />
      </Route>
      <Route path="/accounts" element={<AccountsPage />} />
      <Route path="/accounts/new" element={<NewAccountPage />} />
      <Route path="/accounts/:accountId" element={<AccountLayout />}>
        <Route index element={<AccountOverview />} />
        <Route path="transactions" element={<AccountTransactions />} />
        <Route path="transactions/:transactionId" element={<TransactionDetail />} />
        <Route path="lots" element={<AccountLots />} />
        <Route path="subaccounts" element={<AccountSubaccounts />} />
        <Route path="transfers" element={<AccountTransfers />} />
        <Route path="settings" element={<AccountSettings />} />
        <Route path="record" element={<RecordActivityPage />} />
      </Route>
      <Route path="/categories" element={<CategoriesPage />} />
      <Route path="/connections" element={<ConnectionsPage />} />
      <Route path="*" element={<EmptyState title="Page not found" action={<ButtonLink to="/accounts">Go to accounts</ButtonLink>} />} />
    </Routes>
  );
}
