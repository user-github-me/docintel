import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Actor } from '../common/auth/api-key.guard';
import { ReconciliationService } from './reconciliation.service';

class CreateReconciliationBody {
  @ApiProperty({ description: 'e.g. the invoice PDF batch' }) @IsUUID() leftDocumentId: string;
  @ApiProperty({ description: 'e.g. the Excel/CSV register or a second PDF' }) @IsUUID() rightDocumentId: string;
  @ApiPropertyOptional({ default: 0.05 }) @IsOptional() @IsNumber() @Min(0) @Max(1000) amountTolerance?: number;
  @ApiPropertyOptional({ default: 3 }) @IsOptional() @IsNumber() @Min(0) @Max(60) dateToleranceDays?: number;
}

@ApiTags('cross-verification')
@ApiSecurity('api-key')
@Controller('reconciliations')
export class ReconciliationController {
  constructor(private readonly service: ReconciliationService) {}

  @Post()
  @ApiOperation({ summary: 'Cross-verify two processed documents (PDF-PDF or PDF-Excel/CSV): matches, field discrepancies, missing invoices' })
  create(@Body() body: CreateReconciliationBody, @Actor() actor: string) {
    return this.service.create(body.leftDocumentId, body.rightDocumentId, { amountTolerance: body.amountTolerance, dateToleranceDays: body.dateToleranceDays }, actor);
  }

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }
}
