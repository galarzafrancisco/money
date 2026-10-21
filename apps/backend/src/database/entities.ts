import { AccountEntity } from '../accounts/account.entity';
import { TransactionEntity } from '../transactions/transaction.entity';
import { UserEntity } from '../users/user.entity';
import { InitialSchema1761000000000 } from './migrations/1761000000000-InitialSchema';

export const ENTITIES = [UserEntity, AccountEntity, TransactionEntity];
export const MIGRATIONS = [InitialSchema1761000000000];
