'use strict';
/**
 * nurpc contains constants and functions shared by other modules in the nurpc
 * package.
 *
 * @module nurpc
 */

var _ = require('lodash');
var util = require('util');

// Public API
// ==========

// The main governing power behind the nurpc API design is that it provides
// elements similar to the existing node.js [HTTP2 API][1], node-http2, (which
// is in turn very similar to the [HTTPS API][2]).
//
// In part, the similarity comes from re-use of classes defined in
// node-http2.  In other cases the classes have been copied and modified to
// enforce restrictions in how nurpc uses HTTP2.
//
// In addition, these elements have aliases corresponding to theirs names
// in other nurpc implementations.
//
// [1]: https://github.com/molnarg/node-http2
// [2]: http://nodejs.org/api/http.html
// [3]: http://tools.ietf.org/html/draft-ietf-httpbis-http2-16#section-8.1.2.4

/**
 * reservedHeaders are header names reserved for use by the rpc protocol.
 *
 * @constant
 * @type {string[]}
 */
exports.reservedHeaders = Object.freeze([
  'content-type',
  'grpc-encoding',
  'grpc-message',
  'grpc-message-type',
  'grpc-status',
  'grpc-timeout',
  'te',
  'user-agent'
]);
var reservedHeaders = exports.reservedHeaders;

/**
 * deprecatedHeaders are header names that should not be appear in http2
 * requests.
 *
 * This list is needed here because the http2 package defines it too strictly.
 * In http2, it includes the 'te' header, but that it allowed and is used by the
 * rpc protocol.
 *
 * This list is used in internal replacements of the relevant functions in http2
 * by nurpc.
 *
 * @constant
 * @type {string[]}
 */
exports.deprecatedHeaders = Object.freeze([
  'connection',
  'host',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade'
]);

/**
 * Determines if h is a HTTP2 'reserved' header.
 *
 * All rpc metadata is propagated as headers. Some header names are reserved for
 * used by http2 or by the rpc protocol.
 *
 * @param {string} h a header name
 * @result {boolean} true if a h is special header
 */
exports.isReservedHeader = function isReservedHeader(h) {
  return h[0] === ':' || reservedHeaders.indexOf(h) > -1;
}

/**
 * rpcCodes are the cannonical rpc codes used in to indicate status of rpcs.
 *
 * The order of each name in the array significant, indexOf('A_CODE') gives the
 * actual error code value.
 *
 * @constant
 * @type {string[]}
 */
exports.rpcCodes = Object.freeze([
  // OK is returned on success.
  'OK',

  // CANCELLED indicates the operation was cancelled (typically by the caller).
  'CANCELLED',

  // UNKNOWN error.  An example of where this error may be returned is if a
  // Status value received from another address space belongs to an error-space
  // that is not known in this address space.  Also errors raised by APIs that
  // do not return enough error information may be converted to this error.
  'UNKNOWN',

  // INVALID_ARGUMENT indicates client specified an invalid argument.  Note that
  // this differs from FailedPrecondition. It indicates arguments that are
  // problematic regardless of the state of the system (e.g., a malformed file
  // name).
  'INVALID_ARGUMENT',

  // DEADLINE_EXCEEDED means operation expired before completion.  For operations
  // that change the state of the system, this error may be returned even if the
  // operation has completed successfully. For example, a successful response
  // from a server could have been delayed long enough for the deadline to
  // expire.
  'DEADLINE_EXCEEDED',

  // NOT_FOUND means some requested entity (e.g., file or directory) was not
  // found.
  'NOT_FOUND',

  // ALREADY_EXISTS means an attempt to create an entity failed because one
  // already exists.
  'ALREADY_EXISTS',

  // PERMISSION_DENIED indicates the caller does not have permission to execute
  // the specified operation. It must not be used for rejections caused by
  // exhausting some resource (use ResourceExhausted instead for those errors).
  // It must not be used if the caller cannot be identified (use Unauthenticated
  // instead for those errors).
  'PERMISSION_DENIED',

  // RESOURCE_EXHAUSTED indicates some resource has been exhausted, perhaps a
  // per-user quota, or perhaps the entire file system is out of space.
  'RESOURCE_EXHAUSTED',

  // FAILED_PRECONDITION indicates operation was rejected because the system is
  // not in a state required for the operation's execution.  For example,
  // directory to be deleted may be non-empty, an rmdir operation is applied to
  // a non-directory, etc.
  //
  // A litmus test that may help a service implementor in deciding between
  // FailedPrecondition, Aborted, and Unavailable:
  //
  //  (a) Use Unavailable if the client can retry just the failing call.
  //  (b) Use Aborted if the client should retry at a higher-level (e.g.,
  //      restarting a read-modify-write sequence).
  //  (c) Use FailedPrecondition if the client should not retry until the system
  //      state has been explicitly fixed.  E.g., if an "rmdir" fails because
  //      the directory is non-empty, FailedPrecondition should be returned
  //      since the client should not retry unless they have first fixed up the
  //      directory by deleting files from it.
  //  (d) Use FailedPrecondition if the client performs conditional REST
  //      Get/Update/Delete on a resource and the resource on the server does
  //      not match the condition. E.g., conflicting read-modify-write on the
  //      same resource.
  'FAILED_PRECONDITION',

  // ABORTED indicates the operation was aborted, typically due to a
  // concurrency issue like sequencer check failures, transaction aborts,
  // etc.
  //
  // See litmus test above for deciding between FailedPrecondition,
  // Aborted, and Unavailable.
  'ABORTED',

  // OUT_OF_RANGE means operation was attempted past the valid range.  E.g.,
  // seeking or reading past end of file.
  //
  // Unlike InvalidArgument, this error indicates a problem that may be fixed if
  // the system state changes. For example, a 32-bit file system will generate
  // InvalidArgument if asked to read at an offset that is not in the range
  // [0,2^32-1], but it will generate OutOfRange if asked to read from an offset
  // past the current file size.
  //
  // There is a fair bit of overlap between FailedPrecondition and OutOfRange.
  // We recommend using OutOfRange (the more specific error) when it applies so
  // that callers who are iterating through a space can easily look for an
  // OutOfRange error to detect when they are done.
  'OUT_OF_RANGE',

  // UNIMPLEMENTED indicates operation is not implemented or not
  // supported/enabled in this service.
  'UNIMPLEMENTED',

  // INTERNAL errors.  Means some invariants expected by underlying
  // system has been broken.  If you see one of these errors,
  // something is very broken.
  'INTERNAL',

  // UNAVAILABLE indicates the service is currently unavailable.
  // This is a most likely a transient condition and may be corrected
  // by retrying with a backoff.
  //
  // See litmus test above for deciding between FailedPrecondition,
  // Aborted, and Unavailable.
  'UNAVAILABLE',

  // DATA_LOSS indicates unrecoverable data loss or corruption.
  'DATA_LOSS',

  // UNAUTHENTICATED indicates the request does not have valid authentication
  // credentials for the operation.
  'UNAUTHENTICATED'
]);
var rpcCodes = exports.rpcCodes;

/**
 * Converts the error code name to it the actual code
 *
 * @param {string} name the cannonical name of an rpc code.
 * @returns {number} the integer value for the rpc code.
 * @throws {RangeError} if the name is invalid
 */
exports.rpcCode = function rpcCode(name) {
  var res = rpcCodes.indexOf(name);
  if (res === -1) {
    console.log('Invalid error code name: ', name);
    throw new RangeError('Invalid error code name');
  }
  return res;
}

/**
 * h2Codes is a copy of the http2 error codes array found in
 * node-http2/lib/protocol/framer.js.
 *
 * @description It's derived from [HTTP2 Error Codes](http://goo.gl/S4Lm58). The
 * order of each name in the array significant, indexOf('A_CODE') gives the
 * actual error code value.
 *
 * @constant
 * @type {string[]}
 */
exports.h2Codes = Object.freeze([
  'NO_ERROR',
  'PROTOCOL_ERROR',
  'INTERNAL_ERROR',
  'FLOW_CONTROL_ERROR',
  'SETTINGS_TIMEOUT',
  'STREAM_CLOSED',
  'FRAME_SIZE_ERROR',
  'REFUSED_STREAM',
  'CANCEL',
  'COMPRESSION_ERROR',
  'CONNECT_ERROR',
  'ENHANCE_YOUR_CALM',
  'INADEQUATE_SECURITY',
  'HTTP_1_1_REQUIRED'
]);
var h2Codes = exports.h2Codes;

var notMapped = -1;
var h2ToRpc = _.zipObject([
  [h2Codes.indexOf('NO_ERROR'), rpcCodes.indexOf('INTERNAL')],
  [h2Codes.indexOf('PROTOCOL_ERROR'), rpcCodes.indexOf('INTERNAL')],
  [h2Codes.indexOf('INTERNAL_ERROR'), rpcCodes.indexOf('INTERNAL')],
  [h2Codes.indexOf('FLOW_CONTROL_ERROR'), rpcCodes.indexOf('INTERNAL')],
  [h2Codes.indexOf('SETTINGS_TIMEOUT'), rpcCodes.indexOf('INTERNAL')],
  [h2Codes.indexOf('STREAM_CLOSED'), notMapped],
  [h2Codes.indexOf('HTTP_1_1_REQUIRED'), notMapped],
  [h2Codes.indexOf('FRAME_SIZE_ERROR'), rpcCodes.indexOf('INTERNAL')],
  [h2Codes.indexOf('REFUSED_STREAM'), rpcCodes.indexOf('UNAVAILABLE')],
  [h2Codes.indexOf('CANCEL'), rpcCodes.indexOf('CANCELLED')],
  [h2Codes.indexOf('COMPRESSION_ERROR'), rpcCodes.indexOf('INTERNAL')],
  [h2Codes.indexOf('CONNECT_ERROR'), rpcCodes.indexOf('INTERNAL')],
  [h2Codes.indexOf('ENHANCE_YOUR_CALM'),
   rpcCodes.indexOf('RESOURCE_EXHAUSTED')],
  [h2Codes.indexOf('INADEQUATE_SECURITY'),
   rpcCodes.indexOf('PERMISSION_DENIED')]
]);
var h2Codes = exports.h2Codes;

/**
 * Converts a http2 error code name to an rpc protocol code
name.
 *
 * This is used when constructing a grpc status code when non-OK http2 response
 * is received.
 *
 * @param {string} name the name of http error code
 * @returns {string} the name of the corresponding rpc code
 */
exports.h2NameToRpcName = function h2NameToRpcName(name) {
  var code = h2Codes.indexOf(name);
  var rpcIdx = h2ToRpc[code];
  if (rpcIdx && rpcCodes[rpcIdx]) {
    return rpcCodes[rpcIdx];
  }
  if (rpcIdx == notMapped) {
    return null;
  }
  console.error('Unknown http2 code name', name);
  return 'UNKNOWN';
};

/**
 * cipherSuites is the ciphers recommended when using a secure connection.
 *
 * The list is copied from
 * https://github.com/molnarg/node-http2/blob/master/lib/http.js where it had
 * the following comments:
 *
 * Ciphersuite list based on the recommendations of
 * http://wiki.mozilla.org/Security/Server_Side_TLS
 *
 * The only modification is that kEDH+AESGCM were placed after DHE and ECDHE
 * suites
 *
 * @constant
 * @type {string[]}
 */
exports.cipherSuites = [
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'DHE-RSA-AES128-GCM-SHA256',
  'DHE-DSS-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-SHA256',
  'ECDHE-ECDSA-AES128-SHA256',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-ECDSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA384',
  'ECDHE-ECDSA-AES256-SHA384',
  'ECDHE-RSA-AES256-SHA',
  'ECDHE-ECDSA-AES256-SHA',
  'DHE-RSA-AES128-SHA256',
  'DHE-RSA-AES128-SHA',
  'DHE-DSS-AES128-SHA256',
  'DHE-RSA-AES256-SHA256',
  'DHE-DSS-AES256-SHA',
  'DHE-RSA-AES256-SHA',
  'kEDH+AESGCM',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'ECDHE-RSA-RC4-SHA',
  'ECDHE-ECDSA-RC4-SHA',
  'AES128',
  'AES256',
  'RC4-SHA',
  'HIGH',
  '!aNULL',
  '!eNULL',
  '!EXPORT',
  '!DES',
  '!3DES',
  '!MD5',
  '!PSK'
].join(':');


/**
 * Is an rpc handler that terminates the rpc with rpc code NOT_FOUND.
 *
 * @param {object} request the rpc request
 * @param {object} response the rpc response
 */
exports.notFound = function notFound(request, response) {
  request.unmarshal = response.marshal = _.noop;
  request.once('data', function(data) {
    response.rpcCode = exports.rpcCode('NOT_FOUND');
    response.end('');
  });
};
var notFound = exports.notFound;

/**
 * Creates an rpc handler from other rpc handlers.
 *
 * handlers is an object each of whose properties should be an rpc handler
 * function.  The property name is the route that will dispatch to that
 * handler.
 *
 * If the returned handler is called with an unroute, the fallback handlers is
 * called.
 *
 * @param {object} handlers an object that that maps routes to handlers
 * @param {function(object, object)} [opt_fallback=notFound] handles unknown
 */
exports.makeDispatcher = function makeDispatcher(handlers, opt_fallback) {
  handlers = handlers || {};
  var fallback = opt_fallback || notFound;
  var handle = function handle(request, response) {
    if (handlers.hasOwnProperty(request.url)) {
      handlers[request.url](request, response);
    } else {
      fallback(request, response);
    }
  }
  return handle;
};

// Logging
// -------

/**
 * Logger shim, used when no logger is provided by the user.
 */
exports.noopLogger = {
  fatal: _.noop,
  error: _.noop,
  warn : _.noop,
  info : _.noop,
  debug: _.noop,
  trace: _.noop,

  child: function() { return this; }
};
var noopLogger = exports.noopLogger;
