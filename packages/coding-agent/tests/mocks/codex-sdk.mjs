/**
 * Fake @openai/codex-sdk module for testing.
 *
 * Exposes a FakeCodex class that records constructor, startThread,
 * resumeThread calls and yields configurable events.
 *
 * Tests configure behaviour via the exported `_test` control object.
 */

/** @type {Record<string, unknown>[]} */
let _fakeEvents = [];

/** @type {Error | null} */
let _runStreamedError = null;

/** @type {Array<{opts?: Record<string, unknown>}>} */
let _startThreadCalls = [];

/** @type {Array<{id: string, opts?: Record<string, unknown>}>} */
let _resumeThreadCalls = [];

/** @type {Array<{input: string}>} */
let _runStreamedCalls = [];

/** @type {Record<string, unknown>[]} */
let _constructorCalls = [];

class FakeCodexThread {
  /**
   * Returns Promise<{ events: AsyncGenerator<ThreadEvent> }> matching the real SDK API.
   * @param {string} input
   */
  async runStreamed(input) {
    _runStreamedCalls.push({ input });
    if (_runStreamedError) {
      throw _runStreamedError;
    }
    const events = _fakeEvents;
    return {
      events: (async function* () {
        for (const event of events) {
          yield event;
        }
      })(),
    };
  }
}

export class Codex {
  /** @param {Record<string, unknown>} [opts] */
  constructor(opts) {
    _constructorCalls.push(opts ?? {});
  }

  /** @param {Record<string, unknown>} [opts] */
  startThread(opts) {
    _startThreadCalls.push({ opts });
    return new FakeCodexThread();
  }

  /**
   * @param {string} id
   * @param {Record<string, unknown>} [opts]
   */
  resumeThread(id, opts) {
    _resumeThreadCalls.push({ id, opts });
    return new FakeCodexThread();
  }
}

/**
 * Test control object — lets tests configure fake events and inspect calls.
 */
export const _test = {
  get startThreadCalls() { return _startThreadCalls; },
  get resumeThreadCalls() { return _resumeThreadCalls; },
  get runStreamedCalls() { return _runStreamedCalls; },
  get constructorCalls() { return _constructorCalls; },

  /** @param {Record<string, unknown>[]} events */
  setEvents(events) { _fakeEvents = events; },

  /** @param {Error} err */
  setRunStreamedError(err) { _runStreamedError = err; },

  reset() {
    _fakeEvents = [];
    _runStreamedError = null;
    _startThreadCalls = [];
    _resumeThreadCalls = [];
    _runStreamedCalls = [];
    _constructorCalls = [];
  },
};
