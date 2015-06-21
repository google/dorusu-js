'use strict';

/**
 * nurpc/client allows the creation of clients that access services via the rpc
 * protocol.
 *
 * @module nurpc/client
 */

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
 * generates a client constructor from a service definition.
 *
 * @param {Service} service the service from which to generate the client.
 * @returns {function} a constructor for a client to be used to access service.
 */
exports.buildClient = function buildClient(service) {
  var client = function client(options) {
    options = normalizeOptions(options);
    this.stub = new Stub(options);
  };
  client.prototype = Object.create(null, {
    constructor: { value: client }
  });
  _.forEach(service.methods, function(m) {
    var route = '/' + service.name + '/' + m.name;
    var clientFunc = function(src, headers, callback) {
      var f = this.stub.rpcFunc(m.marshaller, m.unmarshaller);
      f(route, src, headers, callback);
    };
    client.prototype[_.camelCase(m.name)] = clientFunc;
  });

  return client;
};

/**
 * Stub is the nurpc endpoint for rpc connections.
 *
 * @param {object} options for configuring the stub connection.  It expects
 *                 similar fields as are used to create a http.request.
 * @param {Agent} [option.agent] is used to establish the stub connection.
 * @param {Service} [option.service] is used to add additional funcs
 * @constructor
 */
function Stub(options) {
  this.options = normalizeOptions(options);
  this.agent = options.agent || exports.globalAgent;
}
Stub.prototype = Object.create(Object.prototype, {
  constructor: { value: Stub }
});

/**
 * post is an rpc that expects a single request and provides a single response.
 *
 * @param {string} path the path to connect on the rpc server.
 * @param {Object} message the message to send
 * @param {Object} headers additional information to send the server
 * @param {function} callback a node callback to be called with response
 */
Stub.prototype.post = function post(path, message, headers, callback) {
  var f = this.postFunc();
  return f(path, message, headers, callback);
};

/**
 * postFunc creates a function that make a post, using `marshal` to
 * convert.
 *
 * @param {function} opt_marshal for marshalling the message
 * @param {function} opt_unmarshal for unmarshalling the response
 */
Stub.prototype.postFunc = function postFunc(opt_marshal, opt_unmarshal) {
  var doPost = function doPost(path, message, headers, callback) {
    var src = Readable();
    src.push(message);
    src.push(null);
    var f = this.rpcFunc(opt_marshal, opt_unmarshal);
    return f(path, src, headers, callback);
  };
  return doPost.bind(this);
};

/**
 * rpcFunc creates a function that performs an rpc.
 *
 * @param {function} opt_marshal marshals any messages
 * @param {function} opt_unmarshal marshal any response
 * @return {function} a function that performs an rpc
 */
Stub.prototype.rpcFunc = function rpcFunc(opt_marshal, opt_unmarshal) {
  var doRpc = function doRpc(path, msgSrc, headers, callback) {
    var requestOpts = {
      unmarshal: opt_unmarshal,
      headers: headers,
      marshal: opt_marshal
    };
    _.merge(requestOpts, this.options);
    return this.agent.rpc(path, msgSrc, requestOpts, callback);
  };
  return doRpc.bind(this);
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
/**
 * @type {string[]}
 * @constant
 */
var supportedProtocols = [protocol.VERSION];

/**
 * Agent encapsulates access to remote RPC endpoint.
 *
 * @param {object} options configures the remote endpoint
 * @param {object} options.log the logger used to record agent behaviour
 * @param {object} options.settings used to configure the
 * @constructor
 */
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

/**
 * request starts an EncodedOutgoingRequest to the rpc endpoint.
 *
 * @param {object} options configures the request
 * @param {function} callback is node-js callback called with the response.
 */
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

  // Specify the {de,}marshaller if provided
  var encOpts = {};
  _.forEach(['marshal', 'unmarshal'], function(k) {
    if (options[k]) {
      encOpts[k] = options[k];
      delete options[k];
    }
  });
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
 * rpc starts an EncodedOutgoingRequest to the rpc endpoint.
 *
 * @param {string} path the destination path on the endpoint
 * @param {external:Readable} msgSrc a Readble that provides objects to send to
 *                                   the endpoint
 * @param {object} options configures the request
 * @param {function} callback is node-js callback called with the response
 */
Agent.prototype.rpc = function rpc(path, msgSrc, options, callback) {
  options = util._extend({}, options);
  options.path = path;
  var request = this.request(options, callback);

  // Encode the messages and send them
  msgSrc.pipe(request);
  return request;
};

/**
 * The default global `Agent` instance.
 * @const
 * @type {Agent}
 */
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

/**
 * EncodedOutgoingRequest extends `http2.OutgoingMessage` to incorporate the
 * necessary features for sending rpc protocol messages.
 *
 * @param {object} opts configures the request instance
 * @param {function} opts.marshal is used marshal objects sent by this request
 * @constructor
 */
function EncodedOutgoingRequest(opts) {
  OutgoingMessage.call(this);
  this.stream = undefined; // will be created in _start
  this.codecOpts = opts || {};
  this._encoder = new EncodingStream(this.codecOpts);
  this.cancelled = false;
  this._log = undefined;   // will be set to be child logger of the stream
}
EncodedOutgoingRequest.prototype = Object.create(OutgoingMessage.prototype, {
  constructor: { value: EncodedOutgoingRequest }
});

/**
 * Overrides `http2.OutgoingMessage.write` so that all writing is encoded.
 */
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

/**
 * Overrides `http2.OutgoingMessage` to make this a noop
 *
 * This is because outgoing rpc requests do not add trailers.
 */
EncodedOutgoingRequest.prototype.addTrailers = _.noop;

/**
 * Overrides `http2.OutgoingMessage.setHeader` to validate values of any headers
 * reserved by the rpc protocol.
 *
 * @param {string} name the header name
 * @param {string|number|external:Buffer} value the header value
 */
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

/**
 * Starts the request on the given http2.Stream.
 *
 * `options` may have any of the usual properties associated with making http or
 * http2 request, as well the ones highlighted below.
 *
 * @param {Stream} stream the stream on which the request will be made.
 * @param {object} options configures the request
 * @param {function} [options.updateHeaders] used to update headers
 * @param {function} options.path the path to be accessed
 * @param {function} [options.headers] the headers to send
 */
EncodedOutgoingRequest.prototype._start = function _start(stream, options) {
  // Allow headers to updated by a function updateHeaders:
  //
  // func(path, headers, callback(updatedHeaders))
  //
  // This allow headers to be injected dynamically.
  //
  // N.B. updateHeader must not fail.  If the source that updates headers fails,
  // it should invoke the callback with the original headers.
  if (typeof options.updateHeaders === 'function') {
    var updateHeaders = options.updateHeaders;
    var clonedOptions = _.clone(options)
    delete clonedOptions.updateHeaders;
    var _start = this._start.bind(this, stream);
    var withUpdatedHdrs = function(updatedHeaders) {
      clonedOptions.headers = updatedHeaders;
      _start(clonedOptions);
    };
    updateHeaders(options.path, options.headers, withUpdatedHdrs);
    return;
  }

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
  var response = new DecodedIncomingResponse(this.stream, this.codecOpts);
  response.once('ready', this.emit.bind(this, 'response', response));

  // Register a callback that cancels push promises
  this.stream.on('promise', this._onPromise.bind(this));
};

/**
 * Sets the priority on this request's `http2.Stream`.
 */
EncodedOutgoingRequest.prototype.setPriority = function setPriority(priority) {
  if (this.stream) {
    this.stream.priority(priority);
  } else {
    this.once('socket', this.setPriority.bind(this, priority));
  }
};

/**
 * Aborts this request.
 */
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

/**
 * DecodedIncomingResponse is a http2.IncomingResponse that decodes the data it
 * receives as required by rpc protocol.
 *
 * @param {Stream} stream a `http2.Stream`
 * @param {object} opts configures the response's decoder
 * @constructor
 */
function DecodedIncomingResponse(stream, opts) {
  opts = opts || {};
  this._decoder = DecodingStream(opts);
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

/**
 * Overrides `EventEmitter.on` to forward subscriptions to the `data` and `end`
 * events to the decoder so that listeners of this class get the decoded
 * Buffers|Objects.
 */
DecodedIncomingResponse.prototype.on = function on(event, listener) {
  // TODO: determine if there are other Readable events that
  // whose listeners to should be forwarded.
  if ((event === 'data') || (event === 'end')) {
    this._decoder.on(event, listener && listener.bind(this));
  } else {
    IncomingResponse.prototype.on.call(this, event, listener);
  }
};

/**
 * Extends `IncomingResponse._onHeaders` to handle the rpc protocols' special
 * status headers.
 *
 * @param {object} headers the headers (or trailers) received on the stream.
 */
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

/**
 * Used by DecodedIncomingResponse#_onHeaders to fire a metadata event.
 *
 * Metadata includes any header that is not reserved by the rpc protocol.  The
 * `metadata` event is fired if any non-reserved headers have been received.
 *
 * @param {object} headers the headers (or trailers) received on the stream.
 */
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

/**
 * Used by DecodedIncomingResponse#_onHeaders to validate the received status.
 *
 * The rpc protocol reserves some headers for use to signal application status.
 *
 * @param {object} headers the headers (or trailers) received on the stream.
 */
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


/**
 * The nodejs EventEmitter class.
 * @external EventEmitter
 *
 * @see https://nodejs.org/api/events.html
 */
