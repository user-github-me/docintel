import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Res, StreamableFile,
  UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { diskStorage } from 'multer';
import * as path from 'path';
import { Actor } from '../common/auth/api-key.guard';
import { loadConfig } from '../config/config';
import { DocumentsRepository } from './documents.repository';
import { documentSummary, DocumentsService } from './documents.service';
import { ListDocumentsQuery, ReprocessBody, UploadQuery } from './documents.dto';

const cfg = loadConfig();
const tmpDir = path.join(cfg.storageDir, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

@ApiTags('documents')
@ApiSecurity('api-key')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly service: DocumentsService, private readonly repo: DocumentsRepository) {}

  @Post()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Upload one or more documents (PDF, JPG, PNG, TIFF, XLSX, XLS, CSV); processing starts in the background' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } } } } })
  @UseInterceptors(
    FilesInterceptor('files', cfg.MAX_FILES_PER_REQUEST, {
      storage: diskStorage({ destination: tmpDir, filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`) }),
      limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024, files: cfg.MAX_FILES_PER_REQUEST, fields: 10 },
    }),
  )
  async upload(@UploadedFiles() files: Express.Multer.File[], @Query() query: UploadQuery, @Actor() actor: string) {
    if (!files?.length) throw new BadRequestException('No files received (multipart field "files")');
    return this.service.upload(files, query.purpose, query.allowDuplicates, actor);
  }

  @Get()
  @ApiOperation({ summary: 'List documents with processing status (filter by status, type, review flag, filename)' })
  async list(@Query() q: ListDocumentsQuery) {
    const { items, total } = await this.repo.list({ status: q.status, fileType: q.fileType, needsReview: q.needsReview, q: q.q, limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    return { items: items.map(documentSummary), total, page: q.page, pageSize: q.pageSize };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Document detail: status, progress, extracted invoices, document-level issues' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Lightweight processing status for polling' })
  async status(@Param('id', ParseUUIDPipe) id: string) {
    const d = await this.service.require(id);
    return { id: d.id, status: d.status, stage: d.stage, progress: d.progress, pagesProcessed: d.pages_processed, pageCount: d.page_count, needsReview: d.needs_review, errorCode: d.error_code, errorMessage: d.error_message };
  }

  @Get(':id/pages')
  @ApiOperation({ summary: 'Extracted text per page/sheet (with OCR confidence and line boxes)' })
  async pages(@Param('id', ParseUUIDPipe) id: string, @Query('from') from = '1', @Query('to') to?: string) {
    await this.service.require(id);
    const start = Math.max(1, Number(from) || 1);
    const end = Math.min(start + 49, Number(to) || start + 49);
    return { items: await this.repo.pages(id, start, end) };
  }

  @Get(':id/pages/:page/image')
  @ApiOperation({ summary: 'Rendered page image (JPEG) for PDFs and images' })
  async pageImage(@Param('id', ParseUUIDPipe) id: string, @Param('page', ParseIntPipe) page: number, @Res({ passthrough: true }) res: Response) {
    const img = await this.service.pageImage(id, page);
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    return new StreamableFile(img);
  }

  @Get(':id/file')
  @ApiOperation({ summary: 'Download the original file' })
  async file(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const doc = await this.service.require(id);
    res.set({
      'Content-Type': doc.mime_type ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(doc.original_filename)}`,
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(fs.createReadStream(path.resolve(cfg.storageDir, doc.storage_key)));
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'Processing history (stages, durations, retries, failures, corrections)' })
  async events(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.require(id);
    return { items: await this.repo.events(id) };
  }

  @Post(':id/reprocess')
  @HttpCode(202)
  @ApiOperation({ summary: 'Re-run processing (failed jobs, or after configuration changes)' })
  async reprocess(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReprocessBody, @Actor() actor: string) {
    return documentSummary(await this.service.reprocess(id, body?.force ?? false, actor));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a document, its extracted data and the stored file' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: string) {
    await this.service.remove(id, actor);
  }
}
