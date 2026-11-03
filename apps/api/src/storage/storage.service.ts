import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { APP_CONFIG, AppConfig } from '../config/config';

/**
 * Local-disk object storage under STORAGE_DIR, shared with the processor via a volume.
 * Files are stored under random UUID names (never the user-supplied name) outside any web root.
 * Swapping in S3/Azure Blob means implementing these four methods.
 */
@Injectable()
export class StorageService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    fs.mkdirSync(path.join(config.storageDir, 'tmp'), { recursive: true });
  }

  get tmpDir(): string {
    return path.join(this.config.storageDir, 'tmp');
  }

  resolve(key: string): string {
    const full = path.resolve(this.config.storageDir, key);
    if (!full.startsWith(this.config.storageDir + path.sep)) throw new Error('storage key escapes storage root');
    return full;
  }

  /** Move an uploaded temp file into permanent storage; returns the storage key. */
  async persist(tempPath: string, extension: string): Promise<string> {
    const d = new Date();
    const dir = `uploads/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    const key = `${dir}/${randomUUID()}${extension}`;
    const target = this.resolve(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.rename(tempPath, target).catch(async () => {
      await fs.promises.copyFile(tempPath, target);
      await fs.promises.unlink(tempPath);
    });
    return key;
  }

  async sha256(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(filePath).on('data', (c) => hash.update(c)).on('end', () => resolve()).on('error', reject);
    });
    return hash.digest('hex');
  }

  async readHead(filePath: string, bytes = 8192): Promise<Buffer> {
    const fh = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async remove(key: string): Promise<void> {
    await fs.promises.unlink(this.resolve(key)).catch(() => undefined);
  }

  async cached(key: string): Promise<Buffer | null> {
    try {
      return await fs.promises.readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async writeCache(key: string, data: Buffer): Promise<void> {
    const target = this.resolve(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data);
  }
}
