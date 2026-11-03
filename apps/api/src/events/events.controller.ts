import { Controller, MessageEvent, Query, Sse } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { interval, map, merge, Observable } from 'rxjs';
import { EventsService } from './events.service';

@ApiTags('operations')
@ApiSecurity('api-key')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse()
  @ApiOperation({ summary: 'Server-sent events: live document/invoice progress (optionally for one documentId)' })
  stream(@Query('documentId') documentId?: string): Observable<MessageEvent> {
    const heartbeat = interval(15_000).pipe(map(() => ({ data: { type: 'heartbeat', at: new Date().toISOString() } }) as MessageEvent));
    return merge(this.events.events(documentId).pipe(map((e) => ({ data: e }) as MessageEvent)), heartbeat);
  }
}
