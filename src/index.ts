#!/usr/bin/env node

import chalk from "chalk";
import { program } from "commander";
import { promises as fs } from "fs";
import ora from "ora";
import path from "path";
import { EmbeddingCache } from "./cache.js";
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
  useFastCache: boolean,
): Promise<FileItem[]> {
  console.log(chalk.blue(`Processing directory: ${dirPath}`));

  const cache = new EmbeddingCache(dirPath, useFastCache);
  await cache.initialize();

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

  // Batch get all cached embeddings first
  const filePaths = validFiles.map((f) => f.filePath);
  const cachedEmbeddings = await cache.getCachedEmbeddings(filePaths);

  // Create progress spinner for file processing
  const spinner = ora(`Processing files...`).start();
  let processedCount = 0;
  let cachedCount = 0;
  let newEmbeddingCount = 0;
  let errorCount = 0;

  for (const { file, filePath, stats } of validFiles) {
    spinner.text = `Processing ${file} (${processedCount + 1}/${
      validFiles.length
    })`;

    try {
      // Check if we have a cached embedding
      let embedding = cachedEmbeddings.get(filePath);
      let strategy = "";

      if (!embedding) {
        spinner.text = `Getting embedding for ${file}...`;
        try {
          const result = await embeddingService.getFileEmbedding(filePath);
          embedding = result.embedding;
          strategy = result.strategy;
          await cache.setCachedEmbedding(filePath, embedding, strategy);
          newEmbeddingCount++;
          spinner.text = `✓ Cached embedding for ${file} (${strategy})`;
        } catch (error) {
          errorCount++;
          spinner.text = `✗ Failed to get embedding for ${file}: ${error}`;
          continue;
        }
      } else {
        cachedCount++;
        spinner.text = `✓ Using cached embedding for ${file}`;
      }

      fileItems.push({
        filePath,
        embedding,
        size: stats.size,
        lastModified: stats.mtime,
      });

      processedCount++;
    } catch (error) {
      errorCount++;
      spinner.text = `Error processing ${file}: ${error}`;
    }
  }

  // Clean up stale cache entries
  await cache.cleanupStaleEntries();

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
          const cache = new EmbeddingCache(dir, options.strictCache !== true);
          await cache.initialize();

          const stats = await cache.getCacheStats();
          console.log(chalk.blue.bold(`Cache Statistics for: ${dir}`));
          console.log(chalk.gray(`Total entries: ${stats.totalEntries}`));
          console.log(chalk.gray(`Valid entries: ${stats.validEntries}`));
          console.log(chalk.gray(`Stale entries: ${stats.staleEntries}`));
          console.log(
            chalk.gray(
              `Cache size: ${(stats.cacheSize / 1024 / 1024).toFixed(2)} MB`,
            ),
          );

          await cache.close();
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
          const cache = new EmbeddingCache(dir, options.strictCache !== true);
          await cache.initialize();

          console.log(chalk.blue(`Cleaning up stale cache entries in: ${dir}`));
          await cache.cleanupStaleEntries();

          const stats = await cache.getCacheStats();
          console.log(chalk.green(`Cleanup completed!`));
          console.log(chalk.gray(`Remaining entries: ${stats.totalEntries}`));
          console.log(
            chalk.gray(
              `Cache size: ${(stats.cacheSize / 1024 / 1024).toFixed(2)} MB`,
            ),
          );

          await cache.close();
          return;
        }

        // Validate directories
        for (const dir of directories) {
          if (
            !(await fs
              .stat(dir)
              .then((s) => s.isDirectory())
              .catch(() => false))
          ) {
            console.error(chalk.red(`Error: ${dir} is not a valid directory`));
            process.exit(1);
          }
        }

        const targetClusters = options.targetClusters
          ? parseInt(options.targetClusters)
          : undefined;

        // Create embedding service
        const embeddingService = new EmbeddingService(apiKey, false); // verboseTools always false

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

          const dirFiles = await processDirectory(
            path.resolve(dir),
            embeddingService,
            options.strictCache !== true,
          );
          allFiles.push(...dirFiles);
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
