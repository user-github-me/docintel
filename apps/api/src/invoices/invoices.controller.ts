import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Actor } from '../common/auth/api-key.guard';
import { ApproveBody, CorrectInvoiceBody, ListInvoicesQuery, RejectBody } from './invoices.dto';
import { InvoicesService } from './invoices.service';

@ApiTags('invoices')
@ApiSecurity('api-key')
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}

  @Get()
  @ApiOperation({ summary: 'List/filter extracted invoices (keyword, status, supplier, customer, currency, date and amount ranges, issue code)' })
  list(@Query() q: ListInvoicesQuery) {
    return this.service.list(q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Invoice detail: per-field value/confidence/source/evidence, line items, validation issues, corrections' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Manual corrections (audited, optimistic locking); validation is re-run automatically' })
  correct(@Param('id', ParseUUIDPipe) id: string, @Body() body: CorrectInvoiceBody, @Actor() actor: string) {
    return this.service.correct(id, body, actor);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve an invoice (blocked by validation errors unless override=true with a note)' })
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: ApproveBody, @Actor() actor: string) {
    return this.service.approve(id, actor, body?.note, body?.override ?? false);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject an invoice' })
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() body: RejectBody, @Actor() actor: string) {
    return this.service.reject(id, actor, body.reason);
  }

  @Post(':id/revalidate')
  @ApiOperation({ summary: 'Re-run validation (e.g. after related duplicates were deleted)' })
  revalidate(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: string) {
    return this.service.revalidate(id, actor);
  }

  @Get(':id/history')
  @ApiOperation({ summary: 'Corrections and processing history for an invoice' })
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(id);
  }
}
