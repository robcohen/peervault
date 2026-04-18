/**
 * Performance Benchmarks - Sync Performance
 *
 * Measures sync latency, throughput, and scalability.
 * Results are logged for tracking over time.
 */

import { delay } from "../../config";
import type { TestContext } from "../../lib/context";
import { assert, assertFileExists } from "../../lib/assertions";

/** Benchmark result */
interface BenchmarkResult {
  name: string;
  value: number;
  unit: string;
  samples?: number;
}

const results: BenchmarkResult[] = [];

function logBenchmark(result: BenchmarkResult): void {
  results.push(result);
  console.log(`  [BENCHMARK] ${result.name}: ${result.value.toFixed(2)} ${result.unit}`);
}

export default [
  {
    name: "Ensure sync sessions active",
    async fn(ctx: TestContext) {
      // The benchmark suite runs last, so sessions may be in error state
      // from previous tests. Try to recover first.

      // Clear any error sessions
      await Promise.allSettled([
        ctx.test.client.evaluate(`
          (async function() {
            const plugin = window.app?.plugins?.plugins?.["peervault"];
            if (plugin?.peerManager?.clearErrorSessions) {
              plugin.peerManager.clearErrorSessions();
            }
          })()
        `),
        ctx.test2.client.evaluate(`
          (async function() {
            const plugin = window.app?.plugins?.plugins?.["peervault"];
            if (plugin?.peerManager?.clearErrorSessions) {
              plugin.peerManager.clearErrorSessions();
            }
          })()
        `),
      ]);

      await delay(2000);

      // Try to ensure active sessions with retry
      let attempts = 0;
      let active1 = false;
      let active2 = false;

      while (attempts < 5 && (!active1 || !active2)) {
        try {
          active1 = await ctx.test.plugin.ensureActiveSessions();
        } catch {
          active1 = false;
        }
        try {
          active2 = await ctx.test2.plugin.ensureActiveSessions();
        } catch {
          active2 = false;
        }

        if (!active1 || !active2) {
          attempts++;
          if (attempts < 5) {
            // Force sync to trigger reconnection
            await Promise.allSettled([
              ctx.test.plugin.forceSync().catch(() => {}),
              ctx.test2.plugin.forceSync().catch(() => {}),
            ]);
            await delay(3000);
          }
        }
      }

      if (!active1 || !active2) {
        console.log("  Warning: Could not establish active sessions, benchmarks may be inaccurate");
        // Don't fail - let benchmarks run and record what they can
      }
    },
  },

  {
    name: "Benchmark: Single file sync latency",
    async fn(ctx: TestContext) {
      const samples: number[] = [];
      const iterations = 5;

      for (let i = 0; i < iterations; i++) {
        const filename = `bench-latency-${i}.md`;
        const content = `Benchmark file ${i}\nTimestamp: ${Date.now()}`;

        const startTime = Date.now();
        await ctx.test.vault.createFile(filename, content, true);
        await ctx.test2.sync.waitForFile(filename, { timeoutMs: 30000 });
        const endTime = Date.now();

        samples.push(endTime - startTime);

        // Cleanup
        await ctx.test.vault.deleteFile(filename);
        await delay(500);
      }

      const avgLatency = samples.reduce((a, b) => a + b, 0) / samples.length;
      const minLatency = Math.min(...samples);
      const maxLatency = Math.max(...samples);

      logBenchmark({ name: "Single file sync latency (avg)", value: avgLatency, unit: "ms", samples: iterations });
      logBenchmark({ name: "Single file sync latency (min)", value: minLatency, unit: "ms" });
      logBenchmark({ name: "Single file sync latency (max)", value: maxLatency, unit: "ms" });
    },
  },

  {
    name: "Benchmark: Batch file sync throughput",
    async fn(ctx: TestContext) {
      const batchSize = 20;
      const files: string[] = [];

      // Create batch of files
      const startTime = Date.now();
      for (let i = 0; i < batchSize; i++) {
        const filename = `bench-batch-${i}.md`;
        files.push(filename);
        await ctx.test.vault.createFile(filename, `Batch file ${i}\nContent here.`, true);
      }
      const createTime = Date.now() - startTime;

      // Wait for all to sync
      const syncStartTime = Date.now();
      for (const file of files) {
        await ctx.test2.sync.waitForFile(file, { timeoutMs: 60000 });
      }
      const syncTime = Date.now() - syncStartTime;

      const throughput = batchSize / (syncTime / 1000);
      logBenchmark({ name: "Batch creation time", value: createTime, unit: "ms", samples: batchSize });
      logBenchmark({ name: "Batch sync time", value: syncTime, unit: "ms", samples: batchSize });
      logBenchmark({ name: "Batch sync throughput", value: throughput, unit: "files/sec" });

      // Cleanup
      for (const file of files) {
        try { await ctx.test.vault.deleteFile(file); } catch {}
      }
      await delay(1000);
    },
  },

  {
    name: "Benchmark: Large file sync",
    async fn(ctx: TestContext) {
      const sizes = [10 * 1024, 100 * 1024, 500 * 1024]; // 10KB, 100KB, 500KB
      const sizeNames = ["10KB", "100KB", "500KB"];

      for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i];
        const sizeName = sizeNames[i];
        const filename = `bench-large-${sizeName}.md`;
        const content = "x".repeat(size);

        const startTime = Date.now();
        await ctx.test.vault.createFile(filename, content, true);
        await ctx.test2.sync.waitForFile(filename, { timeoutMs: 60000 });
        const endTime = Date.now();

        const latency = endTime - startTime;
        const throughputMBps = (size / 1024 / 1024) / (latency / 1000);

        logBenchmark({ name: `Large file sync (${sizeName})`, value: latency, unit: "ms" });
        logBenchmark({ name: `Large file throughput (${sizeName})`, value: throughputMBps, unit: "MB/s" });

        // Cleanup
        await ctx.test.vault.deleteFile(filename);
        await delay(500);
      }
    },
  },

  {
    name: "Benchmark: Concurrent modification merge",
    async fn(ctx: TestContext) {
      const filename = "bench-concurrent.md";
      const iterations = 3;
      const samples: number[] = [];

      // Helper to read file safely
      const readSafe = async (vault: typeof ctx.test.vault): Promise<string | null> => {
        try {
          return await vault.readFile(filename);
        } catch {
          return null;
        }
      };

      for (let iter = 0; iter < iterations; iter++) {
        // Create base file and wait for sync
        await ctx.test.vault.createFile(filename, "# Base Content\n\n", true);
        await ctx.test2.sync.waitForFile(filename, { timeoutMs: 30000 });
        await delay(500);

        // Make concurrent edits using modifyFile (file already exists)
        const startTime = Date.now();
        await Promise.allSettled([
          ctx.test.vault.modifyFile(filename, "# Base Content\n\nEdit from TEST\n"),
          ctx.test2.vault.modifyFile(filename, "# Base Content\n\nEdit from TEST2\n"),
        ]);

        // Wait for CRDT to converge
        let converged = false;
        const maxWait = 10000;
        const checkInterval = 200;
        let elapsed = 0;

        while (!converged && elapsed < maxWait) {
          const [content1, content2] = await Promise.all([
            readSafe(ctx.test.vault),
            readSafe(ctx.test2.vault),
          ]);

          if (content1 && content2 && content1 === content2 && content1.includes("Edit from")) {
            converged = true;
          } else {
            await delay(checkInterval);
            elapsed += checkInterval;
          }
        }

        const endTime = Date.now();
        samples.push(endTime - startTime);

        // Cleanup
        try {
          await ctx.test.vault.deleteFile(filename);
        } catch {}
        await delay(500);
      }

      const avgTime = samples.reduce((a, b) => a + b, 0) / samples.length;
      logBenchmark({ name: "Concurrent edit merge time (avg)", value: avgTime, unit: "ms", samples: iterations });
    },
  },

  {
    name: "Benchmark: CRDT convergence time",
    async fn(ctx: TestContext) {
      // Make a change and measure CRDT version convergence
      const filename = "bench-convergence.md";
      const content = `Convergence test ${Date.now()}`;

      await ctx.test.vault.createFile(filename, content, true);

      const startTime = Date.now();

      // Wait for CRDT versions to match
      let converged = false;
      const maxWait = 30000;
      const checkInterval = 100;
      let elapsed = 0;

      while (!converged && elapsed < maxWait) {
        const [v1, v2] = await Promise.all([
          ctx.test.plugin.getDocumentVersion(),
          ctx.test2.plugin.getDocumentVersion(),
        ]);

        if (v1 && v2 && v1 === v2) {
          converged = true;
        } else {
          await delay(checkInterval);
          elapsed += checkInterval;
        }
      }

      const convergenceTime = Date.now() - startTime;
      logBenchmark({ name: "CRDT convergence time", value: convergenceTime, unit: "ms" });

      // Cleanup
      await ctx.test.vault.deleteFile(filename);
    },
  },

  {
    name: "Print benchmark summary",
    async fn(ctx: TestContext) {
      console.log("\n============================================================");
      console.log("BENCHMARK SUMMARY");
      console.log("============================================================");

      for (const result of results) {
        const samplesInfo = result.samples ? ` (${result.samples} samples)` : "";
        console.log(`  ${result.name}: ${result.value.toFixed(2)} ${result.unit}${samplesInfo}`);
      }

      console.log("============================================================\n");
    },
  },
];
