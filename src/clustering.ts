import { HDBSCAN } from 'hdbscan-ts';

export interface FileItem {
  filePath: string;
  embedding: number[];
  size: number;
  lastModified: Date;
}

export interface Cluster {
  id: number;
  files: FileItem[];
  centroid?: number[];
}

export class ClusteringService {
  static async clusterFiles(files: FileItem[], minClusterSize: number = 2): Promise<Cluster[]> {
    if (files.length < minClusterSize) {
      // If we have fewer files than minimum cluster size, put them all in one cluster
      return [{
        id: 0,
        files: files
      }];
    }

    // Extract embeddings matrix
    const embeddings = files.map(f => f.embedding);
    
    // Run HDBSCAN clustering
    const hdbscan = new HDBSCAN({
      minClusterSize: minClusterSize,
      minSamples: Math.min(minClusterSize, 3)
    });
    hdbscan.fit(embeddings);
    const labels = hdbscan.labels_;
    
    // Group files by cluster labels
    const clusterMap = new Map<number, FileItem[]>();
    
    labels.forEach((label: number, index: number) => {
      const clusterId = label === -1 ? -1 : label; // -1 is noise/outliers
      if (!clusterMap.has(clusterId)) {
        clusterMap.set(clusterId, []);
      }
      clusterMap.get(clusterId)!.push(files[index]);
    });

    // Convert to cluster array
    const clusters: Cluster[] = [];
    
    clusterMap.forEach((clusterFiles, clusterId) => {
      clusters.push({
        id: clusterId,
        files: clusterFiles,
        centroid: this.calculateCentroid(clusterFiles.map(f => f.embedding))
      });
    });

    // Sort clusters by size (largest first) and then by cluster ID
    clusters.sort((a, b) => {
      if (a.files.length !== b.files.length) {
        return b.files.length - a.files.length;
      }
      return a.id - b.id;
    });

    return clusters;
  }

  private static calculateCentroid(embeddings: number[][]): number[] {
    if (embeddings.length === 0) return [];
    
    const dimensions = embeddings[0].length;
    const centroid = new Array(dimensions).fill(0);
    
    for (const embedding of embeddings) {
      for (let i = 0; i < dimensions; i++) {
        centroid[i] += embedding[i];
      }
    }
    
    for (let i = 0; i < dimensions; i++) {
      centroid[i] /= embeddings.length;
    }
    
    return centroid;
  }

  static formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)}${units[unitIndex]}`;
  }

  static formatDate(date: Date): string {
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  }
}