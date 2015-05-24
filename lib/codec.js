'use strict';

var ConcatStream = require('concat-stream');
var Readable = require('stream').Readable;
var Transform = require('stream').Transform;

exports.encodeMessage = encodeMessage;
exports.decodeMessage = decodeMessage;
exports.EncodingStream = EncodingStream;
exports.DecodingStream = DecodingStream;

// The EncodingStream class
// ==========================

// Public API
// ----------

// - **Class EncodingStream()**
//   - A `Transform` that converts a stream of messages into a frame-encoded
//     data stream.
//
// - **Class DecodingStream()**
//   - A `Transform` that converts a frame-encoded data stream in a stream of
//     messages.
//
// - **encodeMessage(message, opts, callback)**:
//
//   - **message** the raw message to send
//   - **options** affecting how the message
//     - **compress**: can take the value 'gzip' or 'deflate'
//   - **callback** is called with the encoded message
//
// - **decodeMessage(encoded, callback)**:
//
//   - **encoded** the encoded message to decode
//   - **callback** func(err, buf) called with a buffer containing

function encodeMessage(message, opts, callback) {
  var s = new Readable();
  opts = opts || {};
  if (opts.serializer) {
    s.push(opts.serializer(message));
  } else {
    s.push(message);
  }
  s.push(null);
  var dest = new MsgHeaderStream(opts, callback);
  s.pipe(dest);
};

/**
 * EncodingStream is a sink of messages to be sent as single frames.
 *
 * For each input, it emits the buffer obtained by encoding it with
 * `encodeMessage`.
 */
function EncodingStream(opts) {
  // allow use without new
  if (!(this instanceof EncodingStream)) {
    return new EncodingStream();
  }

  if (!opts) opts = {}; // ensure an object
  opts.writableObjectMode = true;  // This stream is to be written with messages
  Transform.call(this, opts);
};
EncodingStream.prototype = Object.create(
  Transform.prototype, { constructor: { value: EncodingStream } });

EncodingStream.prototype._transform = function(msg, unused_encoding, next) {
  var that = this;
  var buf = Buffer(msg);
  encodeMessage(buf, null /* no serializer */, function(encoded) {
    that.push(encoded);
    next();
  });
};

// The minimum length of and encoded buffer.
var MINIMUM_ENCODED_LENGTH = 5;
var LENGTH_INDEX = 1;

function decodeMessage(encoded, callback) {
  var buf = Buffer(encoded);
  if (buf.length < MINIMUM_ENCODED_LENGTH) {
    return callback(new Error(
      'Encoded message was smaller than ' + MINIMUM_ENCODED_LENGTH));
  };

  // TODO: interpret the decompression bit once that's available.
  var compression = buf.readUInt8(0);
  var length = buf.readUInt32BE(LENGTH_INDEX, 4);
  var payload = buf.slice(MINIMUM_ENCODED_LENGTH);
  if (compression == 0 && payload.length !== length) {
    return callback(new Error('Encoded message length is wrong'));
  };

  callback(null, payload);
};

/**
 * DecodingStream accepts data representing a series of encoded messages.
 *
 * It emits the buffers obtained by decoding each with `decodeMessage`.
 */
function DecodingStream(opts) {
  // allow use without new
  if (!(this instanceof DecodingStream)) {
    return new DecodingStream();
  }

  if (!opts) opts = {}; // ensure an object
  opts.readableObjectMode = true; // Buffers will read from this stream
  Transform.call(this, opts);

  this._buffer = null;
};
DecodingStream.prototype = Object.create(
  Transform.prototype, { constructor: { value: DecodingStream } });

DecodingStream.prototype._transform = function _transform(chunk, unused_encoding, next) {
  // create or update the buffer
  this._buffer = Buffer.concat([this._buffer, new Buffer(chunk)]) || new Buffer(msg);
  console.log('Now buffer is:' + this._buffer);
  if (this._buffer.length < MINIMUM_ENCODED_LENGTH) {
    // Not enough header bytes yet, keep going
    // TODO: log this
    next();
    return;
  }

  var length = this._buffer.readUInt32BE(LENGTH_INDEX, 4);
  var unused_compression = this._buffer.readUInt8(0);
  var payloadLength = length + MINIMUM_ENCODED_LENGTH;
  // TODO: once the compression enum is decided, perform decompression
  if (this._buffer.length < payloadLength) {
    // Not enough payload bytes yet, keep going
    // TODO: log this
    next();
    return;
  }

  // There is a complete buffer, emit it
  var msg = this._buffer.slice(MINIMUM_ENCODED_LENGTH, payloadLength);
  // TODO: log the message for debug
  console.log('Pushing: ' + msg);
  this.push(msg);
  this._buffer = this._buffer.slice(payloadLength);
  next();
};

DecodingStream.prototype._flush = function _flush(done) {
  var that = this;
  decodeMessage(this._buffer, function(err, buf) {
    if (err) {
      that.emit('error', err);
      console.log('error: ' + err);
      return;
    }
    console.log('Pushing: ' + buf);
    that.push(buf);
    done();
  });
};

// OutgoingMessage is Writable.
//
// That means that we send data by piping bytes to it.
//
// However, it

/**
 * MsgHeaderStream is a Writable stream that concatenates strings or binary
 * data and calls a callback with a Buffer prepended by its length.
 *
 * @param opts options for determining how the data is written.
 * @param callback The callback invoked when all data has been written.
 */
function MsgHeaderStream(opts, callback) {
  // Initializes the base class with the buffer
  this.opts = opts || {};
  ConcatStream.call(this, { encoding: 'buffer' }, callback);
  this.size = 0;
};
MsgHeaderStream.prototype = Object.create(
  ConcatStream.prototype, {constructor: {value: MsgHeaderStream }});

/**
 * _write overrides the base to count the size of the bytes.
 */
MsgHeaderStream.prototype._write = function(chunk, enc, next) {
  this.body.push(chunk);
  this.size += chunk.length;
  next();
};

/**
 * getBody overrides the base to return the body prefixed with the size
 */
MsgHeaderStream.prototype.getBody = function getBody() {
  // Compute the header block.
  var buf = new Buffer(5);
  if (this.opts.compression) {
    // TODO: fix these compression value once the meaning of the
    // enum values are decided.
    buf.writeUIntBE(0, 0, 1);
  } else {
    buf.writeUIntBE(0, 0, 1);
  }
  buf.writeUIntBE(this.size, 1, 4);
  var parts = this.body.slice();
  parts.unshift(buf);

  // Concatenate the result into a single buffer.
  var bufs = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (Buffer.isBuffer(p)) {
      bufs.push(p);
    } else if (typeof p === 'string' || isArrayish(p)
               || (p && typeof p.subarray === 'function')) {
      bufs.push(Buffer(p));
    } else bufs.push(Buffer(String(p)));
  }
  return Buffer.concat(bufs);
};

function isArrayish (arr) {
  return /Array\]$/.test(Object.prototype.toString.call(arr));
}
