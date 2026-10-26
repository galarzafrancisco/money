import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ApiRoute } from '../openapi/api-route.decorator';
import { apiSchema } from '../openapi/api-schemas';
import type { CurrentUser } from '../users/users.service';
import { TaxAssetsService } from './tax-assets.service';
import { TaxLedgerService } from './tax-ledger.service';
import { TaxYearsService } from './tax-years.service';
import {
  deleteTaxLinkResultSchema,
  deleteTaxRecordResultSchema,
  depreciationScheduleSchema,
  taxAssetListSchema,
  taxAssetSchema,
  taxCategoriesSchema,
  taxEvidenceResultSchema,
  taxFilingSnapshotSchema,
  taxItemListSchema,
  taxItemSchema,
  taxLinkResultSchema,
  taxYearListSchema,
  taxYearReportSchema,
  taxYearSummarySchema,
} from './tax.responses';
import {
  amendYearSchema,
  assetYearSchema,
  createEvidenceSchema,
  createLinkSchema,
  createTaxAssetSchema,
  createTaxItemSchema,
  fileYearSchema,
  listTaxItemsSchema,
  reportQuerySchema,
  scheduleQuerySchema,
  updateTaxAssetSchema,
  updateTaxItemSchema,
  updateYearSchema,
} from './tax.schemas';

/** The tax ledger, asset register and financial-year returns: docs/tax.md. Tracking aids, not tax advice. */
@Controller('api/tax')
@Protected()
export class TaxController {
  constructor(
    private readonly ledger: TaxLedgerService,
    private readonly assets: TaxAssetsService,
    private readonly years: TaxYearsService,
  ) {}

  @Get('categories')
  @ApiRoute({ tag: 'tax', operationId: 'listTaxCategories', summary: 'Suggested tax categories (any slug is accepted)', response: taxCategoriesSchema })
  categories() {
    return this.ledger.categories();
  }

  // ---- items ----

  @Get('items')
  @ApiRoute({ tag: 'tax', operationId: 'listTaxItems', summary: 'Your tax items, filtered by year, kind, category, status, link and evidence state, or text', query: listTaxItemsSchema, response: taxItemListSchema })
  listItems(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, unknown>) {
    return this.ledger.list(user, query as never);
  }

  @Post('items')
  @ApiRoute({ tag: 'tax', operationId: 'createTaxItem', summary: 'Remember something for a tax return: a proposed deduction, income or offset', body: apiSchema('CreateTaxItemRequest', createTaxItemSchema), response: taxItemSchema })
  createItem(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.ledger.create(user, body as never);
  }

  @Get('items/:itemId')
  @ApiRoute({ tag: 'tax', operationId: 'getTaxItem', summary: 'One tax item with its linked transactions, evidence and gaps', response: taxItemSchema })
  getItem(@AuthenticatedUser() user: CurrentUser, @Param('itemId') itemId: string) {
    return this.ledger.get(user, itemId);
  }

  @Patch('items/:itemId')
  @ApiRoute({ tag: 'tax', operationId: 'updateTaxItem', summary: 'Change a tax item (refused while its year is filed)', body: apiSchema('UpdateTaxItemRequest', updateTaxItemSchema), response: taxItemSchema })
  updateItem(@AuthenticatedUser() user: CurrentUser, @Param('itemId') itemId: string, @Body() body: unknown) {
    return this.ledger.update(user, itemId, body as never);
  }

  @Delete('items/:itemId')
  @HttpCode(200)
  @ApiRoute({ tag: 'tax', operationId: 'deleteTaxItem', summary: 'Delete a tax item with its links and evidence (never the transactions)', response: deleteTaxRecordResultSchema })
  deleteItem(@AuthenticatedUser() user: CurrentUser, @Param('itemId') itemId: string) {
    return this.ledger.delete(user, itemId);
  }

  // ---- links and evidence ----

  @Post('links')
  @ApiRoute({ tag: 'tax', operationId: 'linkTaxTransaction', summary: 'Link a tax item or asset to a Money or Up transaction (refuses double counting)', body: apiSchema('CreateTaxLinkRequest', createLinkSchema), response: taxLinkResultSchema })
  link(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.ledger.link(user, body as never);
  }

  @Delete('links/:linkId')
  @HttpCode(200)
  @ApiRoute({ tag: 'tax', operationId: 'unlinkTaxTransaction', summary: 'Remove a link (the transaction is untouched)', response: deleteTaxLinkResultSchema })
  unlink(@AuthenticatedUser() user: CurrentUser, @Param('linkId') linkId: string) {
    return this.ledger.unlink(user, linkId);
  }

  @Post('evidence')
  @ApiRoute({ tag: 'tax', operationId: 'addTaxEvidence', summary: 'Attach an evidence URL (receipt, invoice, calculation) to a tax item or asset', body: apiSchema('CreateTaxEvidenceRequest', createEvidenceSchema), response: taxEvidenceResultSchema })
  addEvidence(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.ledger.addEvidence(user, body as never);
  }

  @Delete('evidence/:evidenceId')
  @HttpCode(200)
  @ApiRoute({ tag: 'tax', operationId: 'removeTaxEvidence', summary: 'Remove an evidence link', response: deleteTaxLinkResultSchema })
  removeEvidence(@AuthenticatedUser() user: CurrentUser, @Param('evidenceId') evidenceId: string) {
    return this.ledger.removeEvidence(user, evidenceId);
  }

  // ---- assets ----

  @Get('assets')
  @ApiRoute({ tag: 'tax', operationId: 'listTaxAssets', summary: 'Your depreciating asset register with this year\'s estimate', response: taxAssetListSchema })
  listAssets(@AuthenticatedUser() user: CurrentUser) {
    return this.assets.list(user);
  }

  @Post('assets')
  @ApiRoute({ tag: 'tax', operationId: 'registerTaxAsset', summary: 'Register a depreciating asset', body: apiSchema('CreateTaxAssetRequest', createTaxAssetSchema), response: taxAssetSchema })
  createAsset(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.assets.create(user, body as never);
  }

  @Get('assets/:assetId')
  @ApiRoute({ tag: 'tax', operationId: 'getTaxAsset', summary: 'One asset with its links, evidence and depreciation schedule', query: scheduleQuerySchema, response: taxAssetSchema })
  getAsset(@AuthenticatedUser() user: CurrentUser, @Param('assetId') assetId: string, @Query() query: Record<string, unknown>) {
    return this.assets.get(user, assetId, query as never);
  }

  @Patch('assets/:assetId')
  @ApiRoute({ tag: 'tax', operationId: 'updateTaxAsset', summary: 'Change an asset\'s inputs, or record its disposal', body: apiSchema('UpdateTaxAssetRequest', updateTaxAssetSchema), response: taxAssetSchema })
  updateAsset(@AuthenticatedUser() user: CurrentUser, @Param('assetId') assetId: string, @Body() body: unknown) {
    return this.assets.update(user, assetId, body as never);
  }

  @Delete('assets/:assetId')
  @HttpCode(200)
  @ApiRoute({ tag: 'tax', operationId: 'deleteTaxAsset', summary: 'Delete an asset entered by mistake (refused once it is in a filed return)', response: deleteTaxRecordResultSchema })
  deleteAsset(@AuthenticatedUser() user: CurrentUser, @Param('assetId') assetId: string) {
    return this.assets.delete(user, assetId);
  }

  @Get('assets/:assetId/schedule')
  @ApiRoute({ tag: 'tax', operationId: 'getDepreciationSchedule', summary: 'Year-by-year decline in value, deduction estimate and workings', query: scheduleQuerySchema, response: depreciationScheduleSchema })
  schedule(@AuthenticatedUser() user: CurrentUser, @Param('assetId') assetId: string, @Query() query: Record<string, unknown>) {
    return this.assets.schedule(user, assetId, query as never);
  }

  @Put('assets/:assetId/years/:taxYear')
  @ApiRoute({ tag: 'tax', operationId: 'setTaxAssetYear', summary: 'Set one year\'s work-use %, review status or claimed amount for an asset', body: apiSchema('SetTaxAssetYearRequest', assetYearSchema), response: taxAssetSchema })
  setYear(@AuthenticatedUser() user: CurrentUser, @Param('assetId') assetId: string, @Param('taxYear') taxYear: string, @Body() body: unknown) {
    return this.assets.setYear(user, assetId, taxYear, body as never);
  }

  // ---- years ----

  @Get('years')
  @ApiRoute({ tag: 'tax', operationId: 'listTaxYears', summary: 'Financial years with positions, their status and totals', response: taxYearListSchema })
  listYears(@AuthenticatedUser() user: CurrentUser) {
    return this.years.list(user);
  }

  @Get('years/:taxYear')
  @ApiRoute({ tag: 'tax', operationId: 'getTaxYear', summary: 'A financial year\'s positions, totals, gaps and filing history', response: taxYearSummarySchema })
  getYear(@AuthenticatedUser() user: CurrentUser, @Param('taxYear') taxYear: string) {
    return this.years.summary(user, taxYear);
  }

  @Patch('years/:taxYear')
  @ApiRoute({ tag: 'tax', operationId: 'updateTaxYear', summary: 'Edit the year\'s preparation notes', body: apiSchema('UpdateTaxYearRequest', updateYearSchema), response: taxYearSummarySchema })
  updateYear(@AuthenticatedUser() user: CurrentUser, @Param('taxYear') taxYear: string, @Body() body: unknown) {
    return this.years.updateNotes(user, taxYear, body as never);
  }

  @Get('years/:taxYear/report')
  @ApiRoute({ tag: 'tax', operationId: 'getTaxYearReport', summary: 'Copyable Markdown summary and CSV of the year (live, or a filed version)', query: reportQuerySchema, response: taxYearReportSchema })
  report(@AuthenticatedUser() user: CurrentUser, @Param('taxYear') taxYear: string, @Query() query: Record<string, unknown>) {
    return this.years.report(user, taxYear, query as never);
  }

  @Post('years/:taxYear/filings')
  @ApiRoute({ tag: 'tax', operationId: 'fileTaxYear', summary: 'Record that the return (or amendment) was lodged: stores an immutable snapshot', body: apiSchema('FileTaxYearRequest', fileYearSchema), response: taxYearSummarySchema })
  file(@AuthenticatedUser() user: CurrentUser, @Param('taxYear') taxYear: string, @Body() body: unknown) {
    return this.years.file(user, taxYear, body as never);
  }

  @Get('years/:taxYear/filings/:version')
  @ApiRoute({ tag: 'tax', operationId: 'getTaxFiling', summary: 'One filed version\'s full snapshot', response: taxFilingSnapshotSchema })
  filing(@AuthenticatedUser() user: CurrentUser, @Param('taxYear') taxYear: string, @Param('version') version: string) {
    return this.years.filing(user, taxYear, version);
  }

  @Post('years/:taxYear/amendment')
  @HttpCode(200)
  @ApiRoute({ tag: 'tax', operationId: 'reopenTaxYear', summary: 'Reopen a filed year for amendment (earlier filings are kept)', body: apiSchema('ReopenTaxYearRequest', amendYearSchema), response: taxYearSummarySchema })
  amend(@AuthenticatedUser() user: CurrentUser, @Param('taxYear') taxYear: string, @Body() body: unknown) {
    return this.years.amend(user, taxYear, body as never);
  }
}
