'use strict';

var _ = require('lodash');
var https = require('https');
var intervalToMicros = require('./codec').intervalToMicros;
var isInterval = require('./codec').isInterval;
var microsToInterval = require('./codec').microsToInterval;
var net = require('net');
var nurpc = require('./nurpc');
var protocol = require('http2').protocol;
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
exports.Call = OutgoingRequest; // as per naming in other nurpc implementations
exports.OutgoingRequest = OutgoingRequest;
exports.DecodedResponse = DecodedResponse;
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
Stub.prototype = Object.create(
  EventEmitter.prototype, { constructor: { value: Stub } });

/**
 * request_response creates a call expects a single request and provides a
 * single response.
 */
Stub.prototype.request_response =
  function request_response(path, message, headers, callback) {
    var src = Readable();
    src.push(message);
    src.push(null);
    var requestOptions = {headers: headers};
    _.merge(requestOptions, this.options);
    return this.agent.rpc(path, src, requestOptions, callback);
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
Agent.prototype = Object.create(
  EventEmitter.prototype, { constructor: { value: Agent } });

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

  var request = new OutgoingRequest(this._log);
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

  // Specify the serializer if one is provided
  var encOpts = {};
  if (options.serialize) {
    encOpts = options.serialize;
  }

  // TODO: update OutgoingRequest so that it holds the encoding stream
  var enc = EncodingStream(encOpts);

  // Encode the messages and send them
  msgSrc.pipe(enc).pipe(request);
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

// OutgoingRequest class
// ---------------------

function OutgoingRequest() {
  OutgoingMessage.call(this);

  this.stream = undefined; // will be created in _start
  this._log = undefined;   // will be set to be child logger of the stream
}
OutgoingRequest.prototype = Object.create(
  OutgoingMessage.prototype, { constructor: { value: OutgoingRequest } });

var isAscii = /^[\x00-\x7F]+$/;

OutgoingRequest.prototype.setHeader = function setHeader(name, value) {
  // Intercept the superclass implementation to handle setting timeouts
  //
  // - users can either set grpc-timeout directly or set a deadline
  // - if the grpc-timeout option is specified and it's a valid interval leave
  // it
  // - if the grpc-timeout option is specified and it's invalid throw
  // - if the deadline option is specified it should be a datetime or it is
  //   invalid.
  // - compute the timeout and add it as a grpc-timeout
  // - remove the deadline option
  if (name === 'deadline') {
    if (!(value instanceof Date)) {
      console.error('bad deadline value: ', value);
      throw new Error('bad deadline value');
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
      throw new Error('bad grpc-timeout value');
    } else {
      OutgoingMessage.prototype.setHeader.call(this, name, value);
    }
    return;
  }
  if (value instanceof Buffer) {
    OutgoingMessage.prototype.setHeader.call(
      this, name + '-bin', value.toString('base64'));
    return;
  }
  if (value instanceof Array) {
    var needsb64 = _.reduce(value, function(acc, v) {
      return acc || v instanceof Buffer || !isAscii.test(value);
    }, false);
    if (needsb64) {
      var tob64 = _.map(value, function(v) {
        return new Buffer(v).toString('base64');
      });
      OutgoingMessage.prototype.setHeader.call(this, name + '-bin', tob64);
      return;
    }
  }
  if (!isAscii.test(value)) {
    OutgoingMessage.prototype.setHeader.call(
      this, name + '-bin', new Buffer(value).toString('base64'));
    return;
  }
  OutgoingMessage.prototype.setHeader.call(this, name, value);
};

OutgoingRequest.prototype._start = function _start(stream, options) {
  this.stream = stream;
  this._log = stream._log.child({ component: 'http' });

  // Use OutgoingRequest.setHeader to ensure only valid additional headers are
  // present
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

  // Set up a timeout to reset the connection if headers[grpc-timeout] is set.
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
  var response = new DecodedResponse(this.stream);
  response.once('ready', this.emit.bind(this, 'response', response));

  // Register a callback that cancels push promises
  this.stream.on('promise', this._onPromise.bind(this));
};

OutgoingRequest.prototype.setPriority = function setPriority(priority) {
  if (this.stream) {
    this.stream.priority(priority);
  } else {
    this.once('socket', this.setPriority.bind(this, priority));
  }
};

// Aborting the request
OutgoingRequest.prototype.abort = function abort() {
  if (this.stream) {
    this.stream.reset('CANCEL');
    this.emit('cancel');
  } else {
    this.on('socket', this.abort.bind(this));
  }
};
// Make abort available as cancel, for similarity with existing nurpc
// implementations.
OutgoingRequest.prototype.cancel = OutgoingRequest.prototype.abort;

// Receiving push promises.
//
// For nurpc calls these should be ignored.  Just cancel them.
OutgoingRequest.prototype._onPromise = function _onPromise(stream, headers) {
  this._log.info({ push_stream: stream.id }, 'Receiving push promise');
  var promise = new IncomingPromise(stream, headers);
  promise.cancel();
};

// DecodedResponse class
// -----------------------------

function DecodedResponse(stream) {
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
DecodedResponse.prototype = Object.create(
  IncomingResponse.prototype, { constructor: { value: DecodedResponse } });

// Overriding `EventEmitter`'s `on(event, listener)` method to forward certain
// subscriptions to ``decoder`.
//
// Forward subscriptions to `data` and `end` to decoder, so that listeners are
// getting decoded data.
DecodedResponse.prototype.on = function on(event, listener) {
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
DecodedResponse.prototype._onHeaders = function _onHeaders(headers) {
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

var endsWithBin = /-bin$/;

DecodedResponse.prototype._updateMetadata = function _updateMetadata(headers) {
  var addMetadata = this._addMetadata.bind(this);
  // copy any of headers that's not a reserved header into the metadata
  //
  // any header that ends with -bin, should be base64 unencoded to a buffer; if
  // it can't be unpacked reset the stream and raised an Exception
  _.forEach(headers, function(value, name) {
    addMetadata(name, value);
  });

  // Emit a metadata event whenever metadata is received.
  if (_.size(this.metadata) > 0 ) {
    this.emit('metadata', this.metadata);
  }
};

DecodedResponse.prototype._addMetadata = function _addMetadata(name, value) {
  if (nurpc.isReservedHeader(name)) {
    return;
  }
  if (!endsWithBin.test(name)) {
    this.metadata[name] = value;
    return;
  }
  var realName = name.slice(0, -4);
  if (_.isArray(value)) {
    this.metadata[realName] = _.map(
      value,
      function(v) { return new Buffer(v, 'base64') });
  } else {
    this.metadata[realName] = new Buffer(value, 'base64');
  }
}

DecodedResponse.prototype._checkStatusHeaders =
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
    if (headers['grpc_status'] || this._lastHeadersSeen) {
      var statusValue = headers['grpc-status'];
      if ((typeof statusValue !== 'string') || statusValue === 0) {
        this._log.error({ key: 'grpc-status', value: statusValue },
                        'Invalid or missing grpc-status value');
        this.stream.reset('PROTOCOL_ERROR');
        throw new Error('Invalid or missing grpc-status value');
      }
      var statusCode = parseInt(statusValue);
      if (isNaN(statusCode)) {
        this._log.error({ key: 'grpc-status', value: statusValue },
                        'Invalid grpc-status value: NaN');
        this.stream.reset('PROTOCOL_ERROR');
        throw new Error('Invalid grpc-status value: NaN');
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
