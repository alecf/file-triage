import inquirer from 'inquirer';
import chalk from 'chalk';
import path from 'path';
import * as readline from 'readline';
import { FileItem, Cluster, ClusteringService } from './clustering.js';
import { FileOperations } from './operations.js';
import { FileInfo } from './fileinfo.js';

export class InteractiveTriager {
  private operations: FileOperations;
  private fileInfo: FileInfo;

  constructor() {
    this.operations = new FileOperations();
    this.fileInfo = new FileInfo();
  }

  async triageClusters(clusters: Cluster[]): Promise<void> {
    console.log(chalk.blue.bold(`\nFound ${clusters.length} clusters to triage.\n`));

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      console.log(chalk.yellow.bold(`\n=== Cluster ${cluster.id} (${cluster.files.length} files) ===`));
      
      await this.triageCluster(cluster, i + 1, clusters.length);
    }

    console.log(chalk.green.bold('\nTriage complete!'));
  }

  private async triageCluster(cluster: Cluster, clusterNum: number, totalClusters: number): Promise<void> {
    this.displayClusterSummary(cluster);

    for (let i = 0; i < cluster.files.length; i++) {
      const file = cluster.files[i];
      const result = await this.triageFile(file, i + 1, cluster.files.length, clusterNum, totalClusters);
      
      if (result === 'deleteAllRemaining') {
        // Delete all remaining files in cluster
        for (let j = i + 1; j < cluster.files.length; j++) {
          const remainingFile = cluster.files[j];
          await this.operations.deleteFile(remainingFile.filePath);
          console.log(chalk.red(`Deleted: ${path.basename(remainingFile.filePath)}`));
        }
        console.log(chalk.cyan('Skipping to next cluster...\n'));
        break;
      } else if (!result) {
        console.log(chalk.cyan('Skipping to next cluster...\n'));
        break;
      }
    }
  }

  private displayClusterSummary(cluster: Cluster): void {
    console.log(chalk.gray('\nFiles in this cluster:'));
    
    // Calculate column widths for alignment
    const maxFileNameLength = Math.max(
      ...cluster.files.map(f => path.basename(f.filePath).length),
      20 // minimum width
    );
    const maxSizeLength = Math.max(
      ...cluster.files.map(f => ClusteringService.formatFileSize(f.size).length),
      8 // minimum width
    );
    
    cluster.files.forEach((file, index) => {
      const fileName = path.basename(file.filePath);
      const size = ClusteringService.formatFileSize(file.size);
      const date = ClusteringService.formatDate(file.lastModified);
      
      const paddedFileName = fileName.padEnd(maxFileNameLength);
      const paddedSize = size.padStart(maxSizeLength);
      
      console.log(`  ${chalk.gray((index + 1).toString().padStart(2))}. ${chalk.white.bold(paddedFileName)} ${chalk.cyan(paddedSize)} ${chalk.gray(date)}`);
    });
    console.log('');
  }

  private async triageFile(file: FileItem, fileNum: number, totalFiles: number, clusterNum: number, totalClusters: number): Promise<boolean | string> {
    const fileName = path.basename(file.filePath);
    const size = ClusteringService.formatFileSize(file.size);
    const date = ClusteringService.formatDate(file.lastModified);

    while (true) {
      console.log(chalk.blue(`\nCluster ${clusterNum}/${totalClusters}, File ${fileNum}/${totalFiles}`));
      console.log(chalk.white.bold(`File: ${fileName}`), chalk.gray(`(${size}, ${date})`));
      console.log(chalk.gray(`Path: ${file.filePath}`));
      
      const { action } = await inquirer.prompt([{
        type: 'rawlist',
        name: 'action',
        message: 'What would you like to do with this file?',
        choices: [
          { name: '🗑️  Delete this file', value: 'delete', key: 'd' },
          { name: '⏭️  Skip to next file', value: 'next', key: 'n' },
          { name: '🗑️💥 Delete this file and all remaining in cluster', value: 'deleteAll', key: 'a' },
          { name: '🚫 Skip to next cluster', value: 'skipCluster', key: 's' },
          { name: '✏️  Rename this file', value: 'rename', key: 'r' },
          { name: 'ℹ️  Show file info', value: 'info', key: 'i' },
          { name: '🚪 Quit triage tool', value: 'quit', key: 'q' }
        ]
      }]);
      
      switch (action) {
        case 'delete':
          await this.operations.deleteFile(file.filePath);
          console.log(chalk.red(`Deleted: ${fileName}`));
          return true;

        case 'next':
          return true;

        case 'deleteAll':
          await this.operations.deleteFile(file.filePath);
          console.log(chalk.red(`Deleted: ${fileName}`));
          
          // Delete all remaining files in this file's parent cluster by accessing it via the method parameter
          // We need to access the cluster files through the method that called this
          return 'deleteAllRemaining'; // Return special value to indicate delete all remaining

        case 'skipCluster':
          return false; // Skip to next cluster

        case 'quit':
          console.log(chalk.yellow('Exiting triage tool...'));
          process.exit(0);

        case 'rename':
          const { newName } = await inquirer.prompt([{
            type: 'input',
            name: 'newName',
            message: 'Enter new filename:',
            default: fileName
          }]);
          
          if (newName && newName !== fileName) {
            const newPath = path.join(path.dirname(file.filePath), newName);
            await this.operations.renameFile(file.filePath, newPath);
            console.log(chalk.green(`Renamed to: ${newName}`));
            file.filePath = newPath; // Update the file path
          }
          return true;

        case 'info':
          await this.fileInfo.displayFileInfo(file.filePath);
          continue; // Stay on same file
      }
    }
  }
}