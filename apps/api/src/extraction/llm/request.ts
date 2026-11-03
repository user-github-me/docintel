import { LlmRequest } from './provider';
import { userInstruction } from './prompt';

/** Untrusted document text first, then the (trusted) instruction last. */
export function buildDocumentPrompt(request: LlmRequest): string {
  return `${request.documentText}\n\n${userInstruction(request.images.length)}`;
}
