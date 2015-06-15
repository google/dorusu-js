'use strict';

var _ = require('lodash');
var https = require('https');
var intervalToMicros = require('./codec').intervalToMicros;
var isInterval = require('./codec').isInterval;
var microsToInterval = require('./codec').microsToInterval;
var net = require('net');
var nurpc = require('./nurpc');
var protocol = require('http2').protocol;
var removeBinValues = require('./codec').removeBinValues;
var url = require('url');
var util = require('util');

var DecodingStream = require('./codec').DecodingStream;
var EncodingStream = require('./codec').EncodingStream;
var Endpoint = protocol.Endpoint;
var EventEmitter = require('events').EventEmitter;
var IncomingMessage = require('http2').IncomingMessage;
var IncomingResponse = require('http2').IncomingResponse;
var OutgoingMessage = require('http2').OutgoingMessage;
var Readable = require('stream').Readable;

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

exports.Stub = Stub;
exports.Call = EncodedOutgoingRequest; // name used in other nurpc libraries
exports.EncodedOutgoingRequest = EncodedOutgoingRequest;
exports.DecodedIncomingResponse = DecodedIncomingResponse;
exports.Agent = Agent;
exports.globalAgent = undefined;

/**
 * Stub is the nurpc endpoint for rpc connections.
 *
 * @param options for configuring the stub connection.  It respects similar
 *                similar fields as are used to create a http.request.
 */
function Stub(options) {
  this.options = normalizeOptions(options);
  this.agent = options.agent || exports.globalAgent;
}
Stub.prototype = Object.create(EventEmitter.prototype, {
  constructor: { value: Stub }
});

/**
 * request_response creates a call expects a single request and provides a
 * single response.
 */
Stub.prototype.request_response =
  function request_response(path, message, headers, callback) {
    var src = Readable();
    src.push(message);
    src.push(null);
    var requestOpts = {headers: headers};
    _.merge(requestOpts, this.options);
    return this.agent.rpc(path, src, requestOpts, callback);
  };

// Logger shim, used when no logger is provided by the user.
function noop() {}
var defaultLogger = {
  fatal: noop,
  error: noop,
  warn : noop,
  info : noop,
  debug: noop,
  trace: noop,

  child: function() { return this; }
};

// Agent class
// -----------

// When doing NPN/ALPN negotiation, there is no fallback to http 1.1.
//
// This differs from the `http2` module, where http 1.1 fallback is supported.
var supportedProtocols = [protocol.VERSION];

function Agent(options) {
  EventEmitter.call(this);

  options = util._extend({}, options);
  this._settings = options.settings;
  this._log = (options.log || defaultLogger).child({ component: 'http' });
  this.endpoints = {};

  // * Using an own HTTPS agent, because the global agent does not look at
  // `NPN/ALPNProtocols` when generating the key identifying the connection,
  // so we may get useless non-negotiated TLS channels even if we ask for a
  // negotiated one. This agent will contain only negotiated
  // channels.
  var agentOptions = {};
  agentOptions.ALPNProtocols = supportedProtocols;
  agentOptions.NPNProtocols = supportedProtocols;
  this._httpsAgent = new https.Agent(agentOptions);

  this.sockets = this._httpsAgent.sockets;
  this.requests = this._httpsAgent.requests;
}
Agent.prototype = Object.create(EventEmitter.prototype, {
  constructor: { value: Agent }
});

Agent.prototype.request = function request(options, callback) {
  // Ensure options is a valid object
  options = normalizeOptions(options);
  if (!options.path) {
    throw new Error('No path specified');
  }

  // for nurpc, we can be quite strict about what values are in the options,
  // however there are still some sane defaults to reflect a typical usage
  // pattern of testing securely on localhost:443
  options.method = (options.method || 'POST').toUpperCase();
  options.protocol = options.protocol || 'https:';
  options.host = options.hostname || options.host || 'localhost';
  options.port = options.port || 443;
  options.plain = options.protocol === 'http:';

  // Specify the serializer if one is provided
  var encOpts = {};
  if (options.serialize) {
    encOpts = options.serialize;
  }

  var request = new EncodedOutgoingRequest(encOpts);
  if (callback) {
    request.on('response', callback);
  }

  var key = [
    !!options.plain,
    options.host,
    options.port
  ].join(':');

  // * There's an existing HTTP/2 connection to this host
  if (key in this.endpoints) {
    var endpoint = this.endpoints[key];
    request._start(endpoint.createStream(), options);
  }

  // * HTTP/2 over plain TCP
  else if (options.plain) {
    var endpoint = new Endpoint(this._log, 'CLIENT', this._settings);
    endpoint.socket = net.connect({
      host: options.host,
      port: options.port,
      localAddress: options.localAddress
    });
    endpoint.pipe(endpoint.socket).pipe(endpoint);
    request._start(endpoint.createStream(), options);
  }

  // * HTTP/2 over TLS negotiated using NPN or ALPN, or fallback to HTTPS1
  else {
    var started = false;
    options.ALPNProtocols = supportedProtocols;
    options.NPNProtocols = supportedProtocols;
    options.servername = options.host; // Server Name Indication
    options.agent = this._httpsAgent;
    options.ciphers = options.ciphers || nurpc.cipherSuites;

    var httpsRequest = https.request(options);
    httpsRequest.on('socket', function(socket) {
      var negotiatedProtocol = socket.alpnProtocol || socket.npnProtocol;
      if (negotiatedProtocol != null) { // null in >=0.11.0, undefined in <0.11.0
        negotiated();
      } else {
        socket.on('secureConnect', negotiated);
      }
    });

    var self = this;
    var negotiated = function negotiated() {
      var endpoint;
      var negotiatedProtocol =
            httpsRequest.socket.alpnProtocol || httpsRequest.socket.npnProtocol;
      if (negotiatedProtocol === protocol.VERSION) {
        httpsRequest.socket.emit('agentRemove');
        unbundleSocket(httpsRequest.socket);
        endpoint = new Endpoint(self._log, 'CLIENT', self._settings);
        endpoint.socket = httpsRequest.socket;
        endpoint.pipe(endpoint.socket).pipe(endpoint);
      }
      if (started) {
        // ** In the meantime, an other connection was made to the same host...
        if (endpoint) {
          // *** and it turned out to be HTTP2 and the
          // *** request was multiplexed on that one, so we should close this one.
          endpoint.close();
        }
        // *** otherwise, the fallback to HTTPS1 is already done.
      } else {
        if (endpoint) {
          self._log.info(
            { e: endpoint, server: options.host + ':' + options.port },
            'New outgoing HTTP/2 connection');
          self.endpoints[key] = endpoint;
          self.emit(key, endpoint);
        } else {
          self.emit(key, undefined);
        }
      }
    };

    this.once(key, function(endpoint) {
      started = true;
      if (endpoint) {
        request._start(endpoint.createStream(), options);
      } else {
        throw new Error('Negotiation did not succeed.');
      }
    });
  }

  return request;
};

/**
 * rpc starts a request to the given path.
 */
Agent.prototype.rpc = function rpc(path, msgSrc, options, callback) {
  options = util._extend({}, options);
  options.path = path;
  var request = this.request(options, callback);

  // Encode the messages and send them
  msgSrc.pipe(request);
  return request;
};

// The default global agent instance
exports.globalAgent = new Agent();

function unbundleSocket(socket) {
  socket.removeAllListeners('data');
  socket.removeAllListeners('end');
  socket.removeAllListeners('readable');
  socket.removeAllListeners('close');
  socket.removeAllListeners('error');
  socket.unpipe();
  delete socket.ondata;
  delete socket.onend;
}

// EncodedOutgoingRequest class
// ----------------------------

function EncodedOutgoingRequest(opts) {
  OutgoingMessage.call(this);
  this.stream = undefined; // will be created in _start
  opts = opts || {};
  this._encoder = new EncodingStream(opts);
  this.cancelled = false;
  this._log = undefined;   // will be set to be child logger of the stream
}
EncodedOutgoingRequest.prototype = Object.create(OutgoingMessage.prototype, {
  constructor: { value: EncodedOutgoingRequest }
});

// _write overrides http2.OutgoingMessage._write so that all writing goes via
// the encoder.
EncodedOutgoingRequest.prototype._write = function _write(chunk, enc, next) {
  if (this.cancelled)  {
    return;
  }
  if (this.stream) {
    this._encoder.write(chunk, enc, next);
  } else {
    OutgoingMessage.prototype._write.call(this, chunk, enc, next);
  }
};

var isAscii = /^[\x00-\x7F]+$/;

// addTrailers is a noop; in the rpc protocol, OutgoingRequests do not set
// trailers.
EncodedOutgoingRequest.prototype.addTrailers = _.noop;

// setHeader intercepts the base class implementation to validate rpc protocol
// headers.
EncodedOutgoingRequest.prototype.setHeader = function setHeader(name, value) {
  // - either `grpc-timeout` directly or `deadline` can set the `grpc-timeout`
  //
  // - `grpc-timeout` must be valid protocol value for grpc-timeout or an Error
  //   is raised.
  //
  // - `deadline` should be a datetime or it is an Error is raised
  //   - when set, the grpc-timeout is computed from the current time and
  //     deadline is removed
  if (name === 'deadline') {
    if (!(value instanceof Date)) {
      console.error('bad deadline value: ', value);
      this.emit('error', new Error('bad deadline value'));
      return;
    }
    var now = Date.now();
    var gap = value.getTime() - now;
    // treat dates in the past as a signal to finish immediately.
    if (gap < 0) gap = 0;
    var interval = microsToInterval(1000 * gap);
    OutgoingMessage.prototype.setHeader.call(this, 'grpc-timeout', interval);
    return;
  }
  if (name === 'grpc-timeout') {
    if (!isInterval(value)) {
      console.error('bad grpc-timeout value: ', value);
      this.emit('error', new Error('bad grpc-timeout value'));
    } else {
      OutgoingMessage.prototype.setHeader.call(this, name, value);
    }
    return;
  }
  var noBins = removeBinValues(name, value);
  OutgoingMessage.prototype.setHeader.call(this, noBins[0], noBins[1]);
};

EncodedOutgoingRequest.prototype._start = function _start(stream, options) {
  this.stream = stream;
  this._encoder.pipe(stream);
  this._log = stream._log.child({ component: 'http' });

  // Use `EncodedOutgoingRequest.setHeader` to ensure only valid additional
  // headers are present
  for (var key in options.headers) {
    this.setHeader(key, options.headers[key]);
  }

  // Add the standard headers
  var headers = this._headers;
  delete headers.host;  // this is sent as :authority
  headers[':scheme'] = options.protocol.slice(0, -1);
  headers[':method'] = options.method;
  headers[':authority'] = options.host;
  headers[':path'] = options.path;

  // Set a timeout to reset the connection if headers[grpc-timeout] is set.
  if (headers['grpc-timeout']) {
    var timeoutMicros = intervalToMicros(headers['grpc-timeout']);
    util.log('Will timeout the connection in', timeoutMicros, 'usec');
    setTimeout(this.abort.bind(this), Math.floor(timeoutMicros/1000));
  }

  // Send the headers
  this._log.info({ scheme: headers[':scheme'], method: headers[':method'],
                   authority: headers[':authority'], path: headers[':path'],
                   headers: (options.headers || {}) }, 'Sending request');
  this.stream.headers(headers);
  this.headersSent = true;

  // Fire the socket event with this stream as the target
  this.emit('socket', this.stream);

  // Create the response, once it's ready have it fire the request's response
  // handler
  var response = new DecodedIncomingResponse(this.stream);
  response.once('ready', this.emit.bind(this, 'response', response));

  // Register a callback that cancels push promises
  this.stream.on('promise', this._onPromise.bind(this));
};

EncodedOutgoingRequest.prototype.setPriority = function setPriority(priority) {
  if (this.stream) {
    this.stream.priority(priority);
  } else {
    this.once('socket', this.setPriority.bind(this, priority));
  }
};

// Aborting the request
EncodedOutgoingRequest.prototype.abort = function abort() {
  this.cancelled = true;
  if (this.stream) {
    var that = this;
    this._encoder.end(function() {
      that.stream.reset('CANCEL');
      that.emit('cancel');
    });
  } else {
    this.on('socket', this.abort.bind(this));
  }
};
// Make abort available as cancel, for similarity with existing nurpc
// implementations.
EncodedOutgoingRequest.prototype.cancel = EncodedOutgoingRequest.prototype.abort;

// Receiving push promises.
//
// For nurpc calls these should be ignored.  These are cancelled on receipt.
EncodedOutgoingRequest.prototype._onPromise =
  function _onPromise(stream, headers) {
    this._log.info({ push_stream: stream.id }, 'Receiving push promise');
    var promise = new IncomingPromise(stream, headers);
    promise.cancel();
};

// DecodedIncomingResponse class
// -----------------------------

function DecodedIncomingResponse(stream) {
  this._decoder = DecodingStream();
  IncomingResponse.call(this, stream);

  // Pipe the stream to the decoder.
  stream.pipe(this._decoder);

  // Copy specific headers as metadata.
  this.metadata = {};

  // Verify that the rpcStatus header is received.
  this._rpcStatus = undefined;
  var that = this;
  stream.once('end', function() {
    if (!that._rpcStatus) {
      throw new Error('No rpc status was received');
    }
  });
}
DecodedIncomingResponse.prototype = Object.create(IncomingResponse.prototype, {
  constructor: { value: DecodedIncomingResponse }
});

// Overriding `EventEmitter`'s `on(event, listener)` method to forward certain
// subscriptions to ``decoder`.
//
// Forward subscriptions to `data` and `end` to decoder, so that listeners are
// getting decoded data.
DecodedIncomingResponse.prototype.on = function on(event, listener) {
  // TODO: determine if there are other Readable events that
  // whose listeners to should be forwarded.
  if ((event === 'data') || (event === 'end')) {
    this._decoder.on(event, listener && listener.bind(this));
  } else {
    IncomingResponse.prototype.on.call(this, event, listener);
  }
};

// _onHeaders extends IncomingResponse to handle the rpc protocol's special
// status headers.
DecodedIncomingResponse.prototype._onHeaders = function _onHeaders(headers) {
  var updateMetadata = this._updateMetadata.bind(this);
  var checkStatusHeaders = this._checkStatusHeaders.bind(this);
  IncomingResponse.prototype._onHeaders.call(this, headers);
  checkStatusHeaders(headers);
  updateMetadata(headers);

  // For rpcs that return more than one message, the status will be in the
  // trailers; this is checked by a listener for 'headers'.
  this.stream.on('headers', function(headers) {
    checkStatusHeaders(headers);
    updateMetadata(headers);
  });
};

DecodedIncomingResponse.prototype._updateMetadata =
  function _updateMetadata(headers) {
    var addMetadata = this._addMetadata.bind(this);
    // copy any of headers that's not a reserved header into the metadata
    //
    // any header that ends with -bin, should be base64 unencoded to a buffer;
    // if it can't be unpacked reset the stream and raise an Error
    _.forEach(headers, function(value, name) {
      addMetadata(name, value);
    });

    // Emit a metadata event whenever metadata is received.
    if (_.size(this.metadata) > 0 ) {
      this.emit('metadata', this.metadata);
    }
  };

var endsWithBin = /-bin$/;

DecodedIncomingResponse.prototype._addMetadata = function _addMetadata(k, v) {
  if (nurpc.isReservedHeader(k)) {
    return;
  }
  if (!endsWithBin.test(k)) {
    this.metadata[k] = v;
    return;
  }
  var realName = k.slice(0, -4);
  if (_.isArray(v)) {
    this.metadata[realName] = _.map(
      v,
      function(x) { return new Buffer(x, 'base64') });
  } else {
    this.metadata[realName] = new Buffer(v, 'base64');
  }
};

DecodedIncomingResponse.prototype._checkStatusHeaders =
  function _checkStatusHeaders(headers) {
    if (this._rpcStatus) {
      return;
    }
    // If the status is present, it must be a valid integer.
    //
    // If the the trailers have been detected.
    //
    // - the status must either already have been sent or
    // - be present in the headers, otherwise it's an rpc protocol error.
    if (headers.hasOwnProperty('grpc-status') || this._lastHeadersSeen) {
      var statusValue = headers['grpc-status'];
      if ((typeof statusValue !== 'string') || statusValue === 0) {
        this._log.error({ key: 'grpc-status', value: statusValue },
                        'Invalid or missing grpc-status value');
        this.stream.reset('PROTOCOL_ERROR');
        this.emit('error', new Error('Invalid or missing grpc-status value'));
        return;
      }
      var statusCode = parseInt(statusValue);
      if (isNaN(statusCode)) {
        this._log.error({ key: 'grpc-status', value: statusValue },
                        'Invalid grpc-status value: NaN');
        this.stream.reset('PROTOCOL_ERROR');
        this.emit('error', new Error('Invalid grpc-status value: NaN'));
        return;
      }
      this._rpcStatus = {
        'code': statusCode,
        'message': headers['grpc-message'] || ''
      };
      // Emit the status, also emitting as an error if its non-zero
      this.emit('status', this._rpcStatus);
      if (statusCode !== 0) {
        this.emit('error', this._rpcStatus);
      }
    }
  };

function normalizeOptions(options) {
  if (typeof options === 'string') {
    return url.parse(options);
  }
  return util._extend({}, options);
};
