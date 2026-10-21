import { AccountEntity } from '../accounts/account.entity';
import { CategoryEntity, HoldingCategoryEntity } from '../categories/category.entity';
import { TransactionEntity } from '../transactions/transaction.entity';
import { UserEntity } from '../users/user.entity';
import { InitialSchema1761000000000 } from './migrations/1761000000000-InitialSchema';
import { SubaccountsAndCategories1761100000000 } from './migrations/1761100000000-SubaccountsAndCategories';

export const ENTITIES = [UserEntity, AccountEntity, TransactionEntity, CategoryEntity, HoldingCategoryEntity];
export const MIGRATIONS = [InitialSchema1761000000000, SubaccountsAndCategories1761100000000];
