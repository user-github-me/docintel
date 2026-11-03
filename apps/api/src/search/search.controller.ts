import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ListInvoicesQuery } from '../invoices/invoices.dto';
import { SearchMode, SearchService } from './search.service';

class SearchQuery extends ListInvoicesQuery {
  @ApiPropertyOptional({ description: 'Free-text query' }) @IsString() @MinLength(1) @MaxLength(300)
  declare q: string;
  @ApiPropertyOptional({ enum: ['hybrid', 'keyword', 'semantic'], default: 'hybrid' }) @IsOptional() @IsIn(['hybrid', 'keyword', 'semantic'])
  mode: SearchMode = 'hybrid';
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit = 20;
}

@ApiTags('search')
@ApiSecurity('api-key')
@Controller('search')
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Search processed documents: keyword (full-text), semantic (vector) or hybrid (RRF), with structured filters' })
  search(@Query() q: SearchQuery) {
    const { q: text, mode, limit, ...filters } = q;
    return this.service.search(text, mode, filters, limit);
  }
}
