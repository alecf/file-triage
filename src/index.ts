#!/usr/bin/env node

import chalk from "chalk";
import { program } from "commander";
import { promises as fs } from "fs";
import path from "path";
import { EmbeddingCache } from "./cache.js";
import { ClusteringService, FileItem } from "./clustering.js";
import { EmbeddingService } from "./embeddings.js";
import { InteractiveTriager } from "./interactive.js";

async function processDirectory(
  dirPath: string,
  embeddingService: EmbeddingService,
): Promise<FileItem[]> {
  console.log(chalk.blue(`Processing directory: ${dirPath}`));

  const cache = new EmbeddingCache(dirPath);
  await cache.initialize();

  const files = await fs.readdir(dirPath);
  const fileItems: FileItem[] = [];

  for (const file of files) {
    if (file.startsWith(".")) continue; // Skip hidden files

    const filePath = path.join(dirPath, file);

    try {
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) continue; // Skip directories
      if (stats.size === 0) continue; // Skip empty files

      console.log(chalk.gray(`Processing: ${file}`));

      // Try to get cached embedding
      let embedding = await cache.getCachedEmbedding(filePath);
      let strategy = "";

      if (!embedding) {
        console.log(chalk.yellow(`  Getting embedding for ${file}`));
        try {
          const result = await embeddingService.getFileEmbedding(filePath);
          embedding = result.embedding;
          strategy = result.strategy;
          await cache.setCachedEmbedding(filePath, embedding, strategy);
          console.log(
            chalk.green(`  ✓ Cached embedding for ${file} (${strategy})`),
          );
        } catch (error) {
          console.log(
            chalk.red(`  ✗ Failed to get embedding for ${file}: ${error}`),
          );
          continue;
        }
      } else {
        console.log(chalk.green(`  ✓ Using cached embedding for ${file}`));
      }

      fileItems.push({
        filePath,
        embedding,
        size: stats.size,
        lastModified: stats.mtime,
      });
    } catch (error) {
      console.log(chalk.red(`Error processing ${file}: ${error}`));
    }
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

        console.log(chalk.blue.bold("File Triage Tool"));
        console.log(
          chalk.gray(
            `Processing ${directories.length} directories with minimum cluster size of ${minClusterSize}\n`,
          ),
        );

        // Process all directories
        const allFiles: FileItem[] = [];
        for (const dir of directories) {
          const dirFiles = await processDirectory(
            path.resolve(dir),
            embeddingService,
          );
          allFiles.push(...dirFiles);
        }

        console.log(chalk.green(`\nProcessed ${allFiles.length} files total`));

        if (allFiles.length === 0) {
          console.log(chalk.yellow("No files to process. Exiting."));
          return;
        }

        // Cluster files
        console.log(chalk.blue("\nClustering files..."));
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
