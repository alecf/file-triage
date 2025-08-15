import { promises as fs } from "fs";
import OpenAI from "openai";
import path from "path";

export class EmbeddingService {
  private openai: OpenAI;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
    });
  }

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

      // For non-text files, use metadata
      return {
        content: `File: ${path.basename(
          filePath,
        )}, Extension: ${ext}, Size: ${this.formatFileSize(stats.size)}`,
        strategy: "metadata-binary",
      };
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
