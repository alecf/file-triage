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
  clusterFiles,
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
    .description("CLI tool for triaging files using embeddings and clustering")
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
      "--auto-cluster",
      "automatically adjust clustering parameters for optimal results",
    )
    .option(
      "--target-clusters <count>",
      "target number of clusters for auto-clustering",
    )
    .option("--verbose-clustering", "show detailed auto-clustering information")
    .option(
      "--ultra-strict",
      "use ultra-strict clustering (max 5% per cluster, max 20 files per cluster)",
    )
    .option("--no-progress", "disable progress indicators")
    .option(
      "--fast-cache",
      "use fast cache validation (faster but less reliable)",
    )
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

        const embeddingService = new EmbeddingService(apiKey);
        const minClusterSize = parseInt(options.minClusterSize);
        const similarityThreshold = parseFloat(
          options.similarityThreshold || "0.95",
        );
        const maxClusterSize = parseInt(options.maxClusterSize || "50");
        const enableAutoCluster = options.autoCluster === true;
        const targetClusters = options.targetClusters
          ? parseInt(options.targetClusters)
          : undefined;
        const verboseClustering = options.verboseClustering === true;
        const ultraStrict = options.ultraStrict === true;
        const showProgress = options.progress !== false;
        const useFastCache = options.fastCache === true;

        // Apply ultra-strict settings if enabled
        if (ultraStrict) {
          console.log(
            chalk.yellow(
              "🔒 Ultra-strict clustering enabled - will enforce very small cluster sizes",
            ),
          );
        }

        const effectiveMaxClusterSize = ultraStrict ? 20 : maxClusterSize;
        console.log(chalk.blue.bold("File Triage Tool"));
        console.log(
          chalk.gray(
            `Processing ${directories.length} directories with clustering parameters:\n` +
              `  - Minimum cluster size: ${minClusterSize}\n` +
              `  - Similarity threshold: ${similarityThreshold}\n` +
              `  - Maximum cluster size: ${effectiveMaxClusterSize}${
                ultraStrict ? " (ultra-strict)" : ""
              }\n` +
              `  - Auto-clustering: ${
                enableAutoCluster ? "enabled" : "disabled"
              }\n` +
              (targetClusters
                ? `  - Target clusters: ${targetClusters}\n`
                : "") +
              `  - Verbose clustering: ${
                verboseClustering ? "enabled" : "disabled"
              }\n`,
          ),
        );

        if (useFastCache) {
          console.log(
            chalk.yellow(
              "⚠️  Fast cache mode enabled - cache validation uses file stats only (faster but less reliable)",
            ),
          );
        }

        // Process all directories with progress
        const allFiles: FileItem[] = [];
        const overallSpinner = showProgress
          ? ora(`Processing directories...`).start()
          : null;

        for (let i = 0; i < directories.length; i++) {
          const dir = directories[i];
          if (showProgress) {
            overallSpinner!.text = `Processing directory ${i + 1}/${
              directories.length
            }: ${path.basename(dir)}`;
          }

          const dirFiles = await processDirectory(
            path.resolve(dir),
            embeddingService,
            useFastCache,
          );
          allFiles.push(...dirFiles);
        }

        if (showProgress) {
          overallSpinner!.succeed(
            `Completed processing ${directories.length} directories`,
          );
        }

        console.log(chalk.green(`\nProcessed ${allFiles.length} files total`));

        if (allFiles.length === 0) {
          console.log(chalk.yellow("No files to process. Exiting."));
          return;
        }

        // Cluster files with progress
        if (showProgress) {
          console.log(chalk.blue("\nClustering files..."));
        }

        let clusters;
        if (enableAutoCluster) {
          // Use auto-clustering with parameter adjustment
          if (showProgress) {
            console.log(
              chalk.blue(
                "🔄 Auto-clustering enabled - will adjust parameters automatically",
              ),
            );
          }

          const autoResult = await autoClusterFiles(
            allFiles,
            {
              minClusterSize,
              similarityThreshold,
              maxClusterSize: ultraStrict ? 20 : maxClusterSize,
            },
            {
              targetClusterCount: targetClusters,
              enableVerbose: verboseClustering,
              maxClusterSizePercent: ultraStrict ? 0.05 : 0.1, // 5% for ultra-strict, 10% for normal
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
        } else {
          // Use manual clustering
          clusters = await clusterFiles(allFiles, {
            minClusterSize,
            similarityThreshold,
            maxClusterSize: ultraStrict ? 20 : maxClusterSize,
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

  program.parse();
}

// ES module equivalent of require.main === module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(chalk.red("Unexpected error:"), error);
    process.exit(1);
  });
}
