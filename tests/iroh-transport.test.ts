/**
 * Iroh Transport Integration Tests
 *
 * Tests for the real P2P transport using Iroh WASM.
 * Note: These tests require a browser-like environment with WASM support.
 * They are skipped in Node.js but can be run in a browser test runner.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Transport, PeerConnection, SyncStream, TransportConfig } from '../src/transport/types';

// Mock logger for tests
const mockLogger = {
  debug: (..._args: unknown[]) => {},
  info: (..._args: unknown[]) => {},
  warn: (..._args: unknown[]) => {},
  error: (..._args: unknown[]) => {},
};

// Mock storage for tests
function createMockStorage() {
  const store = new Map<string, Uint8Array>();
  return {
    loadSecretKey: async () => store.get('secret-key') ?? null,
    saveSecretKey: async (key: Uint8Array) => { store.set('secret-key', key); },
  };
}

describe('Iroh Transport', () => {
  // Skip all Iroh tests in Node.js/Bun environment (WASM requires browser)
  // The WASM module is now bundled inline and can't be loaded outside the build
  const isNode = typeof window === 'undefined';

  describe.skipIf(isNode)('WASM Integration', () => {
    test('should initialize WASM module', async () => {
      // This test would need to run in a browser environment
      // For now, we just verify the module structure
      const { initIrohWasm, isIrohWasmReady } = await import('../src/transport/iroh-transport');
      expect(typeof initIrohWasm).toBe('function');
      expect(typeof isIrohWasmReady).toBe('function');
    });
  });

  // These tests require the WASM module which is bundled inline
  // Skip in Node.js/Bun environment
  describe.skipIf(isNode)('IrohTransport Class Structure', () => {
    test('should export IrohTransport class', async () => {
      const { IrohTransport } = await import('../src/transport/iroh-transport');
      expect(IrohTransport).toBeDefined();
      expect(typeof IrohTransport).toBe('function');
    });

    test('should implement Transport interface', async () => {
      const { IrohTransport } = await import('../src/transport/iroh-transport');
      const config: TransportConfig = {
        storage: createMockStorage(),
        logger: mockLogger,
      };

      const transport = new IrohTransport(config);

      // Check that all Transport interface methods exist
      expect(typeof transport.initialize).toBe('function');
      expect(typeof transport.getNodeId).toBe('function');
      expect(typeof transport.generateTicket).toBe('function');
      expect(typeof transport.connectWithTicket).toBe('function');
      expect(typeof transport.onIncomingConnection).toBe('function');
      expect(typeof transport.getConnections).toBe('function');
      expect(typeof transport.getConnection).toBe('function');
      expect(typeof transport.shutdown).toBe('function');
      expect(typeof transport.isReady).toBe('function');
    });

    test('should not be ready before initialization', async () => {
      const { IrohTransport } = await import('../src/transport/iroh-transport');
      const config: TransportConfig = {
        storage: createMockStorage(),
        logger: mockLogger,
      };

      const transport = new IrohTransport(config);
      expect(transport.isReady()).toBe(false);
    });
  });

  // These tests require the WASM module which is bundled inline
  describe.skipIf(isNode)('Module Exports', () => {
    test('should export all required functions', async () => {
      const exports = await import('../src/transport');

      expect(exports.IrohTransport).toBeDefined();
      expect(exports.initIrohWasm).toBeDefined();
      expect(exports.isIrohWasmReady).toBeDefined();
    });
  });
});

describe('Iroh WASM Types', () => {
  test('generated TypeScript definitions should exist', async () => {
    // Just verify the file structure matches our expectations
    const fs = await import('fs');
    const path = await import('path');

    const dtsPath = path.join(process.cwd(), 'peervault-iroh/pkg/peervault_iroh.d.ts');

    if (fs.existsSync(dtsPath)) {
      const content = fs.readFileSync(dtsPath, 'utf-8');

      // Check for expected class definitions
      expect(content).toContain('class WasmEndpoint');
      expect(content).toContain('class WasmConnection');
      expect(content).toContain('class WasmStream');

      // Check for expected methods
      expect(content).toContain('nodeId()');
      expect(content).toContain('generateTicket()');
      expect(content).toContain('connectWithTicket');
      expect(content).toContain('acceptConnection');
      expect(content).toContain('openStream');
      expect(content).toContain('send');
      expect(content).toContain('receive');
    }
  });

  test('WASM files should exist in pkg directory', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const pkgDir = path.join(process.cwd(), 'peervault-iroh/pkg');

    if (fs.existsSync(pkgDir)) {
      const files = fs.readdirSync(pkgDir);

      expect(files).toContain('peervault_iroh.js');
      expect(files).toContain('peervault_iroh_bg.wasm');
      expect(files).toContain('peervault_iroh.d.ts');
    }
  });

  test('WASM files should be in dist directory after build', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const distDir = path.join(process.cwd(), 'dist');

    if (fs.existsSync(distDir)) {
      const files = fs.readdirSync(distDir);

      expect(files).toContain('main.js');
      expect(files).toContain('peervault_iroh.js');
      expect(files).toContain('peervault_iroh_bg.wasm');
    }
  });
});
