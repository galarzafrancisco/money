import { z } from 'zod';
import { apiSchema, decimalOut } from '../openapi/api-schemas';
import { DEPRECIATION_METHODS } from './depreciation-math';
import { EVIDENCE_KINDS, REVIEW_STATUSES, TAX_ITEM_KINDS, TAX_RETURN_STATUSES } from './tax.schemas';
import { GAP_DESCRIPTIONS } from './tax-views';

/** REST response shapes (OpenAPI) mirroring the tax services' views */

const kind = z.enum(TAX_ITEM_KINDS);
const reviewStatus = z.enum(REVIEW_STATUSES);
const yearStatus = z.enum(TAX_RETURN_STATUSES);
const gap = z.enum(Object.keys(GAP_DESCRIPTIONS) as [keyof typeof GAP_DESCRIPTIONS, ...(keyof typeof GAP_DESCRIPTIONS)[]]);
const owner = { itemId: z.string().nullable(), assetId: z.string().nullable() };

export const taxLinkSchema = apiSchema(
  'TaxLink',
  z.object({
    id: z.string().describe('Link ID (unlink_tax_transaction / DELETE /api/tax/links/:id)'),
    source: z.enum(['manual', 'up']).describe('A Money transaction, or a transaction imported read-only from Up'),
    transactionId: z.string().nullable(),
    upTransactionId: z.string().nullable(),
    accountId: z.string(),
    accountName: z.string(),
    type: z.string().nullable().describe('Money transaction type; null for Up'),
    date: z.string().describe('YYYY-MM-DD (Up: the Australia/Sydney date it was created)'),
    currency: z.string(),
    amount: decimalOut('Absolute amount of the transaction').nullable(),
    direction: z.enum(['out', 'in']).nullable(),
    description: z.string().nullable(),
    status: z.enum(['HELD', 'SETTLED']).nullable(),
    deleted: z.boolean().describe('Up deleted it after import'),
    note: z.string().nullable(),
    alsoLinkedTo: z.array(z.object(owner)).describe('Other tax items or assets linked to the same transaction'),
    createdAt: z.string(),
  }),
);

export const taxLinkResultSchema = apiSchema('TaxLinkResult', taxLinkSchema.extend(owner));

export const taxEvidenceSchema = apiSchema(
  'TaxEvidence',
  z.object({ id: z.string(), label: z.string(), url: z.string(), kind: z.enum(EVIDENCE_KINDS), createdAt: z.string() }),
);
export const taxEvidenceResultSchema = apiSchema('TaxEvidenceResult', taxEvidenceSchema.extend(owner));

export const taxItemSchema = apiSchema(
  'TaxItem',
  z.object({
    id: z.string(),
    taxYear: z.string().describe('e.g. "2026-27"'),
    kind,
    category: z.string(),
    description: z.string(),
    date: z.string().nullable(),
    currency: z.string(),
    amount: decimalOut('As entered; null when taken from linked transactions').nullable(),
    amountSource: z.enum(['entered', 'linked', 'missing']),
    effectiveAmount: decimalOut('The amount the proposal is based on').nullable(),
    claimPercent: decimalOut(),
    proposedAmount: decimalOut('effectiveAmount × claimPercent').nullable(),
    claimedAmount: decimalOut('What was actually claimed, as recorded').nullable(),
    status: reviewStatus,
    rationale: z.string().nullable(),
    notes: z.string().nullable(),
    links: z.array(taxLinkSchema),
    evidence: z.array(taxEvidenceSchema),
    gaps: z.array(gap),
    yearStatus,
    locked: z.boolean().describe('The year is filed: reopen it for amendment to edit'),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export const taxItemListSchema = apiSchema('TaxItemList', z.object({ items: z.array(taxItemSchema), notes: z.array(z.string()) }));

export const taxCategoriesSchema = apiSchema(
  'TaxCategories',
  z.object({ suggested: z.array(z.object({ category: z.string(), kind, label: z.string() })), notes: z.array(z.string()) }),
);

export const deleteTaxRecordResultSchema = apiSchema('DeleteTaxRecordResult', z.object({ deleted: z.boolean(), linksRemoved: z.number().int(), evidenceRemoved: z.number().int() }));
export const deleteTaxLinkResultSchema = apiSchema('DeleteTaxLinkResult', z.object({ deleted: z.boolean(), ...owner }));

const balancing = z
  .object({ terminationValue: decimalOut(), adjustableValue: decimalOut(), amount: decimalOut('Positive: estimated assessable; negative: estimated deduction'), taxableAmount: decimalOut('amount × use %') })
  .nullable();

export const depreciationRowSchema = apiSchema(
  'DepreciationRow',
  z.object({
    taxYear: z.string(),
    startYear: z.number().int(),
    periodStart: z.string(),
    periodEnd: z.string(),
    daysHeld: z.number().int(),
    daysInYear: z.number().int(),
    openingValue: decimalOut(),
    decline: decimalOut('Full decline in value, before use apportionment'),
    closingValue: decimalOut(),
    usePercent: decimalOut(),
    usePercentSource: z.enum(['year', 'default']),
    deduction: decimalOut('decline × usePercent: the estimated deduction'),
    privatePortion: decimalOut(),
    balancingAdjustment: balancing,
    workings: z.string(),
    yearStatus,
    review: z.object({ status: reviewStatus, claimedAmount: decimalOut().nullable(), note: z.string().nullable(), usePercentOverride: decimalOut().nullable() }),
    filed: z.object({ version: z.number().int(), deduction: decimalOut().nullable() }).nullable().describe('The latest filed figure for this year, if filed'),
    driftFromFiled: z.boolean().describe('The filed deduction differs from the one computed now'),
  }),
);

const scheduleFields = {
  rulesVersion: z.string(),
  method: z.enum(DEPRECIATION_METHODS),
  ratePercent: decimalOut().nullable(),
  rateSource: z.enum(['override', 'effective-life', 'immediate']),
  firstYear: z.string().nullable(),
  endReason: z.enum(['WRITTEN_OFF', 'DISPOSED', 'HORIZON', 'NOT_STARTED']),
  totals: z.object({ decline: decimalOut(), deduction: decimalOut(), privatePortion: decimalOut() }),
  throughYear: z.string(),
  rows: z.array(depreciationRowSchema),
  notes: z.array(z.string()),
};
const scheduleSchema = apiSchema('DepreciationScheduleBody', z.object(scheduleFields));
export const depreciationScheduleSchema = apiSchema('DepreciationSchedule', z.object({ assetId: z.string(), name: z.string(), ...scheduleFields }));

const assetFields = {
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  currency: z.string(),
  cost: decimalOut(),
  acquiredOn: z.string(),
  firstUsedOn: z.string().nullable(),
  method: z.enum(DEPRECIATION_METHODS),
  effectiveLifeYears: decimalOut().nullable(),
  ratePercent: decimalOut().nullable(),
  defaultUsePercent: decimalOut(),
  ownership: z.string().nullable(),
  disposedOn: z.string().nullable(),
  disposalProceeds: decimalOut().nullable(),
  notes: z.string().nullable(),
  lifecycle: z.enum(['NOT_IN_USE', 'IN_USE', 'WRITTEN_OFF', 'DISPOSED']),
  adjustableValue: decimalOut('Closing value at the end of the last scheduled year'),
  links: z.array(taxLinkSchema),
  evidence: z.array(taxEvidenceSchema),
  gaps: z.array(gap),
  createdAt: z.string(),
  updatedAt: z.string(),
};

export const taxAssetSchema = apiSchema('TaxAsset', z.object({ ...assetFields, schedule: scheduleSchema }));

export const taxAssetListSchema = apiSchema(
  'TaxAssetList',
  z.object({
    currentTaxYear: z.string(),
    assets: z.array(
      z.object({
        ...assetFields,
        currentYear: z
          .object({ taxYear: z.string(), decline: decimalOut(), deduction: decimalOut(), usePercent: decimalOut(), closingValue: decimalOut() })
          .nullable()
          .describe('This year\'s schedule row, if any'),
      }),
    ),
    notes: z.array(z.string()),
  }),
);

export const taxPositionSchema = apiSchema(
  'TaxPosition',
  z.object({
    id: z.string().describe('The item ID, or asset:<assetId>:<taxYear>[:balancing]'),
    source: z.enum(['ITEM', 'ASSET']),
    itemId: z.string().nullable(),
    assetId: z.string().nullable(),
    kind,
    category: z.string(),
    description: z.string(),
    date: z.string().nullable(),
    currency: z.string(),
    amount: decimalOut().nullable(),
    percent: decimalOut('Claim % (items) or work-use % (assets)'),
    proposedAmount: decimalOut().nullable(),
    claimedAmount: decimalOut().nullable(),
    status: reviewStatus,
    linkCount: z.number().int(),
    evidenceCount: z.number().int(),
    gaps: z.array(gap),
    workings: z.string().nullable(),
  }),
);

export const taxPositionDetailSchema = apiSchema(
  'TaxPositionDetail',
  z.object({
    rationale: z.string().nullable(),
    notes: z.string().nullable(),
    sources: z
      .array(
        z.object({
          source: z.enum(['manual', 'up']),
          transactionId: z.string().nullable(),
          upTransactionId: z.string().nullable(),
          accountName: z.string(),
          date: z.string(),
          currency: z.string(),
          amount: decimalOut().nullable(),
          direction: z.enum(['out', 'in']).nullable(),
          description: z.string().nullable(),
          status: z.enum(['HELD', 'SETTLED']).nullable(),
          deleted: z.boolean(),
          note: z.string().nullable(),
        }),
      )
      .describe('The linked source transactions as they stood when filed'),
    evidence: z.array(z.object({ label: z.string(), url: z.string(), kind: z.enum(EVIDENCE_KINDS) })).describe('Evidence URLs as they stood when filed'),
    asset: z
      .object({
        name: z.string(),
        description: z.string().nullable(),
        cost: decimalOut(),
        acquiredOn: z.string(),
        firstUsedOn: z.string().nullable(),
        method: z.string(),
        effectiveLifeYears: decimalOut().nullable(),
        ratePercent: decimalOut().nullable(),
        ownership: z.string().nullable(),
        disposedOn: z.string().nullable(),
        disposalProceeds: decimalOut().nullable(),
        notes: z.string().nullable(),
        openingValue: decimalOut(),
        closingValue: decimalOut(),
        daysHeld: z.number().int(),
        daysInYear: z.number().int(),
        usePercentSource: z.enum(['year', 'default']),
        reviewNote: z.string().nullable(),
      })
      .nullable()
      .describe('Asset positions: the asset inputs and schedule row the figure came from'),
  }),
);

export const taxFiledPositionSchema = apiSchema('TaxFiledPosition', taxPositionSchema.extend({ detail: taxPositionDetailSchema }));

export const taxDriftLineSchema = apiSchema(
  'TaxDriftLine',
  z.object({
    positionId: z.string(),
    description: z.string(),
    change: z.enum(['added', 'removed', 'changed']).describe('Compared with the latest filing: a position that is new, gone, or different now'),
    fields: z.array(z.string()).describe('changed: the figures or supporting detail that differ (e.g. amount, proposedAmount, sources, evidence, asset)'),
    filedProposed: decimalOut().nullable(),
    liveProposed: decimalOut().nullable(),
  }),
);

const totalLine = { kind, currency: z.string(), count: z.number().int(), proposed: decimalOut(), confirmed: decimalOut(), claimed: decimalOut() };
export const taxTotalLineSchema = apiSchema('TaxTotalLine', z.object(totalLine));
export const taxCategoryTotalSchema = apiSchema('TaxCategoryTotal', z.object({ ...totalLine, category: z.string() }));

const filingFields = () => ({
  id: z.string(),
  version: z.number().int(),
  kind: z.enum(['ORIGINAL', 'AMENDMENT']),
  filedOn: z.string(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  amendmentReason: z.string().nullable(),
  rulesVersion: z.string(),
  positionCount: z.number().int(),
  totals: z.object({ byKind: z.array(taxTotalLineSchema) }),
  createdAt: z.string(),
});
export const taxFilingSchema = apiSchema('TaxFiling', z.object(filingFields()));

const period = z.object({ start: z.string(), end: z.string(), days: z.number().int() });
const gapSummary = z.object({
  counts: z.record(z.string(), z.number().int()).describe('Positions per gap code'),
  positions: z.array(z.object({ id: z.string(), description: z.string(), gaps: z.array(gap) })),
});

export const taxYearSummarySchema = apiSchema(
  'TaxYearSummary',
  z.object({
    taxYear: z.string(),
    jurisdiction: z.string(),
    period,
    status: yearStatus,
    basis: z.enum(['FILED', 'LIVE']).describe('FILED: positions, totals and gaps are the latest filed snapshot. LIVE: computed from the records now.'),
    filedVersion: z.number().int().nullable().describe('The filing version shown when basis is FILED'),
    notes: z.string().nullable(),
    amendingReason: z.string().nullable(),
    positions: z.array(taxPositionSchema),
    totals: z.object({ byKind: z.array(taxTotalLineSchema), byCategory: z.array(taxCategoryTotalSchema) }),
    gaps: gapSummary,
    gapDescriptions: z.record(z.string(), z.string()),
    warnings: z.array(z.string()),
    live: z
      .object({ positions: z.array(taxPositionSchema), totals: z.object({ byKind: z.array(taxTotalLineSchema), byCategory: z.array(taxCategoryTotalSchema) }) })
      .nullable()
      .describe('basis FILED: the same year recomputed from the live records now, kept apart from the filed figures'),
    drift: z.array(taxDriftLineSchema).describe('Differences between the latest filing and the live records (empty while preparing a never-filed year)'),
    filings: z.array(taxFilingSchema),
    rulesVersion: z.string(),
    disclaimers: z.array(z.string()),
  }),
);

export const taxYearListSchema = apiSchema(
  'TaxYearList',
  z.object({
    currentTaxYear: z.string(),
    years: z.array(
      z.object({
        taxYear: z.string(),
        period,
        status: yearStatus,
        current: z.boolean(),
        positionCount: z.number().int(),
        itemCount: z.number().int(),
        assetPositionCount: z.number().int(),
        toReview: z.number().int(),
        withGaps: z.number().int(),
        totals: z.array(taxTotalLineSchema),
        latestFiling: z.object(filingFields()).nullable(),
      }),
    ),
    notes: z.array(z.string()),
  }),
);

export const taxYearReportSchema = apiSchema(
  'TaxYearReport',
  z.object({ taxYear: z.string(), version: z.number().int().nullable(), markdown: z.string().describe('Copyable annual summary'), csv: z.string().describe('One row per position') }),
);

export const taxFilingSnapshotSchema = apiSchema(
  'TaxFilingSnapshot',
  z.object({
    id: z.string(),
    taxYear: z.string(),
    jurisdiction: z.string(),
    period: z.object({ start: z.string(), end: z.string() }),
    version: z.number().int(),
    kind: z.enum(['ORIGINAL', 'AMENDMENT']),
    filedOn: z.string(),
    reference: z.string().nullable(),
    note: z.string().nullable(),
    amendmentReason: z.string().nullable(),
    rulesVersion: z.string(),
    positions: z.array(taxFiledPositionSchema).describe('Each position as filed, with the rationale, sources, evidence and asset inputs behind it'),
    totals: z.object({ byKind: z.array(taxTotalLineSchema), byCategory: z.array(taxCategoryTotalSchema) }),
    gaps: gapSummary,
    createdAt: z.string(),
  }),
);
