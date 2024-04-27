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
  ArrayPrototypeJoin,
  ArrayPrototypeSlice,
  ArrayPrototypeSplice,
  Boolean,
  Error,
  ErrorCaptureStackTrace,
  FunctionPrototypeBind,
  FunctionPrototypeCall,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectGetPrototypeOf,
  ReflectOwnKeys,
  String,
  StringPrototypeSplit,
} = primordials;

const {
  inspect,
  identicalSequenceRange,
} = require('internal/util/inspect');

let spliceOne;

const {
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_UNHANDLED_ERROR,
  },
  genericNodeError,
  kEnhanceStackBeforeInspector,
} = require('internal/errors');

const {
  validateBoolean,
  validateFunction,
  validateNumber,
} = require('internal/validators');
const {
  kRejection,
  kCapture,
  kErrorMonitor,
  kShapeMode,
  kMaxEventTargetListeners,
  kMaxEventTargetListenersWarned
} = require('internal/events/symbols');
const {throwErrorOnMissingErrorHandler} = require("internal/events/internal_event_emitter_helpers");

let EventEmitterAsyncResource;
// The EventEmitterAsyncResource has to be initialized lazily because event.js
// is loaded so early in the bootstrap process, before async_hooks is available.
//
// This implementation was adapted straight from addaleax's
// eventemitter-asyncresource MIT-licensed userland module.
// https://github.com/addaleax/eventemitter-asyncresource
function lazyEventEmitterAsyncResource() {
  EventEmitterAsyncResource ??= require('internal/events/event_emitter_async_resource');
  return EventEmitterAsyncResource;
}


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
  // TODO - should be in the parent
  _maxListeners = undefined;
  // TODO - convert to symbol and rename
  eventEmitterTranslationLayer = undefined;


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
      let er;
      if (args.length > 0)
        er = args[0];
      if (er instanceof Error) {
        try {
          const capture = {};
          ErrorCaptureStackTrace(capture, EventEmitter.prototype.emit);
          ObjectDefineProperty(er, kEnhanceStackBeforeInspector, {
            __proto__: null,
            value: FunctionPrototypeBind(enhanceStackTrace, this, er, capture),
            configurable: true,
          });
        } catch {
          // Continue regardless of error.
        }

        // Note: The comments on the `throw` lines are intentional, they show
        // up in Node's output if this results in an unhandled exception.
        throw er; // Unhandled 'error' event
      }

      let stringifiedEr;
      try {
        stringifiedEr = inspect(er);
      } catch {
        stringifiedEr = er;
      }

      // At least give some kind of context to the user
      const err = new ERR_UNHANDLED_ERROR(stringifiedEr);
      err.context = er;
      throw err; // Unhandled 'error' event
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
      events = this._events = { __proto__: null };
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
          `added to ${inspect(target, { depth: -1 })}. Use emitter.setMaxListeners() to increase limit`,
          { name: 'MaxListenersExceededWarning', emitter: target, type: type, count: existing.length });
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
    // TODO - parent should return this and validate
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
        this._events = { __proto__: null };
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
    // TODO - parent should return this
    const events = this._events;
    if (events === undefined)
      return undefined;

    // Not listening for removeListener, no need to emit
    if (events.removeListener === undefined) {
      if (arguments.length === 0) {
        this._events = { __proto__: null };
        this._eventsCount = 0;
      } else if (events[type] !== undefined) {
        if (--this._eventsCount === 0)
          this._events = { __proto__: null };
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
      this._events = { __proto__: null };
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

  listeners(type, unwrap) {
    const events = this._events;

    if (events === undefined)
      return [];

    const evlistener = events[type];
    if (evlistener === undefined)
      return [];

    if (typeof evlistener === 'function')
      return unwrap ? [evlistener.listener || evlistener] : [evlistener];

    return unwrap ?
      unwrapListeners(evlistener) : arrayClone(evlistener);
  }


  /**
   * Returns the number of listeners listening to event name
   * specified as `type`.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {number}
   */
  listenerCount(type, listener) {
    const events = this._events;

    if (events !== undefined) {
      const evlistener = events[type];

      if (typeof evlistener === 'function') {
        if (listener != null) {
          return listener === evlistener || listener === evlistener.listener ? 1 : 0;
        }

        return 1;
      } else if (evlistener !== undefined) {
        if (listener != null) {
          let matching = 0;

          for (let i = 0, l = evlistener.length; i < l; i++) {
            if (evlistener[i] === listener || evlistener[i].listener === listener) {
              matching++;
            }
          }

          return matching;
        }

        return evlistener.length;
      }
    }

    return 0;
  }

  /**
   * Returns an array listing the events for which
   * the emitter has registered listeners.
   * @returns {any[]}
   */
  eventNames() {
    return this._eventsCount > 0 ? ReflectOwnKeys(this._events) : [];
  };
}

// TODO(rluvaton) - change this to fast and slow event emitter
/**
 * Creates a new `EventEmitter` instance.
 * @param {{ captureRejections?: boolean; }} [opts]
 * @constructs {EventEmitter}
 */
function EventEmitter(opts) {
  EventEmitter.init.call(this, opts);
}
module.exports = {
  SlowEventEmitter
};

// The default for captureRejections is false
ObjectDefineProperty(SlowEventEmitter.prototype, kCapture, {
  __proto__: null,
  value: false,
  writable: true,
  enumerable: false,
});

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
let defaultMaxListeners = 10;
let isEventTarget;

function checkListener(listener) {
  validateFunction(listener, 'listener');
}


// If you're updating this function definition, please also update any
// re-definitions, such as the one in the Domain module (lib/domain.js).
EventEmitter.init = function(opts) {
  // TODO - change this

  if (this._events === undefined ||
      this._events === ObjectGetPrototypeOf(this)._events) {
    this._events = { __proto__: null };
    this._eventsCount = 0;
    this[kShapeMode] = false;
  } else {
    this[kShapeMode] = true;
  }

  this._maxListeners = this._maxListeners || undefined;


  if (opts?.captureRejections) {
    validateBoolean(opts.captureRejections, 'options.captureRejections');
    this[kCapture] = Boolean(opts.captureRejections);
  } else {
    // Assigning the kCapture property directly saves an expensive
    // prototype lookup in a very sensitive hot path.
    this[kCapture] = EventEmitter.prototype[kCapture];
  }
};

function addCatch(that, promise, type, args) {
  if (!that[kCapture]) {
    return;
  }

  // Handle Promises/A+ spec, then could be a getter
  // that throws on second use.
  try {
    const then = promise.then;

    if (typeof then === 'function') {
      then.call(promise, undefined, function(err) {
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


function _getMaxListeners(that) {
  if (that._maxListeners === undefined)
    return EventEmitter.defaultMaxListeners;
  return that._maxListeners;
}

function enhanceStackTrace(err, own) {
  let ctorInfo = '';
  try {
    const { name } = this.constructor;
    if (name !== 'EventEmitter')
      ctorInfo = ` on ${name} instance`;
  } catch {
    // Continue regardless of error.
  }
  const sep = `\nEmitted 'error' event${ctorInfo} at:\n`;

  const errStack = ArrayPrototypeSlice(
    StringPrototypeSplit(err.stack, '\n'), 1);
  const ownStack = ArrayPrototypeSlice(
    StringPrototypeSplit(own.stack, '\n'), 1);

  const { len, offset } = identicalSequenceRange(ownStack, errStack);
  if (len > 0) {
    ArrayPrototypeSplice(ownStack, offset + 1, len - 2,
                         '    [... lines matching original stack trace ...]');
  }

  return err.stack + sep + ArrayPrototypeJoin(ownStack, '\n');
}

function arrayClone(arr) {
  // At least since V8 8.3, this implementation is faster than the previous
  // which always used a simple for-loop
  switch (arr.length) {
    case 2: return [arr[0], arr[1]];
    case 3: return [arr[0], arr[1], arr[2]];
    case 4: return [arr[0], arr[1], arr[2], arr[3]];
    case 5: return [arr[0], arr[1], arr[2], arr[3], arr[4]];
    case 6: return [arr[0], arr[1], arr[2], arr[3], arr[4], arr[5]];
  }
  return ArrayPrototypeSlice(arr);
}

function unwrapListeners(arr) {
  const ret = arrayClone(arr);
  for (let i = 0; i < ret.length; ++i) {
    const orig = ret[i].listener;
    if (typeof orig === 'function')
      ret[i] = orig;
  }
  return ret;
}
