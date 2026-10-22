import { z } from 'zod';

const name = z.string().trim().min(1).max(80).describe('Your name for the group, unique per user (case-insensitive), e.g. "Cash". Not a category and not an account.');
const description = z.string().trim().max(2000).nullish();

export const memberRefSchema = z.object({
  kind: z.enum(['account', 'up']).describe('"account": a Money account (from list_accounts). "up": an imported Up account (from list_up_accounts).'),
  id: z.string().describe('The Money account ID or the Up account ID (Money\'s own UUID for the imported account, not Up\'s ID)'),
});
export type MemberRef = z.infer<typeof memberRefSchema>;

const members = z
  .array(memberRefSchema)
  .max(200)
  .describe('Physical accounts in the group. An account can be in only one group; one that is already in another group is refused unless move is true.');

export const createAccountGroupSchema = z.object({ name, description, members: members.optional(), move: z.boolean().optional() });
export type CreateAccountGroupInput = z.input<typeof createAccountGroupSchema>;

export const updateAccountGroupSchema = z
  .object({
    name: name.optional(),
    description: description.describe('Notes; null clears them'),
    members: members.optional().describe('Replaces the whole membership. Omit to leave membership unchanged.'),
    move: z.boolean().optional().describe('Take accounts that are in another group out of it and put them in this one'),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'Provide at least one field to change' });
export type UpdateAccountGroupInput = z.input<typeof updateAccountGroupSchema>;
