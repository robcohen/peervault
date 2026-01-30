/**
 * Logger Tests
 *
 * Tests for logging functionality, redaction, and log buffer.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  Logger,
  createLogger,
  setGlobalDebugMode,
  getLogBuffer,
  getRecentLogs,
  clearLogBuffer,
} from "../src/utils/logger";

// ============================================================================
// Tests
// ============================================================================

describe("Logger", () => {
  let consoleSpy: {
    debug: ReturnType<typeof spyOn>;
    info: ReturnType<typeof spyOn>;
    warn: ReturnType<typeof spyOn>;
    error: ReturnType<typeof spyOn>;
  };

  beforeEach(() => {
    clearLogBuffer();
    setGlobalDebugMode(false);
    consoleSpy = {
      debug: spyOn(console, "debug").mockImplementation(() => {}),
      info: spyOn(console, "info").mockImplementation(() => {}),
      warn: spyOn(console, "warn").mockImplementation(() => {}),
      error: spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    consoleSpy.debug.mockRestore();
    consoleSpy.info.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.error.mockRestore();
  });

  describe("Basic Logging", () => {
    it("should log info messages", () => {
      const logger = createLogger("Test");
      logger.info("test message");
      expect(consoleSpy.info).toHaveBeenCalledWith("[Test]", "test message");
    });

    it("should log warn messages", () => {
      const logger = createLogger("Test");
      logger.warn("warning message");
      expect(consoleSpy.warn).toHaveBeenCalledWith("[Test]", "warning message");
    });

    it("should log error messages", () => {
      const logger = createLogger("Test");
      logger.error("error message");
      expect(consoleSpy.error).toHaveBeenCalledWith("[Test]", "error message");
    });

    it("should not log debug messages when debug mode is off", () => {
      const logger = createLogger("Test");
      logger.debug("debug message");
      expect(consoleSpy.debug).not.toHaveBeenCalled();
    });

    it("should log debug messages when debug mode is on", () => {
      setGlobalDebugMode(true);
      const logger = createLogger("Test");
      logger.debug("debug message");
      expect(consoleSpy.debug).toHaveBeenCalledWith("[Test]", "debug message");
    });

    it("should handle multiple arguments", () => {
      const logger = createLogger("Test");
      logger.info("message", 123, { key: "value" });
      expect(consoleSpy.info).toHaveBeenCalledWith("[Test]", "message", 123, { key: "value" });
    });
  });

  describe("Log Level Method", () => {
    it("should route to correct method for each level", () => {
      const logger = createLogger("Test");

      logger.log("info", "info message");
      expect(consoleSpy.info).toHaveBeenCalled();

      logger.log("warn", "warn message");
      expect(consoleSpy.warn).toHaveBeenCalled();

      logger.log("error", "error message");
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it("should route debug level correctly", () => {
      setGlobalDebugMode(true);
      const logger = createLogger("Test");
      logger.log("debug", "debug message");
      expect(consoleSpy.debug).toHaveBeenCalled();
    });
  });

  describe("Child Loggers", () => {
    it("should create child logger with nested prefix", () => {
      const parent = createLogger("Parent");
      const child = parent.child("Child");
      child.info("message");
      expect(consoleSpy.info).toHaveBeenCalledWith("[Parent:Child]", "message");
    });

    it("should inherit debug mode from parent", () => {
      setGlobalDebugMode(true);
      const parent = createLogger("Parent");
      const child = parent.child("Child");
      child.debug("debug message");
      expect(consoleSpy.debug).toHaveBeenCalledWith("[Parent:Child]", "debug message");
    });

    it("should create deeply nested child loggers", () => {
      const parent = createLogger("A");
      const child = parent.child("B");
      const grandchild = child.child("C");
      grandchild.info("message");
      expect(consoleSpy.info).toHaveBeenCalledWith("[A:B:C]", "message");
    });
  });

  describe("Log Buffer", () => {
    it("should add logs to buffer", () => {
      const logger = createLogger("Test");
      logger.info("buffered message");

      const buffer = getLogBuffer();
      expect(buffer).toContain("buffered message");
      expect(buffer).toContain("[INFO ]");
      expect(buffer).toContain("[Test]");
    });

    it("should buffer all log levels", () => {
      setGlobalDebugMode(true);
      const logger = createLogger("Test");

      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error("error");

      const buffer = getLogBuffer();
      expect(buffer).toContain("[DEBUG]");
      expect(buffer).toContain("[INFO ]");
      expect(buffer).toContain("[WARN ]");
      expect(buffer).toContain("[ERROR]");
    });

    it("should get recent logs with limit", () => {
      const logger = createLogger("Test");
      for (let i = 0; i < 10; i++) {
        logger.info(`message ${i}`);
      }

      const recent = getRecentLogs(5);
      expect(recent).not.toContain("message 0");
      expect(recent).toContain("message 9");
      expect(recent).toContain("message 5");
    });

    it("should clear log buffer", () => {
      const logger = createLogger("Test");
      logger.info("message");
      expect(getLogBuffer()).toContain("message");

      clearLogBuffer();
      expect(getLogBuffer()).toBe("");
    });

    it("should include timestamp in buffer", () => {
      const logger = createLogger("Test");
      logger.info("message");

      const buffer = getLogBuffer();
      // Timestamp format: HH:MM:SS.mmm
      expect(buffer).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    });
  });

  describe("Sensitive Data Redaction", () => {
    it("should redact 64-char hex strings (node IDs)", () => {
      const logger = createLogger("Test");
      const nodeId = "a".repeat(64);
      logger.info(`Node: ${nodeId}`);

      const buffer = getLogBuffer();
      expect(buffer).not.toContain(nodeId);
      expect(buffer).toContain("[NODE_ID]");
    });

    it("should redact iroh tickets", () => {
      const logger = createLogger("Test");
      logger.info("Ticket: iroh://abc123xyz");

      const buffer = getLogBuffer();
      expect(buffer).not.toContain("iroh://abc123xyz");
      expect(buffer).toContain("[TICKET]");
    });

    it("should redact base64 keys", () => {
      const logger = createLogger("Test");
      // 32+ character base64 string
      const key = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
      logger.info(`Key: ${key}`);

      const buffer = getLogBuffer();
      expect(buffer).not.toContain(key);
      expect(buffer).toContain("[KEY]");
    });

    it("should not redact short strings", () => {
      const logger = createLogger("Test");
      logger.info("Short string: hello");

      const buffer = getLogBuffer();
      expect(buffer).toContain("hello");
    });

    it("should handle Error objects", () => {
      const logger = createLogger("Test");
      const error = new Error("Test error message");
      logger.error("Got error:", error);

      const buffer = getLogBuffer();
      expect(buffer).toContain("Error: Test error message");
    });

    it("should handle objects in logs", () => {
      const logger = createLogger("Test");
      logger.info("Data:", { key: "value", num: 123 });

      const buffer = getLogBuffer();
      expect(buffer).toContain("key");
      expect(buffer).toContain("value");
    });
  });

  describe("Timing Methods", () => {
    it("should time async operations", async () => {
      setGlobalDebugMode(true);
      const logger = createLogger("Test");

      const result = await logger.time("async op", async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 42;
      });

      expect(result).toBe(42);
      const buffer = getLogBuffer();
      expect(buffer).toContain("async op completed");
      expect(buffer).toMatch(/\d+\.\d+ms/);
    });

    it("should time sync operations", () => {
      setGlobalDebugMode(true);
      const logger = createLogger("Test");

      const result = logger.timeSync("sync op", () => {
        return "result";
      });

      expect(result).toBe("result");
      const buffer = getLogBuffer();
      expect(buffer).toContain("sync op completed");
    });

    it("should log error for failed async operations", async () => {
      const logger = createLogger("Test");

      try {
        await logger.time("failing op", async () => {
          throw new Error("Async failure");
        });
      } catch {
        // Expected
      }

      const buffer = getLogBuffer();
      expect(buffer).toContain("failing op failed");
    });

    it("should log error for failed sync operations", () => {
      const logger = createLogger("Test");

      try {
        logger.timeSync("failing op", () => {
          throw new Error("Sync failure");
        });
      } catch {
        // Expected
      }

      const buffer = getLogBuffer();
      expect(buffer).toContain("failing op failed");
    });

    it("should rethrow errors from timed operations", async () => {
      const logger = createLogger("Test");

      await expect(
        logger.time("op", async () => {
          throw new Error("Test error");
        }),
      ).rejects.toThrow("Test error");

      expect(() =>
        logger.timeSync("op", () => {
          throw new Error("Sync test error");
        }),
      ).toThrow("Sync test error");
    });
  });

  describe("Logger Constructor", () => {
    it("should accept custom debug mode function", () => {
      let debugEnabled = false;
      const logger = new Logger("Custom", () => debugEnabled);

      logger.debug("message 1");
      expect(consoleSpy.debug).not.toHaveBeenCalled();

      debugEnabled = true;
      logger.debug("message 2");
      expect(consoleSpy.debug).toHaveBeenCalled();
    });
  });
});
