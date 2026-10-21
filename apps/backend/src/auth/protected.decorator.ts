import { UseGuards, applyDecorators } from '@nestjs/common';
import { AccessTokenGuard } from '@taico/auth/nest';
import { MoneyUserGuard } from './user.guard';

/** Requires a valid Taico access token for this resource and resolves the Money user */
export const Protected = () => applyDecorators(UseGuards(AccessTokenGuard, MoneyUserGuard));
