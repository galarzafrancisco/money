import { z } from 'zod';
import { dec } from '../common/decimal';
import { currencyCode, decimalString, isoDate } from '../common/validation';
import { DEPRECIATION_METHODS } from './depreciation-math';
import { MAX_TAX_YEAR, MIN_TAX_YEAR, parseTaxYear } from './financial-year';

/**
 * Input schemas for the tax ledger and asset register. The service parses
 * with them, so REST and MCP get the same validation; the MCP tools reuse the
 * shapes as their input schemas.
 */

export const TAX_ITEM_KINDS = ['DEDUCTION', 'INCOME', 'OFFSET', 'OTHER'] as const;
export type TaxItemKind = (typeof TAX_ITEM_KINDS)[number];

export const REVIEW_STATUSES = ['TO_REVIEW', 'CONFIRMED', 'EXCLUDED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const TAX_RETURN_STATUSES = ['PREPARING', 'FILED', 'AMENDING'] as const;
export type TaxReturnStatus = (typeof TAX_RETURN_STATUSES)[number];

export const EVIDENCE_KINDS = ['RECEIPT', 'INVOICE', 'CALCULATION', 'STATEMENT', 'OTHER'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Suggestions only: any lower-case slug is accepted, so categories stay extensible */
export const SUGGESTED_TAX_CATEGORIES: readonly { category: string; kind: TaxItemKind; label: string }[] = [
  { category: 'work-related-expenses', kind: 'DEDUCTION', label: 'Work-related expenses' },
  { category: 'self-education', kind: 'DEDUCTION', label: 'Self-education (courses, conferences)' },
  { category: 'tools-and-equipment', kind: 'DEDUCTION', label: 'Tools and equipment (low cost, immediate)' },
  { category: 'depreciating-assets', kind: 'DEDUCTION', label: 'Depreciating assets (from the asset register)' },
  { category: 'home-office', kind: 'DEDUCTION', label: 'Home office running costs' },
  { category: 'phone-and-internet', kind: 'DEDUCTION', label: 'Phone and internet' },
  { category: 'subscriptions-and-memberships', kind: 'DEDUCTION', label: 'Subscriptions, memberships, union fees' },
  { category: 'travel', kind: 'DEDUCTION', label: 'Work travel' },
  { category: 'donations', kind: 'DEDUCTION', label: 'Gifts and donations' },
  { category: 'cost-of-managing-tax-affairs', kind: 'DEDUCTION', label: 'Cost of managing tax affairs' },
  { category: 'investment-expenses', kind: 'DEDUCTION', label: 'Investment expenses (interest, fees)' },
  { category: 'income-protection', kind: 'DEDUCTION', label: 'Income protection insurance' },
  { category: 'other-income', kind: 'INCOME', label: 'Other income to declare' },
  { category: 'tax-offsets', kind: 'OFFSET', label: 'Tax offsets' },
  { category: 'other', kind: 'OTHER', label: 'Other' },
];

const YEAR_HINT = 'Australian financial year, e.g. "2026-27" (1 July 2026 to 30 June 2027). "FY2026-27", "2026/27" or the start year as a number (2026) are accepted too.';

/**
 * A financial year written "2026-27"; parsed to its start year (2026). An
 * integer is taken as the start year, so parsing is idempotent (the MCP SDK
 * hands tools their already-parsed arguments, which the service parses again).
 */
export const taxYear = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const parsed = typeof value === 'number' ? (Number.isInteger(value) && value >= MIN_TAX_YEAR && value <= MAX_TAX_YEAR ? value : null) : parseTaxYear(value);
    if (parsed === null) {
      ctx.addIssue({ code: 'custom', message: 'must be a financial year such as "2026-27"' });
      return z.NEVER;
    }
    return parsed;
  })
  .describe(YEAR_HINT);

const percent = (description: string) =>
  decimalString(description).refine((v) => dec(v).gte(0) && dec(v).lte(100), { message: 'must be between 0 and 100' });

const nonNegative = (description: string) => decimalString(description).refine((v) => dec(v).gte(0), { message: 'must not be negative' });
const positive = (description: string) => decimalString(description).refine((v) => dec(v).gt(0), { message: 'must be greater than 0' });

const category = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase().replace(/[\s_]+/g, '-'))
  .refine((v) => /^[a-z0-9][a-z0-9-]{0,59}$/.test(v), { message: 'must be a short slug such as "self-education" (letters, digits, hyphens; at most 60)' })
  .describe('Category slug. Suggestions: GET /api/tax/categories (list_tax_categories); your own slugs are fine too.');

const text = (max: number) => z.string().trim().max(max);

export const evidenceUrl = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (v) => {
      try {
        const url = new URL(v);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    },
    { message: 'must be an http(s) URL' },
  )
  .describe('Where the document lives (cloud drive, email archive, vendor portal). Money stores the link only, never the file.');

export const evidenceShape = {
  label: text(200).min(1).describe('What it is, e.g. "Receipt", "Invoice INV-123", "Use-percentage diary"'),
  url: evidenceUrl,
  kind: z.enum(EVIDENCE_KINDS).optional().describe('RECEIPT, INVOICE, CALCULATION, STATEMENT or OTHER (default)'),
};
export const evidenceSchema = z.object(evidenceShape);

/** A source: one of a Money transaction or an imported Up transaction */
export const sourceRefShape = {
  transactionId: z.string().optional().describe('A Money transaction ID (list_transactions, search_transactions with source "manual")'),
  upTransactionId: z.string().optional().describe('An imported Up transaction ID (list_up_transactions, search_transactions with source "up")'),
};
const oneSource = (v: { transactionId?: string; upTransactionId?: string }) => (v.transactionId === undefined) !== (v.upTransactionId === undefined);
export const sourceRefSchema = z.object(sourceRefShape).refine(oneSource, { message: 'Give exactly one of transactionId or upTransactionId' });

const allowShared = z
  .boolean()
  .optional()
  .describe('Allow a transaction that is already linked to another tax item (e.g. one invoice split over two claims). Never allowed when it funds a registered asset: that would count the purchase twice.');

export const createTaxItemShape = {
  taxYear: taxYear.optional().describe(`${YEAR_HINT} Default: the year of date, else the current year.`),
  kind: z.enum(TAX_ITEM_KINDS).optional().describe('DEDUCTION (default), INCOME, OFFSET or OTHER'),
  category: category.optional().describe('Category slug, default "other". Suggestions: list_tax_categories.'),
  description: text(500).min(1).describe('What it is, e.g. "AI Engineering Conference ticket"'),
  date: isoDate.optional().describe('When it was incurred or paid (YYYY-MM-DD); also sets the default taxYear'),
  currency: currencyCode.optional().describe('Default AUD. An Australian return is in AUD: convert other currencies yourself.'),
  amount: nonNegative('Full source amount before the claim percentage. Omit to use the linked transactions\' amounts.').optional(),
  claimPercent: percent('Intended claim percentage, 0-100 (default 100), e.g. 50 for half work use').optional(),
  status: z.enum(REVIEW_STATUSES).optional().describe('TO_REVIEW (default), CONFIRMED or EXCLUDED'),
  rationale: text(4000).optional().describe('Why you intend to claim it, in your words. Not a determination of eligibility.'),
  notes: text(4000).optional(),
  claimedAmount: nonNegative('What you actually claimed on the lodged return, once known').optional(),
  links: z.array(sourceRefSchema).max(20).optional().describe('Transactions this item comes from'),
  evidence: z.array(evidenceSchema).max(20).optional().describe('Receipt, invoice or calculation URLs'),
  allowShared,
};
export const createTaxItemSchema = z.object(createTaxItemShape);
export type CreateTaxItemInput = z.input<typeof createTaxItemSchema>;

export const updateTaxItemShape = {
  taxYear: taxYear.optional().describe(`Move the item to another year. ${YEAR_HINT}`),
  kind: z.enum(TAX_ITEM_KINDS).optional(),
  category: category.optional(),
  description: text(500).min(1).optional(),
  date: isoDate.nullish().describe('YYYY-MM-DD; null clears it'),
  currency: currencyCode.optional(),
  amount: nonNegative('Full source amount; null uses the linked transactions').nullish(),
  claimPercent: percent('Intended claim percentage, 0-100').optional(),
  status: z.enum(REVIEW_STATUSES).optional(),
  rationale: text(4000).nullish(),
  notes: text(4000).nullish(),
  claimedAmount: nonNegative('What you actually claimed; null clears it').nullish(),
};
export const updateTaxItemSchema = z
  .object(updateTaxItemShape)
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Provide at least one field to change' });
export type UpdateTaxItemInput = z.input<typeof updateTaxItemSchema>;

export const listTaxItemsShape = {
  taxYear: taxYear.optional(),
  kind: z.enum(TAX_ITEM_KINDS).optional(),
  category: category.optional(),
  status: z.enum(REVIEW_STATUSES).optional(),
  source: z.enum(['linked', 'unlinked']).optional().describe('linked: has at least one transaction; unlinked: manual or not yet matched'),
  evidence: z.enum(['present', 'missing']).optional().describe('Items with or without evidence URLs'),
  q: text(100).min(1).optional().describe('Text in the description, rationale or notes, any case'),
};
export const listTaxItemsSchema = z.object(listTaxItemsShape);
export type ListTaxItemsInput = z.input<typeof listTaxItemsSchema>;

const ownerShape = {
  itemId: z.string().optional().describe('Tax item ID (list_tax_items)'),
  assetId: z.string().optional().describe('Asset ID (list_tax_assets)'),
};
const oneOwner = (v: { itemId?: string; assetId?: string }) => (v.itemId === undefined) !== (v.assetId === undefined);

export const createLinkShape = { ...ownerShape, ...sourceRefShape, note: text(1000).optional(), allowShared };
export const createLinkSchema = z
  .object(createLinkShape)
  .refine(oneOwner, { message: 'Give exactly one of itemId or assetId' })
  .refine(oneSource, { message: 'Give exactly one of transactionId or upTransactionId' });
export type CreateLinkInput = z.input<typeof createLinkSchema>;

export const createEvidenceShape = { ...ownerShape, ...evidenceShape };
export const createEvidenceSchema = z.object(createEvidenceShape).refine(oneOwner, { message: 'Give exactly one of itemId or assetId' });
export type CreateEvidenceInput = z.input<typeof createEvidenceSchema>;

const method = z
  .enum(DEPRECIATION_METHODS)
  .describe('PRIME_COST (straight line: cost × 100%/life), DIMINISHING_VALUE (opening value × 200%/life) or IMMEDIATE (full cost in the first year of use, only if you have confirmed it is eligible)');
const life = positive('Effective life in years: your choice, e.g. from the ATO\'s published determination for the asset or your own self-assessment. Money does not look it up.');
const rate = percent('Overrides the rate derived from effective life, per cent per full year');

export const createTaxAssetShape = {
  name: text(200).min(1).describe('e.g. "NVIDIA DGX Spark"'),
  description: text(4000).optional(),
  category: category.optional().describe('Category slug, default "depreciating-assets"'),
  currency: currencyCode.optional().describe('Default AUD'),
  cost: positive('Cost (purchase price plus costs to get it ready for use)'),
  acquiredOn: isoDate.describe('Purchase or acquisition date (YYYY-MM-DD)'),
  firstUsedOn: isoDate.optional().describe('First used or installed ready for use (YYYY-MM-DD). Decline starts here; omit while not in use yet.'),
  method,
  effectiveLifeYears: life.optional(),
  ratePercent: rate.optional(),
  defaultUsePercent: percent('Work/business use percentage for years without their own figure (default 100). The rest is private use.').optional(),
  ownership: text(2000).optional().describe('Ownership and use context, e.g. "Owned by me; used for consulting work at home"'),
  disposedOn: isoDate.optional().describe('When sold, scrapped or stopped being used (YYYY-MM-DD)'),
  disposalProceeds: nonNegative('Termination value on disposal (sale price, insurance payout). Default 0.').optional(),
  notes: text(4000).optional(),
  links: z.array(sourceRefSchema).max(20).optional().describe('The payment transaction(s) for the purchase'),
  evidence: z.array(evidenceSchema).max(20).optional(),
};
export const createTaxAssetSchema = z.object(createTaxAssetShape);
export type CreateTaxAssetInput = z.input<typeof createTaxAssetSchema>;

export const updateTaxAssetShape = {
  name: text(200).min(1).optional(),
  description: text(4000).nullish(),
  category: category.optional(),
  currency: currencyCode.optional(),
  cost: positive('Cost').optional(),
  acquiredOn: isoDate.optional(),
  firstUsedOn: isoDate.nullish().describe('null: not in use yet'),
  method: method.optional(),
  effectiveLifeYears: life.nullish(),
  ratePercent: rate.nullish(),
  defaultUsePercent: percent('Default work/business use percentage').optional(),
  ownership: text(2000).nullish(),
  disposedOn: isoDate.nullish().describe('null: still held'),
  disposalProceeds: nonNegative('Termination value').nullish(),
  notes: text(4000).nullish(),
};
export const updateTaxAssetSchema = z
  .object(updateTaxAssetShape)
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Provide at least one field to change' });
export type UpdateTaxAssetInput = z.input<typeof updateTaxAssetSchema>;

export const assetYearShape = {
  usePercent: percent('Work/business use percentage for this year; null falls back to the asset\'s default').nullish(),
  status: z.enum(REVIEW_STATUSES).optional().describe('Review state of this year\'s depreciation claim'),
  claimedAmount: nonNegative('What you actually claimed for this asset in this year; null clears it').nullish(),
  note: text(2000).nullish(),
};
export const assetYearSchema = z
  .object(assetYearShape)
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Provide at least one field to change' });
export type AssetYearInput = z.input<typeof assetYearSchema>;

export const scheduleQueryShape = {
  throughYear: taxYear.optional().describe('Last year to show. Default: when a prime-cost write-off would finish, or the current year if later.'),
};
export const scheduleQuerySchema = z.object(scheduleQueryShape);
export type ScheduleQueryInput = z.input<typeof scheduleQuerySchema>;

export const fileYearShape = {
  filedOn: isoDate.describe('The date the return (or amendment) was lodged (YYYY-MM-DD)'),
  reference: text(120).optional().describe('Lodgment or receipt reference, if any'),
  note: text(4000).optional(),
  allowUnreviewed: z.boolean().optional().describe('File even though some positions are still TO_REVIEW (they are recorded as such in the snapshot)'),
};
export const fileYearSchema = z.object(fileYearShape);
export type FileYearInput = z.input<typeof fileYearSchema>;

export const amendYearShape = { reason: text(2000).min(1).describe('Why the filed return is being amended') };
export const amendYearSchema = z.object(amendYearShape);
export type AmendYearInput = z.input<typeof amendYearSchema>;

export const updateYearShape = { notes: text(8000).nullable().describe('Your preparation notes for the year; null clears them') };
export const updateYearSchema = z.object(updateYearShape);
export type UpdateYearInput = z.input<typeof updateYearSchema>;

export const reportQueryShape = { version: z.string().regex(/^\d+$/, { message: 'must be a filing version number' }).optional().describe('A filed version (1 = original). Omit for the live figures.') };
export const reportQuerySchema = z.object(reportQueryShape);
export type ReportQueryInput = z.input<typeof reportQuerySchema>;
