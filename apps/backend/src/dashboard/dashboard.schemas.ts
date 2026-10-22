import { z } from 'zod';
import { currencyCode } from '../common/validation';
import { fxRates } from '../reports/reports.schemas';

/** Shared by GET /api/dashboard (query string) and the get_dashboard MCP tool */
export const dashboardOptionsSchema = z.object({
  displayCurrency: currencyCode
    .default('AUD')
    .describe('Currency to show converted totals and percentages in, e.g. AUD or USD. Only changes how figures are shown; recorded amounts keep their own currency.'),
  fxRates: fxRates
    .optional()
    .describe(
      'Manual exchange rates: units of displayCurrency per 1 unit of each currency, e.g. { "USD": "1.52" } with displayCurrency AUD. A currency without a manual rate gets the latest rate from the market-price provider.',
    ),
});
export type DashboardOptionsInput = z.input<typeof dashboardOptionsSchema>;
