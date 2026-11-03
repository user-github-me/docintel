import { sanitizeFilename, screenUpload } from './upload-validation';

describe('upload screening', () => {
  it('accepts supported types and rejects others', () => {
    expect(screenUpload('a.pdf', 10, Buffer.from('%PDF-1.7')).ok).toBe(true);
    expect(screenUpload('a.docx', 10, Buffer.from('PK')).ok).toBe(false);
    expect(screenUpload('a.pdf', 0, Buffer.alloc(0))).toMatchObject({ ok: false, code: 'empty_file' });
  });
  it('rejects executables disguised with an allowed extension', () => {
    expect(screenUpload('invoice.pdf', 100, Buffer.from('MZ\x90\x00'))).toMatchObject({ ok: false, code: 'unsupported_format' });
  });
  it('sanitises file names', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\x\\inv<1>.pdf')).toBe('inv_1_.pdf');
  });
});
