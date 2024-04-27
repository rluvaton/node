// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  ObjectDefineProperty,
  ReflectOwnKeys,
  String,
} = primordials;

const {
  inspect,
} = require('internal/util/inspect');

let spliceOne;

const {
  genericNodeError,
} = require('internal/errors');

const {
  kRejection,
  kCapture,
  kErrorMonitor,
  kShapeMode,
} = require('internal/events/symbols');
const {throwErrorOnMissingErrorHandler, arrayClone, _getMaxListeners} = require("internal/events/internal_event_emitter_helpers");


// TODO - should have the same API as slow_event_emitter

// TODO - not supporting
//  1. kCapture - false by default
//  2. _maxListeners (but still need to save the data), should be saved on the parent
//  3. kErrorMonitor - undefined by default
// TODO - add comment for what this is optimized for
class SlowEventEmitter {
  // TODO - have a way to support passing _events
  // TODO - add comment on how events are stored
  _events = undefined;
  _eventsCount = 0
  // TODO - convert to symbol and rename
  eventEmitterTranslationLayer = undefined;

  /**
   *
   * @param {FastEventEmitter} fastEventEmitter
   */
  static fromFastEventEmitter(fastEventEmitter) {
    const eventEmitter = new SlowEventEmitter(fastEventEmitter.eventEmitterTranslationLayer);

    // TODO - add missing
    eventEmitter._events = fastEventEmitter._events;
    eventEmitter._eventsCount = fastEventEmitter._eventsCount;
    eventEmitter[kShapeMode] = fastEventEmitter[kShapeMode];

    return eventEmitter;
  }

  // TODO - use opts
  constructor(eventEmitterTranslationLayer, opts) {
    this.eventEmitterTranslationLayer = eventEmitterTranslationLayer;
    // TODO -
  }

  /**
   * Synchronously calls each of the listeners registered
   * for the event.
   * @param {string | symbol} type
   * @param {...any} [args]
   * @returns {boolean}
   */
  emit(type, ...args) {
    let doError = (type === 'error');

    const events = this._events;
    if (events !== undefined) {
      if (doError && events[kErrorMonitor] !== undefined)
        this.emit(kErrorMonitor, ...args);
      doError = (doError && events.error === undefined);
    } else if (!doError)
      return false;

    // If there is no 'error' event listener then throw.
    if (doError) {
      throwErrorOnMissingErrorHandler(args);
    }

    const handler = events[type];

    if (handler === undefined)
      return false;

    if (typeof handler === 'function') {
      const result = handler.apply(this, args);

      // We check if result is undefined first because that
      // is the most common case so we do not pay any perf
      // penalty
      if (result !== undefined && result !== null) {
        addCatch(this, result, type, args);
      }
    } else {
      const len = handler.length;
      const listeners = arrayClone(handler);
      for (let i = 0; i < len; ++i) {
        const result = listeners[i].apply(this, args);

        // We check if result is undefined first because that
        // is the most common case so we do not pay any perf
        // penalty.
        // This code is duplicated because extracting it away
        // would make it non-inlineable.
        if (result !== undefined && result !== null) {
          addCatch(this, result, type, args);
        }
      }
    }

    return true;
  };

  /**
   * Adds a listener to the event emitter.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {EventEmitter}
   */
  addListener(type, listener, prepend) {
    let m;
    let events;
    let existing;

    events = this._events;
    if (events === undefined) {
      events = this._events = {__proto__: null};
      this._eventsCount = 0;
    } else {
      // To avoid recursion in the case that type === "newListener"! Before
      // adding it to the listeners, first emit "newListener".
      if (events.newListener !== undefined) {
        // TODO - emit this to be the eventEmitterTranslationLayer
        this.eventEmitterTranslationLayer.emit('newListener', type,
          listener.listener ?? listener);

        // Re-assign `events` because a newListener handler could have caused the
        // this._events to be assigned to a new object
        events = this._events;
      }
      existing = events[type];
    }

    if (existing === undefined) {
      // Optimize the case of one listener. Don't need the extra array object.
      events[type] = listener;
      ++this._eventsCount;
    } else {
      if (typeof existing === 'function') {
        // Adding the second element, need to change to array.
        existing = events[type] =
          prepend ? [listener, existing] : [existing, listener];
        // If we've already got an array, just append.
      } else if (prepend) {
        existing.unshift(listener);
      } else {
        existing.push(listener);
      }

      // Check for listener leak
      // TODO - move away from this
      m = _getMaxListeners(this);
      if (m > 0 && existing.length > m && !existing.warned) {
        existing.warned = true;
        // No error code for this since it is a Warning
        const w = genericNodeError(
          `Possible EventEmitter memory leak detected. ${existing.length} ${String(type)} listeners ` +
          `added to ${inspect(target, {depth: -1})}. Use emitter.setMaxListeners() to increase limit`,
          {name: 'MaxListenersExceededWarning', emitter: target, type: type, count: existing.length});
        process.emitWarning(w);
      }
    }

    return this;
  }

  /**
   * Removes the specified `listener`.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {EventEmitter}
   */
  removeListener(type, listener) {
    const events = this._events;
    if (events === undefined)
      return undefined;

    const list = events[type];
    if (list === undefined)
      return undefined;

    if (list === listener || list.listener === listener) {
      this._eventsCount -= 1;

      if (this[kShapeMode]) {
        events[type] = undefined;
      } else if (this._eventsCount === 0) {
        this._events = {__proto__: null};
      } else {
        delete events[type];
        if (events.removeListener)
          this.emit('removeListener', type, list.listener || listener);
      }
    } else if (typeof list !== 'function') {
      let position = -1;

      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === listener || list[i].listener === listener) {
          position = i;
          break;
        }
      }

      if (position < 0)
        return this;

      if (position === 0)
        list.shift();
      else {
        if (spliceOne === undefined)
          spliceOne = require('internal/util').spliceOne;
        spliceOne(list, position);
      }

      if (list.length === 1)
        events[type] = list[0];

      if (events.removeListener !== undefined)
        this.emit('removeListener', type, listener);
    }

    return undefined;
  };

  /**
   * Removes all listeners from the event emitter. (Only
   * removes listeners for a specific event name if specified
   * as `type`).
   * @param {string | symbol} [type]
   * @returns {EventEmitter}
   */
  removeAllListeners(type) {
    const events = this._events;
    if (events === undefined)
      return undefined;

    // Not listening for removeListener, no need to emit
    if (events.removeListener === undefined) {
      if (arguments.length === 0) {
        this._events = {__proto__: null};
        this._eventsCount = 0;
      } else if (events[type] !== undefined) {
        if (--this._eventsCount === 0)
          this._events = {__proto__: null};
        else
          delete events[type];
      }
      this[kShapeMode] = false;
      return undefined;
    }

    // Emit removeListener for all listeners on all events
    if (arguments.length === 0) {
      for (const key of ReflectOwnKeys(events)) {
        if (key === 'removeListener') continue;
        this.removeAllListeners(key);
      }
      this.removeAllListeners('removeListener');
      this._events = {__proto__: null};
      this._eventsCount = 0;
      this[kShapeMode] = false;
      return undefined;
    }

    const listeners = events[type];

    if (typeof listeners === 'function') {
      this.removeListener(type, listeners);
    } else if (listeners !== undefined) {
      // LIFO order
      for (let i = listeners.length - 1; i >= 0; i--) {
        this.removeListener(type, listeners[i]);
      }
    }

    return undefined;
  };
}

module.exports = SlowEventEmitter;

// TODO - move this to parent
// The default for captureRejections is false
ObjectDefineProperty(SlowEventEmitter.prototype, kCapture, {
  __proto__: null,
  value: false,
  writable: true,
  enumerable: false,
});

function addCatch(that, promise, type, args) {
  if (!that[kCapture]) {
    return;
  }

  // Handle Promises/A+ spec, then could be a getter
  // that throws on second use.
  try {
    const then = promise.then;

    if (typeof then === 'function') {
      then.call(promise, undefined, function (err) {
        // The callback is called with nextTick to avoid a follow-up
        // rejection from this promise.
        process.nextTick(emitUnhandledRejectionOrErr, that, err, type, args);
      });
    }
  } catch (err) {
    that.emit('error', err);
  }
}

function emitUnhandledRejectionOrErr(ee, err, type, args) {
  if (typeof ee[kRejection] === 'function') {
    ee[kRejection](err, type, ...args);
  } else {
    // We have to disable the capture rejections mechanism, otherwise
    // we might end up in an infinite loop.
    const prev = ee[kCapture];

    // If the error handler throws, it is not catchable and it
    // will end up in 'uncaughtException'. We restore the previous
    // value of kCapture in case the uncaughtException is present
    // and the exception is handled.
    try {
      ee[kCapture] = false;
      ee.emit('error', err);
    } finally {
      ee[kCapture] = prev;
    }
  }
}
