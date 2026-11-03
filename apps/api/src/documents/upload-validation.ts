import * as path from 'path';

export const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.xlsx', '.xlsm', '.xls', '.csv', '.tsv', '.txt']);

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.txt': 'text/plain',
};

/** Display-safe file name: no path components, control characters or absurd lengths. */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  return (clean || 'upload').slice(0, 200);
}

export function extensionOf(name: string): string {
  return path.extname(name).toLowerCase();
}

export function mimeFor(name: string): string {
  return MIME_BY_EXT[extensionOf(name)] ?? 'application/octet-stream';
}

/**
 * Upload-time screening (cheap, before queuing): extension allowlist, empty files, and obvious
 * executables/scripts by magic bytes. Deep content validation (corrupt PDFs, broken workbooks)
 * happens in the processor and is reported as a failed document with a typed error code.
 */
export function screenUpload(name: string, size: number, head: Buffer): { ok: true } | { ok: false; code: string; reason: string } {
  const ext = extensionOf(name);
  if (!ALLOWED_EXTENSIONS.has(ext)) return { ok: false, code: 'unsupported_format', reason: `File type "${ext || 'none'}" is not supported (PDF, JPG, PNG, TIFF, XLSX, XLS, CSV).` };
  if (size === 0) return { ok: false, code: 'empty_file', reason: 'The file is empty.' };
  const sig = head.subarray(0, 4).toString('latin1');
  if (sig.startsWith('MZ') || sig === '\x7fELF' || head.subarray(0, 4).equals(Buffer.from([0xca, 0xfe, 0xba, 0xbe])) || sig.startsWith('#!')) {
    return { ok: false, code: 'unsupported_format', reason: 'Executable or script content is not allowed.' };
  }
  return { ok: true };
}
