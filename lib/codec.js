'use strict';

/**
 * nurpc/codec contains provides behaviour used in encoding and decoding message
 * sent using the rpc protocol.
 *
 * @module nurpc/codec
 */

var _ = require('lodash');
var util = require('util');

var ConcatStream = require('concat-stream');
var Readable = require('stream').Readable;
var Transform = require('stream').Transform;

/**
 * encodeMessage encodes an rpc-protocol encoded message.
 *
 * @param {object} message the message to encode
 * @param {object} opts configures the encoding
 * @param {function} opts.marshal converts an object into a `Buffer`
 * @param {function} done is node-style callback function
 */
exports.encodeMessage = function encodeMessage(message, opts, done) {
  var s = new Readable();
  opts = opts || {};
  if (opts.marshal) {
    s.push(opts.marshal(message));
  } else {
    s.push(message);
  }
  s.push(null);
  var dest = new MsgHeaderStream(opts, done);
  s.pipe(dest);
};
var encodeMessage = exports.encodeMessage;

exports.EncodingStream = EncodingStream;

/**
 * EncodingStream is a `Transform` that encodes messages as required
 * by the rpc protocol.
 *
 * For each input, it emits the buffer obtained by encoding it with
 * `encodeMessage`.
 *
 * @param {object} opts is used to configure how messages are enccoded
 * @param {function} [opts.marshal] converts an object into a `Buffer`
 * @constructor
 * @extends external:Transform
 */
function EncodingStream(opts) {
  // allow use without new
  if (!(this instanceof EncodingStream)) {
    return new EncodingStream(opts);
  }

  this.opts = opts = opts || {};   // ensure opts is an object
  opts.writableObjectMode = true;  // the messages are objects
  this._marshal = opts.marshal;
  Transform.call(this, opts);

  /**
   * Allows the marshal function to be updated.
   *
   * @name EncodingStream#marshal
   * @type {function}
   */
  Object.defineProperty(this, "marshal", {
    set: function(x) { this._marshal = x; }
  });
};
EncodingStream.prototype = Object.create(
  Transform.prototype, { constructor: { value: EncodingStream } });

/**
 * Overrides Transform._transform to rpc-protocol encode messages.
 */
EncodingStream.prototype._transform = function(msg, unused_encoding, next) {
  var that = this;
  var buf = Buffer(msg);
  encodeMessage(buf, {marshal: that._marshal}, function(encoded) {
    that.push(encoded);
    next();
  });
};

// The minimum length of and encoded buffer.
var MINIMUM_ENCODED_LENGTH = 5;
var LENGTH_INDEX = 1;
var COMPRESSION_INDEX = 0;


/**
 * Decodes an `Buffer` encoded as defined by rpc protocol into an object.
 *
 * done is called with a `RangeError` if decoding fails, otherwise it's
 * done(null, decodedObject).
 *
 * @param {external:Buffer} encoded an encoded message
 * @param {object} opts configures the decoding
 * @param {function} opts.unmarshal converts a decoded buffer into an object
 * @param {function} done is node-style callback function
 */
exports.decodeMessage = function decodeMessage(encoded, opts, done) {
  opts = opts || {};
  var buf = Buffer(encoded);
  if (buf.length < MINIMUM_ENCODED_LENGTH) {
    done(new RangeError(
      'Encoded message was smaller than ' + MINIMUM_ENCODED_LENGTH));
    return;
  };

  // TODO: interpret the decompression bit once that's available.
  var compression = buf.readUInt8(COMPRESSION_INDEX);
  var length = buf.readUInt32BE(LENGTH_INDEX, 4);
  var payload = buf.slice(MINIMUM_ENCODED_LENGTH);
  if (compression == 0 && payload.length !== length) {
    done(new Error('Encoded message length is wrong'));
    return;
  };
  if (opts.unmarshal) {
    payload = opts.unmarshal(payload);
  }
  done(null, payload);
};
var decodeMessage = exports.decodeMessage;

exports.DecodingStream = DecodingStream;

/**
 * DecodingStream is a `Transform` that converts a stream of `Buffers`,
 * messages encoded as defined by the rpc protocol into a stream of
 * objects.
 *
 * @param {object} opts is used to configure decoding
 * @param {function} [opts.unmarshal] converts a decoded buffer into an object
 * @constructor
 * @extends external:Transform
 */
function DecodingStream(opts) {
  // allow use without new
  if (!(this instanceof DecodingStream)) {
    return new DecodingStream(opts);
  }

  this.opts = opts = opts || {}; // ensure opts is an object
  opts.readableObjectMode = true; // Buffers will read from this stream
  Transform.call(this, opts);

  this._unmarshal = opts.unmarshal;
  this._buffer = null;

  /**
   * Allows the unmarshal function to be updated.
   *
   * @name DecodingStream#unmarshal
   * @type {function}
   */
  Object.defineProperty(this, "unmarshal", {
    set: function(x) { this._unmarshal = x; }
  });
};
DecodingStream.prototype = Object.create(
  Transform.prototype, { constructor: { value: DecodingStream } });

/**
 * _transform overrides Transform._transform to perform the decoding.
 */
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
    if (this._unmarshal) {
      this.push(this._unmarshal(msg));
    } else {
      this.push(msg);
    }
    this._buffer = this._buffer.slice(payloadLength);
    next();
  };

/**
 * _flush overrides Transform._flush to ensure any outstanding data is decoded.
 *
 * @param {function} done is a callback called once the flush completes.
 */
DecodingStream.prototype._flush = function _flush(done) {
  if (this._buffer.length === 0) {
    done();
    return;
  }
  var pushDecoded = function pushDecoded(err, buf) {
    if (err) {
      this.emit('error', err);
      util.log('decodeMessageCb: error: ', err);
      return;
    }
    if (this._unmarshal) {
      this.push(this._unmarshal(buf));
    } else {
      this.push(buf);
    }
    done();
  };
  decodeMessage(this._buffer, null, pushDecoded.bind(this));
};

/**
 * MsgHeaderStream is a `Writable` that concatenates strings or `Buffer`
 * and invokes a callback with an `Buffer` prepended by its length.
 *
 * @param {object} opts options for determining how the data is written
 * @param {function} callback is invoked when all data has been written
 * @constructor
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
 * Overrides ConcatStream._write to count the size of data in bytes.
 */
MsgHeaderStream.prototype._write = function(chunk, enc, next) {
  this.body.push(chunk);
  this.size += chunk.length;
  next();
};

/**
 * Overrides `ConcatStream.getBody` to return the body prefixed with the
 * size.
 *
 * @returns {external:Buffer} containing the data written to this stream
 *                            prefixed with its length
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

/**
 * Encodes an interval value for transmission.
 *
 * @param {number} micros an interval value in microseconds
 * @returns {string} a valid encoding of the interval
 * @throws {RangeError} the value cannot be encoded
 */
exports.microsToInterval = function microsToInterval(micros) {
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
    return true;
  });
  if (res) {
    return res;
  }
  util.log('interval encode failed: could not encode ', micros);
  throw new RangeError('interval encode failed');
};

var intervalRx = /^(\d+)(H|M|S|m|u|n)$/;

/**
 * Decodes an interval value into a value in microseconds.
 *
 * @param {string} interval an encoded interval value
 * @returns {number} the value of the interval in microseconds
 * @throws {RangeError} the interval can't be decoded.
 */
exports.intervalToMicros = function intervalToMicros(interval) {
  var parsed = interval.match(intervalRx);
  if (!parsed) {
    util.log('interval decode failed: could not encode ', interval);
    throw new RangeError('interval decode failed');
  }
  var amt = parseInt(parsed[1], 10);
  var suffix = parsed[2];
  if (suffix === 'n') {  // handle nanoseconds by converting them to usecs.
    suffix = 'u';
    amt = Math.floor(amt / 1000);
  }
  return microsBySuffix[suffix] * amt;
};

/**
 * Determines if a given value is a valid interval.
 *
 * @param {string} interval the value to check
 * @returns {boolean} true if the value is an valid interval otherwise false
 */
exports.isInterval = function isInterval(interval) {
  return !!interval.match(intervalRx);
};

var isAscii = /^[\x00-\x7F]+$/;

/**
 * Transforms a key value pair to one where the value is base64 encoded if
 * necessary.
 *
 * It returns an array contain two items
 * - the original key and value if no transformation is necessary
 * - the new key and value if base64 encoding was required
 *
 * @param {string} key the key
 * @param {string|external:Buffer} value may be a `Buffer` or non-ascii
 * @returns {string[]} containing the update key and value
 */
exports.removeBinValues = function removeBinValues(key, value) {
  if (value instanceof Array) {
    var needsb64 = _.reduce(value, function(acc, v) {
      return acc || v instanceof Buffer || !isAscii.test(value);
    }, false);
    if (needsb64) {
      var tob64 = _.map(value, function(v) {
        return new Buffer(v).toString('base64');
      });
      return [key + '-bin', tob64];
    } else {
      return [key, value];
    }
  }
  if (value instanceof Buffer) {
    return [key + '-bin', value.toString('base64')];
  }
  if (!isAscii.test(value)) {
    return [key + '-bin', new Buffer(value).toString('base64')];
  }
  return [key, value];
};

/**
 * The nodejs `Buffer` class .
 * @external Buffer
 * @see https://nodejs.org/api/buffer.html
 */

/**
 * The nodejs `stream.Transform` class .
 * @external Transform
 * @see https://nodejs.org/api/stream.html#stream_class_stream_transform
 */
