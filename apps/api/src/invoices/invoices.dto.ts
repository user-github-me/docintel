import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumberString, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class ListInvoicesQuery {
  @ApiPropertyOptional({ description: 'Keyword query (invoice number, names, items)' }) @IsOptional() @IsString() @MaxLength(200)
  q?: string;
  @ApiPropertyOptional({ enum: ['needs_review', 'validated', 'approved', 'rejected'] }) @IsOptional() @IsIn(['needs_review', 'validated', 'approved', 'rejected'])
  status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) supplier?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) customer?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
  @ApiPropertyOptional({ example: '2026-01-01' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dateFrom?: string;
  @ApiPropertyOptional({ example: '2026-12-31' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dateTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() minTotal?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() maxTotal?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() documentId?: string;
  @ApiPropertyOptional({ description: 'Only invoices with this issue code' }) @IsOptional() @Matches(/^[A-Z_]{3,40}$/) issue?: string;
  @ApiPropertyOptional({ enum: ['created_at', 'invoice_date', 'total', 'confidence'] }) @IsOptional() @IsIn(['created_at', 'invoice_date', 'total', 'confidence'])
  sort: 'created_at' | 'invoice_date' | 'total' | 'confidence' = 'created_at';
  @ApiPropertyOptional({ enum: ['asc', 'desc'] }) @IsOptional() @IsIn(['asc', 'desc']) order: 'asc' | 'desc' = 'desc';
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @ApiPropertyOptional({ default: 25 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) pageSize = 25;
}

export class LineItemInput {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) quantity?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) unit_price?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) amount?: string | null;
}

export class CorrectInvoiceBody {
  @ApiProperty({ description: 'Current version (optimistic locking); 409 if someone else saved first' }) @Type(() => Number) @IsInt()
  version: number;
  @ApiPropertyOptional({ description: 'Field corrections, e.g. {"total": "1373.95", "invoice_date": "2026-03-14"}; null clears a value', example: { total: '1373.95' } })
  @IsOptional() @IsObject()
  fields?: Record<string, string | null>;
  @ApiPropertyOptional({ type: [LineItemInput], description: 'Replaces all line items when provided' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => LineItemInput)
  lineItems?: LineItemInput[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ApproveBody {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ description: 'Approve despite blocking errors (note required)' }) @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean()
  override?: boolean;
}

export class RejectBody {
  @ApiProperty() @IsString() @MaxLength(500) reason: string;
}
