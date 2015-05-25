'use strict';

var _ = require('lodash');
var https = require('https');
var intervalToMicros = require('./codec').intervalToMicros;
var isInterval = require('./codec').isInterval;
var microsToInterval = require('./codec').microsToInterval;
var net = require('net');
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
exports.Call = OutgoingRequest; // to reflect naming used in other nurpc implementations
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
Stub.prototype.request_response = function request_response(path, message, headers, callback) {
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

  // * Using an own HTTPS agent, because the global agent does not look at `NPN/ALPNProtocols` when
  //   generating the key identifying the connection, so we may get useless non-negotiated TLS
  //   channels even if we ask for a negotiated one. This agent will contain only negotiated
  //   channels.
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
    endpoint = new Endpoint(this._log, 'CLIENT', this._settings);
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
    options.ciphers = options.ciphers || cipherSuites;

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
      var negotiatedProtocol = httpsRequest.socket.alpnProtocol || httpsRequest.socket.npnProtocol;
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
          // *** and it turned out to be HTTP2 and the request was multiplexed on that one, so we should close this one
          endpoint.close();
        }
        // *** otherwise, the fallback to HTTPS1 is already done.
      } else {
        if (endpoint) {
          self._log.info({ e: endpoint, server: options.host + ':' + options.port },
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

OutgoingRequest.prototype.setHeader = function setHeader(name, value) {
  // Intercept the superclass implementation to handle setting timeouts
  //
  // - users can either set grpc-timeout directly or set a deadline
  // - if the grpc-timeout option is specified and it's a valid interval leave
  // it
  // - if the grpc-timeout option is specified and it's invalid throw
  // - if the deadline option is specified it should be a datetime or its' invalid.
  // - compute the timeout and add it as a grpc-timeout
  // - remove the deadline option
  if (name == 'deadline') {
    if (!(value instanceof Date)) {
      console.error('bad deadline value: ', value);
      throw new Error('bad deadline value');
    }
    var now = Date.now();
    var gap = value.getTime() - now;
    if (gap < 0) gap = 0;  // treat dates in the past as a signal to finish immediately.
    var interval = microsToInterval(1000 * gap);
    OutgoingMessage.prototype.setHeader.call(this, 'grpc-timeout', interval);
  } else if (name == 'grpc-timeout') {
    if (!isInterval(value)) {
      console.error('bad grpc-timeout value: ', value);
      throw new Error('bad grpc-timeout value');
    } else {
      OutgoingMessage.prototype.setHeader.call(this, name, value);
    }
  } else {
    OutgoingMessage.prototype.setHeader.call(this, name, value);
  }
};

OutgoingRequest.prototype._start = function _start(stream, options) {
  this.stream = stream;
  this._log = stream._log.child({ component: 'http' });

  // Use OutgoingMessage.setHeader to ensure only valid additional headers are
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

  // Piper the stream to the decoder.
  stream.pipe(this._decoder);
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

// Copied from https://github.com/molnarg/node-http2/blob/master/lib/http.js
//
// Ciphersuite list based on the recommendations of http://wiki.mozilla.org/Security/Server_Side_TLS
// The only modification is that kEDH+AESGCM were placed after DHE and ECDHE suites
var cipherSuites = [
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

function normalizeOptions(options) {
  if (typeof options === 'string') {
    return url.parse(options);
  }
  return util._extend({}, options);
};
