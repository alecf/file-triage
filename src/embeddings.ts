import { exec } from "child_process";
import { promises as fs } from "fs";
import OpenAI from "openai";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

interface ToolInfo {
  name: string;
  command: string;
  args: string[];
  description: string;
}

/**
 * Service for extracting text content from various file types and generating embeddings
 * Supports dynamic detection and use of command line tools for different file formats
 */
export class EmbeddingService {
  private openai: OpenAI;
  private availableTools: Map<string, ToolInfo> = new Map();
  private toolDetectionDone = false;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
    });
  }

  /**
   * Generate embeddings for multiple files
   */
  async getFileEmbeddings(filePaths: string[]): Promise<
    Array<{
      filePath: string;
      embedding: number[];
      strategy: string;
      error?: string;
    }>
  > {
    const results: Array<{
      filePath: string;
      embedding: number[];
      strategy: string;
      error?: string;
    }> = [];

    for (const filePath of filePaths) {
      try {
        const result = await this.getFileEmbedding(filePath);
        results.push({
          filePath,
          embedding: result.embedding,
          strategy: result.strategy,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        results.push({
          filePath,
          embedding: [],
          strategy: "error",
          error: errorMessage,
        });
      }
    }

    return results;
  }

  /**
   * Generate an embedding for a file by extracting its content using appropriate strategies
   */
  async getFileEmbedding(
    filePath: string,
  ): Promise<{ embedding: number[]; strategy: string }> {
    try {
      const { content, strategy } = await this.extractTextContent(filePath);
      const response = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: content,
        dimensions: 512,
      });

      return {
        embedding: response.data[0].embedding,
        strategy,
      };
    } catch (error) {
      console.error(`Error getting embedding for ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Get a summary of the system's capabilities and available tools
   */
  async getSystemCapabilities(): Promise<{
    availableTools: string[];
    supportedFileTypes: string[];
    totalTools: number;
  }> {
    if (!this.toolDetectionDone) {
      await this.detectAvailableTools();
    }

    const supportedFileTypes = [
      "Text files (various programming languages, markdown, etc.)",
      "PDF documents",
      "Images (JPEG, PNG, GIF, etc.)",
      "Audio files (MP3, WAV, FLAC, etc.)",
      "Video files (MP4, AVI, MOV, etc.)",
      "Archive files (ZIP, TAR, etc.)",
      "Office documents (Word, Excel, PowerPoint)",
      "Binary files (with string extraction and header analysis)",
    ];

    return {
      availableTools: Array.from(this.availableTools.keys()),
      supportedFileTypes,
      totalTools: this.availableTools.size,
    };
  }

  private async extractTextContent(
    filePath: string,
  ): Promise<{ content: string; strategy: string }> {
    const ext = path.extname(filePath).toLowerCase();
    const stats = await fs.stat(filePath);

    // Skip very large files (>10MB)
    if (stats.size > 10 * 1024 * 1024) {
      return {
        content: `Large file: ${path.basename(filePath)} (${this.formatFileSize(
          stats.size,
        )})`,
        strategy: "text-large",
      };
    }

    try {
      // For text-based files, read content directly
      if (this.isTextFile(ext)) {
        const content = await fs.readFile(filePath, "utf-8");
        // Truncate very long content to avoid token limits
        const isTruncated = content.length > 8000;
        const truncatedContent = isTruncated
          ? content.substring(0, 8000) + "..."
          : content;
        return {
          content: truncatedContent,
          strategy: isTruncated ? "text-truncated" : "text",
        };
      }

      // For non-text files, try to extract meaningful content
      return await this.extractNonTextContent(filePath, ext, stats);
    } catch (error) {
      return {
        content: `File: ${path.basename(
          filePath,
        )}, Extension: ${ext}, Size: ${this.formatFileSize(
          stats.size,
        )} (unreadable)`,
        strategy: "metadata-unreadable",
      };
    }
  }

  private async extractNonTextContent(
    filePath: string,
    ext: string,
    stats: any,
  ): Promise<{ content: string; strategy: string }> {
    const fileName = path.basename(filePath);

    // First, try to detect file type using the `file` command
    let detectedType = ext;
    try {
      const { stdout } = await execAsync(`file "${filePath}"`);
      detectedType = stdout.toLowerCase();
    } catch (error) {
      // If `file` command fails, fall back to extension
    }

    // Ensure tools are detected
    if (!this.toolDetectionDone) {
      await this.detectAvailableTools();
    }

    // Try different strategies based on file type
    const strategies = await this.getStrategiesForFile(
      filePath,
      ext,
      detectedType,
    );

    for (const strategy of strategies) {
      try {
        const result = await this.executeStrategy(strategy, filePath);
        if (result) {
          // Ensure strategy name is valid before returning
          const strategyName =
            strategy.name && strategy.name.trim() !== ""
              ? strategy.name
              : "strategy-executed";
          return {
            content: result,
            strategy: strategyName,
          };
        }
      } catch (error) {
        // Continue to next strategy if this one fails
        continue;
      }
    }

    // Fallback to basic metadata
    return {
      content: `File: ${path.basename(
        filePath,
      )}, Extension: ${ext}, Type: ${detectedType}, Size: ${this.formatFileSize(
        stats.size,
      )}`,
      strategy: "metadata-basic",
    };
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
      if (this.availableTools.has("exiftool")) {
        const tool = this.availableTools.get("exiftool")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    // Audio strategies
    if (this.isAudioFile(ext) || detectedType.includes("audio")) {
      if (this.availableTools.has("ffprobe")) {
        const tool = this.availableTools.get("ffprobe")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
      if (this.availableTools.has("exiftool")) {
        const tool = this.availableTools.get("exiftool")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    // Video strategies
    if (this.isVideoFile(ext) || detectedType.includes("video")) {
      if (this.availableTools.has("ffprobe")) {
        const tool = this.availableTools.get("ffprobe")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
      if (this.availableTools.has("exiftool")) {
        const tool = this.availableTools.get("exiftool")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    // Archive strategies
    if (this.isArchiveFile(ext) || detectedType.includes("archive")) {
      if (this.availableTools.has("unzip")) {
        const tool = this.availableTools.get("unzip")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
      if (this.availableTools.has("tar")) {
        const tool = this.availableTools.get("tar")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    // Office document strategies
    if (
      this.isOfficeFile(ext) ||
      detectedType.includes("microsoft") ||
      detectedType.includes("office")
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
      if (this.availableTools.has("xlsx2csv")) {
        const tool = this.availableTools.get("xlsx2csv")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    // Add fallback strategies for binary files
    if (strategies.length === 0) {
      // Try to extract readable strings from binary files
      if (this.availableTools.has("strings")) {
        const tool = this.availableTools.get("strings")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }

      // Add file header analysis for unknown binary files
      if (this.availableTools.has("hexdump")) {
        const tool = this.availableTools.get("hexdump")!;
        if (tool && tool.name && tool.name.trim() !== "") {
          strategies.push(tool);
        }
      }
    }

    // Final validation: ensure all strategies have valid names
    const validStrategies = strategies.filter(
      (strategy) => strategy && strategy.name && strategy.name.trim() !== "",
    );

    return validStrategies;
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

        return `${strategy.description}:\n${truncatedOutput}`;
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get information about available command line tools
   */
  async getAvailableTools(): Promise<string[]> {
    if (!this.toolDetectionDone) {
      await this.detectAvailableTools();
    }
    return Array.from(this.availableTools.keys());
  }

  /**
   * Get detailed information about available tools
   */
  async getToolDetails(): Promise<Map<string, ToolInfo>> {
    if (!this.toolDetectionDone) {
      await this.detectAvailableTools();
    }
    return new Map(this.availableTools);
  }

  /**
   * Manually register a custom tool
   */
  registerCustomTool(tool: ToolInfo): void {
    this.availableTools.set(tool.name, tool);
  }

  /**
   * Remove a tool from the available tools
   */
  removeTool(toolName: string): boolean {
    return this.availableTools.delete(toolName);
  }

  /**
   * Check if a specific tool is available
   */
  async isToolAvailable(toolName: string): Promise<boolean> {
    if (!this.toolDetectionDone) {
      await this.detectAvailableTools();
    }
    return this.availableTools.has(toolName);
  }

  /**
   * Debug method to analyze why a file might be getting "unknown" strategy
   */
  async debugFileProcessing(filePath: string): Promise<{
    fileInfo: any;
    availableTools: string[];
    strategies: any[];
    detectedType: string;
    extension: string;
  }> {
    const ext = path.extname(filePath).toLowerCase();
    const stats = await fs.stat(filePath);

    // Ensure tools are detected
    if (!this.toolDetectionDone) {
      await this.detectAvailableTools();
    }

    // Detect file type
    let detectedType = ext;
    try {
      const { stdout } = await execAsync(`file "${filePath}"`);
      detectedType = stdout.toLowerCase();
    } catch (error) {
      detectedType = "detection-failed";
    }

    // Get strategies
    const strategies = await this.getStrategiesForFile(
      filePath,
      ext,
      detectedType,
    );

    return {
      fileInfo: {
        name: path.basename(filePath),
        extension: ext,
        size: this.formatFileSize(stats.size),
        isTextFile: this.isTextFile(ext),
        isImageFile: this.isImageFile(ext),
        isAudioFile: this.isAudioFile(ext),
        isVideoFile: this.isVideoFile(ext),
        isArchiveFile: this.isArchiveFile(ext),
        isOfficeFile: this.isOfficeFile(ext),
      },
      availableTools: Array.from(this.availableTools.keys()),
      strategies: strategies.map((s) => ({
        name: s.name,
        command: s.command,
        description: s.description,
      })),
      detectedType,
      extension: ext,
    };
  }

  /**
   * Get a summary of the embedding process with statistics
   */
  async getProcessSummary(
    results: Array<{
      filePath: string;
      embedding: number[];
      strategy: string;
      error?: string;
    }>,
  ): Promise<{
    totalFiles: number;
    successfulFiles: number;
    failedFiles: number;
    strategyBreakdown: Record<string, number>;
    errorSummary: Record<string, number>;
  }> {
    const totalFiles = results.length;
    const successfulFiles = results.filter((r) => !r.error).length;
    const failedFiles = results.filter((r) => r.error).length;

    const strategyBreakdown: Record<string, number> = {};
    const errorSummary: Record<string, number> = {};

    results.forEach((result) => {
      if (result.error) {
        errorSummary[result.error] = (errorSummary[result.error] || 0) + 1;
      } else {
        strategyBreakdown[result.strategy] =
          (strategyBreakdown[result.strategy] || 0) + 1;
      }
    });

    return {
      totalFiles,
      successfulFiles,
      failedFiles,
      strategyBreakdown,
      errorSummary,
    };
  }

  private async detectAvailableTools(): Promise<void> {
    const tools: ToolInfo[] = [
      {
        name: "pdfinfo",
        command: "pdfinfo",
        args: ["FILEPATH"],
        description: "PDF metadata and information",
      },
      {
        name: "pdftotext",
        command: "pdftotext",
        args: ["FILEPATH", "-"],
        description: "PDF text content extraction",
      },
      {
        name: "identify",
        command: "identify",
        args: ["-verbose", "FILEPATH"],
        description: "ImageMagick image information",
      },
      {
        name: "gm-identify",
        command: "gm",
        args: ["identify", "-verbose", "FILEPATH"],
        description: "GraphicsMagick image information",
      },
      {
        name: "exiftool",
        command: "exiftool",
        args: ["FILEPATH"],
        description: "File metadata extraction",
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
      },
      {
        name: "unzip",
        command: "unzip",
        args: ["-l", "FILEPATH"],
        description: "ZIP archive contents",
      },
      {
        name: "tar",
        command: "tar",
        args: ["-tf", "FILEPATH"],
        description: "TAR archive contents",
      },
      {
        name: "antiword",
        command: "antiword",
        args: ["FILEPATH"],
        description: "Microsoft Word document text extraction",
      },
      {
        name: "catdoc",
        command: "catdoc",
        args: ["FILEPATH"],
        description: "Microsoft Word document text extraction (alternative)",
      },
      {
        name: "xlsx2csv",
        command: "xlsx2csv",
        args: ["FILEPATH"],
        description: "Excel spreadsheet conversion",
      },
      {
        name: "file",
        command: "file",
        args: ["FILEPATH"],
        description: "File type detection",
      },
      {
        name: "strings",
        command: "strings",
        args: ["FILEPATH"],
        description: "Extract readable strings from binary files",
      },
      {
        name: "hexdump",
        command: "hexdump",
        args: ["-C", "-n", "1024", "FILEPATH"],
        description: "Hexadecimal dump of file header",
      },
      {
        name: "od",
        command: "od",
        args: ["-c", "-N", "1024", "FILEPATH"],
        description: "Octal dump of file header",
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

  private formatFileSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)}${units[unitIndex]}`;
  }
}
