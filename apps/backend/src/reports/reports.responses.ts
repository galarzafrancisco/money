import { z } from 'zod';
import { ACCOUNT_TYPES } from '../accounts/account.entity';
import { apiSchema, decimalOut } from '../openapi/api-schemas';

/** REST response shapes (OpenAPI), mirroring ReportsService's AccountsReport and CategoriesReport */
const categoryRef = z.object({ id: z.string(), name: z.string(), color: z.string().nullable() }).nullable().describe('null = Uncategorized');

export const reportTotalsSchema = apiSchema(
  'ReportTotals',
  z.object({
    byCurrency: z.array(z.object({ currency: z.string(), cash: decimalOut(), holdings: decimalOut(), total: decimalOut() })),
    converted: z
      .object({ baseCurrency: z.string(), cash: decimalOut(), holdings: decimalOut(), total: decimalOut() })
      .nullable()
      .describe('Only with baseCurrency and fxRates: every currency converted at the caller\'s rates'),
  }),
);

export const reportItemSchema = apiSchema(
  'ReportItem',
  z.object({
    accountId: z.string(),
    accountPath: z.array(z.string()),
    kind: z.enum(['cash', 'holding']),
    symbol: z.string().nullable(),
    currency: z.string(),
    quantity: decimalOut().nullable(),
    value: decimalOut(),
    costBase: decimalOut().nullable(),
    basis: z.enum(['cash', 'market', 'cost']),
    price: z.object({ price: decimalOut(), asOf: z.string(), source: z.string(), isMock: z.boolean() }).nullable(),
    category: categoryRef,
    categorySource: z.enum(['holding', 'account', 'ancestor', 'none']),
  }),
);

type AccountReportNode = {
  id: string;
  name: string;
  type: (typeof ACCOUNT_TYPES)[number];
  parentAccountId: string | null;
  level: number;
  categoryId: string | null;
  effectiveCategory: z.infer<typeof categoryRef>;
  own: z.infer<typeof reportTotalsSchema>;
  rolledUp: z.infer<typeof reportTotalsSchema>;
  items: z.infer<typeof reportItemSchema>[];
  children: AccountReportNode[];
};

export const accountReportNodeSchema: z.ZodType<AccountReportNode> = apiSchema(
  'AccountReportNode',
  z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(ACCOUNT_TYPES),
    parentAccountId: z.string().nullable(),
    level: z.number().int(),
    categoryId: z.string().nullable(),
    effectiveCategory: categoryRef,
    own: reportTotalsSchema.describe("This account's own ledger only"),
    rolledUp: reportTotalsSchema.describe('This account plus every subaccount below it. Do not add rolledUp figures across levels.'),
    items: z.array(reportItemSchema),
    get children(): z.ZodArray<z.ZodType<AccountReportNode>> {
      return z.array(accountReportNodeSchema);
    },
  }),
);

const envelope = {
  asOf: z.string(),
  valuation: z.enum(['market', 'cost']),
  fx: z.object({ baseCurrency: z.string(), rates: z.record(z.string(), z.string()) }).nullable(),
  priceProvider: z.string(),
  rootAccountId: z.string().nullable(),
  totals: reportTotalsSchema,
  warnings: z.array(z.string()),
  notes: z.array(z.string()),
};

export const accountsReportSchema = apiSchema('AccountsReport', z.object({ ...envelope, accounts: z.array(accountReportNodeSchema) }));
export const categoriesReportSchema = apiSchema(
  'CategoriesReport',
  z.object({ ...envelope, categories: z.array(z.object({ category: categoryRef, totals: reportTotalsSchema, items: z.array(reportItemSchema) })) }),
);
