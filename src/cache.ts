import { promises as fs } from "fs";
import path from "path";
import { FileHasher } from "./hasher.js";

export interface CacheEntry {
  hash: string;
  embedding: number[];
  filePath: string;
  lastModified: number;
  size: number;
  strategy: string;
}

export interface CacheData {
  [fileName: string]: CacheEntry;
}

export class EmbeddingCache {
  private static readonly CACHE_FILENAME = ".triage.json";
  private cache: CacheData = {};
  private directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private getCachePath(): string {
    return path.join(this.directory, EmbeddingCache.CACHE_FILENAME);
  }

  async initialize(): Promise<void> {
    const cachePath = this.getCachePath();
    try {
      const data = await fs.readFile(cachePath, "utf-8");
      this.cache = JSON.parse(data);
    } catch (error) {
      this.cache = {};
    }
  }

  private async saveCache(): Promise<void> {
    const cachePath = this.getCachePath();
    await fs.writeFile(cachePath, JSON.stringify(this.cache, null, 2));
  }

  async getCachedEmbedding(filePath: string): Promise<number[] | null> {
    const fileName = path.basename(filePath);
    const entry = this.cache[fileName];

    if (!entry) {
      return null;
    }

    try {
      const stats = await fs.stat(filePath);
      const currentHash = await FileHasher.hashFile(filePath);

      if (
        entry.hash === currentHash &&
        entry.lastModified === stats.mtime.getTime() &&
        entry.size === stats.size
      ) {
        // Handle legacy cache entries that don't have strategy field
        if (!entry.strategy) {
          entry.strategy = "unknown";
          await this.saveCache(); // Update the cache with the default strategy
        }
        return entry.embedding;
      }
    } catch (error) {
      console.error(`Error checking file ${filePath}:`, error);
    }

    return null;
  }

  async setCachedEmbedding(
    filePath: string,
    embedding: number[],
    strategy: string,
  ): Promise<void> {
    const fileName = path.basename(filePath);

    try {
      const stats = await fs.stat(filePath);
      const hash = await FileHasher.hashFile(filePath);

      this.cache[fileName] = {
        hash,
        embedding,
        filePath,
        lastModified: stats.mtime.getTime(),
        size: stats.size,
        strategy,
      };

      await this.saveCache();
    } catch (error) {
      console.error(`Error caching embedding for ${filePath}:`, error);
    }
  }
}
