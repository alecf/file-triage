import { promises as fs } from "fs";
import path from "path";

/**
 * Delete a file from the filesystem
 */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    console.error(`Error deleting file ${filePath}:`, error);
    throw error;
  }
}

/**
 * Rename a file from oldPath to newPath
 */
export async function renameFile(
  oldPath: string,
  newPath: string,
): Promise<void> {
  try {
    // Check if target file already exists
    try {
      await fs.access(newPath);
      throw new Error(`File ${newPath} already exists`);
    } catch (error) {
      // File doesn't exist, which is what we want
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await fs.rename(oldPath, newPath);
  } catch (error) {
    console.error(`Error renaming file from ${oldPath} to ${newPath}:`, error);
    throw error;
  }
}

/**
 * Move a file from sourcePath to destinationDir
 */
export async function moveFile(
  sourcePath: string,
  destinationDir: string,
): Promise<string> {
  try {
    const fileName = path.basename(sourcePath);
    const destinationPath = path.join(destinationDir, fileName);

    // Ensure destination directory exists
    await fs.mkdir(destinationDir, { recursive: true });

    // Check if target file already exists
    try {
      await fs.access(destinationPath);
      throw new Error(`File ${destinationPath} already exists`);
    } catch (error) {
      // File doesn't exist, which is what we want
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await fs.rename(sourcePath, destinationPath);
    return destinationPath;
  } catch (error) {
    console.error(
      `Error moving file from ${sourcePath} to ${destinationDir}:`,
      error,
    );
    throw error;
  }
}

/**
 * Copy a file from sourcePath to destinationPath
 */
export async function copyFile(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  try {
    // Check if target file already exists
    try {
      await fs.access(destinationPath);
      throw new Error(`File ${destinationPath} already exists`);
    } catch (error) {
      // File doesn't exist, which is what we want
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await fs.copyFile(sourcePath, destinationPath);
  } catch (error) {
    console.error(
      `Error copying file from ${sourcePath} to ${destinationPath}:`,
      error,
    );
    throw error;
  }
}
