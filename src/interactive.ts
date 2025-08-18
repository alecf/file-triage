import chalk from "chalk";
import { spawn } from "child_process";
import inquirer from "inquirer";
import path from "path";
import {
  Cluster,
  FileItem,
  formatDate,
  formatFileSize,
  splitCluster,
} from "./clustering.js";
import { displayFileInfo } from "./fileinfo.js";
import { deleteFile, renameFile } from "./operations.js";

interface FileStatus {
  originalPath: string;
  currentPath: string;
  status: "pending" | "deleted" | "skipped" | "renamed" | "processed";
  oldName?: string;
  newName?: string;
  action?: string;
}

/**
 * Main function to triage all clusters
 */
export async function triageClusters(clusters: Cluster[]): Promise<void> {
  console.log(
    chalk.blue.bold(`\nFound ${clusters.length} clusters to triage.\n`),
  );

  let currentClusters = [...clusters]; // Create a mutable copy
  let currentIndex = 0;

  while (currentIndex < currentClusters.length) {
    const cluster = currentClusters[currentIndex];
    console.log(
      chalk.yellow.bold(
        `\n=== Cluster ${cluster.id} (${cluster.files.length} files) ===`,
      ),
    );

    const result = await triageCluster(
      cluster,
      currentIndex + 1,
      currentClusters.length,
      currentClusters,
      currentIndex,
    );

    if (result === "split") {
      // Split the cluster and replace it with sub-clusters
      const subClusters = await splitCluster(cluster);

      // Replace the current cluster with the sub-clusters
      currentClusters.splice(currentIndex, 1, ...subClusters);

      // Update the total count display
      console.log(
        chalk.blue.bold(
          `\nNow have ${currentClusters.length} clusters to triage.\n`,
        ),
      );

      // Continue with the first sub-cluster (don't increment index)
      continue;
    }

    // Move to next cluster
    currentIndex++;
  }

  console.log(chalk.green.bold("\nTriage complete!"));
}

/**
 * Triage a single cluster
 */
async function triageCluster(
  cluster: Cluster,
  clusterNum: number,
  totalClusters: number,
  allClusters: Cluster[],
  currentClusterIndex: number,
): Promise<boolean | string> {
  // Initialize file statuses for this cluster
  const fileStatuses: FileStatus[] = cluster.files.map((file) => ({
    originalPath: file.filePath,
    currentPath: file.filePath,
    status: "pending",
    oldName: path.basename(file.filePath),
    newName: path.basename(file.filePath),
  }));

  displayClusterSummary(cluster, fileStatuses);

  for (let i = 0; i < cluster.files.length; i++) {
    const file = cluster.files[i];
    const result = await triageFile(
      file,
      i,
      cluster.files.length,
      clusterNum,
      totalClusters,
      fileStatuses,
      cluster,
      allClusters,
      currentClusterIndex,
    );

    if (result === "deleteAllRemaining") {
      // Delete all remaining files in cluster
      for (let j = i + 1; j < cluster.files.length; j++) {
        const remainingFile = cluster.files[j];
        await deleteFile(remainingFile.filePath);
        fileStatuses[j].status = "deleted";
        fileStatuses[j].action = "Deleted";
        console.log(
          chalk.red(`Deleted: ${path.basename(remainingFile.filePath)}`),
        );
      }

      // Show final cluster state after bulk deletion
      displayClusterSummary(cluster, fileStatuses);

      console.log(chalk.cyan("Skipping to next cluster...\n"));
      break;
    } else if (result === "split") {
      // Return split to trigger cluster splitting in the main loop
      return "split";
    } else if (!result) {
      // Show final cluster state after skipping
      displayClusterSummary(cluster, fileStatuses);
      console.log(chalk.cyan("Skipping to next cluster...\n"));
      break;
    }
  }

  // Show final cluster summary
  displayClusterSummary(cluster, fileStatuses, true);
  return false; // Default return for non-split clusters
}

/**
 * Display a summary of files in a cluster
 */
function displayClusterSummary(
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
    ...cluster.files.map((f) => formatFileSize(f.size).length),
    8, // minimum width
  );

  cluster.files.forEach((file, index) => {
    const status = fileStatuses[index];
    const fileName = path.basename(file.filePath);
    const size = formatFileSize(file.size);
    const date = formatDate(file.lastModified);

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
      !isFinal && index === getCurrentFileIndex(fileStatuses);
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

/**
 * Display a summary of file statuses
 */
function displayStatusSummary(fileStatuses: FileStatus[]): void {
  const total = fileStatuses.length;
  const deleted = fileStatuses.filter((s) => s.status === "deleted").length;
  const skipped = fileStatuses.filter((s) => s.status === "skipped").length;
  const renamed = fileStatuses.filter((s) => s.status === "renamed").length;
  const processed = fileStatuses.filter((s) => s.status === "processed").length;
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

/**
 * Get the index of the current file being processed
 */
function getCurrentFileIndex(fileStatuses: FileStatus[]): number {
  return fileStatuses.findIndex((status) => status.status === "pending");
}

/**
 * Triage a single file
 */
async function triageFile(
  file: FileItem,
  fileIndex: number,
  totalFiles: number,
  clusterNum: number,
  totalClusters: number,
  fileStatuses: FileStatus[],
  originalCluster: Cluster,
  allClusters: Cluster[],
  currentClusterIndex: number,
): Promise<boolean | string> {
  const fileName = path.basename(file.filePath);
  const size = formatFileSize(file.size);
  const date = formatDate(file.lastModified);

  // Update current file status
  fileStatuses[fileIndex].status = "pending";

  // Note: The cluster summary will be shown after each operation to display the current state

  while (true) {
    // Show status summary at the top
    displayStatusSummary(fileStatuses);

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
          { name: "🔀 Split this cluster", value: "split", key: "p" },
          { name: "🚪 Quit triage tool", value: "quit", key: "q" },
          { name: "👁️  Preview this file", value: "preview", key: "v" },
        ],
      },
    ]);

    switch (action) {
      case "delete":
        await deleteFile(file.filePath);
        fileStatuses[fileIndex].status = "deleted";
        fileStatuses[fileIndex].action = "Deleted";
        console.log(chalk.red(`Deleted: ${fileName}`));

        // Show updated cluster state
        displayClusterSummary(originalCluster, fileStatuses);

        return true;

      case "next":
        fileStatuses[fileIndex].status = "skipped";
        fileStatuses[fileIndex].action = "Skipped";

        // Show updated cluster state
        displayClusterSummary(originalCluster, fileStatuses);

        return true;

      case "deleteAll":
        await deleteFile(file.filePath);
        fileStatuses[fileIndex].status = "deleted";
        fileStatuses[fileIndex].action = "Deleted";
        console.log(chalk.red(`Deleted: ${fileName}`));

        // Show updated cluster state
        displayClusterSummary(originalCluster, fileStatuses);

        return "deleteAllRemaining";

      case "skipCluster":
        // Mark remaining files as skipped
        for (let j = fileIndex; j < fileStatuses.length; j++) {
          if (fileStatuses[j].status === "pending") {
            fileStatuses[j].status = "skipped";
            fileStatuses[j].action = "Skipped";
          }
        }

        // Show updated cluster state
        displayClusterSummary(originalCluster, fileStatuses);

        return false;

      case "split":
        console.log(
          chalk.blue(`\n🔀 Splitting cluster ${originalCluster.id}...`),
        );
        return "split";

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
          await renameFile(file.filePath, newPath);

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

        // Show updated cluster state
        displayClusterSummary(originalCluster, fileStatuses);

        return true;

      case "info":
        await displayFileInfo(file.filePath);
        continue; // Stay on same file

      case "preview":
        if (process.platform === "darwin") {
          const qlmanage = spawn("qlmanage", ["-p", file.filePath]);
          qlmanage.on("close", (code) => {
            if (code !== 0) {
              console.error(
                chalk.red(
                  `Failed to preview file with qlmanage. Code: ${code}`,
                ),
              );
            }
          });
        } else {
          console.warn(
            chalk.yellow(
              `Preview functionality is only available on macOS (darwin).`,
            ),
          );
        }
        continue; // Stay on same file
    }
  }
}
