import { describe, expect, it } from "vitest";
import { type DeepPartial, deepMixin, sleepms } from "./utils";

describe("utils", () => {
  describe("sleepms", () => {
    it("should return a promise", () => {
      const result = sleepms(100);
      expect(result).toBeInstanceOf(Promise);
    });

    it("should resolve after some time", async () => {
      const start = Date.now();
      await sleepms(10);
      const end = Date.now();
      expect(end - start).toBeGreaterThanOrEqual(5); // Allow some margin
    });

    it("should handle zero milliseconds", async () => {
      const start = Date.now();
      await sleepms(0);
      const end = Date.now();
      expect(end - start).toBeLessThan(50); // Should be quick
    });
  });

  describe("deepMixin", () => {
    it("should merge simple properties", () => {
      const target = { a: 1, b: 2 };
      const source = { b: 3, c: 4 };
      const result = deepMixin(target, source);

      expect(result).toEqual({ a: 1, b: 3, c: 4 });
      expect(result).toBe(target); // Should modify original object
    });

    it("should merge nested objects", () => {
      const target = {
        user: { name: "John", age: 30 },
        settings: { theme: "dark" },
      };
      const source: DeepPartial<typeof target> = {
        user: { age: 31 },
        settings: { language: "en" } as any,
      };

      deepMixin(target, source);

      expect(target).toEqual({
        user: { name: "John", age: 31 },
        settings: { theme: "dark", language: "en" },
      });
    });

    it("should create nested objects when target property is null", () => {
      const target: any = { config: null };
      const source = { config: { enabled: true } };

      deepMixin(target, source);

      expect(target).toEqual({
        config: { enabled: true },
      });
    });

    it("should create nested objects when target property is primitive", () => {
      const target: any = { config: "string" };
      const source = { config: { enabled: true } };

      deepMixin(target, source);

      expect(target).toEqual({
        config: { enabled: true },
      });
    });

    it("should handle arrays by replacing them", () => {
      const target = { items: [1, 2, 3] };
      const source = { items: [4, 5] };

      deepMixin(target, source);

      expect(target).toEqual({ items: [4, 5] });
    });

    it("should ignore undefined values", () => {
      const target = { a: 1, b: 2 };
      const source = { a: undefined, c: 3 };

      deepMixin(target, source);

      expect(target).toEqual({ a: 1, b: 2, c: 3 });
    });

    it("should handle null values", () => {
      const target = { a: 1, b: 2 };
      const source = { a: null, c: 3 };

      // @ts-expect-error testing runtime null handling
      deepMixin(target, source);

      expect(target).toEqual({ a: null, b: 2, c: 3 });
    });

    it("should handle deeply nested structures", () => {
      const target = {
        level1: {
          level2: {
            level3: { value: "old" },
          },
        },
      };
      const source = {
        level1: {
          level2: {
            level3: { value: "new", extra: "added" },
          },
        },
      };

      deepMixin(target, source);

      expect(target).toEqual({
        level1: {
          level2: {
            level3: { value: "new", extra: "added" },
          },
        },
      });
    });

    it("should handle empty objects", () => {
      const target = {};
      const source = {};

      const result = deepMixin(target, source);

      expect(result).toEqual({});
      expect(result).toBe(target);
    });

    it("should handle complex mixed types", () => {
      const target: any = {
        string: "value",
        number: 42,
        boolean: true,
        object: { nested: "value" },
        array: [1, 2, 3],
      };
      const source: any = {
        string: "new value",
        number: 100,
        boolean: false,
        object: { nested: "new value", added: "property" },
        array: [4, 5],
        newProp: "added",
      };

      deepMixin(target, source);

      expect(target).toEqual({
        string: "new value",
        number: 100,
        boolean: false,
        object: { nested: "new value", added: "property" },
        array: [4, 5],
        newProp: "added",
      });
    });
  });
});
