'use strict';

const {
  ArrayPrototypeJoin,
  ArrayPrototypeSlice,
  ArrayPrototypeSplice,
  Error,
  ErrorCaptureStackTrace,
  FunctionPrototypeBind,
  ObjectDefineProperty,
  StringPrototypeSplit,
} = primordials;

const {
  codes: {
    ERR_UNHANDLED_ERROR,
  },
} = require('internal/errors');


const {kEnhanceStackBeforeInspector} = require("internal/errors");
const {inspect, identicalSequenceRange} = require("internal/util/inspect");

let EventEmitter;

// TODO - move this to a different file
// TODO - rename
function throwErrorOnMissingErrorHandler(args) {
  let er;
  if (args.length > 0)
    er = args[0];

  if (er instanceof Error) {
    try {
      const capture = {};
      EventEmitter ??= require('internal/events/event_emitter').EventEmitter;
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


// TODO - move this
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


module.exports = {
  throwErrorOnMissingErrorHandler
};
