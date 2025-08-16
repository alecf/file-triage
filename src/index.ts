#!/usr/bin/env node

import chalk from "chalk";
import { program } from "commander";
import { promises as fs } from "fs";
import ora from "ora";
import path from "path";
import { EmbeddingCache } from "./cache.js";
import { ClusteringService, FileItem } from "./clustering.js";
import { EmbeddingService } from "./embeddings.js";
import { InteractiveTriager } from "./interactive.js";

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
        const showProgress = options.progress !== false;
        const useFastCache = options.fastCache === true;

        console.log(chalk.blue.bold("File Triage Tool"));
        console.log(
          chalk.gray(
            `Processing ${directories.length} directories with minimum cluster size of ${minClusterSize}\n`,
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
        const clusters = await ClusteringService.clusterFiles(
          allFiles,
          minClusterSize,
        );
        console.log(chalk.green(`Created ${clusters.length} clusters`));

        // Interactive triage
        const triager = new InteractiveTriager();
        await triager.triageClusters(clusters);
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
