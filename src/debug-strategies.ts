import { EmbeddingService } from "./embeddings";

async function debugStrategies() {
  const embeddingService = new EmbeddingService();

  try {
    console.log("=== Debugging Embedding Service ===\n");

    // 1. Check tool detection
    console.log("1. Checking tool detection...");
    const tools = await embeddingService.getAvailableTools();
    console.log(`Available tools: ${tools.length}`);
    tools.forEach((tool) => console.log(`  - ${tool}`));

    // 2. Check system capabilities
    console.log("\n2. Checking system capabilities...");
    const capabilities = await embeddingService.getSystemCapabilities();
    console.log(`Total tools: ${capabilities.totalTools}`);
    console.log(`Available tools: ${capabilities.availableTools.join(", ")}`);

    // 3. Test with a real file if provided
    const testFile = process.argv[2];
    if (testFile) {
      console.log(`\n3. Debugging file: ${testFile}`);
      try {
        const debugInfo = await embeddingService.debugFileProcessing(testFile);
        console.log("\nFile Analysis:");
        console.log(`  Name: ${debugInfo.fileInfo.name}`);
        console.log(`  Extension: ${debugInfo.extension}`);
        console.log(`  Size: ${debugInfo.fileInfo.size}`);
        console.log(`  Detected Type: ${debugInfo.detectedType}`);
        console.log(`  Is Text: ${debugInfo.fileInfo.isTextFile}`);
        console.log(`  Is Image: ${debugInfo.fileInfo.isImageFile}`);
        console.log(`  Is Audio: ${debugInfo.fileInfo.isAudioFile}`);
        console.log(`  Is Video: ${debugInfo.fileInfo.isVideoFile}`);
        console.log(`  Is Archive: ${debugInfo.fileInfo.isArchiveFile}`);
        console.log(`  Is Office: ${debugInfo.fileInfo.isOfficeFile}`);

        console.log(`\nStrategies found: ${debugInfo.strategies.length}`);
        debugInfo.strategies.forEach((strategy, index) => {
          console.log(`  ${index + 1}. ${strategy.name} (${strategy.command})`);
        });

        // 4. Try to get embedding
        console.log("\n4. Attempting to get embedding...");
        const result = await embeddingService.getFileEmbedding(testFile);
        console.log(`  Strategy used: ${result.strategy}`);
        console.log(`  Content length: ${result.content.length}`);
        console.log(
          `  Content preview: ${result.content.substring(0, 200)}...`,
        );
      } catch (error) {
        console.error(
          `Error processing file: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      console.log(
        "\n3. No test file provided. Usage: npm run debug <filepath>",
      );
      console.log("   Example: npm run debug ./test-document.pdf");
    }
  } catch (error) {
    console.error(
      "Debug failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

// Run the debug function
if (require.main === module) {
  debugStrategies();
}

export { debugStrategies };
