import { exec } from "child_process";
import { promises as fs } from "fs";
import OpenAI from "openai";
import path from "path";
import { promisify } from "util";
import { generateFileInfoText } from "./fileinfo.js";

const execAsync = promisify(exec);

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
 */
export class EmbeddingService {
  private openai: OpenAI;
  private availableTools: Map<string, ToolInfo> = new Map();
  private toolDetectionDone = false;
  private verboseToolLogging = false;

  constructor(apiKey?: string, verboseToolLogging = false) {
    this.openai = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
    });
    this.verboseToolLogging = verboseToolLogging;
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
   * Generate an embedding for a file by extracting its content using the unified file info system
   */
  async getFileEmbedding(
    filePath: string,
  ): Promise<{ embedding: number[]; strategy: string }> {
    try {
      // Use the unified file info system to get canonical content
      const content = await generateFileInfoText(filePath);

      // Get the strategy from the file info (we'll extract it from the content)
      const fileInfo = await import("./fileinfo.js").then((m) =>
        m.generateFileInfo(filePath),
      );

      const response = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: content,
        dimensions: 512,
      });

      return {
        embedding: response.data[0].embedding,
        strategy: fileInfo.strategy,
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

  /**
   * Get validation requirements for tools
   */
  getToolValidationRequirements(): Map<string, string> {
    const requirements = new Map<string, string>();

    if (this.availableTools.has("pdftotext")) {
      requirements.set(
        "pdftotext",
        "Requires >100 characters of text content with letters",
      );
    }
    if (this.availableTools.has("antiword")) {
      requirements.set(
        "antiword",
        "Requires >100 characters of text content with letters",
      );
    }
    if (this.availableTools.has("catdoc")) {
      requirements.set(
        "catdoc",
        "Requires >100 characters of text content with letters",
      );
    }
    if (this.availableTools.has("xlsx2csv")) {
      requirements.set(
        "xlsx2csv",
        "Requires >50 characters of CSV content with commas",
      );
    }
    if (this.availableTools.has("strings")) {
      requirements.set(
        "strings",
        "Requires >50 characters with >5 meaningful words",
      );
    }

    return requirements;
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
