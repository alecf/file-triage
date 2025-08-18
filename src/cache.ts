import { createClient } from "@libsql/client";
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
  private static readonly DB_FILENAME = ".triage.db";
  private client: any;
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

  private getDbPath(): string {
    return path.join(this.directory, EmbeddingCache.DB_FILENAME);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    const dbPath = this.getDbPath();
    this.client = createClient({
      url: `file:${dbPath}`,
    });

    // Create tables if they don't exist
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_name TEXT UNIQUE NOT NULL,
        file_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        last_modified INTEGER NOT NULL,
        size INTEGER NOT NULL,
        strategy TEXT NOT NULL,
        is_validated INTEGER DEFAULT 0,
        is_stale INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for better performance
    await this.client.execute(`
      CREATE INDEX IF NOT EXISTS idx_file_name ON cache_entries(file_name)
    `);
    await this.client.execute(`
      CREATE INDEX IF NOT EXISTS idx_file_path ON cache_entries(file_path)
    `);
    await this.client.execute(`
      CREATE INDEX IF NOT EXISTS idx_is_stale ON cache_entries(is_stale)
    `);

    this.isInitialized = true;
  }

  /**
   * Batch validate multiple cache entries to reduce I/O operations
   */
  private async batchValidateCacheEntries(filePaths: string[]): Promise<void> {
    const validationPromises = filePaths.map(async (filePath) => {
      const fileName = path.basename(filePath);

      try {
        const stats = await import("fs").then((fs) =>
          fs.promises.stat(filePath),
        );

        if (this.fastMode) {
          // Fast mode: only check stats (faster but less reliable)
          await this.client.execute({
            sql: `
              UPDATE cache_entries 
              SET is_validated = 1, is_stale = CASE 
                WHEN last_modified = ? AND size = ? THEN 0 
                ELSE 1 
              END
              WHERE file_name = ?
            `,
            args: [stats.mtime.getTime(), stats.size, fileName],
          });
        } else {
          // Accurate mode: check stats first, then hash if needed
          if (stats.size < 1024 * 1024) {
            // Small files: trust stats
            await this.client.execute({
              sql: `
                UPDATE cache_entries 
                SET is_validated = 1, is_stale = CASE 
                  WHEN last_modified = ? AND size = ? THEN 0 
                  ELSE 1 
                END
                WHERE file_name = ?
              `,
              args: [stats.mtime.getTime(), stats.size, fileName],
            });
          } else {
            // Large files: verify hash
            const entry = await this.client.execute({
              sql: `SELECT hash FROM cache_entries WHERE file_name = ?`,
              args: [fileName],
            });

            if (entry.rows.length > 0 && entry.rows[0].hash) {
              try {
                const currentHash = await hashFile(filePath);
                const isStale = entry.rows[0].hash !== currentHash;

                await this.client.execute({
                  sql: `
                    UPDATE cache_entries 
                    SET is_validated = 1, is_stale = ?
                    WHERE file_name = ?
                  `,
                  args: [isStale ? 1 : 0, fileName],
                });
              } catch (error) {
                // If hashing fails, fall back to stats-based validation
                await this.client.execute({
                  sql: `
                    UPDATE cache_entries 
                    SET is_validated = 1, is_stale = CASE 
                      WHEN last_modified = ? AND size = ? THEN 0 
                      ELSE 1 
                    END
                    WHERE file_name = ?
                  `,
                  args: [stats.mtime.getTime(), stats.size, fileName],
                });
              }
            } else {
              // No hash available, trust stats
              await this.client.execute({
                sql: `
                  UPDATE cache_entries 
                  SET is_validated = 1, is_stale = CASE 
                    WHEN last_modified = ? AND size = ? THEN 0 
                    ELSE 1 
                  END
                  WHERE file_name = ?
                `,
                args: [stats.mtime.getTime(), stats.size, fileName],
              });
            }
          }
        }
      } catch (error) {
        // Mark as stale if file access fails
        await this.client.execute({
          sql: `UPDATE cache_entries SET is_validated = 1, is_stale = 1 WHERE file_name = ?`,
          args: [fileName],
        });
      }
    });

    await Promise.all(validationPromises);
  }

  /**
   * Get cached embedding with optimized validation
   */
  async getCachedEmbedding(filePath: string): Promise<number[] | null> {
    const fileName = path.basename(filePath);

    const result = await this.client.execute({
      sql: `SELECT * FROM cache_entries WHERE file_name = ?`,
      args: [fileName],
    });

    if (result.rows.length === 0) {
      return null;
    }

    const entry = result.rows[0];

    // If already validated and not stale, return immediately
    if (entry.is_validated && !entry.is_stale) {
      return JSON.parse(entry.embedding);
    }

    // If not validated, do validation
    if (!entry.is_validated) {
      try {
        const stats = await import("fs").then((fs) =>
          fs.promises.stat(filePath),
        );

        if (this.fastMode) {
          // Fast mode: only check stats
          if (
            entry.last_modified === stats.mtime.getTime() &&
            entry.size === stats.size
          ) {
            await this.client.execute({
              sql: `UPDATE cache_entries SET is_validated = 1, is_stale = 0 WHERE file_name = ?`,
              args: [fileName],
            });
            return JSON.parse(entry.embedding);
          } else {
            await this.client.execute({
              sql: `UPDATE cache_entries SET is_validated = 1, is_stale = 1 WHERE file_name = ?`,
              args: [fileName],
            });
            return null;
          }
        } else {
          // Accurate mode: check stats first, then hash if needed
          if (
            entry.last_modified === stats.mtime.getTime() &&
            entry.size === stats.size
          ) {
            if (stats.size < 1024 * 1024) {
              // Small files: trust stats
              await this.client.execute({
                sql: `UPDATE cache_entries SET is_validated = 1, is_stale = 0 WHERE file_name = ?`,
                args: [fileName],
              });
              return JSON.parse(entry.embedding);
            } else {
              // Large files: verify hash
              if (entry.hash) {
                try {
                  const currentHash = await hashFile(filePath);
                  if (entry.hash === currentHash) {
                    await this.client.execute({
                      sql: `UPDATE cache_entries SET is_validated = 1, is_stale = 0 WHERE file_name = ?`,
                      args: [fileName],
                    });
                    return JSON.parse(entry.embedding);
                  } else {
                    await this.client.execute({
                      sql: `UPDATE cache_entries SET is_validated = 1, is_stale = 1 WHERE file_name = ?`,
                      args: [fileName],
                    });
                    return null;
                  }
                } catch (error) {
                  // If hashing fails, fall back to stats-based validation
                  await this.client.execute({
                    sql: `UPDATE cache_entries SET is_validated = 1, is_stale = 0 WHERE file_name = ?`,
                    args: [fileName],
                  });
                  return JSON.parse(entry.embedding);
                }
              } else {
                // No hash available, trust stats
                await this.client.execute({
                  sql: `UPDATE cache_entries SET is_validated = 1, is_stale = 0 WHERE file_name = ?`,
                  args: [fileName],
                });
                return JSON.parse(entry.embedding);
              }
            }
          } else {
            await this.client.execute({
              sql: `UPDATE cache_entries SET is_validated = 1, is_stale = 1 WHERE file_name = ?`,
              args: [fileName],
            });
            return null;
          }
        }
      } catch (error) {
        await this.client.execute({
          sql: `UPDATE cache_entries SET is_validated = 1, is_stale = 1 WHERE file_name = ?`,
          args: [fileName],
        });
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

      const result = await this.client.execute({
        sql: `SELECT * FROM cache_entries WHERE file_name = ? AND is_validated = 1 AND is_stale = 0`,
        args: [fileName],
      });

      if (result.rows.length > 0) {
        const entry = result.rows[0];
        results.set(filePath, JSON.parse(entry.embedding));
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
      const stats = await import("fs").then((fs) => fs.promises.stat(filePath));
      const hash = await hashFile(filePath);

      // Use UPSERT to handle both insert and update cases
      await this.client.execute({
        sql: `
          INSERT INTO cache_entries (
            file_name, file_path, hash, embedding, last_modified, size, strategy, 
            is_validated, is_stale, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, CURRENT_TIMESTAMP)
          ON CONFLICT(file_name) DO UPDATE SET
            file_path = excluded.file_path,
            hash = excluded.hash,
            embedding = excluded.embedding,
            last_modified = excluded.last_modified,
            size = excluded.size,
            strategy = excluded.strategy,
            is_validated = excluded.is_validated,
            is_stale = excluded.is_stale,
            updated_at = CURRENT_TIMESTAMP
        `,
        args: [
          fileName,
          filePath,
          hash,
          JSON.stringify(embedding),
          stats.mtime.getTime(),
          stats.size,
          strategy,
        ],
      });
    } catch (error) {
      console.error(`Error caching embedding for ${filePath}:`, error);
    }
  }

  /**
   * Clean up stale cache entries to prevent cache bloat
   */
  async cleanupStaleEntries(): Promise<void> {
    const result = await this.client.execute({
      sql: `DELETE FROM cache_entries WHERE is_stale = 1`,
    });

    if (result.rowsAffected > 0) {
      console.log(`Cleaned up ${result.rowsAffected} stale cache entries`);
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{
    totalEntries: number;
    validEntries: number;
    staleEntries: number;
    cacheSize: number;
  }> {
    const totalResult = await this.client.execute({
      sql: `SELECT COUNT(*) as count FROM cache_entries`,
    });

    const validResult = await this.client.execute({
      sql: `SELECT COUNT(*) as count FROM cache_entries WHERE is_validated = 1 AND is_stale = 0`,
    });

    const staleResult = await this.client.execute({
      sql: `SELECT COUNT(*) as count FROM cache_entries WHERE is_stale = 1`,
    });

    // Get database file size
    const fs = await import("fs");
    const dbPath = this.getDbPath();
    let cacheSize = 0;
    try {
      const stats = await fs.promises.stat(dbPath);
      cacheSize = stats.size;
    } catch (error) {
      // Database file might not exist yet
    }

    return {
      totalEntries: totalResult.rows[0].count,
      validEntries: validResult.rows[0].count,
      staleEntries: staleResult.rows[0].count,
      cacheSize,
    };
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
  }
}
