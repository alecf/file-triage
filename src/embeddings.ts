import { exec } from "child_process";
import OpenAI from "openai";
import pLimit from "p-limit";
import path from "path";
import { encoding_for_model } from "tiktoken";
import { promisify } from "util";
import { EmbeddingCache } from "./cache.js";
import {
  detectAvailableTools,
  executeStrategy,
  getStrategiesForFile,
} from "./fileinfo.js";

const execAsync = promisify(exec);

// OpenAI embedding model token limits
const EMBEDDING_MODEL_MAX_TOKENS = 8192;
const EMBEDDING_MODEL_SAFETY_MARGIN = 100; // Leave some buffer
const EMBEDDING_MODEL_TARGET_TOKENS =
  EMBEDDING_MODEL_MAX_TOKENS - EMBEDDING_MODEL_SAFETY_MARGIN;

interface ToolInfo {
  name: string;
  command: string;
  args: string[];
  description: string;
  validation?: (output: string) => boolean; // Optional validation function
  priority?: number; // Optional priority (higher numbers = higher priority)
}

/**
 * Service for extracting text content from various file types and generating embeddings
 * Supports dynamic detection and use of command line tools for different file formats
 * Now includes integrated caching to avoid re-embedding files that are already cached
 */
export class EmbeddingService {
  private openai: OpenAI;
  private verboseToolLogging = false;
  private cache: EmbeddingCache | null = null;
  private cacheDirectory: string | null = null;
  private useFastCache: boolean = true;

  constructor(apiKey?: string, verboseToolLogging = false) {
    this.openai = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
    });
    this.verboseToolLogging = verboseToolLogging;
  }

  /**
   * Initialize the cache for a specific directory
   * This must be called before using the service to enable caching
   */
  async initializeCache(
    directory: string,
    useFastCache: boolean = true,
  ): Promise<void> {
    this.cacheDirectory = directory;
    this.useFastCache = useFastCache;
    this.cache = new EmbeddingCache(directory, useFastCache);
    await this.cache.initialize();
  }

  /**
   * Get cache statistics if cache is initialized
   */
  async getCacheStats(): Promise<{
    totalEntries: number;
    validEntries: number;
    staleEntries: number;
    cacheSize: number;
  } | null> {
    if (!this.cache) {
      return null;
    }
    return await this.cache.getCacheStats();
  }

  /**
   * Get cached embedding information for a specific file
   */
  async getCachedEmbeddingInfo(filePath: string): Promise<{
    embedding: number[];
    strategy: string;
  } | null> {
    if (!this.cache) {
      return null;
    }
    return await this.cache.getCachedEmbedding(filePath);
  }

  /**
   * Clean up stale cache entries
   */
  async cleanupCache(): Promise<void> {
    if (this.cache) {
      await this.cache.cleanupStaleEntries();
    }
  }

  /**
   * Close the cache connection
   */
  async closeCache(): Promise<void> {
    if (this.cache) {
      await this.cache.close();
    }
  }

  /**
   * Count tokens in text using tiktoken
   */
  private countTokens(text: string): number {
    try {
      // Use cl100k_base encoding which is used by text-embedding-3-small
      const encoder = encoding_for_model("text-embedding-3-small");
      const tokens = encoder.encode(text);
      encoder.free();
      return tokens.length;
    } catch (error) {
      // Fallback: rough estimation (1 token ≈ 4 characters for English text)
      return Math.ceil(text.length / 4);
    }
  }

  /**
   * Generate embeddings for multiple files with integrated caching
   */
  async getFileEmbeddings(
    filePaths: string[],
    onProgress?: (current: number, total: number) => void,
  ): Promise<
    Array<{
      filePath: string;
      embedding: number[];
      strategy: string;
      error?: string;
      fromCache?: boolean;
    }>
  > {
    // Create a limiter that allows max 100 concurrent operations
    const limit = pLimit(100);

    let completedCount = 0;
    const totalFiles = filePaths.length;

    // Create an array of promises for parallel processing
    const promises = filePaths.map((filePath) =>
      limit(async () => {
        try {
          const result = await this.getFileEmbedding(filePath);
          completedCount++;

          // Call progress callback if provided
          if (onProgress) {
            onProgress(completedCount, totalFiles);
          }

          return {
            filePath,
            embedding: result.embedding,
            strategy: result.strategy,
            fromCache: result.fromCache,
          };
        } catch (error) {
          completedCount++;

          // Call progress callback if provided
          if (onProgress) {
            onProgress(completedCount, totalFiles);
          }

          const errorMessage =
            error instanceof Error ? error.message : String(error);
          return {
            filePath,
            embedding: [],
            strategy: "error",
            error: errorMessage,
            fromCache: false,
          };
        }
      }),
    );

    // Wait for all promises to resolve
    const results = await Promise.all(promises);
    return results;
  }

  /**
   * Generate an embedding for a file by extracting its content using the unified file info system
   * Now includes integrated caching to avoid re-embedding files that are already cached
   */
  async getFileEmbedding(
    filePath: string,
  ): Promise<{ embedding: number[]; strategy: string; fromCache: boolean }> {
    try {
      // Check cache first if available
      if (this.cache) {
        const cachedResult = await this.cache.getCachedEmbedding(filePath);
        if (cachedResult) {
          return {
            embedding: cachedResult.embedding,
            strategy: cachedResult.strategy,
            fromCache: true,
          };
        }
      }

      // Ensure tools are detected before proceeding
      await detectAvailableTools();

      // Get file extension and detected type
      const ext = path.extname(filePath).toLowerCase();

      // Detect file type using the 'file' command
      let detectedType = "";
      try {
        const { stdout } = await execAsync(`file "${filePath}"`);
        detectedType = stdout.trim();

        // Check if 'file' command couldn't determine the type
        if (
          detectedType.endsWith(": data") ||
          detectedType.includes(": data")
        ) {
          detectedType = "data"; // Mark as unknown type
        }
      } catch (error) {
        // If `file` command fails, mark as unknown type
        detectedType = "data";
      }

      // Get strategies in priority order, but implement proper fallback
      const strategies = await getStrategiesForFile(
        filePath,
        ext,
        detectedType,
      );

      // Debug logging
      if (this.verboseToolLogging) {
        console.log(
          `🔍 Strategies for ${path.basename(filePath)}:`,
          strategies.map((s) => s.name),
        );
      }

      // Try strategies in order until one succeeds
      let content: string | null = null;
      let successfulStrategy: string = "unknown";

      for (const strategy of strategies) {
        try {
          if (this.verboseToolLogging) {
            console.log(`🔄 Trying strategy: ${strategy.name}`);
          }
          content = await executeStrategy(strategy, filePath);
          if (content) {
            successfulStrategy = strategy.name;
            if (this.verboseToolLogging) {
              console.log(`✅ Strategy ${strategy.name} succeeded`);
            }
            break;
          } else {
            if (this.verboseToolLogging) {
              console.log(`❌ Strategy ${strategy.name} returned no content`);
            }
          }
        } catch (error) {
          // Strategy failed, continue to next one
          if (this.verboseToolLogging) {
            console.log(
              `⚠️  Tool ${strategy.name} failed for ${path.basename(
                filePath,
              )}: ${error}`,
            );
          }
        }
      }

      // Note: Fallback tools are now handled in the strategy selection logic
      // Only specialized tools appropriate for the detected file type are used

      // If still no content, throw an error
      if (!content) {
        throw new Error(
          `Failed to extract content from ${path.basename(
            filePath,
          )} using any available tools`,
        );
      }

      // Final safety check: ensure content fits within token limits
      const tokenCount = this.countTokens(content);
      if (tokenCount > EMBEDDING_MODEL_MAX_TOKENS) {
        console.warn(
          `⚠️  Content for ${path.basename(
            filePath,
          )} still exceeds token limit: ${tokenCount} tokens. This may cause embedding to fail.`,
        );
      }

      const response = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: content,
        dimensions: 512,
      });

      const embedding = response.data[0].embedding;

      // Cache the result if cache is available
      if (this.cache) {
        await this.cache.setCachedEmbedding(
          filePath,
          embedding,
          successfulStrategy,
        );
      }

      return {
        embedding,
        strategy: successfulStrategy,
        fromCache: false,
      };
    } catch (error) {
      console.error(`Error getting embedding for ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Get detailed validation failure reason for a specific tool and output
   */
  getValidationFailureReason(toolName: string, output: string): string {
    if (!global.availableTools) {
      return "No tools available";
    }

    const tool = global.availableTools.get(toolName);
    if (!tool || !tool.validation) {
      return "No validation function defined for this tool";
    }

    const cleanOutput = output
      .replace(new RegExp(`${tool.description}:\\s*`, "i"), "")
      .trim();

    switch (toolName) {
      case "pdftotext":
      case "antiword":
      case "catdoc":
        if (cleanOutput.length <= 100) {
          return `Output too short: ${cleanOutput.length} characters (need >100)`;
        }
        if (!/[a-zA-Z]/.test(cleanOutput)) {
          return "Output contains no letters";
        }
        return "Unknown validation failure";

      case "xlsx2csv":
        if (cleanOutput.length <= 50) {
          return `Output too short: ${cleanOutput.length} characters (need >50)`;
        }
        if (!cleanOutput.includes(",")) {
          return "Output doesn't contain CSV format (no commas)";
        }
        return "Unknown validation failure";

      case "strings":
        if (cleanOutput.length <= 50) {
          return `Output too short: ${cleanOutput.length} characters (need >50)`;
        }
        const words = cleanOutput
          .split(/\s+/)
          .filter((word) => word.length > 2);
        if (words.length <= 5) {
          return `Too few meaningful words: ${words.length} (need >5)`;
        }
        if (!/[a-zA-Z]/.test(cleanOutput)) {
          return "Output contains no letters";
        }
        return "Unknown validation failure";

      default:
        return "Unknown tool validation failure";
    }
  }
}
