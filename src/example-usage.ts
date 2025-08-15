import { EmbeddingService } from "./embeddings";

async function demonstrateEmbeddingService() {
  const embeddingService = new EmbeddingService();

  try {
    // Get system capabilities
    console.log("=== System Capabilities ===");
    const capabilities = await embeddingService.getSystemCapabilities();
    console.log(`Total available tools: ${capabilities.totalTools}`);
    console.log("Available tools:", capabilities.availableTools);
    console.log("\nSupported file types:");
    capabilities.supportedFileTypes.forEach((type) => console.log(`- ${type}`));

    // Get available tools
    console.log("\n=== Available Tools ===");
    const availableTools = await embeddingService.getAvailableTools();
    console.log("Available tools:", availableTools);

    // Example: Add a custom tool
    console.log("\n=== Adding Custom Tool ===");
    embeddingService.registerCustomTool({
      name: "custom-pdf",
      command: "pdftotext",
      args: ["FILEPATH", "-", "-layout"],
      description: "Custom PDF text extraction with layout preservation",
    });
    console.log("Custom tool added");

    // Check if specific tools are available
    console.log("\n=== Tool Availability Check ===");
    const hasPdfInfo = await embeddingService.isToolAvailable("pdfinfo");
    const hasImageMagick = await embeddingService.isToolAvailable("identify");
    console.log(`pdfinfo available: ${hasPdfInfo}`);
    console.log(`ImageMagick available: ${hasImageMagick}`);

    // Example: Process different file types
    console.log("\n=== File Processing Examples ===");

    // This would be a real file path in actual usage
    const exampleFiles = [
      "document.pdf",
      "image.jpg",
      "audio.mp3",
      "archive.zip",
      "document.docx",
    ];

    for (const file of exampleFiles) {
      try {
        console.log(`\nProcessing: ${file}`);
        // In real usage, you would call:
        // const result = await embeddingService.getFileEmbedding(file);
        // console.log(`Strategy used: ${result.strategy}`);
        // console.log(`Embedding dimensions: ${result.embedding.length}`);
      } catch (error) {
        console.log(`Error processing ${file}: ${error}`);
      }
    }

    // Debug a specific file (replace with actual file path)
    console.log("\n=== Debug File Processing ===");
    try {
      // Replace 'test-file.txt' with an actual file path to debug
      const debugInfo = await embeddingService.debugFileProcessing(
        "test-file.txt",
      );
      console.log("Debug info:", JSON.stringify(debugInfo, null, 2));
    } catch (error) {
      console.log(
        "Debug failed (file probably doesn't exist):",
        error instanceof Error ? error.message : String(error),
      );
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

// Run the demonstration
if (require.main === module) {
  demonstrateEmbeddingService();
}

export { demonstrateEmbeddingService };
