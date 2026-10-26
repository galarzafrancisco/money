import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { DepreciationMethod } from './depreciation-math';
import type { EvidenceKind, ReviewStatus, TaxItemKind, TaxReturnStatus } from './tax.schemas';

const numeric = (name: string, nullable = true) => ({ name, type: 'numeric' as const, precision: 30, scale: 10, nullable });

/** One proposed tax position in one financial year (start_year 2026 = FY 2026-27). The proposed amount is derived. */
@Entity('tax_items')
export class TaxItemEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'start_year', type: 'integer' }) startYear: number;
  @Column({ type: 'varchar', length: 12 }) kind: TaxItemKind;
  @Column({ type: 'varchar', length: 60 }) category: string;
  @Column({ type: 'varchar', length: 500 }) description: string;
  @Column({ name: 'incurred_on', type: 'date', nullable: true }) incurredOn: string | null;
  @Column({ type: 'varchar', length: 3 }) currency: string;
  /** The full source amount (before the claim percentage); null: taken from linked transactions */
  @Column(numeric('amount')) amount: string | null;
  @Column(numeric('claim_percent', false)) claimPercent: string;
  @Column({ type: 'varchar', length: 12 }) status: ReviewStatus;
  @Column({ type: 'text', nullable: true }) rationale: string | null;
  @Column({ type: 'text', nullable: true }) notes: string | null;
  /** What was actually claimed or filed, recorded by the user. Separate from the proposal. */
  @Column(numeric('claimed_amount')) claimedAmount: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

/** A depreciating asset. Its schedule is derived from these inputs (depreciation-math.ts), never stored. */
@Entity('tax_assets')
export class TaxAssetEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'varchar', length: 60 }) category: string;
  @Column({ type: 'varchar', length: 3 }) currency: string;
  @Column(numeric('cost', false)) cost: string;
  @Column({ name: 'acquired_on', type: 'date' }) acquiredOn: string;
  @Column({ name: 'first_used_on', type: 'date', nullable: true }) firstUsedOn: string | null;
  @Column({ type: 'varchar', length: 20 }) method: DepreciationMethod;
  @Column(numeric('effective_life_years')) effectiveLifeYears: string | null;
  @Column(numeric('rate_percent')) ratePercent: string | null;
  @Column(numeric('default_use_percent', false)) defaultUsePercent: string;
  /** Ownership and use context, in the user's words */
  @Column({ type: 'text', nullable: true }) ownership: string | null;
  @Column({ name: 'disposed_on', type: 'date', nullable: true }) disposedOn: string | null;
  @Column(numeric('disposal_proceeds')) disposalProceeds: string | null;
  @Column({ type: 'text', nullable: true }) notes: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

/** Per asset and financial year: use percentage override, review state and the claimed figure */
@Entity('tax_asset_years')
export class TaxAssetYearEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'asset_id', type: 'uuid' }) assetId: string;
  @Column({ name: 'start_year', type: 'integer' }) startYear: number;
  @Column(numeric('use_percent')) usePercent: string | null;
  @Column({ type: 'varchar', length: 12 }) status: ReviewStatus;
  @Column(numeric('claimed_amount')) claimedAmount: string | null;
  @Column({ type: 'text', nullable: true }) note: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

/** Exactly one owner (item or asset) and exactly one source (Money or Up transaction). Immutable: remove and re-add. */
@Entity('tax_source_links')
export class TaxSourceLinkEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'item_id', type: 'uuid', nullable: true }) itemId: string | null;
  @Column({ name: 'asset_id', type: 'uuid', nullable: true }) assetId: string | null;
  @Column({ name: 'transaction_id', type: 'uuid', nullable: true }) transactionId: string | null;
  @Column({ name: 'up_transaction_id', type: 'uuid', nullable: true }) upTransactionId: string | null;
  @Column({ type: 'text', nullable: true }) note: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

/** A labelled URL to a receipt, invoice or calculation kept elsewhere. Immutable: remove and re-add. */
@Entity('tax_evidence_links')
export class TaxEvidenceLinkEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'item_id', type: 'uuid', nullable: true }) itemId: string | null;
  @Column({ name: 'asset_id', type: 'uuid', nullable: true }) assetId: string | null;
  @Column({ type: 'varchar', length: 200 }) label: string;
  @Column({ type: 'varchar', length: 2048 }) url: string;
  @Column({ type: 'varchar', length: 20 }) kind: EvidenceKind;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

/** A financial year's return record: created on first write in that year, locked by every writer in it */
@Entity('tax_returns')
export class TaxReturnEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ type: 'varchar', length: 4 }) jurisdiction: string;
  @Column({ name: 'start_year', type: 'integer' }) startYear: number;
  @Column({ type: 'varchar', length: 12 }) status: TaxReturnStatus;
  @Column({ type: 'text', nullable: true }) notes: string | null;
  /** Why the filed return was reopened (AMENDING); recorded in the amendment's snapshot when it is filed */
  @Column({ name: 'amending_reason', type: 'text', nullable: true }) amendingReason: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

/** An immutable record of what was filed: never updated or deleted (only with the user) */
@Entity('tax_return_filings')
export class TaxReturnFilingEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'return_id', type: 'uuid' }) returnId: string;
  @Column({ type: 'integer' }) version: number;
  @Column({ type: 'varchar', length: 12 }) kind: 'ORIGINAL' | 'AMENDMENT';
  @Column({ name: 'filed_on', type: 'date' }) filedOn: string;
  @Column({ type: 'varchar', length: 120, nullable: true }) reference: string | null;
  @Column({ type: 'text', nullable: true }) note: string | null;
  @Column({ type: 'jsonb' }) snapshot: unknown;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

export const TAX_ENTITIES = [TaxItemEntity, TaxAssetEntity, TaxAssetYearEntity, TaxSourceLinkEntity, TaxEvidenceLinkEntity, TaxReturnEntity, TaxReturnFilingEntity];
