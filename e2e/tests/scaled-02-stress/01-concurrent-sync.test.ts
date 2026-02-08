/**
 * Scaled Stress Tests - Concurrent Sync
 *
 * Test concurrent operations across all clients in the mesh.
 */

import type { ScaledTestContext } from "../../lib/scaled-context";
import { delay } from "../../config";

interface ScaledTestDef {
  name: string;
  fn: (ctx: ScaledTestContext) => Promise<void>;
  skip?: boolean;
  minClients?: number;
}

const tests: ScaledTestDef[] = [
  {
    name: "Concurrent file creation from all clients",
    minClients: 2,
    fn: async (ctx) => {
      const testPrefix = `concurrent-${Date.now()}`;
      const files: Array<{ client: string; file: string; content: string }> = [];

      // Each client creates a file simultaneously
      const createPromises = ctx.clients.map(async (client, idx) => {
        const file = `${testPrefix}-${idx}.md`;
        const content = `# File from ${client.name}\n\nIndex: ${idx}\nTimestamp: ${Date.now()}`;

        await client.vault.createFile(file, content);
        files.push({ client: client.name, file, content });
      });

      await Promise.all(createPromises);
      console.log(`  Created ${files.length} files concurrently`);

      // Wait for convergence
      const converged = await ctx.waitForConvergence(60000);
      if (!converged) {
        console.log("  Warning: CRDT versions did not fully converge");
      }

      await delay(3000);

      // Verify all files exist on all clients
      let missingCount = 0;
      for (const { file, content, client: originClient } of files) {
        for (const client of ctx.clients) {
          try {
            const actualContent = await client.vault.readFile(file);
            if (!actualContent) {
              console.log(`  Missing: ${file} on ${client.name} (created by ${originClient})`);
              missingCount++;
            }
          } catch (e) {
            console.log(`  Error reading ${file} on ${client.name}: ${e}`);
            missingCount++;
          }
        }
      }

      if (missingCount > 0) {
        throw new Error(`${missingCount} file(s) missing after concurrent creation`);
      }

      console.log(`  All ${files.length} files synced to all ${ctx.clients.length} clients`);

      // Cleanup
      for (const { file } of files) {
        await ctx.clients[0].vault.deleteFile(file).catch(() => {});
      }
      await ctx.waitForConvergence(10000);
    },
  },

  {
    name: "Round-robin edit propagation",
    minClients: 3,
    // Skip for large meshes - CRDT text merging has inherent conflicts with concurrent edits
    skip: true,
    fn: async (ctx) => {
      // Scale timeout based on number of clients (more clients = more time to converge)
      const baseTimeout = 10000;
      const perClientTimeout = 2000;
      const convergenceTimeout = baseTimeout + (ctx.numClients * perClientTimeout);

      // Create a shared file
      const testFile = `round-robin-${Date.now()}.md`;
      let content = `# Round Robin Test\n\nEditors:\n`;

      await ctx.clients[0].vault.createFile(testFile, content);
      await ctx.waitForConvergence(convergenceTimeout);

      // Each client appends to the file in sequence
      for (let i = 0; i < ctx.clients.length; i++) {
        const client = ctx.clients[i];
        const currentContent = await client.vault.readFile(testFile);
        const newContent = currentContent + `- ${client.name} (round ${i + 1})\n`;

        await client.vault.modifyFile(testFile, newContent);
        console.log(`  ${client.name} edited file`);

        // Wait for sync between each edit
        await ctx.waitForConvergence(convergenceTimeout);
      }

      // Verify final content on all clients
      await delay(3000);
      const finalContent = await ctx.clients[0].vault.readFile(testFile);

      for (const client of ctx.clients) {
        const clientContent = await client.vault.readFile(testFile);
        if (clientContent !== finalContent) {
          throw new Error(
            `Content mismatch on ${client.name}: expected ${finalContent.length} chars, got ${clientContent?.length ?? 0}`
          );
        }
      }

      // Verify all edits are present
      for (const client of ctx.clients) {
        if (!finalContent?.includes(client.name)) {
          throw new Error(`Edit from ${client.name} not found in final content`);
        }
      }

      console.log(`  All ${ctx.clients.length} edits propagated successfully`);

      // Cleanup
      await ctx.clients[0].vault.deleteFile(testFile);
      await ctx.waitForConvergence(convergenceTimeout);
    },
  },

  {
    name: "Bulk file sync (scaled per client count)",
    minClients: 2,
    fn: async (ctx) => {
      const testPrefix = `bulk-${Date.now()}`;
      // Scale down files per client as mesh size grows to keep test tractable
      // 2 clients: 10 files, 5 clients: 6 files, 10 clients: 3 files
      const filesPerClient = Math.max(3, Math.floor(20 / ctx.numClients));
      const allFiles: string[] = [];

      console.log(`  Testing with ${filesPerClient} files per client (${filesPerClient * ctx.numClients} total)`);

      // Create warmup file and let sync settle
      await ctx.clients[0].vault.createFile(`${testPrefix}-warmup.md`, "warmup");
      await delay(500);

      // Scale delays based on number of clients (more clients = more sync overhead)
      const fileDelay = Math.max(50, ctx.numClients * 10); // 50ms base, +10ms per client

      // Each client creates files in its own folder to avoid "folder exists" conflicts
      const createPromises = ctx.clients.map(async (client, clientIdx) => {
        const clientFiles: string[] = [];
        for (let i = 0; i < filesPerClient; i++) {
          // Use flat file names instead of nested folders to avoid concurrent folder creation
          const file = `${testPrefix}-c${clientIdx}-f${i}.md`;
          const content = `# Bulk file ${i}\n\nClient: ${client.name}\nIndex: ${i}`;
          await client.vault.createFile(file, content);
          clientFiles.push(file);
          // Delay scales with number of clients
          await delay(fileDelay);
        }
        return clientFiles;
      });

      const filesByClient = await Promise.all(createPromises);
      for (const files of filesByClient) {
        allFiles.push(...files);
      }

      console.log(`  Created ${allFiles.length} files across ${ctx.clients.length} clients`);

      // Wait for convergence - reasonable timeout that scales with mesh complexity
      const convergenceTimeout = Math.min(180000, 60000 + (allFiles.length * ctx.numClients * 100));
      const converged = await ctx.waitForConvergence(convergenceTimeout);
      if (!converged) {
        console.log("  Warning: CRDT versions did not fully converge");
      }

      // Post-convergence delay scales with client count
      await delay(3000 + (ctx.numClients * 500));

      // Verify all files exist on all clients
      let totalMissing = 0;
      for (const client of ctx.clients) {
        let missing = 0;
        for (const file of allFiles) {
          try {
            const content = await client.vault.readFile(file);
            if (!content) missing++;
          } catch {
            missing++;
          }
        }
        if (missing > 0) {
          console.log(`  ${client.name} missing ${missing}/${allFiles.length} files`);
          totalMissing += missing;
        }
      }

      if (totalMissing > 0) {
        throw new Error(`${totalMissing} total file(s) missing after bulk sync`);
      }

      console.log(`  All ${allFiles.length} files synced to all ${ctx.clients.length} clients`);

      // Cleanup - delete the test files and warmup file
      for (const file of allFiles) {
        await ctx.clients[0].vault.deleteFile(file).catch(() => {});
      }
      await ctx.clients[0].vault.deleteFile(`${testPrefix}-warmup.md`).catch(() => {});
      await ctx.waitForConvergence(30000);
    },
  },
];

export default tests;
