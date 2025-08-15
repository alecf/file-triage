import { promises as fs } from 'fs';
import { createHash } from 'crypto';

export class FileHasher {
  static async hashFile(filePath: string): Promise<string> {
    const fileBuffer = await fs.readFile(filePath);
    // Using MD5 for fast hashing - good enough for file change detection
    const hash = createHash('md5');
    hash.update(fileBuffer);
    return hash.digest('hex');
  }
}