/**
 * Scaled Performance Benchmarks
 *
 * Measures sync performance across N-client mesh networks.
 * Tracks latency, throughput, and convergence times.
 */

import type { ScaledTestContext, ClientContext } from "../../lib/scaled-context";
import { delay } from "../../config";

interface ScaledTestDef {
  name: string;
  fn: (ctx: ScaledTestContext) => Promise<void>;
  skip?: boolean;
  minClients?: number;
}

/** Benchmark result */
interface BenchmarkResult {
  name: string;
  value: number;
  unit: string;
  clients?: number;
  samples?: number;
}

const results: BenchmarkResult[] = [];

function logBenchmark(result: BenchmarkResult): void {
  results.push(result);
  const clientInfo = result.clients ? ` [${result.clients} clients]` : "";
  const samplesInfo = result.samples ? ` (${result.samples} samples)` : "";
  console.log(`  [BENCHMARK] ${result.name}${clientInfo}: ${result.value.toFixed(2)} ${result.unit}${samplesInfo}`);
}

const tests: ScaledTestDef[] = [
  {
    name: "Ensure all sessions are live",
    minClients: 2,
    fn: async (ctx) => {
      // Wait for sessions to be established
      const maxWait = 30000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWait) {
        let allLive = true;

        for (const client of ctx.clients) {
          const sessions = await client.plugin.getActiveSessions();
          const liveSessions = sessions.filter((s: { state: string }) => s.state === "live");
          if (liveSessions.length < ctx.numClients - 1) {
            allLive = false;
            break;
          }
        }

        if (allLive) {
          console.log("  All sessions live - ready for benchmarks");
          return;
        }

        await delay(500);
      }

      console.log("  Warning: Not all sessions are live, benchmarks may be affected");
    },
  },

  {
    name: "Benchmark: Single file sync latency (hub to all)",
    minClients: 2,
    fn: async (ctx) => {
      const samples: number[] = [];
      const iterations = 5;
      const hub = ctx.clients[0];
      const spokes = ctx.clients.slice(1);

      for (let i = 0; i < iterations; i++) {
        const filename = `bench-latency-${i}.md`;
        const content = `Benchmark file ${i}\nTimestamp: ${Date.now()}`;

        const startTime = Date.now();
        await hub.vault.createFile(filename, content);

        // Wait for all spokes to receive the file
        await Promise.all(
          spokes.map((spoke) => spoke.sync.waitForFile(filename, { timeoutMs: 30000 }))
        );
        const endTime = Date.now();

        samples.push(endTime - startTime);

        // Cleanup
        await hub.vault.deleteFile(filename);
        await delay(300);
      }

      const avgLatency = samples.reduce((a, b) => a + b, 0) / samples.length;
      const minLatency = Math.min(...samples);
      const maxLatency = Math.max(...samples);

      logBenchmark({ name: "Hub-to-all sync latency (avg)", value: avgLatency, unit: "ms", clients: ctx.numClients, samples: iterations });
      logBenchmark({ name: "Hub-to-all sync latency (min)", value: minLatency, unit: "ms", clients: ctx.numClients });
      logBenchmark({ name: "Hub-to-all sync latency (max)", value: maxLatency, unit: "ms", clients: ctx.numClients });
    },
  },

  {
    name: "Benchmark: Edge-to-edge sync latency (via mesh)",
    minClients: 3,
    fn: async (ctx) => {
      const samples: number[] = [];
      const iterations = 3;

      // Test sync from last client to first (longest path in hub-and-spoke)
      const sender = ctx.clients[ctx.numClients - 1];
      const receiver = ctx.clients[1]; // Another spoke, not the hub

      for (let i = 0; i < iterations; i++) {
        const filename = `bench-edge-${i}.md`;
        const content = `Edge test ${i} from ${sender.name}`;

        const startTime = Date.now();
        await sender.vault.createFile(filename, content);
        await receiver.sync.waitForFile(filename, { timeoutMs: 30000 });
        const endTime = Date.now();

        samples.push(endTime - startTime);

        // Cleanup via sender
        await sender.vault.deleteFile(filename);
        await delay(300);
      }

      const avgLatency = samples.reduce((a, b) => a + b, 0) / samples.length;
      logBenchmark({ name: "Edge-to-edge sync latency (avg)", value: avgLatency, unit: "ms", clients: ctx.numClients, samples: iterations });
    },
  },

  {
    name: "Benchmark: Mesh convergence time",
    minClients: 2,
    fn: async (ctx) => {
      const filename = `bench-convergence-${Date.now()}.md`;
      const content = `Convergence test\nClients: ${ctx.numClients}`;

      await ctx.clients[0].vault.createFile(filename, content);

      const startTime = Date.now();
      const converged = await ctx.waitForConvergence(60000);
      const convergenceTime = Date.now() - startTime;

      if (converged) {
        logBenchmark({ name: "Mesh convergence time", value: convergenceTime, unit: "ms", clients: ctx.numClients });
      } else {
        console.log(`  Warning: Convergence timed out after ${convergenceTime}ms`);
      }

      // Cleanup
      await ctx.clients[0].vault.deleteFile(filename);
      await ctx.waitForConvergence(10000);
    },
  },

  {
    name: "Benchmark: Parallel file creation throughput",
    minClients: 2,
    fn: async (ctx) => {
      // Each client creates files simultaneously
      const filesPerClient = Math.max(3, Math.floor(15 / ctx.numClients));
      const testPrefix = `bench-throughput-${Date.now()}`;
      const allFiles: string[] = [];

      const startTime = Date.now();

      // Parallel creation from all clients
      const createPromises = ctx.clients.map(async (client, clientIdx) => {
        const clientFiles: string[] = [];
        for (let i = 0; i < filesPerClient; i++) {
          const file = `${testPrefix}-c${clientIdx}-f${i}.md`;
          await client.vault.createFile(file, `Throughput test ${clientIdx}-${i}`);
          clientFiles.push(file);
          await delay(30); // Small delay to avoid overwhelming
        }
        return clientFiles;
      });

      const filesByClient = await Promise.all(createPromises);
      for (const files of filesByClient) {
        allFiles.push(...files);
      }

      const createTime = Date.now() - startTime;

      // Wait for convergence
      const syncStartTime = Date.now();
      const converged = await ctx.waitForConvergence(120000);
      const syncTime = Date.now() - syncStartTime;

      const totalFiles = allFiles.length;
      const throughput = totalFiles / (syncTime / 1000);

      logBenchmark({ name: "Parallel creation time", value: createTime, unit: "ms", clients: ctx.numClients, samples: totalFiles });
      logBenchmark({ name: "Mesh sync time", value: syncTime, unit: "ms", clients: ctx.numClients, samples: totalFiles });
      logBenchmark({ name: "Mesh throughput", value: throughput, unit: "files/sec", clients: ctx.numClients });

      // Cleanup
      for (const file of allFiles) {
        await ctx.clients[0].vault.deleteFile(file).catch(() => {});
      }
      await ctx.waitForConvergence(30000);
    },
  },

  {
    name: "Benchmark: Large file sync across mesh",
    minClients: 2,
    fn: async (ctx) => {
      const sizes = [10 * 1024, 50 * 1024, 100 * 1024]; // 10KB, 50KB, 100KB
      const sizeNames = ["10KB", "50KB", "100KB"];
      const hub = ctx.clients[0];

      for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i];
        const sizeName = sizeNames[i];
        const filename = `bench-large-${sizeName}.md`;
        const content = "x".repeat(size);

        const startTime = Date.now();
        await hub.vault.createFile(filename, content);

        // Wait for all clients to receive
        const converged = await ctx.waitForConvergence(60000);
        const endTime = Date.now();

        if (converged) {
          const latency = endTime - startTime;
          const throughputMBps = (size / 1024 / 1024) / (latency / 1000);

          logBenchmark({ name: `Large file sync (${sizeName})`, value: latency, unit: "ms", clients: ctx.numClients });
          logBenchmark({ name: `Large file throughput (${sizeName})`, value: throughputMBps, unit: "MB/s", clients: ctx.numClients });
        } else {
          console.log(`  Warning: ${sizeName} file sync did not converge`);
        }

        // Cleanup
        await hub.vault.deleteFile(filename);
        await delay(500);
      }
    },
  },

  {
    name: "Benchmark: Concurrent modification merge time",
    minClients: 3,
    fn: async (ctx) => {
      const filename = "bench-concurrent-merge.md";
      const iterations = 3;
      const samples: number[] = [];

      for (let iter = 0; iter < iterations; iter++) {
        // Create base file
        await ctx.clients[0].vault.createFile(filename, "# Base Content\n\n");
        await ctx.waitForConvergence(30000);

        // All clients make concurrent edits
        const startTime = Date.now();
        await Promise.allSettled(
          ctx.clients.map((client, idx) =>
            client.vault.modifyFile(filename, `# Base Content\n\nEdit from ${client.name}\n`)
          )
        );

        // Wait for CRDT to converge
        const converged = await ctx.waitForConvergence(30000);
        const endTime = Date.now();

        if (converged) {
          samples.push(endTime - startTime);
        }

        // Cleanup
        await ctx.clients[0].vault.deleteFile(filename);
        await delay(500);
      }

      if (samples.length > 0) {
        const avgTime = samples.reduce((a, b) => a + b, 0) / samples.length;
        logBenchmark({ name: "Concurrent merge time (avg)", value: avgTime, unit: "ms", clients: ctx.numClients, samples: samples.length });
      }
    },
  },

  {
    name: "Benchmark: Session overhead per client",
    minClients: 2,
    fn: async (ctx) => {
      // Measure memory/session count scaling
      let totalSessions = 0;

      for (const client of ctx.clients) {
        const sessions = await client.plugin.getActiveSessions();
        totalSessions += sessions.length;
      }

      // In a mesh, each client has N-1 sessions
      const expectedSessions = ctx.numClients * (ctx.numClients - 1);
      const sessionEfficiency = (totalSessions / expectedSessions) * 100;

      logBenchmark({ name: "Total active sessions", value: totalSessions, unit: "sessions", clients: ctx.numClients });
      logBenchmark({ name: "Session efficiency", value: sessionEfficiency, unit: "%", clients: ctx.numClients });
    },
  },

  {
    name: "Print benchmark summary",
    minClients: 2,
    fn: async (ctx) => {
      console.log("\n" + "=".repeat(70));
      console.log(`BENCHMARK SUMMARY (${ctx.numClients} clients)`);
      console.log("=".repeat(70));

      // Group by metric type
      const latencyMetrics = results.filter(r => r.name.includes("latency") || r.name.includes("time"));
      const throughputMetrics = results.filter(r => r.name.includes("throughput") || r.name.includes("files/sec") || r.name.includes("MB/s"));
      const otherMetrics = results.filter(r => !latencyMetrics.includes(r) && !throughputMetrics.includes(r));

      if (latencyMetrics.length > 0) {
        console.log("\nLatency Metrics:");
        for (const r of latencyMetrics) {
          console.log(`  ${r.name}: ${r.value.toFixed(2)} ${r.unit}`);
        }
      }

      if (throughputMetrics.length > 0) {
        console.log("\nThroughput Metrics:");
        for (const r of throughputMetrics) {
          console.log(`  ${r.name}: ${r.value.toFixed(2)} ${r.unit}`);
        }
      }

      if (otherMetrics.length > 0) {
        console.log("\nOther Metrics:");
        for (const r of otherMetrics) {
          console.log(`  ${r.name}: ${r.value.toFixed(2)} ${r.unit}`);
        }
      }

      console.log("\n" + "=".repeat(70));
    },
  },
];

export default tests;
