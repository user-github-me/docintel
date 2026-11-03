import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListDocumentsQuery {
  @ApiPropertyOptional({ enum: ['queued', 'processing', 'analyzing', 'completed', 'failed', 'duplicate'] })
  @IsOptional() @IsIn(['queued', 'processing', 'analyzing', 'completed', 'failed', 'duplicate'])
  status?: string;

  @ApiPropertyOptional({ enum: ['pdf', 'image', 'xlsx', 'xls', 'csv'] })
  @IsOptional() @IsIn(['pdf', 'image', 'xlsx', 'xls', 'csv'])
  fileType?: string;

  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean()
  needsReview?: boolean;

  @ApiPropertyOptional({ description: 'Filename contains' }) @IsOptional() @IsString() @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 25 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize = 25;
}

export class UploadQuery {
  @ApiPropertyOptional({ enum: ['invoices', 'reference'], description: '"reference" = ledger/register used only for cross-verification (excluded from duplicate checks)' })
  @IsOptional() @IsIn(['invoices', 'reference'])
  purpose: 'invoices' | 'reference' = 'invoices';

  @ApiPropertyOptional({ description: 'Process byte-identical re-uploads instead of linking them to the original' })
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean()
  allowDuplicates = false;
}

export class ReprocessBody {
  @ApiPropertyOptional({ description: 'Required when the document has manual corrections that re-extraction would replace' })
  @IsOptional() @IsBoolean()
  force?: boolean;
}
