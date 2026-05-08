export * from "./commands.js";
export * from "./phases.js";

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  console.log("Popcorn Queue worker phase scaffold ready. Connect queue storage and integrations in the next implementation slice.");
}
