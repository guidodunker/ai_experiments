import { OpenRouter } from "@openrouter/sdk";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error(
    "OPENROUTER_API_KEY is not set. Run with: node --experimental-strip-types --env-file=.env.example scripts/embed.ts",
  );
  process.exit(1);
}

const openrouter = new OpenRouter({ apiKey });

const input = process.argv.slice(2).join(" ") || "Your text string goes here";

const response = await openrouter.embeddings.generate({
  requestBody: {
    model: "qwen/qwen3-embedding-8b",
    input,
    encodingFormat: "float",
  },
});

// generate() is typed as CreateEmbeddingsResponseBody | string — narrow before use.
if (typeof response === "string") {
  throw new Error(`Unexpected raw response: ${response}`);
}

const first = response.data[0];
if (!first) {
  throw new Error("Response contained no embeddings");
}

// embedding is number[] for encodingFormat "float", string for "base64".
const vector = first.embedding;
if (typeof vector === "string") {
  throw new Error("Expected a float vector, got a base64 string");
}

console.log(`model:      ${response.model}`);
console.log(`dimensions: ${vector.length}`);
console.log(`first 8:    ${JSON.stringify(vector.slice(0, 8))}`);
console.log(`usage:      ${JSON.stringify(response.usage ?? {})}`);
