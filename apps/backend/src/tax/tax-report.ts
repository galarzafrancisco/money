import { GAP_DESCRIPTIONS, type CategoryTotalLine, type GapCode, type PositionView, type TotalLine } from './tax-views';

/** What a report is rendered from: a live year summary or a filed snapshot */
export type ReportInput = {
  taxYear: string;
  period: { start: string; end: string };
  status: string;
  positions: readonly PositionView[];
  totals: { byKind: readonly TotalLine[]; byCategory: readonly CategoryTotalLine[] };
  filedVersion?: number | null;
  /** Shown under the status line, e.g. that the live records drifted from the filed figures */
  warnings?: readonly string[];
};

const KIND_LABEL: Record<string, string> = { DEDUCTION: 'Deductions', INCOME: 'Income', OFFSET: 'Offsets', OTHER: 'Other' };

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row per position, for a spreadsheet or a tax agent */
export function renderCsv(input: ReportInput): string {
  const header = ['taxYear', 'kind', 'category', 'description', 'date', 'currency', 'amount', 'percent', 'proposedAmount', 'claimedAmount', 'status', 'source', 'links', 'evidence', 'gaps'];
  const lines = input.positions.map((p) =>
    [input.taxYear, p.kind, p.category, p.description, p.date, p.currency, p.amount, p.percent, p.proposedAmount, p.claimedAmount, p.status, p.source, p.linkCount, p.evidenceCount, p.gaps.join(' ')].map(csvCell).join(','),
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}

/** A copyable annual summary: totals, then every position grouped by kind and category, then open gaps */
export function renderMarkdown(input: ReportInput): string {
  const out: string[] = [];
  out.push(`# Tax summary FY ${input.taxYear} (${input.period.start} to ${input.period.end})`);
  out.push('');
  out.push(`Status: ${input.status}${input.filedVersion ? ` (filed version ${input.filedVersion})` : ''}. Tracking aid only, not tax advice: proposed figures are your own intentions and estimates.`);
  for (const w of input.warnings ?? []) {
    out.push('');
    out.push(`> ${w}`);
  }
  out.push('');
  out.push('## Totals');
  out.push('');
  if (input.totals.byKind.length === 0) out.push('No positions recorded.');
  for (const t of input.totals.byKind) {
    out.push(`- ${KIND_LABEL[t.kind] ?? t.kind} (${t.currency}): proposed ${t.proposed}, confirmed ${t.confirmed}, claimed ${t.claimed} (${t.count} position${t.count === 1 ? '' : 's'})`);
  }
  for (const kind of ['DEDUCTION', 'INCOME', 'OFFSET', 'OTHER']) {
    const categories = input.totals.byCategory.filter((c) => c.kind === kind);
    if (categories.length === 0) continue;
    out.push('');
    out.push(`## ${KIND_LABEL[kind]}`);
    for (const c of categories) {
      out.push('');
      out.push(`### ${c.category}: proposed ${c.proposed} ${c.currency}`);
      out.push('');
      out.push('| Date | Description | Amount | % | Proposed | Claimed | Status |');
      out.push('|---|---|---:|---:|---:|---:|---|');
      for (const p of input.positions.filter((x) => x.kind === kind && x.category === c.category && x.currency === c.currency)) {
        out.push(`| ${p.date ?? ''} | ${p.description.replace(/\|/g, '\\|')} | ${p.amount ?? '—'} | ${p.percent} | ${p.proposedAmount ?? '—'} | ${p.claimedAmount ?? ''} | ${p.status} |`);
      }
    }
  }
  const withGaps = input.positions.filter((p) => p.gaps.length > 0);
  if (withGaps.length > 0) {
    out.push('');
    out.push('## Open questions');
    out.push('');
    for (const p of withGaps) out.push(`- ${p.description}: ${p.gaps.map((g: GapCode) => GAP_DESCRIPTIONS[g]).join('; ')}`);
  }
  return out.join('\n') + '\n';
}
