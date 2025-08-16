# File Triage Architecture

A CLI tool for triaging files using embeddings and clustering to help organize and categorize large collections of files.

## Overview

File Triage processes directories of files by:

1. **Extracting meaningful content** from various file types using command-line tools
2. **Generating embeddings** using OpenAI's API for semantic understanding
3. **Clustering similar files** using HDBSCAN algorithm
4. **Providing interactive interface** for manual triage and organization

## Core Components

### 1. **Main CLI (`src/index.ts`)**

- **Entry point** for the application
- **Progress indicators** using `ora` for real-time feedback
- **Directory processing** coordination
- **Command-line argument parsing** with Commander.js
- **Progress control** via `--no-progress` flag

**Key Features:**

- Shows progress across multiple directories
- Displays file processing status (cached vs. new embeddings)
- Tracks errors and success counts
- Provides overall completion summaries

### 2. **Embedding Service (`src/embeddings.ts`)**

- **Content extraction** from various file types
- **Dynamic tool detection** for available command-line utilities
- **Fallback strategies** for unknown file types
- **OpenAI integration** for embedding generation

**Supported File Types:**

- **Text files**: Programming languages, markdown, config files, etc.
- **PDFs**: `pdfinfo` for metadata, `pdftotext` for content
- **Images**: ImageMagick/GraphicsMagick for analysis, ExifTool for metadata
- **Audio/Video**: FFprobe for format/codec info
- **Archives**: `unzip`/`tar` for contents listing
- **Office documents**: `antiword`/`catdoc` for text extraction
- **Binary files**: `strings`, `hexdump`, `od` for fallback analysis

**Tool Detection:**

- Automatically detects available command-line tools
- Uses `command -v` for cross-platform compatibility
- Caches tool availability for performance
- Supports custom tool registration

### 3. **Caching Layer (`src/cache.ts`)**

- **Persistent storage** of embeddings and strategies
- **File-based caching** using JSON storage
- **Hash-based invalidation** for file changes
- **Strategy tracking** for debugging and optimization

**Cache Structure:**

```json
{
  "file_hash": "sha256_hash",
  "embedding": [0.1, 0.2, ...],
  "strategy": "pdfinfo",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### 4. **Clustering Service (`src/clustering.ts`)**

- **HDBSCAN algorithm** for density-based clustering
- **Dimensionality reduction** for large embedding sets
- **Configurable cluster sizes** via `--min-cluster-size`
- **Similarity-based grouping** of semantically related files

**Clustering Process:**

1. Normalize embeddings to unit vectors
2. Apply HDBSCAN with configurable parameters
3. Group files by cluster membership
4. Provide cluster statistics and file lists

### 5. **Interactive Interface (`src/interactive.js`)**

- **Terminal-based UI** for cluster exploration
- **File preview** and navigation
- **Cluster management** (rename, merge, split)
- **Export capabilities** for organized results

## Data Flow

```
Directories → File Discovery → Content Extraction → Embedding Generation → Clustering → Interactive Triage
     ↓              ↓              ↓                    ↓              ↓           ↓
  Progress      Filtering      Tool Selection      OpenAI API    HDBSCAN     User Actions
  Indicators   (Hidden/Dirs)   (PDF/Image/etc)    (512 dim)    Algorithm   (Rename/Move)
```

## File Processing Pipeline

### Phase 1: Discovery & Filtering

- Scan directories for valid files
- Skip hidden files, directories, and empty files
- Count and validate files for processing

### Phase 2: Content Extraction

- Check cache for existing embeddings
- If not cached, determine file type using `file` command
- Select appropriate extraction strategy based on file type
- Execute command-line tools to extract content
- Fall back to basic metadata if all strategies fail

### Phase 3: Embedding Generation

- Send extracted content to OpenAI API
- Generate 512-dimensional embeddings
- Cache results with strategy information

### Phase 4: Clustering

- Normalize all embeddings
- Apply HDBSCAN clustering algorithm
- Group files by similarity
- Provide cluster statistics

### Phase 5: Interactive Triage

- Present clusters to user
- Allow exploration and organization
- Support file operations and cluster management

## Command-Line Interface

### Basic Usage

```bash
file-triage <directories...> [options]
```

### Options

- `-k, --openai-key <key>`: OpenAI API key
- `-c, --min-cluster-size <size>`: Minimum cluster size (default: 2)
- `--no-progress`: Disable progress indicators
- `--fast-cache`: Use fast cache validation (faster but less reliable)

### Examples

```bash
# Process single directory
file-triage ./documents

# Process multiple directories
file-triage ./documents ./images ./downloads

# Custom cluster size
file-triage -c 3 ./documents

# Disable progress indicators
file-triage --no-progress ./documents

# Use fast cache mode for maximum performance
file-triage --fast-cache ./documents
```

## Progress Indicators

### Directory Level

```
🔍 Processing directories...
Processing directory 1/3: documents
Processing directory 2/3: images
Processing directory 3/3: downloads
✅ Completed processing 3 directories
```

### File Level

```
📁 Processing files...
Processing document.pdf (1/15)
Getting embedding for document.pdf...
✓ Cached embedding for document.pdf (pdfinfo)
✅ Processed 15 files (8 cached, 7 new)
```

## Error Handling

- **Graceful degradation** when tools are unavailable
- **Fallback strategies** for unknown file types
- **Error tracking** without stopping processing
- **Detailed error messages** for debugging
- **Cache invalidation** on file changes

## Performance Considerations

- **Tool detection** happens once per service instance
- **Command timeouts** prevent hanging operations
- **Content truncation** keeps embeddings within token limits
- **Large file skipping** (>10MB) with basic metadata
- **Efficient caching** reduces API calls
- **Progress indicators** can be disabled for maximum performance

### Cache Performance Optimizations

The caching system includes several performance optimizations:

- **Batch validation**: Multiple cache entries are validated simultaneously to reduce I/O operations
- **Lazy validation**: Cache entries are only validated when first accessed
- **Smart hashing**: Small files (<1MB) use fast in-memory hashing, large files use streaming
- **Fast mode**: Optional `--fast-cache` flag uses stat-based validation only (faster but less reliable)
- **Validation caching**: Once validated, cache entries are marked to avoid repeated checks
- **Stale cleanup**: Automatic removal of invalid cache entries to prevent bloat

### Performance Modes

- **Accurate mode** (default): Full file hash validation for reliability
- **Fast mode** (`--fast-cache`): Stat-based validation only for maximum speed
- **Hybrid approach**: Small files use fast validation, large files use hash validation when needed

## Dependencies

### Core Dependencies

- `openai`: OpenAI API integration
- `hdbscan-ts`: Clustering algorithm
- `commander`: CLI argument parsing
- `chalk`: Colored terminal output
- `ora`: Progress indicators
- `inquirer`: Interactive prompts

### Optional System Tools

- `file`: File type detection
- `pdfinfo`/`pdftotext`: PDF processing
- `identify`/`gm`: Image analysis
- `ffprobe`: Media file analysis
- `exiftool`: Metadata extraction
- `unzip`/`tar`: Archive handling

## Extensibility

### Adding New File Types

1. Define file extension patterns
2. Add tool detection and execution
3. Register in the tool detection system
4. Update file type classification methods

### Custom Tools

```typescript
embeddingService.registerCustomTool({
  name: "custom-extractor",
  command: "my-tool",
  args: ["FILEPATH", "arg1"],
  description: "Custom content extraction",
});
```

### Clustering Parameters

- Adjust `min-cluster-size` for different granularity
- Modify HDBSCAN parameters for clustering behavior
- Implement custom similarity metrics

## Use Cases

- **Document organization**: Group similar documents by content
- **Media management**: Categorize images, audio, and video files
- **Code organization**: Group related source code files
- **Archive triage**: Organize large collections of mixed file types
- **Research organization**: Categorize research papers and materials

## Architecture Principles

1. **Separation of concerns**: Each service has a single responsibility
2. **Progressive enhancement**: Graceful fallbacks for missing tools
3. **User feedback**: Rich progress indicators and status updates
4. **Performance optimization**: Caching, timeouts, and efficient algorithms
5. **Extensibility**: Easy addition of new file types and tools
6. **Error resilience**: Continue processing despite individual failures
