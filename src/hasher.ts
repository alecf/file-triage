import { createHash } from "crypto";
import { createReadStream, promises as fs } from "fs";

export class FileHasher {
  static async hashFile(filePath: string): Promise<string> {
    try {
      const stats = await fs.stat(filePath);

      // For small files (< 1MB), read the entire file at once (faster)
      if (stats.size < 1024 * 1024) {
        const fileBuffer = await fs.readFile(filePath);
        const hash = createHash("md5");
        hash.update(fileBuffer);
        return hash.digest("hex");
      }

      // For larger files, use streaming to avoid memory issues
      return new Promise((resolve, reject) => {
        const hash = createHash("md5");
        const stream = createReadStream(filePath);

        stream.on("data", (data) => {
          hash.update(data);
        });

        stream.on("end", () => {
          resolve(hash.digest("hex"));
        });

        stream.on("error", (error) => {
          reject(error);
        });
      });
    } catch (error) {
      throw new Error(`Failed to hash file ${filePath}: ${error}`);
    }
  }

  /**
   * Fast hash using only file stats (modification time + size)
   * This is much faster than reading file content but less reliable
   * Use only when speed is critical and some false positives are acceptable
   */
  static async fastHashFile(filePath: string): Promise<string> {
    try {
      const stats = await fs.stat(filePath);
      const hash = createHash("md5");
      hash.update(filePath);
      hash.update(stats.mtime.getTime().toString());
      hash.update(stats.size.toString());
      return hash.digest("hex");
    } catch (error) {
      throw new Error(`Failed to fast hash file ${filePath}: ${error}`);
    }
  }
}
