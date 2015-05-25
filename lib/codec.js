'use strict';

var _ = require('lodash');
var util = require('util');

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
//   - **options** affecting how the message is encoded
//     - **compress**: can take the value 'gzip' or 'deflate'
//     - **serializer**: a function f(message): Buffer
//   - **callback** is called with the encoded message
//
// - **decodeMessage(encoded, options, callback)**:
//
//   - **encoded** the encoded message to decode
//     - **compress**: can take the value 'gzip' or 'deflate'
//     - **deserializer**: a function f(Buffer): object
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
    return new EncodingStream(opts);
  }

  this.opts = opts = opts || {};   // ensure opts is an object
  opts.writableObjectMode = true;  // the messages are objects
  Transform.call(this, opts);
};
EncodingStream.prototype = Object.create(
  Transform.prototype, { constructor: { value: EncodingStream } });

EncodingStream.prototype._transform = function(msg, unused_encoding, next) {
  var that = this;
  var buf = Buffer(msg);
  encodeMessage(buf, this.opts, function(encoded) {
    that.push(encoded);
    next();
  });
};

// The minimum length of and encoded buffer.
var MINIMUM_ENCODED_LENGTH = 5;
var LENGTH_INDEX = 1;
var COMPRESSION_INDEX = 0;

function decodeMessage(encoded, opts, callback) {
  opts = opts || {};
  var buf = Buffer(encoded);
  if (buf.length < MINIMUM_ENCODED_LENGTH) {
    return callback(new Error(
      'Encoded message was smaller than ' + MINIMUM_ENCODED_LENGTH));
  };

  // TODO: interpret the decompression bit once that's available.
  var compression = buf.readUInt8(COMPRESSION_INDEX);
  var length = buf.readUInt32BE(LENGTH_INDEX, 4);
  var payload = buf.slice(MINIMUM_ENCODED_LENGTH);
  if (compression == 0 && payload.length !== length) {
    return callback(new Error('Encoded message length is wrong'));
  };
  if (opts.deserializer) {
    payload = opts.deserializer(payload);
  }
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
    return new DecodingStream(opts);
  }

  this.opts = opts = opts || {}; // ensure opts is an object
  opts.readableObjectMode = true; // Buffers will read from this stream
  Transform.call(this, opts);

  this._buffer = null;
};
DecodingStream.prototype = Object.create(
  Transform.prototype, { constructor: { value: DecodingStream } });

DecodingStream.prototype._transform =
  function _transform(chunk, unused_encoding, next) {
    // Create or update the buffer.
    if (this._buffer) {
      this._buffer = Buffer.concat([this._buffer, chunk]);
    } else {
      this._buffer = chunk;
    }
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
    var msg = new Buffer(
      this._buffer.slice(MINIMUM_ENCODED_LENGTH, payloadLength));
    // TODO: log the message for debug
    if (this.opts.deserializer) {
      this.push(this.opts.deserializer(msg));
    } else {
      this.push(msg);
    }
    this._buffer = this._buffer.slice(payloadLength);
    next();
  };

DecodingStream.prototype._flush = function _flush(done) {
  if (this._buffer.length === 0) {
    done();
    return;
  }
  var that = this;
  var pushDecoded = function pushDecoded(err, buf) {
    if (err) {
      that.emit('error', err);
      util.log('decodeMessageCb: error: ', err);
      return;
    }
    if (that.opts.deserializer) {
      that.push(that.opts.deserializer(buf));
    } else {
      that.push(buf);
    }
    done();
  };
  decodeMessage(this._buffer, null, pushDecoded);
};

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

var microsBySuffix = {
  'H': 3600 * Math.pow(10, 6),
  'M': 60 * Math.pow(10, 6),
  'S': Math.pow(10, 6),
  'm': Math.pow(10, 3),
  'u': 1
  // 'n': 0 // is never used when encoding and interval
};
var maxInterval = Math.pow(10, 8) - 1;

exports.microsToInterval = microsToInterval;
exports.intervalToMicros = intervalToMicros;
exports.isInterval = isInterval;

/**
 * Encodes an interval value for transmission.
 *
 * @param micros an interval value in microseconds
 * @result a valid encoding of the interval
 *
 * @throws an Exception if the value can't be encoded, as its an error
 * provide such a value.
 */
function microsToInterval(micros) {
  var res = null;
  _.forEach(microsBySuffix, function(denom, s) {
    if (micros % denom == 0) {
      var amt = micros/denom;
      while (amt > maxInterval && s != 'H') {
        switch(s) {
        case 'u':
          amt = Math.floor(amt / 1000);
          s = 'm';
          break;
        case 'm':
          amt = Math.floor(amt / 1000);
          s = 'S';
          break;
        case 'S':
          amt = Math.floor(amt / 60);
          s = 'M';
          break;
        case 'M':
          amt = Math.floor(amt / 60);
          s = 'H';
          break;
        }
      }
      if (amt <= maxInterval) {
        res = '' + amt + s;
        return false;
      }
    }
  });
  if (res) {
    return res;
  }
  util.log('interval encode failed: could not encode ', micros);
  throw new Error('interval encode failed');
}

var intervalRx = /^(\d+)(H|M|S|m|u|n)$/;

/**
 * Decodes an interval value into a value in microseconds.
 *
 * @param interval an encoded interval value
 * @result the value of the interval in microseconds
 *
 * @throws an Exception if the interval can't be decoded.
 */
function intervalToMicros(interval) {
  var parsed = interval.match(intervalRx);
  if (!parsed) {
    util.log('interval decode failed: could not encode ', interval);
    throw new Error('interval decode failed');
  }
  var amt = parseInt(parsed[1], 10);
  var suffix = parsed[2];
  if (suffix === 'n') {  // handle nanoseconds by converting them to usecs.
    suffix = 'u';
    amt = Math.floor(amt / 1000);
  }
  return microsBySuffix[suffix] * amt;
}

/**
 * Determines is a given value is a valid interval.
 *
 * @param interval the value to check
 * @result true if the value is an valid interval otherwise false.
 */
function isInterval(interval) {
  return !!interval.match(intervalRx);
}
