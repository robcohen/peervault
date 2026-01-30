/**
 * Event Emitter Tests
 *
 * Tests for the type-safe event emitter utility.
 */

import { describe, it, expect, spyOn } from "bun:test";
import { EventEmitter } from "../src/utils/events";

// ============================================================================
// Test Event Types
// ============================================================================

interface TestEvents extends Record<string, unknown> {
  "test:string": string;
  "test:number": number;
  "test:object": { id: number; name: string };
  "test:void": void;
}

// ============================================================================
// Basic Event Tests
// ============================================================================

describe("EventEmitter", () => {
  describe("on/emit", () => {
    it("should call listener when event is emitted", () => {
      const emitter = new EventEmitter<TestEvents>();
      let received: string | null = null;

      emitter.on("test:string", (data) => {
        received = data;
      });

      emitter.emit("test:string", "hello");

      expect(received).toBe("hello");
    });

    it("should call multiple listeners in order", () => {
      const emitter = new EventEmitter<TestEvents>();
      const calls: number[] = [];

      emitter.on("test:number", () => calls.push(1));
      emitter.on("test:number", () => calls.push(2));
      emitter.on("test:number", () => calls.push(3));

      emitter.emit("test:number", 42);

      expect(calls).toEqual([1, 2, 3]);
    });

    it("should pass correct data to listeners", () => {
      const emitter = new EventEmitter<TestEvents>();
      let received: { id: number; name: string } | null = null;

      emitter.on("test:object", (data) => {
        received = data;
      });

      emitter.emit("test:object", { id: 123, name: "test" });

      expect(received).toEqual({ id: 123, name: "test" });
    });

    it("should handle void events", () => {
      const emitter = new EventEmitter<TestEvents>();
      let called = false;

      emitter.on("test:void", () => {
        called = true;
      });

      emitter.emit("test:void", undefined);

      expect(called).toBe(true);
    });

    it("should not call listeners for different events", () => {
      const emitter = new EventEmitter<TestEvents>();
      let stringCalled = false;
      let numberCalled = false;

      emitter.on("test:string", () => {
        stringCalled = true;
      });
      emitter.on("test:number", () => {
        numberCalled = true;
      });

      emitter.emit("test:string", "hello");

      expect(stringCalled).toBe(true);
      expect(numberCalled).toBe(false);
    });
  });

  describe("off", () => {
    it("should remove a specific listener", () => {
      const emitter = new EventEmitter<TestEvents>();
      const calls: string[] = [];

      const listener1 = () => calls.push("listener1");
      const listener2 = () => calls.push("listener2");

      emitter.on("test:string", listener1);
      emitter.on("test:string", listener2);

      emitter.off("test:string", listener1);
      emitter.emit("test:string", "test");

      expect(calls).toEqual(["listener2"]);
    });

    it("should handle removing non-existent listener", () => {
      const emitter = new EventEmitter<TestEvents>();

      // Should not throw
      emitter.off("test:string", () => {});
    });

    it("should return unsubscribe function from on()", () => {
      const emitter = new EventEmitter<TestEvents>();
      const calls: string[] = [];

      const unsubscribe = emitter.on("test:string", () => calls.push("called"));

      emitter.emit("test:string", "test1");
      unsubscribe();
      emitter.emit("test:string", "test2");

      expect(calls).toEqual(["called"]);
    });
  });

  describe("once", () => {
    it("should only call listener once", () => {
      const emitter = new EventEmitter<TestEvents>();
      let callCount = 0;

      emitter.once("test:string", () => {
        callCount++;
      });

      emitter.emit("test:string", "first");
      emitter.emit("test:string", "second");
      emitter.emit("test:string", "third");

      expect(callCount).toBe(1);
    });

    it("should pass correct data to once listener", () => {
      const emitter = new EventEmitter<TestEvents>();
      let received: number | null = null;

      emitter.once("test:number", (data) => {
        received = data;
      });

      emitter.emit("test:number", 42);

      expect(received).toBe(42);
    });

    it("should return unsubscribe function", () => {
      const emitter = new EventEmitter<TestEvents>();
      let called = false;

      const unsubscribe = emitter.once("test:string", () => {
        called = true;
      });

      unsubscribe();
      emitter.emit("test:string", "test");

      expect(called).toBe(false);
    });
  });

  describe("removeAllListeners", () => {
    it("should remove all listeners for a specific event", () => {
      const emitter = new EventEmitter<TestEvents>();
      let stringCalls = 0;
      let numberCalls = 0;

      emitter.on("test:string", () => stringCalls++);
      emitter.on("test:string", () => stringCalls++);
      emitter.on("test:number", () => numberCalls++);

      emitter.removeAllListeners("test:string");

      emitter.emit("test:string", "test");
      emitter.emit("test:number", 42);

      expect(stringCalls).toBe(0);
      expect(numberCalls).toBe(1);
    });

    it("should remove all listeners when no event specified", () => {
      const emitter = new EventEmitter<TestEvents>();
      let stringCalls = 0;
      let numberCalls = 0;

      emitter.on("test:string", () => stringCalls++);
      emitter.on("test:number", () => numberCalls++);

      emitter.removeAllListeners();

      emitter.emit("test:string", "test");
      emitter.emit("test:number", 42);

      expect(stringCalls).toBe(0);
      expect(numberCalls).toBe(0);
    });
  });

  describe("listenerCount", () => {
    it("should return correct listener count", () => {
      const emitter = new EventEmitter<TestEvents>();

      expect(emitter.listenerCount("test:string")).toBe(0);

      emitter.on("test:string", () => {});
      expect(emitter.listenerCount("test:string")).toBe(1);

      emitter.on("test:string", () => {});
      expect(emitter.listenerCount("test:string")).toBe(2);
    });

    it("should decrease count after removal", () => {
      const emitter = new EventEmitter<TestEvents>();
      const listener = () => {};

      emitter.on("test:string", listener);
      emitter.on("test:string", () => {});
      expect(emitter.listenerCount("test:string")).toBe(2);

      emitter.off("test:string", listener);
      expect(emitter.listenerCount("test:string")).toBe(1);
    });
  });

  describe("error handling", () => {
    it("should continue calling other listeners if one throws", () => {
      const emitter = new EventEmitter<TestEvents>();
      const calls: number[] = [];

      // Spy on console.error to suppress output during test
      const consoleSpy = spyOn(console, "error").mockImplementation(() => {});

      emitter.on("test:number", () => calls.push(1));
      emitter.on("test:number", () => {
        throw new Error("Listener error");
      });
      emitter.on("test:number", () => calls.push(3));

      emitter.emit("test:number", 42);

      expect(calls).toEqual([1, 3]);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("concurrent modification safety", () => {
    it("should handle off() during emit()", () => {
      const emitter = new EventEmitter<TestEvents>();
      const calls: number[] = [];

      const listener1 = () => {
        calls.push(1);
        emitter.off("test:number", listener2);
      };
      const listener2 = () => calls.push(2);
      const listener3 = () => calls.push(3);

      emitter.on("test:number", listener1);
      emitter.on("test:number", listener2);
      emitter.on("test:number", listener3);

      emitter.emit("test:number", 42);

      // All listeners should be called since we copy the array before iterating
      expect(calls).toEqual([1, 2, 3]);

      // But listener2 should be removed for next emit
      calls.length = 0;
      emitter.emit("test:number", 42);
      expect(calls).toEqual([1, 3]);
    });

    it("should handle on() during emit()", () => {
      const emitter = new EventEmitter<TestEvents>();
      const calls: number[] = [];

      const listener1 = () => {
        calls.push(1);
        emitter.on("test:number", () => calls.push(4));
      };
      const listener2 = () => calls.push(2);

      emitter.on("test:number", listener1);
      emitter.on("test:number", listener2);

      emitter.emit("test:number", 42);

      // New listener should NOT be called during this emit (we copied before iterating)
      expect(calls).toEqual([1, 2]);

      // But should be called on next emit
      calls.length = 0;
      emitter.emit("test:number", 42);
      expect(calls).toEqual([1, 2, 4]);
    });

    it("should handle once() self-removal during emit()", () => {
      const emitter = new EventEmitter<TestEvents>();
      const calls: number[] = [];

      emitter.once("test:number", () => calls.push(1));
      emitter.on("test:number", () => calls.push(2));

      emitter.emit("test:number", 42);

      // Both should be called
      expect(calls).toEqual([1, 2]);

      // Once listener should be removed
      calls.length = 0;
      emitter.emit("test:number", 42);
      expect(calls).toEqual([2]);
    });
  });
});
