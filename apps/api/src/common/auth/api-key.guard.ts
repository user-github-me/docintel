import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../../config/config';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * API-key authentication (X-API-Key or Authorization: Bearer). Keys are compared as SHA-256
 * digests with timingSafeEqual against every configured key, so timing does not leak which
 * prefix matched. The key's name becomes the actor recorded in the audit trail.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly keys: Array<{ name: string; digest: Buffer }>;

  constructor(private readonly reflector: Reflector, @Inject(APP_CONFIG) config: AppConfig) {
    this.keys = config.apiKeys.map((k) => ({ name: k.name, digest: digest(k.key) }));
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<Request & { actor?: string }>();
    const header = req.headers['x-api-key'];
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const provided = (Array.isArray(header) ? header[0] : header) ?? bearer;
    if (!provided) throw new UnauthorizedException('Missing API key (X-API-Key header)');
    const candidate = digest(provided);
    let match: string | null = null;
    for (const k of this.keys) if (timingSafeEqual(candidate, k.digest)) match = k.name;
    if (!match) throw new UnauthorizedException('Invalid API key');
    // The web BFF passes the signed-in reviewer's name; it is only trusted together with a valid key.
    const onBehalf = req.headers['x-actor'];
    const actorName = typeof onBehalf === 'string' && /^[\w.@ -]{1,64}$/.test(onBehalf) ? `${match}:${onBehalf}` : match;
    req.actor = actorName;
    return true;
  }
}

export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request & { actor?: string }>();
  return req.actor ?? 'anonymous';
});
