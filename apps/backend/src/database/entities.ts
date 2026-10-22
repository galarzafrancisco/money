import { AccountEntity } from '../accounts/account.entity';
import { CategoryEntity, HoldingCategoryEntity } from '../categories/category.entity';
import { SaleLotAllocationEntity } from '../transactions/sale-lot-allocation.entity';
import { TransactionEntity } from '../transactions/transaction.entity';
import { TransferEntity } from '../transfers/transfer.entity';
import { UserEntity } from '../users/user.entity';
import { InitialSchema1761000000000 } from './migrations/1761000000000-InitialSchema';
import { SubaccountsAndCategories1761100000000 } from './migrations/1761100000000-SubaccountsAndCategories';
import { Transfers1761200000000 } from './migrations/1761200000000-Transfers';
import { DailyValuations1761300000000 } from './migrations/1761300000000-DailyValuations';
import { SaleLotAllocations1761400000000 } from './migrations/1761400000000-SaleLotAllocations';
import { WebSessions1761500000000 } from './migrations/1761500000000-WebSessions';
import { SuperannuationAccounts1761600000000 } from './migrations/1761600000000-SuperannuationAccounts';
import { PriceHistoryCache1761700000000 } from './migrations/1761700000000-PriceHistoryCache';

export const ENTITIES = [UserEntity, AccountEntity, TransactionEntity, SaleLotAllocationEntity, CategoryEntity, HoldingCategoryEntity, TransferEntity];
export const MIGRATIONS = [
  InitialSchema1761000000000,
  SubaccountsAndCategories1761100000000,
  Transfers1761200000000,
  DailyValuations1761300000000,
  SaleLotAllocations1761400000000,
  WebSessions1761500000000,
  SuperannuationAccounts1761600000000,
  PriceHistoryCache1761700000000,
];
