# File Triage Tool

A CLI tool for triaging files using OpenAI embeddings and HDBSCAN clustering.

## Features

- **Smart Clustering**: Uses OpenAI's text-embedding-3-small model (512 dimensions) to understand file content and cluster similar files together
- **Efficient Caching**: Caches embeddings in `.triage.json` files with file hashing to avoid redundant API calls
- **Interactive Interface**: Beautiful CLI interface with colors and prompts for triaging files
- **File Operations**: Delete, rename, skip files, or perform batch operations on clusters
- **File Analysis**: Show detailed file information using system tools like `file`, `identify`, and `head`

## Installation

```bash
npm install
npm run build
```

## Usage

Set your OpenAI API key:

```bash
export OPENAI_API_KEY="your-api-key-here"
```

Run the tool on one or more directories:

```bash
npm start ~/Downloads ~/Documents
# or
./dist/index.js ~/Downloads ~/Documents
```

### Options

- `-k, --openai-key <key>`: OpenAI API key (alternative to environment variable)
- `-c, --min-cluster-size <size>`: Minimum cluster size (default: 2)
- `--auto-cluster`: Automatically adjust clustering parameters for optimal results
- `--target-clusters <count>`: Target number of clusters for auto-clustering
- `--verbose-clustering`: Show detailed auto-clustering information

### Interactive Commands

For each file in each cluster, you can:

- 🗑️ **Delete this file** - Delete the current file
- ⏭️ **Skip to next file** - Move to the next file without changes
- 🗑️💥 **Delete this file and all remaining in cluster** - Delete current file and all remaining files in the cluster
- 🚫 **Skip to next cluster** - Move to the next cluster
- ✏️ **Rename this file** - Rename the current file
- ℹ️ **Show file info** - Display detailed information about the file

## How it Works

1. **File Scanning**: Scans all files in specified directories
2. **Embedding Generation**: Creates embeddings for each file using OpenAI's API (cached for efficiency)
3. **Clustering**: Groups similar files using HDBSCAN clustering algorithm with intelligent preprocessing
4. **Interactive Triage**: Presents clusters one by one for manual review and action

### Clustering Options

#### **Manual Clustering**

- **Min Cluster Size**: Prevent tiny clusters from forming

#### **Auto-Clustering (Recommended)**

Use `--auto-cluster` to automatically optimize clustering parameters:

- Automatically detects and fixes giant clusters (>30% of dataset)
- Adjusts parameters based on clustering quality
- Re-clusters up to 3 times for optimal results
- Provides detailed analysis and suggestions

**Example:**

```bash
# Basic auto-clustering
file-triage /path/to/files --auto-cluster

# With target cluster count
file-triage /path/to/files --auto-cluster --target-clusters 50

# Verbose mode to see adjustments
file-triage /path/to/files --auto-clustering --verbose-clustering
```

## Cache Files

The tool creates `.triage.json` files in each directory to cache embeddings. These files contain:

- File hashes to detect changes
- Generated embeddings
- File metadata (size, modification time)

You can safely delete these cache files if needed - they will be regenerated on the next run.

## Requirements

- Node.js 18+
- OpenAI API key
- Unix-like system (for file analysis tools)
