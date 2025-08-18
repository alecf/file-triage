import { exec } from "child_process";
import OpenAI from "openai";
import pLimit from "p-limit";
import path from "path";
import { encoding_for_model } from "tiktoken";
import { promisify } from "util";
import { EmbeddingCache } from "./cache.js";
import { generateFileInfo, generateFileInfoText } from "./fileinfo.js";

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
  private availableTools: Map<string, ToolInfo> = new Map();
  private toolDetectionDone = false;
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
  async getFileEmbeddings(filePaths: string[]): Promise<
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

    // Create an array of promises for parallel processing
    const promises = filePaths.map((filePath) =>
      limit(async () => {
        try {
          const result = await this.getFileEmbedding(filePath);
          return {
            filePath,
            embedding: result.embedding,
            strategy: result.strategy,
            fromCache: result.fromCache,
          };
        } catch (error) {
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

      // Use the unified file info system to get canonical content
      const content = await generateFileInfoText(filePath);

      // Final safety check: ensure content fits within token limits
      const tokenCount = this.countTokens(content);
      if (tokenCount > EMBEDDING_MODEL_MAX_TOKENS) {
        console.warn(
          `⚠️  Content for ${path.basename(
            filePath,
          )} still exceeds token limit: ${tokenCount} tokens. This may cause embedding to fail.`,
        );
      }

      // Get the strategy from the file info
      const fileInfo = await generateFileInfo(filePath);

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
          fileInfo.strategy,
        );
      }

      return {
        embedding,
        strategy: fileInfo.strategy,
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
    const tool = this.availableTools.get(toolName);
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

  private async detectAvailableTools(): Promise<void> {
    const tools: ToolInfo[] = [
      {
        name: "pdftotext",
        command: "pdftotext",
        args: ["FILEPATH", "-"],
        description: "PDF text content extraction",
        priority: 10, // Higher priority than pdfinfo
        validation: (output: string) => {
          // Only succeed if we extract meaningful text content (more than 100 characters)
          const textContent = output
            .replace(/PDF text content extraction:\s*/i, "")
            .trim();
          return textContent.length > 100 && /[a-zA-Z]/.test(textContent);
        },
      },
      {
        name: "pdfinfo",
        command: "pdfinfo",
        args: ["FILEPATH"],
        description: "PDF metadata and information",
        priority: 1,
      },

      {
        name: "identify",
        command: "identify",
        args: ["-verbose", "FILEPATH"],
        description: "ImageMagick image information",
        priority: 1,
      },
      {
        name: "gm-identify",
        command: "gm",
        args: ["identify", "-verbose", "FILEPATH"],
        description: "GraphicsMagick image information",
        priority: 1,
      },
      {
        name: "exiftool",
        command: "exiftool",
        args: ["FILEPATH"],
        description: "File metadata extraction",
        priority: 1,
      },
      {
        name: "ffprobe",
        command: "ffprobe",
        args: [
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          "FILEPATH",
        ],
        description: "FFmpeg media file information",
        priority: 1,
      },
      {
        name: "unzip",
        command: "unzip",
        args: ["-l", "FILEPATH"],
        description: "ZIP archive contents",
        priority: 1,
      },
      {
        name: "tar",
        command: "tar",
        args: ["-tf", "FILEPATH"],
        description: "TAR archive contents",
        priority: 1,
      },
      {
        name: "antiword",
        command: "antiword",
        args: ["FILEPATH"],
        description: "Microsoft Word document text extraction",
        priority: 5, // Higher priority for text extraction
        validation: (output: string) => {
          // Only succeed if we extract meaningful text content
          const textContent = output
            .replace(/Microsoft Word document text extraction:\s*/i, "")
            .trim();
          return textContent.length > 100 && /[a-zA-Z]/.test(textContent);
        },
      },
      {
        name: "catdoc",
        command: "catdoc",
        args: ["FILEPATH"],
        description: "Microsoft Word document text extraction (alternative)",
        priority: 4, // Slightly lower than antiword
        validation: (output: string) => {
          // Only succeed if we extract meaningful text content
          const textContent = output
            .replace(
              /Microsoft Word document text extraction \(alternative\):\s*/i,
              "",
            )
            .trim();
          return textContent.length > 100 && /[a-zA-Z]/.test(textContent);
        },
      },
      {
        name: "xlsx2csv",
        command: "xlsx2csv",
        args: ["FILEPATH"],
        description: "Excel spreadsheet conversion",
        priority: 5, // Higher priority for spreadsheet data
        validation: (output: string) => {
          // Only succeed if we get meaningful CSV content
          const csvContent = output
            .replace(/Excel spreadsheet conversion:\s*/i, "")
            .trim();
          return csvContent.length > 50 && csvContent.includes(",");
        },
      },
      {
        name: "file",
        command: "file",
        args: ["FILEPATH"],
        description: "File type detection",
        priority: 1,
      },
      {
        name: "strings",
        command: "strings",
        args: ["FILEPATH"],
        description: "Extract readable strings from binary files",
        priority: 3, // Medium priority for binary text extraction
        validation: (output: string) => {
          // Only succeed if we extract meaningful strings
          const stringsContent = output
            .replace(/Extract readable strings from binary files:\s*/i, "")
            .trim();
          // Check for meaningful content: should have reasonable length and contain actual words
          const words = stringsContent
            .split(/\s+/)
            .filter((word) => word.length > 2);
          return (
            stringsContent.length > 50 &&
            words.length > 5 &&
            /[a-zA-Z]/.test(stringsContent)
          );
        },
      },
      {
        name: "hexdump",
        command: "hexdump",
        args: ["-C", "-n", "1024", "FILEPATH"],
        description: "Hexadecimal dump of file header",
        priority: 1,
      },
      {
        name: "od",
        command: "od",
        args: ["-c", "-N", "1024", "FILEPATH"],
        description: "Octal dump of file header",
        priority: 1,
      },
    ];

    let detectedCount = 0;
    for (const tool of tools) {
      try {
        // Use 'command -v' instead of 'which' for better compatibility
        await execAsync(`command -v ${tool.command}`);
        this.availableTools.set(tool.name, tool);
        detectedCount++;
      } catch (error) {
        // Tool not available
      }
    }

    this.toolDetectionDone = true;
  }

  private async getStrategiesForFile(
    filePath: string,
    ext: string,
    detectedType: string,
  ): Promise<ToolInfo[]> {
    const strategies: ToolInfo[] = [];

    // PDF strategies
    if (ext === ".pdf" || detectedType.includes("pdf")) {
      if (this.availableTools.has("pdfinfo")) {
        const tool = this.availableTools.get("pdfinfo")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
      if (this.availableTools.has("pdftotext")) {
        const tool = this.availableTools.get("pdftotext")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    // Image strategies
    if (this.isImageFile(ext) || detectedType.includes("image")) {
      if (this.availableTools.has("identify")) {
        const tool = this.availableTools.get("identify")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
      if (this.availableTools.has("gm-identify")) {
        const tool = this.availableTools.get("gm-identify")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    // Document strategies
    if (
      ext === ".doc" ||
      ext === ".docx" ||
      detectedType.includes("microsoft word")
    ) {
      if (this.availableTools.has("antiword")) {
        const tool = this.availableTools.get("antiword")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
      if (this.availableTools.has("catdoc")) {
        const tool = this.availableTools.get("catdoc")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    // Spreadsheet strategies
    if (ext === ".xlsx" || ext === ".xls" || detectedType.includes("excel")) {
      if (this.availableTools.has("xlsx2csv")) {
        const tool = this.availableTools.get("xlsx2csv")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    // Archive strategies
    if (ext === ".zip" || detectedType.includes("zip")) {
      if (this.availableTools.has("unzip")) {
        const tool = this.availableTools.get("unzip")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    if (
      ext === ".tar" ||
      ext === ".tar.gz" ||
      ext === ".tgz" ||
      detectedType.includes("tar")
    ) {
      if (this.availableTools.has("tar")) {
        const tool = this.availableTools.get("tar")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    // Media strategies
    if (
      this.isAudioFile(ext) ||
      this.isVideoFile(ext) ||
      detectedType.includes("video") ||
      detectedType.includes("audio")
    ) {
      if (this.availableTools.has("ffprobe")) {
        const tool = this.availableTools.get("ffprobe")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    // Generic metadata extraction
    if (this.availableTools.has("exiftool")) {
      const tool = this.availableTools.get("exiftool")!;
      if (tool && tool.name && tool.name.trim() !== "") {
        strategies.push(tool);
      }
    }

    // Binary file analysis
    if (this.availableTools.has("strings")) {
      const tool = this.availableTools.get("strings")!;
      if (tool && tool.name && tool.name.trim() !== "") {
        strategies.push(tool);
      }
    }

    // Fallback strategies for binary files
    if (this.availableTools.has("hexdump")) {
      const tool = this.availableTools.get("hexdump")!;
      if (tool && tool.name && tool.name.trim() !== "") {
        strategies.push(tool);
      }
    }

    if (this.availableTools.has("od")) {
      const tool = this.availableTools.get("od")!;
      if (tool && tool.name && tool.name.trim() !== "") {
        strategies.push(tool);
      }
    }

    // Sort strategies by priority (higher numbers = higher priority)
    strategies.sort((a, b) => (b.priority || 1) - (a.priority || 1));

    return strategies;
  }

  private async executeStrategy(
    strategy: ToolInfo,
    filePath: string,
  ): Promise<string | null> {
    try {
      const args = strategy.args.map((arg) =>
        arg === "FILEPATH" ? `"${filePath}"` : arg,
      );
      const command = `${strategy.command} ${args.join(" ")}`;

      const { stdout, stderr } = await execAsync(command, {
        timeout: 10000,
        maxBuffer: 1024 * 1024, // 1MB buffer
      });

      if (stdout && stdout.trim()) {
        // Truncate very long output to avoid token limits
        const output = stdout.trim();
        const isTruncated = output.length > 6000;
        const truncatedOutput = isTruncated
          ? output.substring(0, 6000) + "..."
          : output;

        // Apply validation if the tool has a validation function
        if (strategy.validation && !strategy.validation(truncatedOutput)) {
          if (this.verboseToolLogging) {
            const failureReason = this.getValidationFailureReason(
              strategy.name,
              truncatedOutput,
            );
            console.log(
              `⚠️  Tool ${strategy.name} validation failed for ${path.basename(
                filePath,
              )}: ${failureReason}`,
            );
          }
          return null; // Validation failed
        }

        // Log successful tool execution if verbose mode is enabled
        if (this.verboseToolLogging) {
          console.log(
            `✅ Tool ${strategy.name} succeeded for ${path.basename(
              filePath,
            )} (${truncatedOutput.length} characters)`,
          );
        }

        return `${strategy.description}:\n${truncatedOutput}`;
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private isImageFile(ext: string): boolean {
    const imageExtensions = [
      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".bmp",
      ".tiff",
      ".tif",
      ".webp",
      ".svg",
      ".ico",
      ".raw",
      ".heic",
      ".heif",
    ];
    return imageExtensions.includes(ext);
  }

  private isAudioFile(ext: string): boolean {
    const audioExtensions = [
      ".mp3",
      ".wav",
      ".flac",
      ".aac",
      ".ogg",
      ".wma",
      ".m4a",
      ".opus",
      ".aiff",
      ".alac",
    ];
    return audioExtensions.includes(ext);
  }

  private isVideoFile(ext: string): boolean {
    const videoExtensions = [
      ".mp4",
      ".avi",
      ".mov",
      ".wmv",
      ".flv",
      ".webm",
      ".mkv",
      ".m4v",
      ".3gp",
      ".ogv",
    ];
    return videoExtensions.includes(ext);
  }

  private isArchiveFile(ext: string): boolean {
    const archiveExtensions = [
      ".zip",
      ".tar",
      ".gz",
      ".bz2",
      ".xz",
      ".7z",
      ".rar",
      ".cab",
      ".ar",
      ".deb",
      ".rpm",
    ];
    return archiveExtensions.includes(ext);
  }

  private isOfficeFile(ext: string): boolean {
    const officeExtensions = [
      ".doc",
      ".docx",
      ".xls",
      ".xlsx",
      ".ppt",
      ".pptx",
      ".odt",
      ".ods",
      ".odp",
    ];
    return officeExtensions.includes(ext);
  }

  private isTextFile(ext: string): boolean {
    const textExtensions = [
      ".txt",
      ".md",
      ".json",
      ".js",
      ".ts",
      ".jsx",
      ".tsx",
      ".py",
      ".java",
      ".cpp",
      ".c",
      ".h",
      ".hpp",
      ".css",
      ".html",
      ".xml",
      ".yaml",
      ".yml",
      ".toml",
      ".ini",
      ".cfg",
      ".log",
      ".csv",
      ".sql",
      ".sh",
      ".bat",
      ".ps1",
      ".php",
      ".rb",
      ".go",
      ".rs",
      ".kt",
      ".swift",
      ".scala",
      ".clj",
      ".hs",
      ".ml",
      ".fs",
      ".r",
      ".m",
      ".pl",
      ".lua",
      ".vim",
      ".dockerfile",
      ".gitignore",
      ".gitconfig",
      ".editorconfig",
    ];
    return textExtensions.includes(ext) || ext === "";
  }
}
