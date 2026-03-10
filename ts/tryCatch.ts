/**
 * A utility function to wrap another function with a try-catch block.
 * If an error occurs during the execution of the function, the provided
 * catchFn is called with the error, the original function, and its arguments.
 *
 * @param catchFn - The function to call when an error occurs.
 * @param fn - The function to wrap.
 * @returns A new function that wraps the original function with error handling.
 */
export function tryCatch<F extends (...args: any[]) => any, R>(
  catchFn: (error: unknown, attempts: number, robustFn: F, ...args: Parameters<F>) => R,
  fn: F,
) {
  let attempts = 0;
  return function robustFn(...args: Parameters<F>) {
    try {
      attempts++;
      return fn(...args);
    } catch (error) {
      return catchFn(error, attempts, robustFn as F, ...args);
    }
  };
}
