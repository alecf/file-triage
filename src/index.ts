#!/usr/bin/env node

import chalk from "chalk";
import { program } from "commander";
import { promises as fs } from "fs";
import ora from "ora";
import path from "path";
import {
  analyzeClusteringResults,
  autoClusterFiles,
  FileItem,
} from "./clustering.js";
import { EmbeddingService } from "./embeddings.js";
import { triageClusters } from "./interactive.js";

async function processDirectory(
  dirPath: string,
  embeddingService: EmbeddingService,
): Promise<FileItem[]> {
  console.log(chalk.blue(`Processing directory: ${dirPath}`));

  const files = await fs.readdir(dirPath);
  const fileItems: FileItem[] = [];

  // Filter out hidden files, directories, and empty files
  const validFiles = [];
  for (const file of files) {
    if (file.startsWith(".")) continue; // Skip hidden files

    const filePath = path.join(dirPath, file);
    try {
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) continue; // Skip directories
      if (stats.size === 0) continue; // Skip empty files
      validFiles.push({ file, filePath, stats });
    } catch (error) {
      console.log(chalk.red(`Error checking ${file}: ${error}`));
    }
  }

  console.log(chalk.gray(`Found ${validFiles.length} valid files to process`));

  if (validFiles.length === 0) {
    return fileItems;
  }

  // Create progress spinner for file processing
  const spinner = ora(`Processing files...`).start();
  let processedCount = 0;
  let cachedCount = 0;
  let newEmbeddingCount = 0;
  let errorCount = 0;

  try {
    spinner.text = `Getting embeddings for ${validFiles.length} files...`;

    // Use the batch method with concurrency limits instead of individual calls
    const filePaths = validFiles.map((f) => f.filePath);
    const results = await embeddingService.getFileEmbeddings(filePaths);

    // Process the batch results
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const { file, stats } = validFiles[i];

      if (result.error) {
        errorCount++;
        spinner.text = `✗ Failed to get embedding for ${file}: ${result.error}`;
        continue;
      }

      if (result.fromCache) {
        cachedCount++;
        spinner.text = `✓ Using cached embedding for ${file}`;
      } else {
        newEmbeddingCount++;
        spinner.text = `✓ Generated new embedding for ${file} (${result.strategy})`;
      }

      fileItems.push({
        filePath: result.filePath,
        embedding: result.embedding,
        size: stats.size,
        lastModified: stats.mtime,
      });

      processedCount++;
    }
  } catch (error) {
    errorCount++;
    spinner.text = `✗ Failed to process files: ${error}`;
  }

  // Clean up stale cache entries
  await embeddingService.cleanupCache();

  // Show final results
  if (errorCount === 0) {
    spinner.succeed(
      `Processed ${processedCount} files (${cachedCount} cached, ${newEmbeddingCount} new)`,
    );
  } else {
    spinner.warn(
      `Processed ${processedCount} files with ${errorCount} errors (${cachedCount} cached, ${newEmbeddingCount} new)`,
    );
  }

  return fileItems;
}

async function main() {
  program
    .name("file-triage")
    .description(
      "CLI tool for triaging files using embeddings and auto-clustering with database cache (auto-clustering always enabled, fast cache by default)",
    )
    .version("1.0.0")
    .argument("<directories...>", "directories to process")
    .option(
      "-k, --openai-key <key>",
      "OpenAI API key (or set OPENAI_API_KEY env var)",
    )
    .option("-c, --min-cluster-size <size>", "minimum cluster size", "2")
    .option(
      "--similarity-threshold <threshold>",
      "similarity threshold for clustering (0-1)",
      "0.95",
    )
    .option("--max-cluster-size <size>", "maximum files per cluster", "50")
    .option(
      "--target-clusters <count>",
      "target number of clusters for auto-clustering (optional)",
    )
    .option(
      "--strict-cache",
      "use strict cache validation (slower but more reliable)",
    )
    .option("--cache-stats", "show cache statistics and exit")
    .option("--cache-cleanup", "clean up stale cache entries and exit")
    .action(async (directories: string[], options) => {
      try {
        // Validate OpenAI API key
        const apiKey = options.openaiKey || process.env.OPENAI_API_KEY;
        if (!apiKey) {
          console.error(
            chalk.red(
              "Error: OpenAI API key is required. Set OPENAI_API_KEY environment variable or use -k flag.",
            ),
          );
          process.exit(1);
        }

        // Create embedding service
        const embeddingService = new EmbeddingService(apiKey, false); // verboseTools always false

        // Handle cache stats option
        if (options.cacheStats) {
          if (directories.length === 0) {
            console.error(
              chalk.red(
                "Error: Please specify a directory to check cache stats",
              ),
            );
            process.exit(1);
          }

          const dir = directories[0];
          await embeddingService.initializeCache(
            dir,
            options.strictCache !== true,
          );

          const stats = await embeddingService.getCacheStats();
          if (stats) {
            console.log(chalk.blue.bold(`Cache Statistics for: ${dir}`));
            console.log(chalk.gray(`Total entries: ${stats.totalEntries}`));
            console.log(chalk.gray(`Valid entries: ${stats.validEntries}`));
            console.log(chalk.gray(`Stale entries: ${stats.staleEntries}`));
            console.log(
              chalk.gray(
                `Cache size: ${(stats.cacheSize / 1024 / 1024).toFixed(2)} MB`,
              ),
            );
          } else {
            console.log(chalk.yellow("Cache not initialized"));
          }

          await embeddingService.closeCache();
          return;
        }

        // Handle cache cleanup option
        if (options.cacheCleanup) {
          if (directories.length === 0) {
            console.error(
              chalk.red("Error: Please specify a directory to clean cache"),
            );
            process.exit(1);
          }

          const dir = directories[0];
          await embeddingService.initializeCache(
            dir,
            options.strictCache !== true,
          );

          console.log(chalk.blue(`Cleaning up stale cache entries in: ${dir}`));
          await embeddingService.cleanupCache();

          const stats = await embeddingService.getCacheStats();
          if (stats) {
            console.log(chalk.green(`Cleanup completed!`));
            console.log(chalk.gray(`Remaining entries: ${stats.totalEntries}`));
            console.log(
              chalk.gray(
                `Cache size: ${(stats.cacheSize / 1024 / 1024).toFixed(2)} MB`,
              ),
            );
          }

          await embeddingService.closeCache();
          return;
        }

        // Validate directories
        for (const dir of directories) {
          try {
            const stats = await fs.stat(dir);
            if (!stats.isDirectory()) {
              console.error(
                chalk.red(`Error: ${dir} is not a valid directory`),
              );
              process.exit(1);
            }
          } catch (error) {
            console.error(chalk.red(`Error: ${dir} is not accessible`));
            process.exit(1);
          }
        }

        const targetClusters = options.targetClusters
          ? parseInt(options.targetClusters)
          : undefined;

        console.log(chalk.blue.bold("File Triage Tool"));
        console.log(
          chalk.gray(
            `Processing ${directories.length} directories with clustering parameters:\n` +
              `  - Minimum cluster size: ${options.minClusterSize}\n` +
              `  - Similarity threshold: ${options.similarityThreshold}\n` +
              `  - Maximum cluster size: ${options.maxClusterSize}\n` +
              `  - Auto-clustering: enabled\n` +
              (targetClusters
                ? `  - Target clusters: ${targetClusters}\n`
                : "") +
              `  - Cache mode: ${
                options.strictCache !== true ? "fast" : "strict"
              }\n`,
          ),
        );

        if (options.strictCache !== true) {
          console.log(
            chalk.yellow(
              "⚡ Fast cache mode enabled (default) - validation uses file stats only (faster but less reliable)",
            ),
          );
        } else {
          console.log(
            chalk.yellow(
              "🔒 Strict cache mode enabled - validation uses full file content (slower but more reliable)",
            ),
          );
        }

        // Process all directories with progress
        const allFiles: FileItem[] = [];
        const overallSpinner = ora(`Processing directories...`).start();

        for (let i = 0; i < directories.length; i++) {
          const dir = directories[i];
          overallSpinner.text = `Processing directory ${i + 1}/${
            directories.length
          }: ${path.basename(dir)}`;

          // Initialize cache for this directory
          await embeddingService.initializeCache(
            path.resolve(dir),
            options.strictCache !== true,
          );

          const dirFiles = await processDirectory(
            path.resolve(dir),
            embeddingService,
          );
          allFiles.push(...dirFiles);

          // Close cache for this directory before moving to next
          await embeddingService.closeCache();
        }

        overallSpinner.succeed(
          `Completed processing ${directories.length} directories`,
        );

        console.log(chalk.green(`\nProcessed ${allFiles.length} files total`));

        if (allFiles.length === 0) {
          console.log(chalk.yellow("No files to process. Exiting."));
          return;
        }

        // Cluster files with progress
        console.log(chalk.blue("\nClustering files..."));

        let clusters;
        // Always use auto-clustering
        console.log(
          chalk.blue(
            "🔄 Auto-clustering enabled - will adjust parameters automatically",
          ),
        );

        const autoResult = await autoClusterFiles(
          allFiles,
          {
            minClusterSize: parseInt(options.minClusterSize),
            similarityThreshold: parseFloat(
              options.similarityThreshold || "0.95",
            ),
            maxClusterSize: parseInt(options.maxClusterSize || "50"),
          },
          {
            targetClusterCount: targetClusters,
            enableVerbose: true, // Enable verbose output for better insights
            maxClusterSizePercent: 0.15, // Increased from 0.1 to 0.15 for more realistic limits
          },
        );

        clusters = autoResult.clusters;

        // Show auto-clustering results
        console.log(
          chalk.green(
            `✅ Auto-clustering completed in ${autoResult.iterations} iteration(s)`,
          ),
        );
        console.log(
          chalk.blue(`📊 Final parameters:`, autoResult.finalOptions),
        );

        if (autoResult.adjustments.length > 0) {
          console.log(chalk.yellow("\n🔧 Parameter adjustments made:"));
          autoResult.adjustments.forEach((adjustment) => {
            console.log(chalk.yellow(`  • ${adjustment}`));
          });
        }

        console.log(chalk.green(`Created ${clusters.length} clusters`));

        // Analyze clustering results and provide suggestions
        const analysis = analyzeClusteringResults(clusters);
        console.log(chalk.blue("\n📊 Clustering Analysis:"));
        console.log(chalk.gray(`Total files: ${analysis.totalFiles}`));
        console.log(chalk.gray(`Total clusters: ${analysis.totalClusters}`));
        console.log(chalk.gray(`Size distribution:`));
        Object.entries(analysis.sizeDistribution).forEach(([range, count]) => {
          if (count > 0) {
            console.log(chalk.gray(`  ${range}: ${count} clusters`));
          }
        });

        if (analysis.suggestions.length > 0) {
          console.log(chalk.yellow("\n💡 Suggestions for better clustering:"));
          analysis.suggestions.forEach((suggestion) => {
            console.log(chalk.yellow(`  • ${suggestion}`));
          });
        }

        // Interactive triage
        await triageClusters(clusters);
      } catch (error) {
        console.error(chalk.red("Error:"), error);
        process.exit(1);
      }
    });

  // Graceful shutdown handler
  process.on("SIGINT", async () => {
    console.log(chalk.yellow("\nReceived SIGINT, shutting down gracefully..."));
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log(
      chalk.yellow("\nReceived SIGTERM, shutting down gracefully..."),
    );
    process.exit(0);
  });

  program.parse();
}

// ES module equivalent of require.main === module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(chalk.red("Unexpected error:"), error);
    process.exit(1);
  });
}
