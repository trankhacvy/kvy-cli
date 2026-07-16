/**
 * Ported (verbatim logic) from Happy — https://github.com/slopus/happy
 * Original: happy-cli/src/utils/PushableAsyncIterable.ts (MIT)
 *
 * MIT License
 * Copyright (c) 2026 Happy Coder Contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ---
 * A generic async iterable that can be pushed to from the outside — the
 * `prompt` half of `@anthropic-ai/claude-agent-sdk`'s `query({ prompt })`
 * streaming-input mode (plan.md §16 "2.1 Remote mode": "`query()` with
 * `PushableAsyncIterable` prompt stream"). `claudeRemote.ts` keeps ONE of
 * these alive for the lifetime of a `query()` call and pushes a new
 * `SDKUserMessage` onto it every time the remote composer sends a message,
 * so a single SDK session spans many user turns instead of restarting
 * `query()` per message.
 */
export class PushableAsyncIterable<T> implements AsyncIterableIterator<T> {
  private queue: T[] = [];
  private waiters: Array<{
    resolve: (value: IteratorResult<T, undefined>) => void;
    reject: (error: Error) => void;
  }> = [];
  private isDone = false;
  private error: Error | null = null;
  private started = false;

  /** Push a value to the iterable. Throws if already ended/errored. */
  push(value: T): void {
    // Checked in this order (a one-line fix over Happy's original, which
    // checked `isDone` first): `setError()` also sets `isDone = true`, so
    // checking `isDone` first would report the misleading "completed"
    // message for a push after an error instead of surfacing the real error.
    if (this.error) {
      throw this.error;
    }
    if (this.isDone) {
      throw new Error("Cannot push to completed iterable");
    }

    // If there's a waiting consumer, deliver directly; otherwise queue it.
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
    } else {
      this.queue.push(value);
    }
  }

  /** Mark the iterable as complete. Idempotent. */
  end(): void {
    if (this.isDone) return;
    this.isDone = true;
    this.cleanup();
  }

  /** Set an error on the iterable — the next (or any waiting) `next()` rejects with it. */
  setError(err: Error): void {
    if (this.isDone) return;
    this.error = err;
    this.isDone = true;
    this.cleanup();
  }

  private cleanup(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      if (this.error) {
        waiter.reject(this.error);
      } else {
        waiter.resolve({ done: true, value: undefined });
      }
    }
  }

  async next(): Promise<IteratorResult<T, undefined>> {
    if (this.queue.length > 0) {
      return { done: false, value: this.queue.shift() as T };
    }

    if (this.isDone) {
      if (this.error) throw this.error;
      return { done: true, value: undefined };
    }

    return new Promise<IteratorResult<T, undefined>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async return(_value?: unknown): Promise<IteratorResult<T, undefined>> {
    this.end();
    return { done: true, value: undefined };
  }

  async throw(e: unknown): Promise<IteratorResult<T, undefined>> {
    this.setError(e instanceof Error ? e : new Error(String(e)));
    throw this.error;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    if (this.started) {
      throw new Error("PushableAsyncIterable can only be iterated once");
    }
    this.started = true;
    return this;
  }

  get done(): boolean {
    return this.isDone;
  }

  get hasError(): boolean {
    return this.error !== null;
  }

  get queueSize(): number {
    return this.queue.length;
  }

  get waiterCount(): number {
    return this.waiters.length;
  }
}
