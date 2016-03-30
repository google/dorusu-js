/*
 *
 * Copyright 2015, Google Inc.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 */
'use strict';

/**
 * dorusu/client allows the creation of clients that access services via the rpc
 * protocol.
 *
 * @module dorusu/client
 */

var _ = require('lodash');
var http2 = require('http2');
var https = require('https');
var intervalToMicros = require('./codec').intervalToMicros;
var isInterval = require('./codec').isInterval;
var microsToInterval = require('./codec').microsToInterval;
var net = require('net');
var dorusu = require('./dorusu');
var protocol = require('http2').protocol;
var removeBinValues = require('./codec').removeBinValues;
var url = require('url');
var util = require('util');

var DecodingStream = require('./codec').DecodingStream;
var EncodingStream = require('./codec').EncodingStream;
var Endpoint = protocol.Endpoint;
var EventEmitter = require('events').EventEmitter;
var IncomingResponse = http2.IncomingResponse;
var OutgoingMessage = http2.OutgoingMessage;
var PassThrough = require('stream').PassThrough;
var Readable = require('stream').Readable;

// Public API
// ==========

// The main governing power behind the dorusu API design is that it provides
// elements similar to the existing node.js [HTTP2 API][1], node-http2, (which
// is in turn very similar to the [HTTPS API][2]).
//
// In part, the similarity comes from re-use of classes defined in
// node-http2.  In other cases the classes have been copied and modified to
// enforce restrictions in how dorusu uses HTTP2.
//
// In addition, these elements have aliases corresponding to theirs names
// in other dorusu implementations.
//
// [1]: https://github.com/molnarg/node-http2
// [2]: http://nodejs.org/api/http.html
// [3]: http://tools.ietf.org/html/draft-ietf-httpbis-http2-16#section-8.1.2.4

exports.Stub = Stub;
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
  /**
   * Defines a client class the has methods corresponding to each method in
   * service.
   * @constructor
   */
  var svcClient = function svcClient(options) {
    options = normalizeOptions(options);
    options.serviceName = service.name;
    this.stub = new Stub(options);
  };
  svcClient.prototype = Object.create(null, {
    constructor: { value: svcClient }
  });
  _.forEach(service.methods, function(m) {
    var route = '/' + service.name + '/' + m.name;

    /**
     * @param {Object|external:Readable} src either the message to send or a
     *                                       Readable giving a series of them
     * @param {Object} headers sent along wih the message(s)
     * @param {Object} opts holds optional info affecting the rpc
     * @param {Object} opts.headers holds the rpc headers
     * @param {function} callback a node-js callback called with the response.
     */
    var method = function method(src, callback, opts) {
      var f = this.stub.rpcFunc(m.marshaller, m.unmarshaller);
      return f(route, src, callback, opts);
    };
    svcClient.prototype[_.camelCase(m.name)] = method;
  });

  return svcClient;
};

/**
 * Stub is the dorusu endpoint for rpc connections.
 *
 * @param {object} options for configuring the stub connection.  It expects
 *                 similar fields as are used to create a http.request.
 * @param {Agent} [option.agent] is used to establish the stub connection.
 * @param {Service} [option.service] is used to add additional funcs
 * @constructor
 */
function Stub(options) {
  this.options = normalizeOptions(options);
  if (options.agent) {
    this.agent = options.agent;
  } else if (options.log) {
    this.agent = new Agent(options);
  } else {
    this.agent = exports.globalAgent;
  }
}
Stub.prototype = Object.create(Object.prototype, {
  constructor: { value: Stub }
});

/**
 * post is an rpc that expects a single request and provides a single response.
 *
 * @param {string} path the path to connect on the rpc server.
 * @param {Object} message the message to send
 * @param {function} callback a node callback to be called with response
 * @param {Object} headers additional information to send the server
 */
Stub.prototype.post = function post(path, message, callback, headers) {
  var f = this.rpcFunc();
  return f(path, message, callback, headers);
};

/**
 * rpcFunc creates a function that performs an rpc.
 *
 * @param {function} opt_marshal marshals any messages
 * @param {function} opt_unmarshal marshal any response
 * @return {function} a function that performs an rpc
 */
Stub.prototype.rpcFunc = function rpcFunc(opt_marshal, opt_unmarshal) {
  /**
   * @param {string} path the path of the rpc at the rpc endpoint
   * @param {Object|external:Readable} msgSrc either the message or Readable
   *                                          that provides messages
   * @param {function} callback is called with the response
   * @param {Object} opts holds optional info affecting the rpc
   * @param {Object} opts.headers holds the rpc headers
   */
  var doRpc = function doRpc(path, msgSrc, callback, opts) {
    var requestOpts = {
      unmarshal: opt_unmarshal,
      marshal: opt_marshal
    };
    _.merge(requestOpts, this.options, opts, function(a, b) {
      /** Needed until lodash 4. is distributed
       *
       * see https://github.com/lodash/lodash/issues/1453
       */
      if (b instanceof Buffer) {
        return b;
      }
      return undefined;
    });
    return this.agent.rpc(path, msgSrc, requestOpts, callback);
  };
  return doRpc.bind(this);
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
 * @param {object} options.settings used to configure the http2 endpoint
 * @constructor
 */
function Agent(options) {
  EventEmitter.call(this);
  this.setMaxListeners(0);  // Unlimited listeners, prevents warnings

  options = util._extend({}, options);
  this._settings = options.settings;
  this._log = (options.log || dorusu.noopLogger).child({ component: 'http' });
  this.endpoints = {};

  // * Using an own HTTPS agent, because the global agent does not look at
  // `NPN/ALPNProtocols` when generating the key identifying the connection,
  // so we may get useless non-negotiated TLS channels even if we ask for a
  // negotiated one. This agent will contain only negotiated
  // channels.
  options.ALPNProtocols = supportedProtocols;
  options.NPNProtocols = supportedProtocols;
  this._httpsAgent = new https.Agent(options);

  this.sockets = this._httpsAgent.sockets;
  this.requests = this._httpsAgent.requests;
}
Agent.prototype = Object.create(EventEmitter.prototype, {
  constructor: { value: Agent }
});

function hasAgentOptions(options) {
  return options.pfx !== null ||
    options.key !== null ||
    options.passphrase !== null ||
    options.cert !== null ||
    options.ca !== null ||
    options.ciphers !== null ||
    options.rejectUnauthorized !== null ||
    options.secureProtocol !== null;
}

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

  // for dorusu, we can be quite strict about what values are in the options,
  // however there are still some sane defaults to reflect a typical usage
  // pattern of testing securely on localhost:443
  options.method = (options.method || 'POST').toUpperCase();
  options.protocol = options.protocol || 'https:';
  options.host = options.hostname || options.host || 'localhost';
  options.port = options.port || 443;
  options.plain = options.protocol === 'http:';

  // Specify the {de,}marshaller if provided
  var encOpts = {log: options.log};
  _.forEach(['marshal', 'unmarshal'], function(k) {
    if (options[k]) {
      encOpts[k] = options[k];
      delete options[k];
    }
  });
  var req = new EncodedOutgoingRequest(encOpts);
  if (callback) {
    req.on('response', callback);
  }

  var key = [
    !!options.plain,
    options.host,
    options.port
  ].join(':');

  // * There's an existing HTTP/2 connection to this host
  if (key in this.endpoints) {
    req._start(this.endpoints[key].createStream(), options);
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
    req._start(endpoint.createStream(), options);
  }

  // * HTTP/2 over TLS negotiated using NPN or ALPN, or fallback to HTTPS1
  else {
    var started = false;
    var createAgent = hasAgentOptions(options);
    options.ALPNProtocols = supportedProtocols;
    options.NPNProtocols = supportedProtocols;
    // Server Name Indication
    if (createAgent) {
      options.agent = new https.Agent(options);
    } else if (!options.agent) {
      options.agent = this._httpsAgent;
    }
    options.ciphers = options.ciphers || dorusu.cipherSuites;

    var httpsRequest = https.request(options);
    var negotiated = function negotiated() {
      var endpoint;
      var negotiatedProtocol =
        httpsRequest.socket.alpnProtocol || httpsRequest.socket.npnProtocol;
      if (negotiatedProtocol === protocol.VERSION) {
        httpsRequest.socket.emit('agentRemove');
        unbundleSocket(httpsRequest.socket);
        endpoint = new Endpoint(this._log, 'CLIENT', this._settings);
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
          this._log.info(
            { e: endpoint, server: options.host + ':' + options.port },
            'New outgoing HTTP/2 connection');
          this.endpoints[key] = endpoint;
          this.emit(key, endpoint);
        } else {
          this.emit(key, undefined);
        }
      }
    }.bind(this);

    var onHttpsSocket = function onHttpsSocket(socket) {
      var negotiatedProtocol = socket.alpnProtocol || socket.npnProtocol;
      if (negotiatedProtocol !== null) { // null in >=0.11.0, undefined in <0.11.0
        negotiated();
      } else {
        socket.on('secureConnect', negotiated);
      }
    };
    httpsRequest.on('socket', onHttpsSocket);

    this.once(key, function(endpoint) {
      started = true;
      if (endpoint) {
        req._start(endpoint.createStream(), options);
      } else {
        throw new Error('Negotiation did not succeed.');
      }
    });
  }

  return req;
};

/**
 * rpc starts an EncodedOutgoingRequest to the rpc endpoint.
 *
 * @param {string} path the destination path on the endpoint
 * @param {Object|external:Readable} msgSrc either an object to send or a
 *                                          Readable that provides objects to
 *                                          send to the endpoint
 * @param {Object} options holds optional info configuring the rpc
 * @param {Object} options.headers holds the rpc headers
 * @param {function} callback is node-js callback called with the response
 */
Agent.prototype.rpc = function rpc(path, msgSrc, options, callback) {
  options = util._extend({}, options);
  options.path = path;

  // Ensure that msgSrc to a readable.
  var src = msgSrc;
  if (!(src instanceof Readable)) {
    // There is just 1 message, create a Readable that streams it
    src = new Readable({objectMode:true});
    src.push(msgSrc);
    src.push(null);
  }

  var request = this.request(options, callback);
  src.pipe(request);
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
  this.secure = true;  // for insecure requests, this is updated in _start
  this.codecOpts = opts || {};
  this._encoder = new EncodingStream(this.codecOpts);
  var onFinish = this._finish.bind(this);
  this._encoder.on('finish', onFinish);
  this.cancelled = false;
  this.cancelResponse = undefined;
  this._data_sent = false;
  this._log = undefined;   // will be set to be child logger of the stream
}
EncodedOutgoingRequest.prototype = Object.create(OutgoingMessage.prototype, {
  constructor: { value: EncodedOutgoingRequest }
});

/**
 * Extends `http2.OutgoingMessage._finish` so as write an extra empty frame if
 * no data was sent.
 */
EncodedOutgoingRequest.prototype._finish = function _finish() {
  if (this.stream && !this._data_sent) {
    var emptyBuffer = new Buffer(0);
    this.stream.write(emptyBuffer);
  }
  OutgoingMessage.prototype._finish.call(this);
};

/**
 * Overrides `http2.OutgoingMessage.write` so that all writing is encoded.
 */
EncodedOutgoingRequest.prototype.write = function write() {
  if (this.cancelled)  {
    return;
  }
  if (this.stream) {
    this._data_sent = true;
    this._encoder.write.apply(this._encoder, arguments);
  } else {
    this.once('socket', this.write.apply.bind(this.write, this, arguments));
  }
};

/**
 * Overrides `http2.OutgoingMessage.end` so that all writing is encoded.
 */
EncodedOutgoingRequest.prototype.end = function end() {
  if (this.cancelled)  {
    return;
  }
  if (this.stream) {
    this._encoder.end.apply(this._encoder, arguments);
  } else {
    this.once('socket', this.end.apply.bind(this.end, this, arguments));
  }
};

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
  if (!this.secure && dorusu.blockSecureHeader(name)) {
    return;
  }
  if (name === 'deadline') {
    if (!(value instanceof Date)) {
      this._log.error({ key: 'deadline', value: value },
                      'Bad deadline value');
      this.emit('error', new Error('bad deadline value'));
      return;
    }
    var now = Date.now();
    var gap = value.getTime() - now;
    // treat dates in the past as a signal to finish immediately.
    if (gap < 0) {
      gap = 0;
    }
    var interval = microsToInterval(1000 * gap);
    OutgoingMessage.prototype.setHeader.call(this, 'grpc-timeout', interval);
    return;
  }
  if (name === 'grpc-timeout') {
    if (!isInterval(value)) {
      this._log.error({ key: 'grpc-timeout', value: value },
                      'Invalid grpc-timeout value');
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
 * @param {function} [options.headers] the headers to send
 * @param {function} [options.updateHeaders] used to update headers
 * @param {string} [options.path] the path to be accessed
 * @param {string} [options.plain] when true the connection is insecure
 */
EncodedOutgoingRequest.prototype._start = function _start(stream, options) {
  this._log = stream._log.child({ component: 'rpc_client' });
  this.secure = !options.plain;

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
    var clonedOptions = _.clone(options);
    delete clonedOptions.updateHeaders;
    var _restart = this._start.bind(this, stream);
    var withUpdatedHdrs = (err, updatedHeaders) => {
      if (!err) {
        clonedOptions.headers = updatedHeaders;
        this._log.debug({
          headers: updatedHeaders
        }, 'Finished updateHeaders');
        _restart(clonedOptions);
        return;
      }
      this.emit('error', err);
    };
    var authUri = 'https://' + options.host + '/' + options.serviceName;
    this._log.debug({
      authUri: authUri,
      headers: clonedOptions.headers || {}
    }, 'Calling updateHeaders');
    updateHeaders(authUri, options.headers, withUpdatedHdrs);
    return;
  }

  this.stream = stream;
  this._encoder.pipe(stream);

  // Use `EncodedOutgoingRequest.setHeader` to ensure only valid additional
  // headers are present
  this.setHeader('user-agent', 'dorusu-nodejs/0.1');
  this.setHeader('content-type', 'application/grpc');
  for (var key in options.headers) {
    this.setHeader(key, options.headers[key]);
  }

  // Add the standard headers
  var headers = this._headers;
  delete headers.host;  // this is sent as :authority
  headers[':scheme'] = options.protocol.slice(0, -1);
  headers[':method'] = options.method;
  headers[':authority'] = options.server_host_override || options.host;
  headers[':path'] = options.path;
  headers.te = 'trailers';

  // Set a timeout to reset the connection if headers[grpc-timeout] is set.
  if (headers['grpc-timeout']) {
    var timeoutMicros = intervalToMicros(headers['grpc-timeout']);
    setTimeout(this.cancel.bind(this, dorusu.rpcCode('DEADLINE_EXCEEDED')),
               Math.floor(timeoutMicros/1000));
    this._log.debug({'timeout': timeoutMicros}, 'Set rpc timeout');
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
  this.cancelResponse = response.canceller;
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
EncodedOutgoingRequest.prototype.abort = function abort(opt_code) {
  if (this.stream) {
    var cancelCode = opt_code || dorusu.rpcCode('CANCELLED');
    if (this.cancelResponse) {
      this.cancelResponse(cancelCode);
    }
    this.emit('cancel', cancelCode);
    this.cancelled = true;
    this.stream.unpipe();
    this.stream.reset('CANCEL');
  } else {
    this.on('socket', this.abort.bind(this, opt_code));
  }
};
// Make abort available as cancel, for similarity with existing dorusu
// implementations.
EncodedOutgoingRequest.prototype.cancel = EncodedOutgoingRequest.prototype.abort;

// Receiving push promises.
//
// For dorusu calls these should be ignored.  These are cancelled on receipt.
EncodedOutgoingRequest.prototype._onPromise =
  function _onPromise(stream, headers) {
    this._log.info({ push_stream: stream.id }, 'Receiving push promise');
    var promise = new http2.IncomingPromise(stream, headers);
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
  opts.highWaterMark = opts.highWaterMark || 32 * 1024 * 1024;
  this._decoder = new DecodingStream(opts);
  IncomingResponse.call(this, stream);

  // Re-invoke the PassThrough constructor.
  //
  // DecodedIncomingRequest inherits from IncomingResponse
  //
  // IncomingResponse inherits from PassThrough, but does not set the
  // highWaterMark.  (Its constructor should be updated to allow this).  As a
  // workaround, calling PassThrough's constructor again here seems to have the
  // desired effect.
  PassThrough.call(this, {highWaterMark: 32 * 1024 * 1024});

  // Pipe the stream to the decoder.
  stream.pipe(this._decoder);

  // Copy specific headers as metadata.
  this.metadata = {};

  // Verify that the rpcStatus header is received.
  stream.once('end', this._checkOnEnd.bind(this));
  this._rpcStatus = undefined;

  /**
   * canceller is a function(code) that's called with the cancellation status
   * code to cancel the response.
   */
  Object.defineProperty(this, 'canceller', {
    get: () => this._cancel.bind(this)
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
  this.stream.on('headers', (headers) => {
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
    _.forEach(headers, (value, name) => addMetadata(name, value));

    // Emit a metadata event whenever metadata is received.
    if (_.size(this.metadata) > 0 ) {
      this.emit('metadata', this.metadata);
    }
  };

var endsWithBin = /-bin$/;

DecodedIncomingResponse.prototype._addMetadata = function _addMetadata(k, v) {
  if (dorusu.isReservedHeader(k)) {
    return;
  }
  if (!endsWithBin.test(k)) {
    this.metadata[k] = v;
    return;
  }
  var realName = k.slice(0, -4);
  if (_.isArray(v)) {
    this.metadata[realName] = _.map(v, (x) => new Buffer(x, 'base64'));
  } else {
    this.metadata[realName] = new Buffer(v, 'base64');
  }
};

/**
 * Cancels the response, set the its rpcStatus.
 */
DecodedIncomingResponse.prototype._cancel = function _cancel(code) {
  this._rpcStatus = {
    'code': code,
    'message': ''
  };
  this._decoder.push(null);   /* End the decoder stream */

  /* Emit 'status' here; a'cancel' event is emitted on the request */
  this.emit('status', this._rpcStatus);
};

/**
 * an internal callback that confirms that the response has a status
 * assigned when it ends.
 */
DecodedIncomingResponse.prototype._checkOnEnd = function _checkOnEnd() {
  this._log.info('stream on <end>, rpcStatus is %j', this._rpcStatus);
  if (!this._rpcStatus) {
    throw new Error('No rpc status was received');
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
      this._log.debug(this._rpcStatus, 'the rpc status is already set');
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
}

/**
 * The nodejs `Buffer` class .
 * @external Buffer
 * @see https://nodejs.org/api/buffer.html
 */

/**
 * The nodejs `EventEmitter` class.
 * @external EventEmitter
 * @see https://nodejs.org/api/events.html
 */

/**
 * The nodejs `stream.Readable` class.
 * @external Readable
 * @see https://nodejs.org/api/stream.html#stream_class_stream_readable
 */
