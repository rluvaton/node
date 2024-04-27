'use strict';

const {
  Symbol,
  SymbolFor
} = primordials;

const kFirstEventParam = Symbol('nodejs.kFirstEventParam');

const kRejection = SymbolFor('nodejs.rejection');
const kCapture = Symbol('kCapture');
const kErrorMonitor = Symbol('events.errorMonitor');
const kShapeMode = Symbol('shapeMode');
const kMaxEventTargetListeners = Symbol('events.maxEventTargetListeners');
const kMaxEventTargetListenersWarned =
  Symbol('events.maxEventTargetListenersWarned');

module.exports = {
  kFirstEventParam,
  kRejection,
  kCapture,
  kErrorMonitor,
  kShapeMode,
  kMaxEventTargetListeners,
  kMaxEventTargetListenersWarned
};
