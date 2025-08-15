# Enhanced Embedding Service Features

The `EmbeddingService` class has been enhanced with dynamic strategies for extracting information from various file types using command line tools.

## Features

### Automatic Tool Detection

The service automatically detects which command line tools are available on your system and uses them accordingly.

### Supported File Types

#### Text Files

- Programming languages (JS, TS, Python, Java, C++, etc.)
- Markdown, HTML, CSS, XML, YAML, TOML
- Configuration files, logs, CSV, SQL
- Shell scripts, Dockerfiles

#### PDF Documents

- **pdfinfo**: Extracts metadata (title, author, pages, etc.)
- **pdftotext**: Extracts text content

#### Images

- **ImageMagick (identify)**: Detailed image information
- **GraphicsMagick (gm identify)**: Alternative image analysis
- **ExifTool**: Metadata extraction (EXIF, IPTC, etc.)

#### Audio Files

- **FFprobe**: Audio format, duration, bitrate, codec info
- **ExifTool**: Audio metadata

#### Video Files

- **FFprobe**: Video format, resolution, duration, codec info
- **ExifTool**: Video metadata

#### Archives

- **unzip**: ZIP file contents listing
- **tar**: TAR archive contents listing

#### Office Documents

- **antiword**: Microsoft Word document text extraction
- **catdoc**: Alternative Word document extraction
- **xlsx2csv**: Excel spreadsheet conversion

#### Binary Files (Fallback)

- **strings**: Extract readable strings from binary files
- **hexdump**: Hexadecimal dump of file headers
- **od**: Octal dump of file headers

## Usage

### Basic Usage

```typescript
import { EmbeddingService } from "./embeddings";

const embeddingService = new EmbeddingService();

// Get embedding for any file type
const result = await embeddingService.getFileEmbedding("document.pdf");
console.log(`Strategy used: ${result.strategy}`);
console.log(`Embedding: ${result.embedding.length} dimensions`);
```

### Check System Capabilities

```typescript
// Get overview of what the system can do
const capabilities = await embeddingService.getSystemCapabilities();
console.log(`Available tools: ${capabilities.availableTools}`);
console.log(`Supported file types: ${capabilities.supportedFileTypes}`);
```

### Tool Management

```typescript
// Check if a specific tool is available
const hasPdfInfo = await embeddingService.isToolAvailable("pdfinfo");

// Get list of available tools
const tools = await embeddingService.getAvailableTools();

// Add custom tools
embeddingService.registerCustomTool({
  name: "custom-pdf",
  command: "pdftotext",
  args: ["FILEPATH", "-", "-layout"],
  description: "Custom PDF extraction with layout preservation",
});

// Remove tools
embeddingService.removeTool("custom-pdf");
```

## Installation Requirements

### Required Tools

- **file**: File type detection (usually pre-installed)
- **strings**: String extraction (usually pre-installed)

### Optional Tools (Install as needed)

#### PDF Processing

```bash
# macOS
brew install poppler

# Ubuntu/Debian
sudo apt-get install poppler-utils

# CentOS/RHEL
sudo yum install poppler-utils
```

#### Image Processing

```bash
# ImageMagick
brew install imagemagick  # macOS
sudo apt-get install imagemagick  # Ubuntu/Debian

# GraphicsMagick
brew install graphicsmagick  # macOS
sudo apt-get install graphicsmagick  # Ubuntu/Debian

# ExifTool
brew install exiftool  # macOS
sudo apt-get install exiftool  # Ubuntu/Debian
```

#### Media Processing

```bash
# FFmpeg (includes ffprobe)
brew install ffmpeg  # macOS
sudo apt-get install ffmpeg  # Ubuntu/Debian
```

#### Office Document Processing

```bash
# antiword
brew install antiword  # macOS
sudo apt-get install antiword  # Ubuntu/Debian

# catdoc
brew install catdoc  # macOS
sudo apt-get install catdoc  # Ubuntu/Debian

# xlsx2csv
pip install xlsx2csv  # Python package
```

## How It Works

1. **File Type Detection**: Uses the `file` command to determine file type
2. **Strategy Selection**: Chooses appropriate tools based on file type
3. **Content Extraction**: Executes command line tools to extract information
4. **Fallback Handling**: Falls back to basic metadata if tools fail
5. **Content Truncation**: Ensures output fits within token limits

## Error Handling

- Tools that fail are silently skipped
- Fallback strategies ensure some information is always extracted
- Timeouts prevent hanging on problematic files
- Buffer limits prevent memory issues with large outputs

## Performance Considerations

- Tool detection happens once per service instance
- Commands have 10-second timeouts
- Output is truncated to 6000 characters to stay within token limits
- Large files (>10MB) are skipped with basic metadata

## Extending the System

### Adding New Tools

```typescript
embeddingService.registerCustomTool({
  name: "my-tool",
  command: "my-command",
  args: ["FILEPATH", "arg1", "arg2"],
  description: "Description of what this tool does",
});
```

### Custom File Type Detection

You can extend the file type detection by modifying the `isImageFile`, `isAudioFile`, etc. methods, or by adding new detection methods.

## Example Output

### PDF File

```
Strategy: pdfinfo
Content: PDF metadata and information:
Title:          Sample Document
Author:         John Doe
Subject:        Sample PDF
Creator:        Microsoft Word
Producer:       Microsoft Word
CreationDate:   Mon Jan 01 12:00:00 2024
ModDate:        Mon Jan 01 12:00:00 2024
Tagged:         no
Form:           none
Pages:          5
Encrypted:      no
Page size:      612 x 792 pts (letter)
File size:      245 KB
Optimized:      no
PDF version:    1.4
```

### Image File

```
Strategy: identify
Content: ImageMagick image information:
Image: image.jpg
  Format: JPEG (Joint Photographic Experts Group JFIF format)
  Mime type: image/jpeg
  Class: DirectClass
  Geometry: 1920x1080+0+0
  Resolution: 72x72
  Print size: 26.6667x15
  Units: PixelsPerInch
  Colorspace: sRGB
  Type: TrueColor
  Base type: Undefined
  Endianness: Undefined
  Depth: 8-bit
  Channel depth:
    Red: 8-bit
    Green: 8-bit
    Blue: 8-bit
  Channel statistics:
    Pixels: 2073600
    Red:
      min: 0  (0)
      max: 255 (1)
      mean: 127.5 (0.5)
      standard deviation: 73.9 (0.29)
      kurtosis: -1.2
      skewness: 0
    Green:
      min: 0  (0)
      max: 255 (1)
      mean: 127.5 (0.5)
      standard deviation: 73.9 (0.29)
      kurtosis: -1.2
      skewness: 0
    Blue:
      min: 0  (0)
      max: 255 (1)
      mean: 127.5 (0.5)
      standard deviation: 73.9 (0.29)
      kurtosis: -1.2
      skewness: 0
  Image statistics:
    Overall:
      min: 0  (0)
      max: 255 (1)
      mean: 127.5 (0.5)
      standard deviation: 73.9 (0.29)
      kurtosis: -1.2
      skewness: 0
  Rendering intent: Perceptual
  Gamma: 0.454545
  Chromaticity:
    red primary: (0.64,0.33)
    green primary: (0.3,0.6)
    blue primary: (0.15,0.06)
    white point: (0.3127,0.329)
  Background color: white
  Border color: sRGB(223,223,223)
  Matte color: grey74
  Transparent color: black
  Interlace: None
  Intensity: Undefined
  Compose: Over
  Page geometry: 1920x1080+0+0
  Dispose: Undefined
  Iterations: 0
  Compression: JPEG
  Quality: 92
  Orientation: Undefined
  Properties:
    date:create: 2024-01-01T12:00:00+00:00
    date:modify: 2024-01-01T12:00:00+00:00
    jpeg:colorspace: 2
    jpeg:sampling-factor: 2x2,1x1,1x1
    signature: 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
  Artifacts:
    filename: image.jpg
    verbose: true
  Tainted: False
  Filesize: 245KB
  Number pixels: 2.074M
  Pixels per second: 0B
  User time: 0.000u
  Elapsed time: 0:01.000
  Version: ImageMagick 7.1.0-47 Q16-HDRI x86_64 2023-01-01 https://imagemagick.org
```
