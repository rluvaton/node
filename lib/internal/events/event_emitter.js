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
  Boolean,
  FunctionPrototypeCall,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectGetPrototypeOf,
  ReflectOwnKeys,
} = primordials;


const {
  codes: {
    ERR_INVALID_ARG_TYPE,
  },
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

const FastEventEmitter = require('internal/events/fast_event_emitter');
const SlowEventEmitter = require("internal/events/slow_event_emitter");
const {arrayClone, _getMaxListeners} = require("internal/events/internal_event_emitter_helpers");

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

/**
 * Creates a new `EventEmitter` instance.
 * @param {{ captureRejections?: boolean; }} [opts]
 * @constructs {EventEmitter}
 */
// function EventEmitter(opts) {
//   EventEmitter.init.call(this, opts);
// }

module.exports = {
  EventEmitter,
  _getMaxListeners,
};
// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.usingDomains = false;

EventEmitter.captureRejectionSymbol = kRejection;
ObjectDefineProperty(EventEmitter, 'captureRejections', {
  __proto__: null,
  get() {
    return EventEmitter.prototype[kCapture];
  },
  set(value) {
    validateBoolean(value, 'EventEmitter.captureRejections');

    EventEmitter.prototype[kCapture] = value;
  },
  enumerable: true,
});

ObjectDefineProperty(EventEmitter, 'EventEmitterAsyncResource', {
  __proto__: null,
  enumerable: true,
  get: lazyEventEmitterAsyncResource,
  set: undefined,
  configurable: true,
});

// TODO(rluvaton): support changing error monitor on events
EventEmitter.errorMonitor = kErrorMonitor;


// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
let defaultMaxListeners = 10;
let isEventTarget;

function checkListener(listener) {
  validateFunction(listener, 'listener');
}

ObjectDefineProperty(EventEmitter, 'defaultMaxListeners', {
  __proto__: null,
  enumerable: true,
  get: function () {
    return defaultMaxListeners;
  },
  set: function (arg) {
    validateNumber(arg, 'defaultMaxListeners', 0);
    defaultMaxListeners = arg;
  },
});

ObjectDefineProperties(EventEmitter, {
  kMaxEventTargetListeners: {
    __proto__: null,
    value: kMaxEventTargetListeners,
    enumerable: false,
    configurable: false,
    writable: false,
  },
  kMaxEventTargetListenersWarned: {
    __proto__: null,
    value: kMaxEventTargetListenersWarned,
    enumerable: false,
    configurable: false,
    writable: false,
  },
});

/**
 * Sets the max listeners.
 * @param {number} n
 * @param {EventTarget[] | EventEmitter[]} [eventTargets]
 * @returns {void}
 */
EventEmitter.setMaxListeners =
  function (n = defaultMaxListeners, ...eventTargets) {
    validateNumber(n, 'setMaxListeners', 0);
    if (eventTargets.length === 0) {
      defaultMaxListeners = n;
    } else {
      if (isEventTarget === undefined)
        isEventTarget = require('internal/event_target').isEventTarget;

      for (let i = 0; i < eventTargets.length; i++) {
        const target = eventTargets[i];
        if (isEventTarget(target)) {
          target[kMaxEventTargetListeners] = n;
          target[kMaxEventTargetListenersWarned] = false;
        } else if (typeof target.setMaxListeners === 'function') {
          target.setMaxListeners(n);
        } else {
          throw new ERR_INVALID_ARG_TYPE(
            'eventTargets',
            ['EventEmitter', 'EventTarget'],
            target);
        }
      }
    }
  };

// If you're updating this function definition, please also update any
// re-definitions, such as the one in the Domain module (lib/domain.js).
EventEmitter.init = function (opts) {
  // TODO - update this
  if (this._events === undefined ||
    // TODO - find a better way to check this
    this._events === ObjectGetPrototypeOf(this)._events) {
    this._events = {__proto__: null};
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

function onceWrapper() {
  if (!this.fired) {
    this.target.removeListener(this.type, this.wrapFn);
    this.fired = true;
    if (arguments.length === 0)
      return this.listener.call(this.target);
    return this.listener.apply(this.target, arguments);
  }
}

function _onceWrap(target, type, listener) {
  const state = {fired: false, wrapFn: undefined, target, type, listener};
  const wrapped = onceWrapper.bind(state);
  wrapped.listener = listener;
  state.wrapFn = wrapped;
  return wrapped;
}

function _listeners(target, type, unwrap) {
  const events = target._events;

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


function unwrapListeners(arr) {
  const ret = arrayClone(arr);
  for (let i = 0; i < ret.length; ++i) {
    const orig = ret[i].listener;
    if (typeof orig === 'function')
      ret[i] = orig;
  }
  return ret;
}

/**
 * Returns the number of listeners listening to the event name
 * specified as `type`.
 * @deprecated since v3.2.0
 * @param {EventEmitter} emitter
 * @param {string | symbol} type
 * @returns {number}
 */
EventEmitter.listenerCount = function (emitter, type) {
  if (typeof emitter.listenerCount === 'function') {
    return emitter.listenerCount(type);
  }
  return FunctionPrototypeCall(listenerCount, emitter, type);
};


/**
 * Returns the number of listeners listening to event name
 * specified as `type`.
 * @param {string | symbol} type
 * @param {Function} listener
 * @returns {number}
 */
function listenerCount(type, listener) {
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

const kImpl = Symbol('kImpl');
const kCaptureValue = Symbol('kCaptureValue');
const kIsFastPath = Symbol('kIsFastPath');
const kSwitchToSlowPath = Symbol('kSwitchToSlowPath');

// TODO - change this back to function prototype
class EventEmitter {
  [kImpl] = undefined;
  [kIsFastPath] = true;
  [kCaptureValue] = false;

  _maxListeners = 0;

  // TODO - backwards compat
  get _eventsCount() {
    return this[kImpl]._eventsCount;
  }

  set _eventsCount(n) {
    // TODO - deprecate this
    this[kImpl]._eventsCount = n;
  }

  get _events() {
    return this[kImpl]._events;
  }

  set _events(events) {
    // TODO - might need to change to slow path
    // TODO - deprecate this
    this[kImpl]._events = events;
  }

  // TODO - add backwards compat

  constructor(opt) {
    this[kImpl] = new FastEventEmitter(this, opt);
    this[kIsFastPath] = true;
    // TODO - call init
  }

  /**
   * Increases the max listeners of the event emitter.
   * @param {number} n
   * @returns {EventEmitter}
   */
  setMaxListeners(n) {
    validateNumber(n, 'setMaxListeners', 0);
    this._maxListeners = n;
    return this;
  }

  /**
   * Returns the current max listener value for the event emitter.
   * @returns {number}
   */
  getMaxListeners() {
    return _getMaxListeners(this);
  }

  /**
   * Synchronously calls each of the listeners registered
   * for the event.
   * @param {string | symbol} type
   * @param {...any} [args]
   * @returns {boolean}
   */
  emit(type, ...args) {
    return this[kImpl].emit(type, ...args);
  }

  /**
   * Adds a listener to the event emitter.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {EventEmitter}
   */
  addListener(type, listener) {
    checkListener(listener);

    if(this[kIsFastPath] && this[kImpl].isListenerAlreadyExists(type)) {
      this[kSwitchToSlowPath]();
    }

    return this[kImpl].addListener(type, listener);
  }

  /**
   * Adds a listener to the event emitter.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {EventEmitter}
   */
  // TODO - change to on = addListener
  on(type, listener) {
    checkListener(listener);

    if(this[kIsFastPath] && this[kImpl].isListenerAlreadyExists(type)) {
      this[kSwitchToSlowPath]();
    }

    return this[kImpl].addListener(type, listener);
  }


  /**
   * Adds the `listener` function to the beginning of
   * the listeners array.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {EventEmitter}
   */
  prependListener(type, listener) {
    checkListener(listener);

    if(this[kIsFastPath] && this[kImpl].isListenerAlreadyExists(type)) {
      this[kSwitchToSlowPath]();
    }

    return this[kImpl].addListener(type, listener, true);
  }


  /**
   * Adds a one-time `listener` function to the event emitter.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {EventEmitter}
   */
  once(type, listener) {
    checkListener(listener);

    this.on(type, _onceWrap(this, type, listener));
    return this;
  };


  /**
   * Adds a one-time `listener` function to the beginning of
   * the listeners array.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {EventEmitter}
   */
  prependOnceListener(type, listener) {
    checkListener(listener);

    this.prependListener(type, _onceWrap(this, type, listener));
    return this;
  }


  /**
   * Removes the specified `listener` from the listeners array.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {EventEmitter}
   */
  removeListener(type, listener) {
    // TODO - did remove listener had checkListener
    checkListener(listener);

    this[kImpl].removeListener(type, listener);

    return this;
  }

  // TODO - EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
  off(type, listener) {
    // TODO - did remove listener had checkListener
    checkListener(listener);

    this[kImpl].removeListener(type, listener);

    return this;
  }

  /**
   * Removes all listeners from the event emitter. (Only
   * removes listeners for a specific event name if specified
   * as `type`).
   * @param {string | symbol} [type]
   * @returns {EventEmitter}
   */
  removeAllListeners(type) {
    this[kImpl].removeAllListeners(type);
    return this;
  }

  /**
   * Returns a copy of the array of listeners for the event name
   * specified as `type`.
   * @param {string | symbol} type
   * @returns {Function[]}
   */
  listeners(type) {
    return _listeners(this, type, true);
  };

  /**
   * Returns a copy of the array of listeners and wrappers for
   * the event name specified as `type`.
   * @param {string | symbol} type
   * @returns {Function[]}
   */
  rawListeners(type) {
    return _listeners(this, type, false);
  };


  /**
   * Returns the number of listeners listening to event name
   * specified as `type`.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {number}
   */
  listenerCount(type, listener) {
    // TODO - change this back to prototype
    return listenerCount.call(this, type, listener);
  }

  /**
   * Returns an array listing the events for which
   * the emitter has registered listeners.
   * @returns {any[]}
   */
  eventNames() {
    return this._eventsCount > 0 ? ReflectOwnKeys(this._events) : [];
  };

  [kSwitchToSlowPath]() {
    if(!this[kIsFastPath]) {
      return;
    }

    this[kIsFastPath] = false;
    this[kImpl] = SlowEventEmitter.fromFastEventEmitter(this[kImpl]);
  }
}

// The default for captureRejections is false
ObjectDefineProperty(EventEmitter.prototype, kCapture, {
  __proto__: null,
  get() {
    return this[kCaptureValue];
  },
  set(value) {
    this[kCaptureValue] = value;

    if (value) {
      this[kSwitchToSlowPath]();
    }
  },
  writable: true,
  enumerable: false,
});
