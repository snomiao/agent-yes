import { describe, expect, it } from "vitest";
import { tryCatch } from "./tryCatch";

describe("tryCatch", () => {
  describe("direct overload", () => {
    it("should catch errors and call catchFn with error, attempts, robustFn, and args", () => {
      let catchedError: unknown;
      let catchedAttempts: unknown;
      let catchedFn: unknown;
      let catchedArgs!: unknown[];
      const catchFn = (error: unknown, attempts: number, fn: unknown, ...args: unknown[]) => {
        catchedError = error;
        catchedAttempts = attempts;
        catchedFn = fn;
        catchedArgs = args;
        return "caught";
      };

      let calledArgs: unknown[] = [];
      const errorFn = (...args: unknown[]) => {
        calledArgs = args;
        throw new Error("test error");
      };

      const wrappedFn = tryCatch(catchFn, errorFn);
      const result = wrappedFn("arg1", "arg2");

      expect(result).toBe("caught");
      expect(catchedError).toBeInstanceOf(Error);
      expect(catchedAttempts).toBe(1);
      expect(catchedFn).toBe(wrappedFn);
      expect(catchedArgs).toEqual(["arg1", "arg2"]);
      expect(calledArgs).toEqual(["arg1", "arg2"]);
    });

    it("should return normal result when no error occurs directly", () => {
      let catchCalled = false;
      const catchFn = () => {
        catchCalled = true;
        return "error";
      };

      let calledArgs: unknown[] = [];
      const normalFn = (...args: unknown[]) => {
        calledArgs = args;
        return "success";
      };

      const wrappedFn = tryCatch(catchFn, normalFn);
      const result = wrappedFn("arg1", "arg2");

      expect(result).toBe("success");
      expect(catchCalled).toBe(false);
      expect(calledArgs).toEqual(["arg1", "arg2"]);
    });
  });

  describe("error handling", () => {
    it("should handle different error types and pass function context", () => {
      const results: unknown[] = [];
      const functions: unknown[] = [];
      const catchFn = (error: unknown, _attempts: number, fn: unknown, ..._args: unknown[]) => {
        results.push(error);
        functions.push(fn);
        return "handled";
      };

      // String error
      const stringErrorFn = () => {
        throw "string error";
      };
      const wrappedStringFn = tryCatch(catchFn, stringErrorFn);
      expect(wrappedStringFn()).toBe("handled");
      expect(results[0]).toBe("string error");
      expect(functions[0]).toBe(wrappedStringFn);

      // Object error
      const objectError = { message: "object error" };
      const objectErrorFn = () => {
        throw objectError;
      };
      const wrappedObjectFn = tryCatch(catchFn, objectErrorFn);
      expect(wrappedObjectFn()).toBe("handled");
      expect(results[1]).toBe(objectError);
      expect(functions[1]).toBe(wrappedObjectFn);

      // null error
      const nullErrorFn = () => {
        throw null;
      };
      const wrappedNullFn = tryCatch(catchFn, nullErrorFn);
      expect(wrappedNullFn()).toBe("handled");
      expect(results[2]).toBe(null);
      expect(functions[2]).toBe(wrappedNullFn);
    });

    it("should preserve function parameters and pass them to catchFn", () => {
      let caughtError: unknown;
      let caughtAttempts: unknown;
      let caughtFn: unknown;
      let caughtArgs!: unknown[];
      const catchFn = (error: unknown, attempts: number, fn: unknown, ...args: unknown[]) => {
        caughtError = error;
        caughtAttempts = attempts;
        caughtFn = fn;
        caughtArgs = args;
        return "caught";
      };

      let testArgs: [number, string, boolean] | undefined;
      const testFn = (a: number, b: string, c: boolean) => {
        testArgs = [a, b, c];
        if (a > 5) throw new Error("too big");
        return `${a}-${b}-${c}`;
      };

      const wrappedFn = tryCatch(catchFn, testFn);

      // Normal execution
      expect(wrappedFn(3, "test", true)).toBe("3-test-true");
      expect(testArgs).toEqual([3, "test", true]);

      // Error execution
      expect(wrappedFn(10, "error", false)).toBe("caught");
      expect(testArgs).toEqual([10, "error", false]);
      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtAttempts).toBe(2);
      expect(caughtFn).toBe(wrappedFn);
      expect(caughtArgs).toEqual([10, "error", false]);
    });

    it("should handle functions with no parameters", () => {
      let caughtError: unknown;
      let caughtAttempts: unknown;
      let caughtFn: unknown;
      let caughtArgs!: unknown[];
      const catchFn = (error: unknown, attempts: number, fn: unknown, ...args: unknown[]) => {
        caughtError = error;
        caughtAttempts = attempts;
        caughtFn = fn;
        caughtArgs = args;
        return "no params caught";
      };

      let called = false;
      const noParamsFn = () => {
        called = true;
        throw new Error("no params error");
      };

      const wrappedFn = tryCatch(catchFn, noParamsFn);
      const result = wrappedFn();

      expect(result).toBe("no params caught");
      expect(called).toBe(true);
      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtAttempts).toBe(1);
      expect(caughtFn).toBe(wrappedFn);
      expect(caughtArgs).toEqual([]);
    });

    it("should handle functions returning different types", () => {
      const catchFn = () => null;

      // Function returning number
      const numberFn = tryCatch(catchFn, () => 42);
      expect(numberFn()).toBe(42);

      // Function returning object
      const obj = { key: "value" };
      const objectFn = tryCatch(catchFn, () => obj);
      expect(objectFn()).toBe(obj);

      // Function returning undefined
      const undefinedFn = tryCatch(catchFn, () => undefined);
      expect(undefinedFn()).toBeUndefined();
    });
  });

  describe("attempts tracking", () => {
    it("should increment attempts on each call", () => {
      const attemptsList: number[] = [];
      const catchFn = (_error: unknown, attempts: number) => {
        attemptsList.push(attempts);
        return "caught";
      };

      const errorFn = () => {
        throw new Error("fail");
      };

      const wrappedFn = tryCatch(catchFn, errorFn);
      wrappedFn();
      wrappedFn();
      wrappedFn();

      expect(attemptsList).toEqual([1, 2, 3]);
    });

    it("should count attempts for both successful and failed calls", () => {
      let lastAttempts = 0;
      const catchFn = (_error: unknown, attempts: number) => {
        lastAttempts = attempts;
        return -1;
      };

      let callCount = 0;
      const sometimesFails = () => {
        callCount++;
        if (callCount % 2 === 0) throw new Error("even call");
        return callCount;
      };

      const wrappedFn = tryCatch(catchFn, sometimesFails);
      expect(wrappedFn()).toBe(1); // attempt 1, success
      expect(wrappedFn()).toBe(-1); // attempt 2, fail
      expect(lastAttempts).toBe(2);
      expect(wrappedFn()).toBe(3); // attempt 3, success
      expect(wrappedFn()).toBe(-1); // attempt 4, fail
      expect(lastAttempts).toBe(4);
    });

    it("should allow retry via robustFn", () => {
      let callCount = 0;
      const catchFn = (_error: unknown, attempts: number, retry: () => number) => {
        if (attempts < 3) return retry();
        return -1;
      };

      const unreliableFn = () => {
        callCount++;
        if (callCount < 3) throw new Error("not yet");
        return 42;
      };

      const wrappedFn = tryCatch(catchFn, unreliableFn);
      expect(wrappedFn()).toBe(42);
      expect(callCount).toBe(3);
    });
  });

  describe("type safety", () => {
    it("should maintain function signature", () => {
      const catchFn = (_error: unknown, _attempts: number, _fn: unknown, ..._args: unknown[]) =>
        "error";
      const originalFn = (a: number, b: string): string => `${a}-${b}`;

      const wrappedFn = tryCatch(catchFn, originalFn);

      // This should be type-safe
      const result: string = wrappedFn(1, "test");
      expect(result).toBe("1-test");
    });

    it("should pass function reference and arguments to catchFn", () => {
      let capturedFn: unknown;
      let capturedArgs!: unknown[];
      const catchFn = (_error: unknown, _attempts: number, fn: unknown, ...args: unknown[]) => {
        capturedFn = fn;
        capturedArgs = args;
        return "handled";
      };

      const testFn = (_x: number, _y: string) => {
        throw new Error("test");
      };

      const wrappedFn = tryCatch(catchFn, testFn);
      wrappedFn(42, "hello");

      expect(capturedFn).toBe(wrappedFn);
      expect(capturedArgs).toEqual([42, "hello"]);
    });
  });
});
