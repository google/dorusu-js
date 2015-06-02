'use strict';

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

exports.isReservedHeader = isReservedHeader;

var reservedHeaders = [
  'content-type',
  'grpc-encoding',
  'grpc-message',
  'grpc-message-type',
  'grpc-status',
  'grpc-timeout',
  'te',
  'user-agent',
];

/**
 * Determines if h is a HTTP2 'reserved' header
 *
 * All rpc metadata is propagated as headers. Some header names are reserved for
 * used by http2 or by the rpc protocol.
 *
 * @param h a header name
 * @result true if a h is special header
 */
function isReservedHeader(h) {
  return h[0] === ':' || reservedHeaders.indexOf(h) > -1;
}
