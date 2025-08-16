import chalk from "chalk";
import { exec } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Display comprehensive information about a file
 */
export async function displayFileInfo(filePath: string): Promise<void> {
  console.log(chalk.blue.bold("\n=== File Information ==="));
  console.log(chalk.white(`File: ${path.basename(filePath)}`));
  console.log(chalk.gray(`Path: ${filePath}`));

  // Basic file stats
  try {
    const stats = await fs.stat(filePath);
    console.log(chalk.green(`Size: ${formatFileSize(stats.size)}`));
    console.log(chalk.green(`Modified: ${stats.mtime.toLocaleString()}`));
    console.log(chalk.green(`Created: ${stats.birthtime.toLocaleString()}`));
    console.log(chalk.green(`Permissions: ${stats.mode.toString(8)}`));
  } catch (error) {
    console.log(chalk.red("Could not read file stats"));
  }

  // File type detection using `file` command
  await displayFileType(filePath);

  // Image info if available
  await displayImageInfo(filePath);

  // Text preview for text files
  await displayTextPreview(filePath);
}

/**
 * Display file type information using the `file` command
 */
async function displayFileType(filePath: string): Promise<void> {
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
 * Display text preview for text files
 */
async function displayTextPreview(filePath: string): Promise<void> {
  try {
    const ext = path.extname(filePath).toLowerCase();

    // Check if it might be a text file
    if (isLikelyTextFile(ext)) {
      const stats = await fs.stat(filePath);

      // Don't try to read very large files
      if (stats.size > 1024 * 1024) {
        // 1MB
        console.log(chalk.yellow("File too large for preview"));
        return;
      }

      // Try to read as text and show first few lines
      try {
        const { stdout } = await execAsync(`head -n 10 "${filePath}"`);
        if (stdout.trim()) {
          console.log(chalk.blue("\n--- Preview (first 10 lines) ---"));
          console.log(chalk.gray(stdout));
          console.log(chalk.blue("--- End Preview ---"));
        }
      } catch (error) {
        // File might be binary, try with strings command
        try {
          const { stdout } = await execAsync(
            `strings "${filePath}" | head -n 5`,
          );
          if (stdout.trim()) {
            console.log(chalk.blue("\n--- Text content found ---"));
            console.log(chalk.gray(stdout));
            console.log(chalk.blue("--- End content ---"));
          }
        } catch (stringsError) {
          console.log(chalk.yellow("Could not extract text preview"));
        }
      }
    }
  } catch (error) {
    console.log(chalk.yellow("Could not generate preview"));
  }
}

/**
 * Check if a file extension suggests it's likely a text file
 */
function isLikelyTextFile(ext: string): boolean {
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
