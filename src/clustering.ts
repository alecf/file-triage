import { HDBSCAN } from "hdbscan-ts";

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

export interface ClusteringOptions {
  minClusterSize?: number;
  minSamples?: number;
  similarityThreshold?: number; // Cosine similarity threshold (0-1)
  maxClusterSize?: number; // Maximum files per cluster
}

export interface AutoClusteringOptions {
  maxIterations?: number;
  targetClusterCount?: number; // Target number of clusters (optional)
  maxClusterSizePercent?: number; // Max cluster size as % of total files
  minClusterSizePercent?: number; // Min cluster size as % of total files
  enableVerbose?: boolean; // Show detailed auto-adjustment info
}

export interface AutoClusteringResult {
  clusters: Cluster[];
  iterations: number;
  finalOptions: ClusteringOptions;
  adjustments: string[];
  analysis: ReturnType<typeof analyzeClusteringResults>;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Calculate cosine distance between two vectors
 */
function calculateCosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

/**
 * Calculate cosine similarity between two vectors
 */
function calculateCosineSimilarity(a: number[], b: number[]): number {
  return cosineSimilarity(a, b);
}

/**
 * Find the index of the least similar file in a list of files
 */
function findLeastSimilarFile(
  newFile: FileItem,
  existingFiles: FileItem[],
): number {
  let leastSimilarIndex = -1;
  let minSimilarity = 1; // Start with a high similarity

  for (let i = 0; i < existingFiles.length; i++) {
    const similarity = calculateCosineSimilarity(
      newFile.embedding,
      existingFiles[i].embedding,
    );
    if (similarity < minSimilarity) {
      minSimilarity = similarity;
      leastSimilarIndex = i;
    }
  }
  return leastSimilarIndex;
}

/**
 * Cluster files using HDBSCAN algorithm with improved parameters
 */
export async function clusterFiles(
  files: FileItem[],
  options: ClusteringOptions | number = {},
): Promise<Cluster[]> {
  // Handle legacy number parameter
  const opts: ClusteringOptions =
    typeof options === "number" ? { minClusterSize: options } : options;

  const {
    minClusterSize = 2,
    minSamples = Math.min(minClusterSize, 3),
    similarityThreshold = 0.95,
    maxClusterSize = 50,
  } = opts;

  if (files.length < minClusterSize) {
    // If we have fewer files than minimum cluster size, put them all in one cluster
    return [
      {
        id: 0,
        files: files,
      },
    ];
  }

  // Extract embeddings matrix
  const embeddings = files.map((f) => f.embedding);

  // Run HDBSCAN clustering with more parameters
  const hdbscan = new HDBSCAN({
    minClusterSize: minClusterSize,
    minSamples: minSamples,
    // Add more HDBSCAN parameters if the library supports them
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
      centroid: calculateCentroid(clusterFiles.map((f) => f.embedding)),
    });
  });

  // Post-process: Split clusters that exceed maxClusterSize
  const finalClusters: Cluster[] = [];
  let nextClusterId = Math.max(...clusters.map((c) => c.id)) + 1;
  let splitCount = 0;

  for (const cluster of clusters) {
    if (cluster.files.length <= maxClusterSize) {
      finalClusters.push(cluster);
    } else {
      // Split large cluster into smaller sub-clusters
      console.log(
        `✂️  Splitting large cluster ${cluster.id} (${cluster.files.length} files) into sub-clusters (max size: ${maxClusterSize})`,
      );
      const subClusters = splitLargeCluster(
        cluster,
        maxClusterSize,
        nextClusterId,
      );
      finalClusters.push(...subClusters);
      nextClusterId += subClusters.length;
      splitCount++;
    }
  }

  if (splitCount > 0) {
    console.log(
      `✅ Split ${splitCount} large clusters to respect maxClusterSize of ${maxClusterSize}`,
    );
  }

  // Sort clusters by size (largest first) and then by cluster ID
  finalClusters.sort((a, b) => {
    if (a.files.length !== b.files.length) {
      return b.files.length - a.files.length;
    }
    return a.id - b.id;
  });

  // Final validation: ensure no cluster exceeds maxClusterSize
  const oversizedClusters = finalClusters.filter(
    (c) => c.files.length > maxClusterSize,
  );
  if (oversizedClusters.length > 0) {
    console.warn(
      `⚠️  Warning: ${oversizedClusters.length} clusters still exceed maxClusterSize of ${maxClusterSize}:`,
    );
    oversizedClusters.forEach((c) => {
      console.warn(`   Cluster ${c.id}: ${c.files.length} files`);
    });
  }

  return finalClusters;
}

/**
 * Calculate the centroid (mean) of a set of embeddings
 */
function calculateCentroid(embeddings: number[][]): number[] {
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

/**
 * Split a large cluster into smaller sub-clusters that respect maxClusterSize
 */
function splitLargeCluster(
  cluster: Cluster,
  maxClusterSize: number,
  startClusterId: number,
): Cluster[] {
  const files = cluster.files;
  const subClusters: Cluster[] = [];
  let currentClusterId = startClusterId;

  // If cluster is small enough, return it as is
  if (files.length <= maxClusterSize) {
    return [
      {
        ...cluster,
        id: currentClusterId,
      },
    ];
  }

  // Use a more sophisticated approach: try to maintain similarity within sub-clusters
  const numSubClusters = Math.ceil(files.length / maxClusterSize);

  if (numSubClusters === 1) {
    // Just one sub-cluster needed
    return [
      {
        ...cluster,
        id: currentClusterId,
      },
    ];
  }

  // For multiple sub-clusters, try to group similar files together
  // Start with the first file as a seed for the first sub-cluster
  const subClusterFiles: FileItem[][] = [];
  const usedFiles = new Set<number>();

  // Initialize sub-clusters with the most representative files
  for (let i = 0; i < numSubClusters; i++) {
    subClusterFiles[i] = [];
  }

  // Find the most representative file for each sub-cluster (most central to the cluster)
  const centroid =
    cluster.centroid || calculateCentroid(files.map((f) => f.embedding));
  const distances = files.map((file, index) => ({
    index,
    distance: calculateCosineDistance(file.embedding, centroid),
  }));

  // Sort by distance to centroid (closest first)
  distances.sort((a, b) => a.distance - b.distance);

  // Assign the most central files as seeds for each sub-cluster
  for (let i = 0; i < numSubClusters; i++) {
    const seedIndex = distances[i].index;
    subClusterFiles[i].push(files[seedIndex]);
    usedFiles.add(seedIndex);
  }

  // Distribute remaining files to the most similar sub-cluster
  for (let i = 0; i < files.length; i++) {
    if (usedFiles.has(i)) continue;

    const file = files[i];
    let bestSubCluster = 0;
    let bestSimilarity = -1;

    // Find the sub-cluster with the highest average similarity
    for (let j = 0; j < numSubClusters; j++) {
      if (subClusterFiles[j].length >= maxClusterSize) continue;

      const avgSimilarity =
        subClusterFiles[j].reduce((sum, subFile) => {
          return (
            sum + calculateCosineSimilarity(file.embedding, subFile.embedding)
          );
        }, 0) / subClusterFiles[j].length;

      if (avgSimilarity > bestSimilarity) {
        bestSimilarity = avgSimilarity;
        bestSubCluster = j;
      }
    }

    // Add file to the best sub-cluster
    if (subClusterFiles[bestSubCluster].length < maxClusterSize) {
      subClusterFiles[bestSubCluster].push(file);
    } else {
      // If all sub-clusters are full, find the one with the most similar files
      let bestFit = 0;
      let bestFitSimilarity = -1;

      for (let j = 0; j < numSubClusters; j++) {
        const avgSimilarity =
          subClusterFiles[j].reduce((sum, subFile) => {
            return (
              sum + calculateCosineSimilarity(file.embedding, subFile.embedding)
            );
          }, 0) / subClusterFiles[j].length;

        if (avgSimilarity > bestFitSimilarity) {
          bestFitSimilarity = avgSimilarity;
          bestFit = j;
        }
      }

      // Replace the least similar file in the best-fit sub-cluster
      const leastSimilarIndex = findLeastSimilarFile(
        file,
        subClusterFiles[bestFit],
      );
      if (leastSimilarIndex !== -1) {
        subClusterFiles[bestFit][leastSimilarIndex] = file;
      }
    }
  }

  // Create sub-cluster objects
  for (let i = 0; i < numSubClusters; i++) {
    if (subClusterFiles[i].length > 0) {
      subClusters.push({
        id: currentClusterId++,
        files: subClusterFiles[i],
        centroid: calculateCentroid(subClusterFiles[i].map((f) => f.embedding)),
      });
    }
  }

  return subClusters;
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)}${units[unitIndex]}`;
}

/**
 * Format date in localized format
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString() + " " + date.toLocaleTimeString();
}

/**
 * Analyze clustering results and suggest better parameters
 */
export function analyzeClusteringResults(clusters: Cluster[]): {
  totalClusters: number;
  totalFiles: number;
  clusterSizes: number[];
  sizeDistribution: Record<string, number>;
  suggestions: string[];
} {
  const totalClusters = clusters.length;
  const totalFiles = clusters.reduce((sum, c) => sum + c.files.length, 0);
  const clusterSizes = clusters
    .map((c) => c.files.length)
    .sort((a, b) => b - a);

  // Analyze size distribution
  const sizeDistribution: Record<string, number> = {
    "1-5": 0,
    "6-10": 0,
    "11-25": 0,
    "26-50": 0,
    "51-100": 0,
    "100+": 0,
  };

  clusterSizes.forEach((size) => {
    if (size <= 5) sizeDistribution["1-5"]++;
    else if (size <= 10) sizeDistribution["6-10"]++;
    else if (size <= 25) sizeDistribution["11-25"]++;
    else if (size <= 50) sizeDistribution["26-50"]++;
    else if (size <= 100) sizeDistribution["51-100"]++;
    else sizeDistribution["100+"]++;
  });

  // Generate suggestions
  const suggestions: string[] = [];

  if (sizeDistribution["100+"] > 0) {
    suggestions.push(
      `Found ${sizeDistribution["100+"]} very large clusters (>100 files). ` +
        `Consider reducing --similarity-threshold from 0.95 to 0.90 or 0.85.`,
    );
  }

  if (sizeDistribution["51-100"] > 0) {
    suggestions.push(
      `Found ${sizeDistribution["51-100"]} large clusters (51-100 files). ` +
        `Consider reducing --max-cluster-size from 50 to 25.`,
    );
  }

  if (sizeDistribution["1-5"] > totalClusters * 0.7) {
    suggestions.push(
      `More than 70% of clusters are very small (1-5 files). ` +
        `Consider increasing --min-cluster-size from 2 to 3 or 4.`,
    );
  }

  if (totalClusters > totalFiles * 0.3) {
    suggestions.push(
      `Very high number of clusters relative to files. ` +
        `Consider increasing --similarity-threshold from 0.95 to 0.97.`,
    );
  }

  if (suggestions.length === 0) {
    suggestions.push("Clustering results look well-balanced!");
  }

  return {
    totalClusters,
    totalFiles,
    clusterSizes,
    sizeDistribution,
    suggestions,
  };
}

/**
 * Automatically cluster files with parameter adjustment
 * Re-clusters up to 3 times, adjusting parameters based on results
 */
export async function autoClusterFiles(
  files: FileItem[],
  initialOptions: ClusteringOptions = {},
  autoOptions: AutoClusteringOptions = {},
): Promise<AutoClusteringResult> {
  const {
    maxIterations = 3,
    targetClusterCount,
    maxClusterSizePercent = 0.05, // Reduced from 0.1 to 0.05 (5% of total files) for very strict clustering
    minClusterSizePercent = 0.02, // 2% of total files
    enableVerbose = false,
  } = autoOptions;

  const totalFiles = files.length;
  let currentOptions: ClusteringOptions = {
    minClusterSize: 2,
    similarityThreshold: 0.95,
    maxClusterSize: 20, // Reduced from 25 to 20 for very strict initial clustering
    ...initialOptions,
  };

  // Apply a hard cap on maxClusterSize based on the percentage limit
  const hardMaxClusterSize = Math.max(
    20,
    Math.floor(totalFiles * maxClusterSizePercent),
  ); // Reduced minimum from 25 to 20
  currentOptions.maxClusterSize = Math.min(
    currentOptions.maxClusterSize || 20,
    hardMaxClusterSize,
  );

  const adjustments: string[] = [];
  let bestClusters: Cluster[] = [];
  let bestScore = 0;

  if (enableVerbose) {
    console.log(`🔄 Auto-clustering: Starting with ${totalFiles} files`);
    console.log(
      `📊 Target: Balanced clusters with max ${Math.round(
        maxClusterSizePercent * 100,
      )}% per cluster (hard cap: ${hardMaxClusterSize} files)`,
    );
  }

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Always show current parameters and results
    console.log(`\n🔄 Iteration ${iteration}/${maxIterations}`);
    console.log(`📋 Parameters:`, currentOptions);

    // Cluster with current options
    const clusters = await clusterFiles(files, currentOptions);
    const analysis = analyzeClusteringResults(clusters);

    // Calculate clustering quality score
    const score = calculateClusteringScore(
      analysis,
      totalFiles,
      targetClusterCount,
    );

    // Always show results
    console.log(
      `📊 Results: ${clusters.length} clusters, Score: ${score.toFixed(3)}`,
    );
    console.log(`📈 Size distribution:`, analysis.sizeDistribution);

    // Keep track of best result
    if (score > bestScore) {
      bestScore = score;
      bestClusters = clusters;
    }

    // Check if we should stop (good enough clustering)
    if (score > 0.8) {
      if (enableVerbose) {
        console.log(
          `✅ Clustering quality score ${score.toFixed(
            3,
          )} is good enough, stopping`,
        );
      }
      break;
    }

    // If this is the last iteration, don't adjust parameters
    if (iteration === maxIterations) {
      if (enableVerbose) {
        console.log(`🛑 Reached maximum iterations, using best result`);
      }
      break;
    }

    // Analyze and adjust parameters
    const newOptions = adjustClusteringParameters(
      currentOptions,
      analysis,
      totalFiles,
      maxClusterSizePercent,
      minClusterSizePercent,
      targetClusterCount,
    );

    // Check if parameters actually changed
    const hasChanges =
      JSON.stringify(newOptions) !== JSON.stringify(currentOptions);
    if (!hasChanges) {
      if (enableVerbose) {
        console.log(`🔄 No parameter changes needed, stopping`);
      }
      break;
    }

    // Apply adjustments
    const adjustment = describeParameterChanges(currentOptions, newOptions);
    adjustments.push(`Iteration ${iteration}: ${adjustment}`);

    if (enableVerbose) {
      console.log(`🔧 Adjusting: ${adjustment}`);
    }

    currentOptions = newOptions;
  }

  // Return best result
  const finalAnalysis = analyzeClusteringResults(bestClusters);

  if (enableVerbose) {
    console.log(
      `\n🎯 Final result: ${
        bestClusters.length
      } clusters with score ${bestScore.toFixed(3)}`,
    );
    console.log(`📊 Final size distribution:`, finalAnalysis.sizeDistribution);
  }

  return {
    clusters: bestClusters,
    iterations: Math.min(maxIterations, adjustments.length + 1),
    finalOptions: currentOptions,
    adjustments,
    analysis: finalAnalysis,
  };
}

/**
 * Calculate a quality score for clustering results
 * Higher score = better clustering
 */
function calculateClusteringScore(
  analysis: ReturnType<typeof analyzeClusteringResults>,
  totalFiles: number,
  targetClusterCount?: number,
): number {
  let score = 0;
  const { totalClusters, sizeDistribution, clusterSizes } = analysis;

  // Score based on cluster count (if target specified)
  if (targetClusterCount) {
    const countDiff = Math.abs(totalClusters - targetClusterCount);
    const countScore = Math.max(0, 1 - countDiff / targetClusterCount);
    score += countScore * 0.3;
  }

  // Score based on size distribution balance
  const idealSizes = [0.1, 0.2, 0.3, 0.2, 0.15, 0.05]; // Ideal distribution percentages
  const actualSizes = [
    sizeDistribution["1-5"] / totalClusters,
    sizeDistribution["6-10"] / totalClusters,
    sizeDistribution["11-25"] / totalClusters,
    sizeDistribution["26-50"] / totalClusters,
    sizeDistribution["51-100"] / totalClusters,
    sizeDistribution["100+"] / totalClusters,
  ];

  let distributionScore = 0;
  for (let i = 0; i < idealSizes.length; i++) {
    distributionScore += Math.max(
      0,
      1 - Math.abs(actualSizes[i] - idealSizes[i]),
    );
  }
  distributionScore /= idealSizes.length;
  score += distributionScore * 0.4;

  // Score based on avoiding extreme sizes
  const maxClusterPercent = Math.max(...clusterSizes) / totalFiles;
  const sizePenalty = Math.max(0, maxClusterPercent - 0.05) * 6; // Penalty for clusters >5% (reduced from 10%) and increased multiplier from 4 to 6
  score += Math.max(0, 1 - sizePenalty) * 0.3;

  return Math.min(1, score);
}

/**
 * Adjust clustering parameters based on analysis results
 */
function adjustClusteringParameters(
  currentOptions: ClusteringOptions,
  analysis: ReturnType<typeof analyzeClusteringResults>,
  totalFiles: number,
  maxClusterSizePercent: number,
  minClusterSizePercent: number,
  targetClusterCount?: number,
): ClusteringOptions {
  const newOptions = { ...currentOptions };
  const { totalClusters, sizeDistribution, clusterSizes } = analysis;

  // Rule 1: Reduce max cluster size if one cluster is >5% of dataset (reduced from 10%)
  const maxClusterSize = Math.max(...clusterSizes);
  const maxClusterPercent = maxClusterSize / totalFiles;

  if (maxClusterPercent > maxClusterSizePercent) {
    // More aggressive reduction for giant clusters
    const reductionFactor = maxClusterPercent > 0.15 ? 0.3 : 0.5; // More aggressive than before (was 0.3 and 0.6)
    const newMaxSize = Math.max(
      5,
      Math.floor(maxClusterSize * reductionFactor),
    );
    newOptions.maxClusterSize = newMaxSize;

    // Also reduce similarity threshold to be more strict
    if (newOptions.similarityThreshold) {
      const thresholdReduction = maxClusterPercent > 0.15 ? 0.2 : 0.1; // More aggressive threshold reduction
      newOptions.similarityThreshold = Math.max(
        0.7,
        newOptions.similarityThreshold - thresholdReduction,
      );
    }
  }

  // Rule 2: Increase min cluster size if many small clusters
  const smallClusterCount = sizeDistribution["1-5"] + sizeDistribution["6-10"];
  const smallClusterPercent = smallClusterCount / totalClusters;

  if (smallClusterPercent > 0.7 && smallClusterCount > 30) {
    newOptions.minClusterSize = Math.min(
      10,
      (newOptions.minClusterSize || 2) + 1,
    );
  }

  // Rule 3: Adjust similarity threshold based on cluster count
  if (targetClusterCount) {
    const currentRatio = totalClusters / totalFiles;
    const targetRatio = targetClusterCount / totalFiles;

    if (currentRatio > targetRatio * 1.5) {
      // Too many clusters, increase similarity threshold
      newOptions.similarityThreshold = Math.min(
        0.98,
        (newOptions.similarityThreshold || 0.95) + 0.02,
      );
    } else if (currentRatio < targetRatio * 0.5) {
      // Too few clusters, decrease similarity threshold
      newOptions.similarityThreshold = Math.max(
        0.8,
        (newOptions.similarityThreshold || 0.95) - 0.03,
      );
    }
  }

  // Rule 4: Adjust max cluster size based on overall distribution
  const largeClusterCount =
    sizeDistribution["51-100"] + sizeDistribution["100+"];
  if (largeClusterCount > 0 && newOptions.maxClusterSize) {
    const avgClusterSize = totalFiles / totalClusters;
    if (avgClusterSize > newOptions.maxClusterSize * 0.8) {
      // Clusters are too large on average
      newOptions.maxClusterSize = Math.max(
        10,
        Math.floor(newOptions.maxClusterSize * 0.8),
      );
    }
  }

  // Rule 5: Fine-tune based on size distribution
  if (sizeDistribution["100+"] > 0) {
    // Very large clusters exist, be more aggressive
    newOptions.similarityThreshold = Math.max(
      0.8,
      (newOptions.similarityThreshold || 0.95) - 0.05,
    );
    newOptions.maxClusterSize = Math.max(
      10,
      Math.floor((newOptions.maxClusterSize || 50) * 0.6),
    );
  }

  // Rule 6: Immediate action for extremely large clusters (>10% of total files, reduced from 20%)
  if (maxClusterPercent > 0.1) {
    // Emergency reduction for extremely large clusters
    newOptions.maxClusterSize = Math.max(5, Math.floor(maxClusterSize * 0.25)); // More aggressive reduction (was 0.3)
    if (newOptions.similarityThreshold) {
      newOptions.similarityThreshold = Math.max(
        0.7,
        newOptions.similarityThreshold - 0.25,
      ); // More aggressive threshold reduction (was 0.2)
    }
  }

  return newOptions;
}

/**
 * Describe parameter changes in human-readable format
 */
function describeParameterChanges(
  oldOptions: ClusteringOptions,
  newOptions: ClusteringOptions,
): string {
  const changes: string[] = [];

  if (oldOptions.minClusterSize !== newOptions.minClusterSize) {
    changes.push(
      `min-cluster-size: ${oldOptions.minClusterSize} → ${newOptions.minClusterSize}`,
    );
  }

  if (oldOptions.similarityThreshold !== newOptions.similarityThreshold) {
    changes.push(
      `similarity-threshold: ${oldOptions.similarityThreshold} → ${newOptions.similarityThreshold}`,
    );
  }

  if (oldOptions.maxClusterSize !== newOptions.maxClusterSize) {
    changes.push(
      `max-cluster-size: ${oldOptions.maxClusterSize} → ${newOptions.maxClusterSize}`,
    );
  }

  return changes.join(", ");
}
