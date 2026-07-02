/**
 * A utility class to wait for idle periods based on activity pings.
 *
 * @example
 * const idleWaiter = new IdleWaiter();
 *
 * // Somewhere in your code, when activity occurs:
 * idleWaiter.ping();
 *
 * // To wait for an idle period of 5 seconds:
 * await idleWaiter.wait(5000);
 * console.log('System has been idle for 5 seconds');
 */
export class IdleWaiter {
  lastActivityTime = Date.now();
  checkInterval = 100; // Default check interval in milliseconds

  constructor() {
    this.ping();
  }

  ping() {
    this.lastActivityTime = Date.now();
    return this;
  }

  /** Milliseconds since the last ping. */
  idleTimeMs() {
    return Date.now() - this.lastActivityTime;
  }

  async wait(ms: number) {
    while (this.lastActivityTime >= Date.now() - ms)
      await new Promise((resolve) => setTimeout(resolve, this.checkInterval));
  }
}
