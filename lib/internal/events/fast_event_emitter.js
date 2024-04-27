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
  FunctionPrototypeCall,
  ObjectGetPrototypeOf,
  ReflectOwnKeys,
} = primordials;

const {
  kShapeMode,
} = require('internal/events/symbols');
const {throwErrorOnMissingErrorHandler} = require('internal/events/internal_event_emitter_helpers');


// TODO - should have the same API as slow_event_emitter

// TODO - not supporting
//  1. kCapture - false by default
//  2. _maxListeners (but still need to save the data), should be saved on the parent
//  3. kErrorMonitor - undefined by default
// TODO - add comment for what this is optimized for
class FastEventEmitter {
  // TODO - have a way to support passing _events
  // TODO - add comment on how events are stored
  _events = undefined;
  _eventsCount
  // TODO - convert to symbol and rename
  eventEmitterTranslationLayer = undefined;

  // TODO - use opts
  constructor(eventEmitterTranslationLayer, opts) {
    this.eventEmitterTranslationLayer = eventEmitterTranslationLayer;
    // TODO - check this:
    // If you're updating this function definition, please also update any
    // re-definitions, such as the one in the Domain module (lib/domain.js).
    if (this._events === undefined ||
      // TODO - this is not correct
      // TODO - change the this here?
      this._events === ObjectGetPrototypeOf(this)._events) {
      // TODO - removed the __proto__ assignment
      this._events = {  };
      this._eventsCount = 0;
      this[kShapeMode] = false;
    } else {
      this[kShapeMode] = true;
    }
  }

  /**
   * Synchronously calls each of the listeners registered
   * for the event.
   * @param {string | symbol} type
   * @param {...any} [args]
   * @returns {boolean}
   */
  emit(type, ...args) {
    const events = this._events;
    if(type === 'error' && events?.error === undefined) {
      throwErrorOnMissingErrorHandler.apply(this, args);
      return;
    }

    // TODO(rluvaton): will it be faster to add check if events is undefined instead?
    const handler = events?.[type];

    if(handler === undefined) {
      return false;
    }

    // TODO - change
    handler.apply(this.eventEmitterTranslationLayer, args);

    return true;
  };

  // TODO - should switch to slow mode
  isListenerAlreadyExists(type) {
    return this._events?.[type] !== undefined;
  }

  /**
   * Adds a listener to the event emitter.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {EventEmitter}
   */
  addListener(type, listener) {
    // TODO - add validation before getting here
    // TODO - if got here that can add without switching to slow mode
    let events;

    events = this._events;
    // TODO - simplify this
    if (events === undefined) {
      events = this._events = {
        // TODO - change this?
        __proto__: null
      };
      this._eventsCount = 0;
    } else {
      // To avoid recursion in the case that type === "newListener"! Before
      // adding it to the listeners, first emit "newListener".
      if (events.newListener !== undefined) {
        // TODO(rluvaton): use apply to pass the parent eventEmitter
        this.emit('newListener', type,
          listener.listener ?? listener);

        // Re-assign `events` because a newListener handler could have caused the
        // this._events to be assigned to a new object
        // TODO(rluvaton): change this
        events = this._events;
      }
    }

    // Optimize the case of one listener. Don't need the extra array object.
    events[type] = listener;
    ++this._eventsCount;

    return target;
  }

  /**
   * Removes the specified `listener`.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {EventEmitter}
   */
  removeListener(type, listener) {
    // TODO - add validation before getting here
    // TODO - parent function should return `this`

    const events = this._events;
    if (events === undefined)
      return undefined;

    const list = events[type];
    if (list === undefined || (list !== listener && list.listener !== listener))
      return undefined;

    this._eventsCount -= 1;

    if (this[kShapeMode]) {
      events[type] = undefined;
    } else if (this._eventsCount === 0) {
      // TODO - keep this?
      this._events = {__proto__: null};
    } else {
      delete events[type];
      if (events.removeListener)
      // TODO(rluvaton): use apply to pass the parent eventEmitter
        this.emit('removeListener', type, list.listener || listener);
    }
  };

  /**
   * Removes all listeners from the event emitter. (Only
   * removes listeners for a specific event name if specified
   * as `type`).
   * @param {string | symbol} [type]
   * @returns {EventEmitter}
   */
  removeAllListeners(type) {
    // TODO - parent function should return `this`
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
    }
  };

  listeners(type, unwrap) {
    const events = this._events;

    if (events === undefined)
      return [];

    const evlistener = events[type];
    if (evlistener === undefined)
      return [];

    return unwrap ? [evlistener.listener || evlistener] : [evlistener];
  }


  /**
   * Returns the number of listeners listening to event name
   * specified as `type`.
   * @param {string | symbol} type
   * @param {Function} listener
   * @returns {number}
   */
  listenerCount(type, listener) {
    const evlistener = this._events?.[type];

    if(evlistener === undefined) {
      return 0;
    }

    if (listener != null) {
      return listener === evlistener || listener === evlistener.listener ? 1 : 0;
    }

    return 1;
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

