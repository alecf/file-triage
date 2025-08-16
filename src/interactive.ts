import chalk from "chalk";
import inquirer from "inquirer";
import path from "path";
import { Cluster, ClusteringService, FileItem } from "./clustering.js";
import { FileInfo } from "./fileinfo.js";
import { FileOperations } from "./operations.js";

interface FileStatus {
  originalPath: string;
  currentPath: string;
  status: "pending" | "deleted" | "skipped" | "renamed" | "processed";
  oldName?: string;
  newName?: string;
  action?: string;
}

export class InteractiveTriager {
  private operations: FileOperations;
  private fileInfo: FileInfo;

  constructor() {
    this.operations = new FileOperations();
    this.fileInfo = new FileInfo();
  }

  async triageClusters(clusters: Cluster[]): Promise<void> {
    console.log(
      chalk.blue.bold(`\nFound ${clusters.length} clusters to triage.\n`),
    );

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      console.log(
        chalk.yellow.bold(
          `\n=== Cluster ${cluster.id} (${cluster.files.length} files) ===`,
        ),
      );

      await this.triageCluster(cluster, i + 1, clusters.length);
    }

    console.log(chalk.green.bold("\nTriage complete!"));
  }

  private async triageCluster(
    cluster: Cluster,
    clusterNum: number,
    totalClusters: number,
  ): Promise<void> {
    // Initialize file statuses for this cluster
    const fileStatuses: FileStatus[] = cluster.files.map((file) => ({
      originalPath: file.filePath,
      currentPath: file.filePath,
      status: "pending",
      oldName: path.basename(file.filePath),
      newName: path.basename(file.filePath),
    }));

    this.displayClusterSummary(cluster, fileStatuses);

    for (let i = 0; i < cluster.files.length; i++) {
      const file = cluster.files[i];
      const result = await this.triageFile(
        file,
        i,
        cluster.files.length,
        clusterNum,
        totalClusters,
        fileStatuses,
        cluster,
      );

      if (result === "deleteAllRemaining") {
        // Delete all remaining files in cluster
        for (let j = i + 1; j < cluster.files.length; j++) {
          const remainingFile = cluster.files[j];
          await this.operations.deleteFile(remainingFile.filePath);
          fileStatuses[j].status = "deleted";
          fileStatuses[j].action = "Deleted";
          console.log(
            chalk.red(`Deleted: ${path.basename(remainingFile.filePath)}`),
          );
        }
        console.log(chalk.cyan("Skipping to next cluster...\n"));
        break;
      } else if (!result) {
        console.log(chalk.cyan("Skipping to next cluster...\n"));
        break;
      }
    }

    // Show final cluster summary
    this.displayClusterSummary(cluster, fileStatuses, true);
  }

  private displayClusterSummary(
    cluster: Cluster,
    fileStatuses: FileStatus[],
    isFinal: boolean = false,
  ): void {
    const title = isFinal ? "Final cluster status:" : "Files in this cluster:";
    console.log(chalk.gray(`\n${title}`));

    // Calculate column widths for alignment
    const maxFileNameLength = Math.max(
      ...cluster.files.map((f) => path.basename(f.filePath).length),
      20, // minimum width
    );
    const maxSizeLength = Math.max(
      ...cluster.files.map(
        (f) => ClusteringService.formatFileSize(f.size).length,
      ),
      8, // minimum width
    );

    cluster.files.forEach((file, index) => {
      const status = fileStatuses[index];
      const fileName = path.basename(file.filePath);
      const size = ClusteringService.formatFileSize(file.size);
      const date = ClusteringService.formatDate(file.lastModified);

      const paddedFileName = fileName.padEnd(maxFileNameLength);
      const paddedSize = size.padStart(maxSizeLength);

      // Status icon and color
      let statusIcon = "⏳"; // pending
      let statusColor = chalk.gray;
      let statusText = "";

      switch (status.status) {
        case "deleted":
          statusIcon = "🗑️";
          statusColor = chalk.red;
          statusText = "Deleted";
          break;
        case "skipped":
          statusIcon = "⏭️";
          statusColor = chalk.yellow;
          statusText = "Skipped";
          break;
        case "renamed":
          statusIcon = "✏️";
          statusColor = chalk.green;
          statusText = `Renamed: ${status.oldName} → ${status.newName}`;
          break;
        case "processed":
          statusIcon = "✅";
          statusColor = chalk.green;
          statusText = "Processed";
          break;
        case "pending":
          statusIcon = "⏳";
          statusColor = chalk.gray;
          statusText = "Pending";
          break;
      }

      // Highlight current file (if not final summary)
      const isCurrentFile =
        !isFinal && index === this.getCurrentFileIndex(fileStatuses);
      const fileNameColor = isCurrentFile ? chalk.white.bold : chalk.white;
      const indexColor = isCurrentFile ? chalk.blue.bold : chalk.gray;

      console.log(
        `  ${indexColor(
          (index + 1).toString().padStart(2),
        )}. ${statusIcon} ${fileNameColor(paddedFileName)} ${chalk.cyan(
          paddedSize,
        )} ${chalk.gray(date)} ${statusColor(statusText)}`,
      );
    });
    console.log("");
  }

  private displayStatusSummary(fileStatuses: FileStatus[]): void {
    const total = fileStatuses.length;
    const deleted = fileStatuses.filter((s) => s.status === "deleted").length;
    const skipped = fileStatuses.filter((s) => s.status === "skipped").length;
    const renamed = fileStatuses.filter((s) => s.status === "renamed").length;
    const processed = fileStatuses.filter(
      (s) => s.status === "processed",
    ).length;
    const pending = fileStatuses.filter((s) => s.status === "pending").length;

    console.log(
      chalk.gray("📊 Status Summary:"),
      chalk.red(`🗑️ ${deleted}`),
      chalk.yellow(`⏭️ ${skipped}`),
      chalk.green(`✏️ ${renamed}`),
      chalk.green(`✅ ${processed}`),
      chalk.blue(`⏳ ${pending}`),
      chalk.gray(`/ ${total}`),
    );
  }

  private getCurrentFileIndex(fileStatuses: FileStatus[]): number {
    return fileStatuses.findIndex((status) => status.status === "pending");
  }

  private async triageFile(
    file: FileItem,
    fileIndex: number,
    totalFiles: number,
    clusterNum: number,
    totalClusters: number,
    fileStatuses: FileStatus[],
    originalCluster: Cluster,
  ): Promise<boolean | string> {
    const fileName = path.basename(file.filePath);
    const size = ClusteringService.formatFileSize(file.size);
    const date = ClusteringService.formatDate(file.lastModified);

    // Update current file status
    fileStatuses[fileIndex].status = "pending";

    // Note: We don't need to call displayClusterSummary here since it's already shown
    // at the beginning of triageCluster and will be updated on the next iteration

    while (true) {
      // Show status summary at the top
      this.displayStatusSummary(fileStatuses);

      console.log(
        chalk.blue(
          `\nCluster ${clusterNum}/${totalClusters}, File ${
            fileIndex + 1
          }/${totalFiles}`,
        ),
      );
      console.log(
        chalk.white.bold(`File: ${fileName}`),
        chalk.gray(`(${size}, ${date})`),
      );
      console.log(chalk.gray(`Path: ${file.filePath}`));

      const { action } = await inquirer.prompt([
        {
          type: "rawlist",
          name: "action",
          message: "What would you like to do with this file?",
          choices: [
            { name: "🗑️  Delete this file", value: "delete", key: "d" },
            { name: "⏭️  Skip to next file", value: "next", key: "n" },
            {
              name: "🗑️💥 Delete this file and all remaining in cluster",
              value: "deleteAll",
              key: "a",
            },
            { name: "🚫 Skip to next cluster", value: "skipCluster", key: "s" },
            { name: "✏️  Rename this file", value: "rename", key: "r" },
            { name: "ℹ️  Show file info", value: "info", key: "i" },
            { name: "🚪 Quit triage tool", value: "quit", key: "q" },
          ],
        },
      ]);

      switch (action) {
        case "delete":
          await this.operations.deleteFile(file.filePath);
          fileStatuses[fileIndex].status = "deleted";
          fileStatuses[fileIndex].action = "Deleted";
          console.log(chalk.red(`Deleted: ${fileName}`));
          return true;

        case "next":
          fileStatuses[fileIndex].status = "skipped";
          fileStatuses[fileIndex].action = "Skipped";
          return true;

        case "deleteAll":
          await this.operations.deleteFile(file.filePath);
          fileStatuses[fileIndex].status = "deleted";
          fileStatuses[fileIndex].action = "Deleted";
          console.log(chalk.red(`Deleted: ${fileName}`));

          return "deleteAllRemaining";

        case "skipCluster":
          // Mark remaining files as skipped
          for (let j = fileIndex; j < fileStatuses.length; j++) {
            if (fileStatuses[j].status === "pending") {
              fileStatuses[j].status = "skipped";
              fileStatuses[j].action = "Skipped";
            }
          }
          return false;

        case "quit":
          console.log(chalk.yellow("Exiting triage tool..."));
          process.exit(0);

        case "rename":
          const { newName } = await inquirer.prompt([
            {
              type: "input",
              name: "newName",
              message: "Enter new filename:",
              default: fileName,
            },
          ]);

          if (newName && newName !== fileName) {
            const newPath = path.join(path.dirname(file.filePath), newName);
            await this.operations.renameFile(file.filePath, newPath);

            // Update file status
            fileStatuses[fileIndex].status = "renamed";
            fileStatuses[fileIndex].oldName = fileName;
            fileStatuses[fileIndex].newName = newName;
            fileStatuses[fileIndex].action = "Renamed";
            fileStatuses[fileIndex].currentPath = newPath;

            // Update file object
            file.filePath = newPath;

            console.log(chalk.green(`Renamed to: ${newName}`));
          }
          // Mark as processed even if no rename occurred
          fileStatuses[fileIndex].status = "processed";
          fileStatuses[fileIndex].action = "Processed";
          return true;

        case "info":
          await this.fileInfo.displayFileInfo(file.filePath);
          continue; // Stay on same file
      }
    }
  }
}
