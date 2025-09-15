import chalk from "chalk";
import { exec } from "child_process";
import { promises as fs, Stats } from "fs";
import path from "path";
import { encoding_for_model } from "tiktoken";
import { promisify } from "util";

const execAsync = promisify(exec);

// OpenAI embedding model token limits
const EMBEDDING_MODEL_MAX_TOKENS = 8192;
const EMBEDDING_MODEL_SAFETY_MARGIN = 100; // Leave some buffer
const EMBEDDING_MODEL_TARGET_TOKENS =
  EMBEDDING_MODEL_MAX_TOKENS - EMBEDDING_MODEL_SAFETY_MARGIN;

/**
 * Count tokens in text using tiktoken
 */
function countTokens(text: string): number {
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
 * Truncate text to fit within token limit while preserving meaningful content
 */
function truncateToTokenLimit(
  text: string,
  maxTokens: number = EMBEDDING_MODEL_TARGET_TOKENS,
): {
  truncatedText: string;
  isTruncated: boolean;
  originalTokens: number;
  truncatedTokens: number;
} {
  const originalTokens = countTokens(text);

  if (originalTokens <= maxTokens) {
    return {
      truncatedText: text,
      isTruncated: false,
      originalTokens,
      truncatedTokens: originalTokens,
    };
  }

  // Binary search to find the right truncation point
  let left = 0;
  let right = text.length;
  let bestTruncatedText = "";
  let bestTokenCount = 0;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const truncatedText = text.substring(0, mid);
    const tokenCount = countTokens(truncatedText);

    if (tokenCount <= maxTokens) {
      bestTruncatedText = truncatedText;
      bestTokenCount = tokenCount;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  // Add truncation indicator
  const finalText =
    bestTruncatedText + "\n\n... (content truncated to fit token limit)";
  const finalTokenCount = countTokens(finalText);

  return {
    truncatedText: finalText,
    isTruncated: true,
    originalTokens,
    truncatedTokens: finalTokenCount,
  };
}

interface ToolInfo {
  name: string;
  command: string;
  args: string[];
  description: string;
  validation?: (output: string) => boolean;
  priority?: number;
}

interface FileInfo {
  filename: string;
  size: number;
  lastModified: Date;
  content: string;
  strategy: string;
}

/**
 * Generate canonical file info that includes filename, size, date, and content
 * This is used for both embeddings and user display
 */
export async function generateFileInfo(filePath: string): Promise<FileInfo> {
  const filename = path.basename(filePath);
  const stats = await fs.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();

  let content: string;
  let strategy: string;

  try {
    if (isTextFile(ext)) {
      // For text files, use token-based truncation for embeddings
      const fileContent = await fs.readFile(filePath, "utf-8");
      const truncationResult = truncateToTokenLimit(fileContent);

      content = truncationResult.truncatedText;
      strategy = truncationResult.isTruncated ? "text-truncated" : "text";

      if (truncationResult.isTruncated) {
        console.log(
          chalk.yellow(
            `⚠️  File ${filename} truncated: ${truncationResult.originalTokens} → ${truncationResult.truncatedTokens} tokens`,
          ),
        );
      }
    } else {
      // For non-text files, let the extraction function handle size limits
      const result = await extractNonTextContent(filePath, ext, stats);
      content = result.content;
      strategy = result.strategy;
    }
  } catch (error) {
    content = `File: ${filename}, Extension: ${ext}, Size: ${formatFileSize(
      stats.size,
    )} (unreadable)`;
    strategy = "metadata-unreadable";
  }

  return {
    filename,
    size: stats.size,
    lastModified: stats.mtime,
    content,
    strategy,
  };
}

/**
 * Generate file info text in the canonical format for embeddings
 * Ensures the total text fits within token limits
 */
export async function generateFileInfoText(filePath: string): Promise<string> {
  const fileInfo = await generateFileInfo(filePath);

  const combinedText = `Filename: ${fileInfo.filename}
Size: ${fileInfo.size} bytes
Last Modified: ${fileInfo.lastModified.toISOString()}
File content:
${fileInfo.content}`;

  // Apply token-based truncation to the combined text
  const truncationResult = truncateToTokenLimit(combinedText);

  if (truncationResult.isTruncated) {
    console.log(
      chalk.yellow(
        `⚠️  Combined text for ${fileInfo.filename} truncated: ${truncationResult.originalTokens} → ${truncationResult.truncatedTokens} tokens`,
      ),
    );
  }

  return truncationResult.truncatedText;
}

/**
 * Generate file info text for user display (truncated content)
 */
export async function generateFileInfoTextForDisplay(
  filePath: string,
): Promise<string> {
  const fileInfo = await generateFileInfo(filePath);

  // Truncate content to first 10 lines for display
  const contentLines = fileInfo.content.split("\n");
  const displayContent =
    contentLines.length > 10
      ? contentLines.slice(0, 10).join("\n") + "\n... (truncated)"
      : fileInfo.content;

  return `Filename: ${fileInfo.filename}
Size: ${formatFileSize(fileInfo.size)}
Last Modified: ${fileInfo.lastModified.toLocaleString()}
File content:
${displayContent}`;
}

/**
 * Display comprehensive information about a file for user interaction
 */
export async function displayFileInfo(filePath: string): Promise<void> {
  console.log(chalk.blue.bold("\n=== File Information ==="));

  try {
    const fileInfo = await generateFileInfo(filePath);

    console.log(chalk.white(`File: ${fileInfo.filename}`));
    console.log(chalk.gray(`Path: ${filePath}`));
    console.log(chalk.green(`Size: ${formatFileSize(fileInfo.size)}`));
    console.log(
      chalk.green(`Modified: ${fileInfo.lastModified.toLocaleString()}`),
    );

    // File type detection using `file` command
    await displayFileType(filePath);

    // Image info if available
    await displayImageInfo(filePath);

    // Content preview (truncated for display)
    console.log(chalk.blue("\n--- Content Preview ---"));
    const contentLines = fileInfo.content.split("\n");
    if (contentLines.length > 10) {
      console.log(chalk.gray(contentLines.slice(0, 10).join("\n")));
      console.log(
        chalk.yellow(
          `... (showing first 10 lines of ${contentLines.length} total)`,
        ),
      );
    } else {
      console.log(chalk.gray(fileInfo.content));
    }
    console.log(chalk.blue("--- End Content ---"));

    console.log(chalk.cyan(`Strategy used: ${fileInfo.strategy}`));
  } catch (error) {
    console.log(chalk.red(`Error generating file info: ${error}`));
  }
}

/**
 * Extract content from non-text files using available tools
 */
async function extractNonTextContent(
  filePath: string,
  ext: string,
  stats: Stats,
): Promise<{ content: string; strategy: string }> {
  const fileName = path.basename(filePath);

  // First, try to detect file type using the `file` command
  let detectedType = "";
  try {
    const { stdout } = await execAsync(`file "${filePath}"`);
    detectedType = stdout.trim();

    // Check if 'file' command couldn't determine the type
    if (detectedType.endsWith(": data") || detectedType.includes(": data")) {
      detectedType = "data"; // Mark as unknown type
    }
  } catch (error) {
    // If `file` command fails, mark as unknown type
    detectedType = "data";
  }

  // Check if this is a file type where size matters for content extraction
  const isSizeSensitiveFile =
    isArchiveFile(ext) ||
    isOfficeFile(ext) ||
    detectedType.includes("archive") ||
    detectedType.includes("document") ||
    detectedType.includes("spreadsheet");

  // For size-sensitive files, check if they're too large for content extraction
  if (isSizeSensitiveFile && stats.size > 50 * 1024 * 1024) {
    // 50MB limit for archives/documents
    return {
      content: `Large ${
        detectedType.includes("archive") ? "archive" : "document"
      } file: ${fileName} (${formatFileSize(
        stats.size,
      )}) - content extraction skipped due to size`,
      strategy: "metadata-large-file",
    };
  }

  // Ensure tools are detected
  if (!global.availableTools) {
    await detectAvailableTools();
  }

  // Try different strategies based on file type
  const strategies = await getStrategiesForFile(filePath, ext, detectedType);

  for (const strategy of strategies) {
    try {
      const result = await executeStrategy(strategy, filePath);
      if (result) {
        return {
          content: result,
          strategy: strategy.name || "strategy-executed",
        };
      }
    } catch (error) {
      // Continue to next strategy if this one fails
      continue;
    }
  }

  // Fallback to basic metadata
  return {
    content: `File: ${fileName}, Extension: ${ext}, Type: ${detectedType}, Size: ${formatFileSize(
      stats.size,
    )}`,
    strategy: "metadata-basic",
  };
}

/**
 * Get strategies for processing a specific file type
 */
export async function getStrategiesForFile(
  filePath: string,
  ext: string,
  detectedType: string,
): Promise<ToolInfo[]> {
  const strategies: ToolInfo[] = [];

  if (!global.availableTools) {
    await detectAvailableTools();
  }

  const tools = global.availableTools!;

  // Parse the detected type from the 'file' command output
  // The output format is typically: "filename: type description"
  let parsedType = "";
  if (detectedType && detectedType !== ext) {
    // Extract the type description after the colon
    const colonIndex = detectedType.indexOf(":");
    if (colonIndex !== -1) {
      parsedType = detectedType
        .substring(colonIndex + 1)
        .trim()
        .toLowerCase();
    } else {
      parsedType = detectedType.toLowerCase();
    }
  }

  // If 'file' command couldn't determine type (returns "data"), be very conservative
  if (parsedType === "data" || parsedType === "") {
    // Only use extension-based detection as a last resort, and be conservative
    if (isTextFile(ext)) {
      // For known text files, we can be confident
      if (tools.has("cat")) {
        strategies.push(tools.get("cat")!);
      }
      if (tools.has("head")) {
        strategies.push(tools.get("head")!);
      }
    } else {
      // For unknown binary files, only use exiftool for metadata, no content extraction
      if (tools.has("exiftool")) {
        strategies.push(tools.get("exiftool")!);
      }
      // Don't add strings/hexdump here - only as absolute last resort
      return strategies;
    }
    return strategies;
  }

  // Use the parsed type from 'file' command as primary source of truth
  // PDF strategies
  if (parsedType.includes("pdf") || ext === ".pdf") {
    if (tools.has("pdfinfo")) {
      strategies.push(tools.get("pdfinfo")!);
    }
    if (tools.has("pdftotext")) {
      strategies.push(tools.get("pdftotext")!);
    }
  }

  // Image strategies - metadata tools first, then strings as last resort
  if (parsedType.includes("image") || isImageFile(ext)) {
    if (tools.has("identify")) {
      strategies.push(tools.get("identify")!);
    }
    if (tools.has("gm-identify")) {
      strategies.push(tools.get("gm-identify")!);
    }
    if (tools.has("exiftool")) {
      strategies.push(tools.get("exiftool")!);
    }
    // Add strings as last resort for images (as per memory rule)
    if (tools.has("strings")) {
      strategies.push(tools.get("strings")!);
    }
  }

  // Document strategies
  if (
    parsedType.includes("microsoft word") ||
    parsedType.includes("word") ||
    ext === ".doc" ||
    ext === ".docx"
  ) {
    if (tools.has("antiword")) {
      strategies.push(tools.get("antiword")!);
    }
    if (tools.has("catdoc")) {
      strategies.push(tools.get("catdoc")!);
    }
  }

  // Spreadsheet strategies
  if (
    parsedType.includes("excel") ||
    parsedType.includes("spreadsheet") ||
    ext === ".xlsx" ||
    ext === ".xls"
  ) {
    if (tools.has("xlsx2csv")) {
      strategies.push(tools.get("xlsx2csv")!);
    }
  }

  // Archive strategies
  if (
    parsedType.includes("zip") ||
    parsedType.includes("archive") ||
    ext === ".zip"
  ) {
    if (tools.has("unzip")) {
      strategies.push(tools.get("unzip")!);
    }
  }

  if (
    parsedType.includes("tar") ||
    parsedType.includes("archive") ||
    ext === ".tar" ||
    ext === ".tar.gz" ||
    ext === ".tgz"
  ) {
    if (tools.has("tar")) {
      strategies.push(tools.get("tar")!);
    }
  }

  // Disk image and package strategies
  if (
    parsedType.includes("disk image") ||
    parsedType.includes("dmg") ||
    parsedType.includes("pkg") ||
    ext === ".dmg" ||
    ext === ".pkg" ||
    ext === ".iso"
  ) {
    if (tools.has("exiftool")) {
      strategies.push(tools.get("exiftool")!);
    }
    // Don't add strings for disk images - they often contain binary garbage
  }

  // Media strategies
  if (
    parsedType.includes("video") ||
    parsedType.includes("audio") ||
    isAudioFile(ext) ||
    isVideoFile(ext)
  ) {
    if (tools.has("ffprobe")) {
      strategies.push(tools.get("ffprobe")!);
    }
    if (tools.has("exiftool")) {
      strategies.push(tools.get("exiftool")!);
    }
  }

  // Generic metadata extraction - add for most file types
  if (tools.has("exiftool") && !strategies.some((s) => s.name === "exiftool")) {
    strategies.push(tools.get("exiftool")!);
  }

  // Compressed file strategies
  if (
    parsedType.includes("gzip") ||
    parsedType.includes("bzip2") ||
    parsedType.includes("xz") ||
    ext === ".gz" ||
    ext === ".bz2" ||
    ext === ".xz" ||
    filePath.includes(".gz") ||
    filePath.includes(".bz2") ||
    filePath.includes(".xz")
  ) {
    if (tools.has("gunzip")) {
      strategies.push(tools.get("gunzip")!);
    }
  }

  // Zlib and other compressed data strategies
  if (parsedType.includes("zlib") || parsedType.includes("compressed")) {
    // For compressed data, just use metadata tools - don't try to extract content
    // The strings tool often produces garbage for compressed files
  }

  // Plain text file strategies - only for files confirmed to be text
  if (
    parsedType.includes("text") ||
    parsedType.includes("ascii") ||
    parsedType.includes("utf-8") ||
    parsedType.includes("csv") ||
    isTextFile(ext)
  ) {
    if (tools.has("cat")) {
      strategies.push(tools.get("cat")!);
    }
    if (tools.has("head")) {
      strategies.push(tools.get("head")!);
    }
  }

  // Certificate and key file strategies
  if (
    parsedType.includes("pem") ||
    parsedType.includes("certificate") ||
    parsedType.includes("private key") ||
    ext === ".pem" ||
    ext === ".crt" ||
    ext === ".key" ||
    ext === ".cer"
  ) {
    // For security reasons, only extract metadata, not content
    if (tools.has("exiftool")) {
      strategies.push(tools.get("exiftool")!);
    }
    // Add strings with very limited output for certificate files
    if (tools.has("strings")) {
      strategies.push(tools.get("strings")!);
    }
  }

  // Add fallback tools for binary files that don't have enough strategies
  // This ensures we can extract some content from most binary files
  if (
    strategies.length === 0 ||
    (strategies.length === 1 && strategies[0].name === "exiftool")
  ) {
    // For binary files, just use hexdump as fallback - strings often produces garbage
    if (tools.has("hexdump") && !strategies.some((s) => s.name === "hexdump")) {
      strategies.push(tools.get("hexdump")!);
    }
  }

  // If we still have no strategies, create a basic metadata strategy
  if (strategies.length === 0) {
    // This will be handled in the executeStrategy function as a special case
    const basicStrategy: ToolInfo = {
      name: "basic-metadata",
      command: "echo",
      args: ["basic-file-info"],
      description: "Basic file metadata and information",
      priority: 0,
    };
    strategies.push(basicStrategy);
  }

  // Sort strategies by priority (higher numbers = higher priority)
  strategies.sort((a, b) => (b.priority || 1) - (a.priority || 1));

  return strategies;
}

/**
 * Execute a strategy to extract content from a file
 */
export async function executeStrategy(
  strategy: ToolInfo,
  filePath: string,
): Promise<string | null> {
  try {
    // Handle basic metadata strategy specially
    if (strategy.name === "basic-metadata") {
      const stats = await fs.stat(filePath);
      const ext = path.extname(filePath);
      const fileName = path.basename(filePath);
      const fileSize = formatFileSize(stats.size);
      const lastModified = stats.mtime.toISOString();

      return `File: ${fileName}, Extension: ${ext}, Size: ${fileSize}, Last Modified: ${lastModified}`;
    }

    const args = strategy.args.map((arg) =>
      arg === "FILEPATH" ? `"${filePath}"` : arg,
    );
    const command = `${strategy.command} ${args.join(" ")}`;

    // Get file stats to adjust buffer size and timeout
    const stats = await fs.stat(filePath);
    const isLargeFile = stats.size > 100 * 1024 * 1024; // 100MB

    const { stdout, stderr } = await execAsync(command, {
      timeout: isLargeFile ? 30000 : 10000, // 30s for large files, 10s for normal
      maxBuffer: isLargeFile ? 50 * 1024 * 1024 : 5 * 1024 * 1024, // 50MB for large files, 5MB for normal
    });

    if (stdout && stdout.trim()) {
      // Use token-based truncation for tool output
      const output = stdout.trim();
      const fullContent = `${strategy.description}:\n${output}`;

      const truncationResult = truncateToTokenLimit(fullContent);

      // Apply validation if the tool has a validation function
      if (
        strategy.validation &&
        !strategy.validation(truncationResult.truncatedText)
      ) {
        return null; // Validation failed
      }

      return truncationResult.truncatedText;
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Detect available command line tools
 */
export async function detectAvailableTools(): Promise<void> {
  if (global.availableTools) {
    return; // Already detected
  }

  global.availableTools = new Map<string, ToolInfo>();

  const tools: ToolInfo[] = [
    {
      name: "gunzip",
      command: "gunzip",
      args: ["-c", "FILEPATH"],
      description: "Decompress gzipped files",
      priority: 8,
      validation: (output: string) => {
        const content = output
          .replace(/Decompress gzipped files:\s*/i, "")
          .trim();
        return content.length > 10 && /[a-zA-Z]/.test(content);
      },
    },
    {
      name: "cat",
      command: "cat",
      args: ["FILEPATH"],
      description: "Plain text file content",
      priority: 7,
      validation: (output: string) => {
        const content = output
          .replace(/Plain text file content:\s*/i, "")
          .trim();
        return content.length > 10 && /[a-zA-Z]/.test(content);
      },
    },
    {
      name: "head",
      command: "head",
      args: ["-c", "10000", "FILEPATH"],
      description: "Preview file content (first 10KB)",
      priority: 6,
      validation: (output: string) => {
        const content = output
          .replace(/Preview file content \(first 10KB\):\s*/i, "")
          .trim();
        return content.length > 50 && /[a-zA-Z]/.test(content);
      },
    },
    {
      name: "pdftotext",
      command: "pdftotext",
      args: ["FILEPATH", "-"],
      description: "PDF text content extraction",
      priority: 10,
      validation: (output: string) => {
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
      priority: 7,
    },
    {
      name: "gm-identify",
      command: "gm",
      args: ["identify", "-verbose", "FILEPATH"],
      description: "GraphicsMagick image information",
      priority: 7,
    },
    {
      name: "exiftool",
      command: "exiftool",
      args: ["FILEPATH"],
      description: "File metadata extraction",
      priority: 6,
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
      priority: 5,
      validation: (output: string) => {
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
      priority: 4,
      validation: (output: string) => {
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
      priority: 5,
      validation: (output: string) => {
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
      args: ["-n", "4", "FILEPATH"], // Only strings with 4+ characters
      description: "Extract readable strings from binary files",
      priority: 0,
      validation: (output: string) => {
        const stringsContent = output
          .replace(/Extract readable strings from binary files:\s*/i, "")
          .trim();
        // For binary files, be more lenient - just require some content and some letters
        return stringsContent.length > 10 && /[a-zA-Z]/.test(stringsContent);
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

  for (const tool of tools) {
    try {
      await execAsync(`command -v ${tool.command}`);
      global.availableTools.set(tool.name, tool);
    } catch (error) {
      // Tool not available
    }
  }
}

/**
 * Display file type information using the `file` command
 */
export async function displayFileType(filePath: string): Promise<void> {
  try {
    const { stdout } = await execAsync(`file "${filePath}"`);
    const fileType = stdout.trim().split(":")[1]?.trim() || "Unknown";
    console.log(chalk.cyan(`Type: ${fileType}`));
  } catch (error) {
    console.log(chalk.yellow("Could not determine file type"));
  }
}

/**
 * Display image information if the file is an image
 */
async function displayImageInfo(filePath: string): Promise<void> {
  try {
    // Try to get image info using `identify` command (ImageMagick)
    const { stdout } = await execAsync(`identify "${filePath}" 2>/dev/null`);
    if (stdout.trim()) {
      const parts = stdout.trim().split(" ");
      if (parts.length >= 3) {
        const dimensions = parts[2];
        const format = parts[1];
        console.log(chalk.magenta(`Image: ${format} ${dimensions}`));
      }
    }
  } catch (error) {
    // Try with `sips` command (macOS)
    try {
      const { stdout } = await execAsync(
        `sips -g pixelWidth -g pixelHeight "${filePath}" 2>/dev/null`,
      );
      const lines = stdout.trim().split("\n");
      const width = lines
        .find((l) => l.includes("pixelWidth"))
        ?.split(":")[1]
        ?.trim();
      const height = lines
        .find((l) => l.includes("pixelHeight"))
        ?.split(":")[1]
        ?.trim();
      if (width && height) {
        console.log(chalk.magenta(`Image: ${width}x${height}`));
      }
    } catch (sipsError) {
      // Not an image file or tools not available
    }
  }
}

/**
 * Check if a file extension suggests it's a text file
 */
export function isTextFile(ext: string): boolean {
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
    ".env",
    ".conf",
  ];
  return textExtensions.includes(ext) || ext === "";
}

/**
 * Check if a file extension suggests it's an image file
 */
export function isImageFile(ext: string): boolean {
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
  return imageExtensions.includes(ext.toLowerCase());
}

/**
 * Check if a file extension suggests it's an audio file
 */
export function isAudioFile(ext: string): boolean {
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
  return audioExtensions.includes(ext.toLowerCase());
}

/**
 * Check if a file extension suggests it's a video file
 */
export function isVideoFile(ext: string): boolean {
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
  return videoExtensions.includes(ext.toLowerCase());
}

/**
 * Check if a file extension suggests it's an archive file
 */
export function isArchiveFile(ext: string): boolean {
  const archiveExtensions = [
    ".zip",
    ".rar",
    ".7z",
    ".tar",
    ".tar.gz",
    ".tgz",
    ".gz",
    ".bz2",
    ".xz",
  ];
  return archiveExtensions.includes(ext.toLowerCase());
}

/**
 * Check if a file extension suggests it's an office file
 */
export function isOfficeFile(ext: string): boolean {
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
    ".rtf",
    ".wps",
    ".wks",
    ".wpd",
    ".wk1",
    ".wk2",
    ".wk3",
    ".wk4",
    ".wq1",
    ".wq2",
    ".wq3",
    ".wq4",
  ];
  return officeExtensions.includes(ext.toLowerCase());
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)}${units[unitIndex]}`;
}

// Global variable to store available tools (shared between function calls)
declare global {
  var availableTools: Map<string, ToolInfo> | undefined;
}
