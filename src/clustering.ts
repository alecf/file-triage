import { HDBSCAN } from "./hdbscan";

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
}

export interface AutoClusteringOptions {
  maxIterations?: number;
  targetClusterCount?: number; // Target number of clusters (optional)
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
 * Cluster files using HDBSCAN algorithm with improved parameters
 */
export async function clusterFiles(
  files: FileItem[],
  options: ClusteringOptions | number = {},
): Promise<Cluster[]> {
  // Handle legacy number parameter
  const opts: ClusteringOptions =
    typeof options === "number" ? { minClusterSize: options } : options;

  const { minClusterSize = 2, minSamples = Math.min(minClusterSize, 3) } = opts;

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
    metric: "cosine",
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

  // Sort clusters by size (largest first) and then by cluster ID
  clusters.sort((a, b) => {
    if (a.files.length !== b.files.length) {
      return b.files.length - a.files.length;
    }
    return a.id - b.id;
  });

  return clusters;
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
        `Consider increasing --min-cluster-size from 2 to 4 or 5.`,
    );
  }

  if (sizeDistribution["51-100"] > 0) {
    suggestions.push(
      `Found ${sizeDistribution["51-100"]} large clusters (51-100 files). ` +
        `Consider increasing --min-cluster-size from 2 to 3 or 4.`,
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
        `Consider increasing --min-cluster-size from 2 to 3 or 4.`,
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
    maxIterations = 5, // Increased from 3 to 5 for more refinement
    targetClusterCount,
    minClusterSizePercent = 0.02, // 2% of total files
    enableVerbose = false,
  } = autoOptions;

  const totalFiles = files.length;
  let currentOptions: ClusteringOptions = {
    minClusterSize: 2,
    ...initialOptions,
  };

  const adjustments: string[] = [];
  let bestClusters: Cluster[] = [];
  let bestScore = 0;
  let bestClusterCount = 0;

  if (enableVerbose) {
    console.log(`🔄 Auto-clustering: Starting with ${totalFiles} files`);
    console.log(`📊 Target: Balanced clusters with optimal min-cluster-size`);
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

    // Show cluster count analysis
    const clusterRatio = clusters.length / totalFiles;
    console.log(
      `📊 Cluster ratio: ${(clusterRatio * 100).toFixed(1)}% (${
        clusters.length
      }/${totalFiles})`,
    );

    // Show largest cluster info
    const largestCluster = Math.max(...analysis.clusterSizes);
    const largestClusterPercent = ((largestCluster / totalFiles) * 100).toFixed(
      1,
    );
    console.log(
      `📊 Largest cluster: ${largestCluster} files (${largestClusterPercent}%)`,
    );

    // Keep track of best result
    if (score > bestScore) {
      bestScore = score;
      bestClusters = clusters;
      bestClusterCount = clusters.length; // Track best cluster count
    }

    // Check if we should stop (good enough clustering)
    if (score > 0.85) {
      // Increased from 0.8 to 0.85 for better quality
      if (enableVerbose) {
        console.log(
          `✅ Clustering quality score ${score.toFixed(
            3,
          )} is good enough, stopping`,
        );
      }
      break;
    }

    // Additional stopping criteria: if we've found a good result and improvements are minimal
    if (bestScore > 0.8 && score < bestScore + 0.02) {
      if (enableVerbose) {
        console.log(
          `✅ Found good clustering (${bestScore.toFixed(
            3,
          )}) with minimal improvement, stopping`,
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

    // Show final insights
    const finalClusterRatio = bestClusters.length / totalFiles;
    const finalLargestCluster = Math.max(...finalAnalysis.clusterSizes);
    const finalLargestClusterPercent = (
      (finalLargestCluster / totalFiles) *
      100
    ).toFixed(1);

    console.log(
      `📊 Final cluster ratio: ${(finalClusterRatio * 100).toFixed(1)}%`,
    );
    console.log(
      `📊 Final largest cluster: ${finalLargestCluster} files (${finalLargestClusterPercent}%)`,
    );

    if (parseFloat(finalLargestClusterPercent) > 15) {
      console.log(
        `⚠️  Note: Large cluster detected (${finalLargestClusterPercent}%) - this may indicate natural grouping in your data`,
      );
    }
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
    score += countScore * 0.25; // Reduced weight from 0.3 to 0.25
  }

  // Score based on size distribution balance - prefer more balanced distributions
  const idealSizes = [0.15, 0.25, 0.3, 0.2, 0.08, 0.02]; // Adjusted ideal distribution
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
  score += distributionScore * 0.35; // Increased weight from 0.4 to 0.35

  // Score based on avoiding extreme sizes - but be more lenient with large clusters
  const maxClusterPercent = Math.max(...clusterSizes) / totalFiles;
  const sizePenalty = Math.max(0, maxClusterPercent - 0.2) * 2; // Penalty for clusters >20% (increased from 10%)
  score += Math.max(0, 1 - sizePenalty) * 0.25; // Reduced weight from 0.3 to 0.25

  // New: Score based on cluster count balance - prefer moderate number of clusters
  const clusterCountRatio = totalClusters / totalFiles;
  let countBalanceScore = 0;
  if (clusterCountRatio < 0.01) {
    // Too few clusters (less than 1% of files)
    countBalanceScore = 0.3;
  } else if (clusterCountRatio < 0.05) {
    // Good range (1-5% of files)
    countBalanceScore = 1.0;
  } else if (clusterCountRatio < 0.1) {
    // Acceptable range (5-10% of files)
    countBalanceScore = 0.7;
  } else {
    // Too many clusters (more than 10% of files)
    countBalanceScore = 0.4;
  }
  score += countBalanceScore * 0.15; // New weight for cluster count balance

  return Math.min(1, score);
}

/**
 * Adjust clustering parameters based on analysis results
 */
function adjustClusteringParameters(
  currentOptions: ClusteringOptions,
  analysis: ReturnType<typeof analyzeClusteringResults>,
  totalFiles: number,
  minClusterSizePercent: number,
  targetClusterCount?: number,
): ClusteringOptions {
  const newOptions = { ...currentOptions };
  const { totalClusters, sizeDistribution, clusterSizes } = analysis;

  // Rule 2: Adjust min cluster size based on overall file count and cluster distribution
  const smallClusterCount = sizeDistribution["1-5"] + sizeDistribution["6-10"];
  const smallClusterPercent = smallClusterCount / totalClusters;

  if (smallClusterPercent > 0.6 && totalFiles > 100) {
    // Too many small clusters in large datasets
    newOptions.minClusterSize = Math.min(
      8, // Increased from 5 to 8
      (newOptions.minClusterSize || 2) + 2, // More aggressive increase
    );
  } else if (smallClusterPercent < 0.2 && totalFiles > 200) {
    // Too few small clusters in large datasets - might be over-clustering
    newOptions.minClusterSize = Math.max(
      2,
      (newOptions.minClusterSize || 2) - 1,
    );
  }

  // Rule 3: Smart minClusterSize adjustment based on cluster count and target
  if (targetClusterCount) {
    const currentRatio = totalClusters / totalFiles;
    const targetRatio = targetClusterCount / totalFiles;

    if (currentRatio > targetRatio * 1.3) {
      // Too many clusters, increase minClusterSize to reduce cluster count
      newOptions.minClusterSize = Math.min(
        10, // Maximum reasonable minClusterSize
        (newOptions.minClusterSize || 2) + 1,
      );
    } else if (currentRatio < targetRatio * 0.7) {
      // Too few clusters, decrease minClusterSize to increase cluster count
      newOptions.minClusterSize = Math.max(
        2, // Minimum reasonable minClusterSize
        (newOptions.minClusterSize || 2) - 1,
      );
    }
  }

  // Rule 5: Fine-tune based on overall clustering quality
  const clusterCountRatio = totalClusters / totalFiles;

  if (clusterCountRatio < 0.005 && totalFiles > 500) {
    // Very few clusters in large dataset - likely under-clustering
    // Reduce minClusterSize to encourage more clusters
    newOptions.minClusterSize = Math.max(
      2,
      (newOptions.minClusterSize || 2) - 1,
    );
  } else if (clusterCountRatio > 0.15 && totalFiles > 200) {
    // Too many clusters in large dataset - likely over-clustering
    // Increase minClusterSize to reduce cluster count
    newOptions.minClusterSize = Math.min(
      8,
      (newOptions.minClusterSize || 2) + 1,
    );
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

  return changes.join(", ");
}

/**
 * Split a single cluster into multiple sub-clusters using auto-clustering
 * This is useful during interactive triage when a user wants to break down a large cluster
 */
export async function splitCluster(
  cluster: Cluster,
  autoOptions: AutoClusteringOptions = {},
): Promise<Cluster[]> {
  if (cluster.files.length < 4) {
    // If cluster is too small, return it unchanged
    return [cluster];
  }

  console.log(
    `\n🔄 Splitting cluster ${cluster.id} (${cluster.files.length} files) into sub-clusters...`,
  );

  // Apply auto-clustering to just this cluster's files
  const result = await autoClusterFiles(
    cluster.files,
    {
      minClusterSize: 2, // Start with minimum size for splitting
    },
    {
      ...autoOptions,
      maxIterations: 3, // Fewer iterations for splitting
      enableVerbose: false, // Less verbose output for splitting
    },
  );

  // Assign new IDs to the sub-clusters
  const subClusters = result.clusters.map((subCluster, index) => ({
    ...subCluster,
    id: cluster.id * 1000 + index, // Use a large multiplier to avoid ID conflicts
  }));

  console.log(
    `✅ Split cluster ${cluster.id} into ${subClusters.length} sub-clusters`,
  );

  return subClusters;
}
