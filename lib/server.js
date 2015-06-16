'use strict';

var _ = require('lodash');
var intervalToMicros = require('./codec').intervalToMicros;
var isInterval = require('./codec').isInterval;
var nurpc = require('./nurpc');
var protocol = require('http2').protocol;
var removeBinValues = require('./codec').removeBinValues;

var DecodingStream = require('./codec').DecodingStream;
var EncodingStream = require('./codec').EncodingStream;
var Endpoint = protocol.Endpoint;
var IncomingRequest = require('http2').IncomingRequest;
var OutgoingResponse = require('http2').OutgoingResponse;
var Server = require('http2').Server;

// EncodedOutgoingResponse class
// ----------------------------

exports.EncodedOutgoingResponse = EncodedOutgoingResponse;

// EncodedOutgoingResponse extends http2.OutgoingResponse for use in rpc servers.
//
// - `Writeable._write` is overridden to expect objects i.e. this is response is
//                      is to be written to in writableObjectMode with Buffers
//                      containing discrete rpc messages.
//
// - `Writable.end` is overridden to ensure the rpc protocol'ss required
//                  trailers are sent.
//
// Properties:
//   - rpcMessage: when it's sent as the rpc status message
//   - rpcCode: when set, it's as sent the rpc status code.  If not set
//              it defaults to O (OK)
function EncodedOutgoingResponse(stream, opts) {
  // The stream's _write method is to be called with encoded objects.
  opts = opts || {};
  this._encoder = EncodingStream(opts);
  this._encoder.pipe(stream);
  this.rpcMessage = null;
  this.rpcCode = null;

  OutgoingResponse.call(this, stream);
  this.sendDate = false;  /* reset this, set by OutgoingResponse.call(...) */
}
EncodedOutgoingResponse.prototype = Object.create(OutgoingResponse.prototype, {
  constructor: { value: EncodedOutgoingResponse }
});

// _write overrides http2.OutgoingResponse._write so that all writes go through
// the encoder Transform stream.
EncodedOutgoingResponse.prototype._write = function _write(chunk, enc, next) {
  if (this.stream) {
    this._encoder.write(chunk, enc, next);
  } else {
    OutgoingResponse.prototype._write.call(this, chunk, enc, next);
  }
};

// end overrides http2.OutgoingResponse.end so that the rpc protocol's trailers
// get written.
//
// http2.OutgoingMessage, the parent of http2.OutgoingResponse implements the
// finish event so that any trailers get sent. This override makes sure `end`
// adds the rpc protocol's required trailers.
EncodedOutgoingResponse.prototype.end = function end() {
  this._updateTrailers();
  return OutgoingResponse.prototype.end.apply(this, arguments);
};

// _updateTrailers updates the trailers with values required by the rpc
// protocol.
EncodedOutgoingResponse.prototype._updateTrailers = function _updateTrailers() {
  var trailers = {}
  _.merge(trailers, this._trailers);
  if (!trailers['grpc-status']) {
    if (!this.rpcCode) {
      // no code set, default to OK
      trailers['grpc-status'] = nurpc.rpcCode('OK');
    } else {
      trailers['grpc-status'] = this.rpcCode;
    }
  }
  // Set the status message is this.rpcMessage is set.
  if (!trailers['grpc-message'] && this.rpcMessage) {
    trailers['grpc-message'] = this.rpcMessage
  }

  // loop through the trailers, replace key with a Buffer value with an ascii
  // value and modify the key accordingly
  var updatedTrailers = {};
  _.forEach(trailers, function updateATrailer(value, key) {
    var noBins = removeBinValues(key, value);
    updatedTrailers[noBins[0]] = noBins[1];
  });
  this.addTrailers(updatedTrailers);
};

var isAscii = /^[\x00-\x7F]+$/;

// setHeader extends the base class implementation to transform binary headers.
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
//     in which contains the subset of http2 headers that contain metadata
function DecodedIncomingRequest(stream) {
  this._decoder = DecodingStream();
  IncomingRequest.call(this, stream);

  // Pipe the stream to the decoder.
  stream.pipe(this._decoder);

  // Copy specific headers as metadata.
  this.metadata = {};

  // A deadline may be set, by sending a protocol-encoded timeout value.
  this.deadline = undefined;
  this.timeoutValue = undefined;
};

DecodedIncomingRequest.prototype = Object.create(
  IncomingRequest.prototype, { constructor: { value: DecodedIncomingRequest } });

// Overriding `EventEmitter`'s `on(event, listener)` method to forward certain
// subscriptions to ``decoder`.
//
// Forward subscriptions to `data` and `end` to decoder, so that listeners are
// getting decoded data.
DecodedIncomingRequest.prototype.on = function on(event, listener) {
  // TODO: determine if there are other Readable events that whose listeners to
  // should be forwarded.
  if ((event === 'data') || (event === 'end')) {
    this._decoder.on(event, listener && listener.bind(this));
  } else {
    IncomingRequest.prototype.on.call(this, event, listener);
  }
};

// _onHeaders extends IncomingRequest to handle the rpc protocol's metadata
DecodedIncomingRequest.prototype._onHeaders = function _onHeaders(headers) {
  var updateMetadata = this._updateMetadata.bind(this);
  var checkTimeout = this._checkTimeout.bind(this);
  IncomingRequest.prototype._onHeaders.call(this, headers);
  updateMetadata(headers);
  checkTimeout(headers, true /* timeout is allowed */);

  this.stream.on('headers', function(headers) {
    updateMetadata(headers);
    checkTimeout(headers, false /* timeout is not allowed */);
  });
};

DecodedIncomingRequest.prototype._checkTimeout =
  function _checkTimeout(headers, isAllowed) {
    if (!headers.hasOwnProperty('grpc-timeout')) {
      return;
    }
    if (!isAllowed) {
      console.error('grpc-timeout in the trailers!');
      this.stream.reset('PROTOCOL_ERROR');
      this.emit('error', new Error('grpc-timeout in the trailers!'));
     }
    var value = headers['grpc-timeout'];
    if (!isInterval(value)) {
      console.error('bad grpc-timeout value: ', value);
      this.stream.reset('PROTOCOL_ERROR');
      this.emit('error', new Error('bad grpc-timeout value'));
      return;
    }
    this.timeoutValue = value;
    var timeoutMicros = intervalToMicros(value);
    this.deadline = Date.now() + Math.floor(timeoutMicros / 1000);
  }

// TODO: make the _addMetadata/_updateMetadata a mixin
DecodedIncomingRequest.prototype._updateMetadata =
  function _updateMetadata(headers) {
    var addMetadata = this._addMetadata.bind(this);
    _.forEach(headers, function(value, name) {
      addMetadata(name, value);
    });

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

// RpcServer class
// ---------------

exports.RpcServer = RpcServer;

// RpcServer extends `http2.Server` for use in rpc servers.
//
// - _start is overridden to use `DecodedIncomingRequest` and
//     `EncodedOutgoingResponse` as the request and response constructors
//     respectively
function RpcServer(options) {
  Server.call(this, options);
};
RpcServer.prototype = Object.create(Server.prototype, {
  constructor: { value: RpcServer }
});

// Overrides `http2.Server._start` to handle rpc connections
//
// starts HTTP/2, but uses EncodedOutgoingResponse and DecodedIncomingRequest
// for constructing the request and response when handling new streams.
RpcServer.prototype._start = function _start(socket) {
  var endpoint = new Endpoint(this._log, 'SERVER', this._settings);

  this._log.info({ e: endpoint,
                   client: socket.remoteAddress + ':' + socket.remotePort,
                   SNI: socket.servername
                 }, 'New incoming RPC connection');

  endpoint.pipe(socket).pipe(endpoint);

  var self = this;
  endpoint.on('stream', function _onStream(stream) {
    var response = new EncodedOutgoingResponse(stream);
    var request = new DecodedIncomingRequest(stream);

    request.once('ready', self.emit.bind(self, 'request', request, response));
  });

  endpoint.on('error', this.emit.bind(this, 'clientError'));
  socket.on('error', this.emit.bind(this, 'clientError'));

  this.emit('connection', socket, endpoint);
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

  if (requestListener) {
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

  var server = new RpcServer(options);

  if (requestListener) {
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

// notFound is used in service-building to indicate that a request was not
// found.
exports.notFound = function notFound(request, response) {
  request.once('data', function(data) {
    response.rpcCode = nurpc.rpcCode('NOT_FOUND');
    response.end('');
  });
}

exports.makeDispatcher = makeDispatcher;

// makeDispatcher is used in service-building to indicate that a request was not
// found.
function makeDispatcher(handlers) {
  handlers = handlers || {};
  var notFound = exports.notFound;
  var handle = function handle(request, response) {
    if (handlers.hasOwnProperty(request.url)) {
      handlers[request.url](request, response);
    } else {
      notFound(request, response);
    }
  }
  return handle;
}
