import { promises as fs } from "fs";
import path from "path";
import { hashFile } from "./hasher.js";

export interface CacheEntry {
  hash: string;
  embedding: number[];
  filePath: string;
  lastModified: number;
  size: number;
  strategy: string;
  // Add validation flags to avoid repeated I/O
  isValidated?: boolean;
  isStale?: boolean;
}

export interface CacheData {
  [fileName: string]: CacheEntry;
}

export class EmbeddingCache {
  private static readonly CACHE_FILENAME = ".triage.json";
  private cache: CacheData = {};
  private directory: string;
  private isInitialized = false;
  private fastMode: boolean;

  constructor(directory: string, fastMode: boolean = false) {
    this.directory = directory;
    this.fastMode = fastMode;
  }

  /**
   * Set fast mode for cache validation
   * When enabled, uses only file stats for validation (faster but less reliable)
   */
  setFastMode(enabled: boolean): void {
    this.fastMode = enabled;
  }

  private getCachePath(): string {
    return path.join(this.directory, EmbeddingCache.CACHE_FILENAME);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    const cachePath = this.getCachePath();
    try {
      const data = await fs.readFile(cachePath, "utf-8");
      this.cache = JSON.parse(data);

      // Mark all entries as needing validation
      for (const entry of Object.values(this.cache)) {
        entry.isValidated = false;
        entry.isStale = false;
      }
    } catch (error) {
      this.cache = {};
    }
    this.isInitialized = true;
  }

  private async saveCache(): Promise<void> {
    const cachePath = this.getCachePath();
    await fs.writeFile(cachePath, JSON.stringify(this.cache, null, 2));
  }

  /**
   * Batch validate multiple cache entries to reduce I/O operations
   */
  private async batchValidateCacheEntries(filePaths: string[]): Promise<void> {
    const validationPromises = filePaths.map(async (filePath) => {
      const fileName = path.basename(filePath);
      const entry = this.cache[fileName];

      if (!entry || entry.isValidated) return;

      try {
        const stats = await fs.stat(filePath);

        if (this.fastMode) {
          // Fast mode: only check stats (faster but less reliable)
          if (
            entry.lastModified === stats.mtime.getTime() &&
            entry.size === stats.size
          ) {
            entry.isValidated = true;
            entry.isStale = false;
          } else {
            entry.isStale = true;
            entry.isValidated = true;
          }
        } else {
          // Accurate mode: check stats first, then hash if needed
          if (
            entry.lastModified === stats.mtime.getTime() &&
            entry.size === stats.size
          ) {
            // Stats match, but in accurate mode we still need to verify hash for large files
            if (stats.size < 1024 * 1024) {
              // Small files: trust stats
              entry.isValidated = true;
              entry.isStale = false;
            } else {
              // Large files: verify hash (but only if we have one)
              if (entry.hash) {
                try {
                  const currentHash = await hashFile(filePath);
                  if (entry.hash === currentHash) {
                    entry.isValidated = true;
                    entry.isStale = false;
                  } else {
                    entry.isStale = true;
                    entry.isValidated = true;
                  }
                } catch (error) {
                  // If hashing fails, fall back to stats-based validation
                  entry.isValidated = true;
                  entry.isStale = false;
                }
              } else {
                // No hash available, trust stats
                entry.isValidated = true;
                entry.isStale = false;
              }
            }
          } else {
            entry.isStale = true;
            entry.isValidated = true;
          }
        }
      } catch (error) {
        entry.isStale = true;
        entry.isValidated = true;
      }
    });

    await Promise.all(validationPromises);
  }

  /**
   * Get cached embedding with optimized validation
   */
  async getCachedEmbedding(filePath: string): Promise<number[] | null> {
    const fileName = path.basename(filePath);
    const entry = this.cache[fileName];

    if (!entry) {
      return null;
    }

    // If already validated and not stale, return immediately
    if (entry.isValidated && !entry.isStale) {
      return entry.embedding;
    }

    // If not validated, do validation
    if (!entry.isValidated) {
      try {
        const stats = await fs.stat(filePath);

        if (this.fastMode) {
          // Fast mode: only check stats
          if (
            entry.lastModified === stats.mtime.getTime() &&
            entry.size === stats.size
          ) {
            entry.isValidated = true;
            entry.isStale = false;
            return entry.embedding;
          } else {
            entry.isStale = true;
            entry.isValidated = true;
            return null;
          }
        } else {
          // Accurate mode: check stats first, then hash if needed
          if (
            entry.lastModified === stats.mtime.getTime() &&
            entry.size === stats.size
          ) {
            if (stats.size < 1024 * 1024) {
              // Small files: trust stats
              entry.isValidated = true;
              entry.isStale = false;
              return entry.embedding;
            } else {
              // Large files: verify hash
              if (entry.hash) {
                try {
                  const currentHash = await hashFile(filePath);
                  if (entry.hash === currentHash) {
                    entry.isValidated = true;
                    entry.isStale = false;
                    return entry.embedding;
                  } else {
                    entry.isStale = true;
                    entry.isValidated = true;
                    return null;
                  }
                } catch (error) {
                  // If hashing fails, fall back to stats-based validation
                  entry.isValidated = true;
                  entry.isStale = false;
                  return entry.embedding;
                }
              } else {
                // No hash available, trust stats
                entry.isValidated = true;
                entry.isStale = false;
                return entry.embedding;
              }
            }
          } else {
            entry.isStale = true;
            entry.isValidated = true;
            return null;
          }
        }
      } catch (error) {
        entry.isStale = true;
        entry.isValidated = true;
        return null;
      }
    }

    // If marked as stale, return null
    return null;
  }

  /**
   * Batch get cached embeddings for multiple files
   */
  async getCachedEmbeddings(
    filePaths: string[],
  ): Promise<Map<string, number[]>> {
    const results = new Map<string, number[]>();

    // Batch validate all cache entries first
    await this.batchValidateCacheEntries(filePaths);

    // Now collect all valid cached embeddings
    for (const filePath of filePaths) {
      const fileName = path.basename(filePath);
      const entry = this.cache[fileName];

      if (entry && entry.isValidated && !entry.isStale) {
        results.set(filePath, entry.embedding);
      }
    }

    return results;
  }

  async setCachedEmbedding(
    filePath: string,
    embedding: number[],
    strategy: string,
  ): Promise<void> {
    const fileName = path.basename(filePath);

    try {
      const stats = await fs.stat(filePath);
      const hash = await hashFile(filePath);

      this.cache[fileName] = {
        hash,
        embedding,
        filePath,
        lastModified: stats.mtime.getTime(),
        size: stats.size,
        strategy,
        isValidated: true,
        isStale: false,
      };

      await this.saveCache();
    } catch (error) {
      console.error(`Error caching embedding for ${filePath}:`, error);
    }
  }

  /**
   * Clean up stale cache entries to prevent cache bloat
   */
  async cleanupStaleEntries(): Promise<void> {
    const staleKeys = Object.keys(this.cache).filter(
      (key) => this.cache[key].isStale,
    );

    for (const key of staleKeys) {
      delete this.cache[key];
    }

    if (staleKeys.length > 0) {
      await this.saveCache();
    }
  }
}
