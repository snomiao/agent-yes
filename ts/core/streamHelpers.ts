/**
 * Stream processing utilities for terminal I/O
 *
 * Provides helper functions for stream lifecycle management.
 */

/**
 * Create a terminator transform stream that ends when promise resolves
 *
 * Creates a TransformStream that automatically terminates when the provided
 * promise resolves. Used to stop output processing when the agent exits.
 *
 * @param exitPromise - Promise that resolves when stream should terminate
 * @returns TransformStream that terminates on promise resolution
 *
 * @example
 * ```typescript
 * const exitPromise = Promise.withResolvers<number>();
 * stream.by(createTerminatorStream(exitPromise.promise));
 *
 * // Later, when agent exits:
 * exitPromise.resolve(0);
 * ```
 */
export function createTerminatorStream(
  exitPromise: Promise<unknown>,
): TransformStream<string, string> {
  return new TransformStream({
    start: function terminator(ctrl) {
      exitPromise.then(() => ctrl.terminate());
    },
    transform: (e, ctrl) => ctrl.enqueue(e),
    flush: (ctrl) => ctrl.terminate(),
  });
}
