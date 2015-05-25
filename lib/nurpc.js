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

exports.isSpecialHeader = isSpecialHeader;

var specialHeaders = [
  'content-type',
  'grpc-encoding',
  'grpc-message-type',
  'grpc-status',
  'grpc-timeout',
  'te',
  'user-agent',
];

/**
 * Determines if h is a special header
 * @param h a header name
 * @result true if a h is special header
 */
function isSpecialHeader(h) {
  return h[0] === ':' || specialHeaders.indexOf(h) > -1;
}
