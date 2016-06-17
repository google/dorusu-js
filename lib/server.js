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
 * dorusu/server allows the creation of servers to be accessed via the rpc
 * protocol.
 *
 * @module dorusu/server
 */

var _ = require('lodash');
var tls = require('tls');
var intervalToMicros = require('./codec').intervalToMicros;
var isInterval = require('./codec').isInterval;
var dorusu = require('./dorusu');
var protocol = require('http2').protocol;
var removeBinValues = require('./codec').removeBinValues;

var DecodingStream = require('./codec').DecodingStream;
var EncodingStream = require('./codec').EncodingStream;
var Endpoint = protocol.Endpoint;
var IncomingRequest = require('http2').IncomingRequest;
var OutgoingResponse = require('http2').OutgoingResponse;
var PassThrough = require('stream').PassThrough;
var Server = require('http2').Server;

// EncodedOutgoingResponse class
// ----------------------------

exports.EncodedOutgoingResponse = EncodedOutgoingResponse;

/**
 * EncodedOutgoingResponse extends `http2.OutgoingResponse` for use in rpc
 * servers.
 *
 * @param {Stream} stream a `http2.Stream`
 * @param {object} opts configures the response's encoder
 * @constructor
 */
function EncodedOutgoingResponse(stream, opts) {
  // The stream's write method is to be called with encoded objects.
  opts = opts || {};
  opts.highWaterMark = opts.highWaterMark || 32 * 1024 * 1024;
  /**
   * The rpc status message.
   *
   * @type {string|null}
   * @name EncodedOutgoingResponse#rpcMessage
   */
  this.rpcMessage = null;

  /**
   * The rpc status code.
   *
   * @type {number|null}
   * @name EncodedOutgoingResponse#rpcCode
   */
  this.rpcCode = null;

  this._encoder = new EncodingStream(opts);
  OutgoingResponse.call(this, stream);

  // The base class #end method does trailer handling and closes the stream. So:
  //
  // - _encoder should pipe to the stream without closing it on its end
  // - _encoder's finish event should invoke the base class #end to close
  //   the stream with appropriate header handling.
  this._encoder.pipe(this.stream, {end: false});
  this._encoder.on('finish', this._finish.bind(this));

  // Handle errors in write the response by sending the INTERNAL status code.
  this._encoder.on('error', () => {
    this.rpcCode = dorusu.rpcCode('INTERNAL');
    this._finish();
  });

  // emit a cancel event to allow a additional cleanup.
  stream.on('state', (state) => {
    if (state === 'CLOSED') {
      this.stream = null;
   }
  });

  this.sendDate = false;  /* reset this, set by OutgoingResponse.call(...) */
  this.setHeader('content-type', 'application/grpc');

  // Allow .marshal to set the marshaller on the encoder
  Object.defineProperty(this, 'marshal', {
    set: (x) => { this._encoder.marshal = x; },
    get: () => this._encoder.marshal
  });
}
EncodedOutgoingResponse.prototype = Object.create(OutgoingResponse.prototype, {
  constructor: { value: EncodedOutgoingResponse }
});

/**
 * Overrides the base class to expect objects to be encoded in each call, i.e,
 * the response is expected to be written to in writeableObjectMode with objects
 * representing rpc messages that will be encoded into buffers by this
 * instance's encoder.
 */
EncodedOutgoingResponse.prototype.write = function write() {
  this._implicitHeaders();
  this._encoder.write.apply(this._encoder, arguments);
};

/**
 * Overrides the base class to ensure correctly implement the rpc protocol.
 *
 * Ensures
 * - any final message is correctly encoded as defined by the rpc protocol.
 */
EncodedOutgoingResponse.prototype.end = function end() {
  if (this.stream) {
    this._implicitHeaders();
    this._encoder.end.apply(this._encoder, arguments);
  }
};

/**
 * Overrides the base class to ensure correctly implement the rpc protocol.
 *
 * Ensures that the rpc protocol's required trailers are sent.
 */
EncodedOutgoingResponse.prototype._finish = function _finish() {
  if (this.stream) {
    this._updateTrailers();
    OutgoingResponse.prototype._finish.call(this);
  } else {
    this.once('socket', this._finish.bind(this));
  }
};

/**
 * Used by EncodedOutgoingResponse#_end
 */
EncodedOutgoingResponse.prototype._updateTrailers = function _updateTrailers() {
  var pre = this._trailers || {};
  var trailers = {};
  if (!pre['grpc-status']) {
    if (!this.rpcCode) {
      // no code set, default to OK
      trailers['grpc-status'] = dorusu.rpcCode('OK');
    } else {
      trailers['grpc-status'] = this.rpcCode;
    }
  }
  // Set the status message is this.rpcMessage is set.
  if (!trailers['grpc-message'] && this.rpcMessage) {
    trailers['grpc-message'] = this.rpcMessage;
  }

  // loop through the original trailers
  //
  // - update key and value using removeBinValues in trailers
  _.forEach(pre, function updateATrailer(value, key) {
    var noBins = removeBinValues(key, value);
    trailers[noBins[0]] = noBins[1];
  });
  this.addTrailers(trailers);
};

/**
 * Extends the base class to detect and transform headers with binary values.
 *
 * @param {string} name the name of header
 * @param {string|Buffer|Array} value the header value
 */
EncodedOutgoingResponse.prototype.setHeader = function setHeader(name, value) {
  var noBins = removeBinValues(name, value);
  OutgoingResponse.prototype.setHeader.call(this, noBins[0], noBins[1]);
};

// DecodedIncomingRequest class
// ----------------------------

exports.DecodedIncomingRequest = DecodedIncomingRequest;

// DecodedIncomingRequest extends `http2.IncomingRequest` for use in rpc servers.
//
// - `EventEmitter.on` is extended to delegate the 'data' and 'end'
//     subscriptions to a decoder to which a stream's data is piped
//
// - `IncomingRequest._onHeaders` is extended to fire a `metadata` event
//     in which contains the subset of http2 headers that contain rpc metadata

/**
 * DecodedIncomingRequest extends `http2.IncomingRequest` for use in rpc servers.
 *
 * @param {Stream} stream a `http2.Stream`
 * @constructor
 */
function DecodedIncomingRequest(stream) {
  this._decoder = new DecodingStream({highWaterMark: 32 * 1024 * 1024});
  IncomingRequest.call(this, stream);

  // Re-invoke the PassThrough constructor.
  //
  // DecodedIncomingRequest inherits from IncomingRequest
  //
  // IncomingRequest inherits from PassThrough, but does not set the
  // highWaterMark.  (Its constructor should be updated to allow this).  As a
  // workaround, calling PassThrough's constructor again here seems to have the
  // desired effect.
  PassThrough.call(this, {highWaterMark: 32 * 1024 * 1024});

  // Pipe the stream to the decoder, but emit the errors from this instance
  stream.pipe(this._decoder).on('error', (err) => {
    this._decoder.unpipe();
    if (err === this._decoder) {
      this.emit('cancel', dorusu.rpcCode('INTERNAL'));
    } else {
      this.emit('error', err);
    }
  });

  // When the stream closes, emit a cancel event to allow a additional cleanup.
  this.closed = false;
  stream.on('state', (state) => {
    if (state === 'CLOSED') {
      this.closed = true;
      this.emit('cancel', dorusu.rpcCode('CANCELLED'));
    }
  });

  // Allow access to unreserved headers as metadata.
  this.metadata = {};

  // A deadline may be set, by sending a protocol-encoded timeout value.
  this.deadline = undefined;
  this.timeoutValue = undefined;

  // Allow .unmarshal to set the unmarshaller on the decoder
  Object.defineProperty(this, 'unmarshal', {
    set: (x) => { this._decoder.unmarshal = x; },
    get: () => { return this._decoder.unmarshal; }
  });
}

DecodedIncomingRequest.prototype = Object.create(
  IncomingRequest.prototype, { constructor: { value: DecodedIncomingRequest } });

/**
 * Adds a child request.
 *
 * A child request is a request to another service that's made during the
 * execution of an existing request on a server.
 *
 * @param req an EncodedOutgoingRequest the child request
 */
DecodedIncomingRequest.prototype.addChild = function addChild(req) {
  // Handle either 'cancel' or error events:
  //
  // cancel: for client cancellation and deadline propagation, and internal errors
  // error: for some internal and user errors
  if (this.closed) {
    req.cancel();
  } else {
    this.on('cancel', (code) => { req.cancel(code); });
    this.on('error', () => { req.cancel(); });
  }
};

/**
 * Overrides `EventEmitter.on` to forward subscriptions to the `data` and `end`
 * events to the decoder so that listeners of this class get the decoded
 * Buffers|Objects.
 */
DecodedIncomingRequest.prototype.on = function on(event, listener) {
  // TODO: determine if there are other Readable events that whose listeners to
  // should be forwarded.
  if ((event === 'data') || (event === 'end')) {
    this._decoder.on(event, listener && listener.bind(this));
  } else {
    IncomingRequest.prototype.on.call(this, event, listener);
  }
};

/**
 * Extends `IncomingRequest._onHeaders` to handle the rpc protocols' metadata
 * headers.
 *
 * @param {object} headers the headers (or trailers) received on the stream.
 */
DecodedIncomingRequest.prototype._onHeaders = function _onHeaders(headers) {
  IncomingRequest.prototype._onHeaders.call(this, headers);
  this._updateMetadata(headers);
  this._checkTimeout(headers);
};

DecodedIncomingRequest.prototype._checkTimeout =
  function _checkTimeout(headers) {
    if (!headers.hasOwnProperty('grpc-timeout')) {
      return;
    }
    var value = headers['grpc-timeout'];
    if (!isInterval(value)) {
      this._log.error('Invalid header: bad grpc-timeout value');
      this.stream.reset('PROTOCOL_ERROR');
      this.emit('error', new Error('bad grpc-timeout value'));
      return;
    }
    this.timeoutValue = value;
    var timeoutMicros = intervalToMicros(value);
    this.deadline = new Date(Date.now() + Math.floor(timeoutMicros / 1000));
    setTimeout(() => {
      this.emit('cancel', dorusu.rpcCode('DEADLINE_EXCEEDED'));
    }, Math.floor(timeoutMicros / 1000));
  };

// TODO: make the _addMetadata/_updateMetadata a mixin
DecodedIncomingRequest.prototype._updateMetadata =
  function _updateMetadata(headers) {
    var addMetadata = this._addMetadata.bind(this);
    _.forEach(headers, (value, name) => { addMetadata(name, value); });

    // Emit a metadata event whenever metadata is received.
    if (_.size(this.metadata) > 0) {
      this.emit('metadata', this.metadata);
    }
  };

// TODO: make the _addMetadata/_updateMetadata a mixin
var endsWithBin = /-bin$/;

// copy any of headers that's not a reserved header into the metadata
//
// any header that ends with -bin, should be base64 unencoded to a buffer; if
// it can't be unpacked reset the stream and raised an Exception
DecodedIncomingRequest.prototype._addMetadata = function _addMetadata(k, v) {
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

// RpcServer class
// ---------------

exports.RpcServer = RpcServer;

/**
 * RpcServer extends `http2.Server` for use in rpc servers.
 *
 * @param {object} options configures the rpc server
 * @param {app.RpcApp} options.app when specified, the server is configured with
 *                                  the handlers added by calling app.dispatch()
 * @constructor
 */
function RpcServer(options) {
  Server.call(this, options);
  this.app = options.app;
}
RpcServer.prototype = Object.create(Server.prototype, {
  constructor: { value: RpcServer }
});

/**
 * Extends `http2.Server._start` to handle rpc connections
 *
 * Uses EncodedOutgoingResponse and DecodedIncomingRequest instead of the parent
 * classes when constructing the request and response when handling new streams.
 */
RpcServer.prototype._start = function _start(socket) {
  var endpoint = new Endpoint(this._log, 'SERVER', this._settings);

  this._log.info({ e: endpoint,
                   client: socket.remoteAddress + ':' + socket.remotePort,
                   SNI: socket.servername
                 }, 'New incoming RPC connection');

  endpoint.pipe(socket).pipe(endpoint);

  var that = this;
  endpoint.on('stream', function _onStream(stream) {
    var response = new EncodedOutgoingResponse(stream);
    var request = new DecodedIncomingRequest(stream);

    if (that.app) {
      request.once('ready', that._useApp.bind(that, request, response));
    }
    request.once('ready', that.emit.bind(that, 'request', request, response));

    // Handle errors in request handlers by ending with the UNKNOWN status code
    request.once('error', () => {
      response.rpcCode = dorusu.rpcCode('UNKNOWN');
      response.end();
    });

    // When the request is cancelled, cancel the response.
    request.once('cancel', (code) => {
      response.rpcCode = code || dorusu.rpcCode('CANCELLED');
      response.end();
    });
  });

  endpoint.on('error', this.emit.bind(this, 'clientError'));
  socket.on('error', this.emit.bind(this, 'clientError'));

  this.emit('connection', socket, endpoint);
};

RpcServer.prototype._useApp = function _useApp(request, response) {
  if (!this.app || !this.app.hasRoute(request.url)) {
    return;
  }
  request.unmarshal = this.app.unmarshaller(request.url);
  response.marshal = this.app.marshaller(request.url);
};

function createServerRaw(options, requestListener) {
  if (typeof options === 'function') {
    requestListener = options;
    options = {};
  }

  if (options.pfx || (options.key && options.cert)) {
    throw new Error('options.pfx, options.key, and options.cert are nonsensical!');
  }

  options.plain = true;
  var server = new RpcServer(options);

  // If there is an app, the requestListener if present acts as a fallback.
  // Otherwise the requestListener handlers the requests
  if (options.app) {
    server.on('request', options.app.dispatcher(requestListener));
  } else if (requestListener) {
    server.on('request', requestListener);
  }

  return server;
}

function createServerTLS(options, requestListener) {
  if (typeof options === 'function') {
    throw new Error('options are required!');
  }
  if (!options.pfx && !(options.key && options.cert)) {
    throw new Error('options.pfx or options.key and options.cert are required!');
  }
  options.plain = false;
  options.SNICallback = function SNICallback(name, done) {
    var ctx = tls.createSecureContext({
      key: options.key,
      cert: options.cert
    });
    done(null, ctx);
  };

  var server = new RpcServer(options);

  // If there is an app, the requestListener if present acts as a fallback.
  // Otherwise the requestListener handlers the requests
  if (options.app) {
    server.on('request', options.app.dispatcher(requestListener));
  } else if (requestListener) {
    server.on('request', requestListener);
  }

  return server;
}

// Exposed main interfaces for HTTPS connections (the default)
exports.https = {};
exports.createServer = exports.https.createServer = createServerTLS;

// Exposed main interfaces for raw TCP connections
exports.raw = {};
exports.raw.createServer = createServerRaw;
