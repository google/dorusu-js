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

var chai = require('chai');
chai.use(require('dirty-chai'));
var decodeMessage = require('../lib/codec').decodeMessage;
var encodeMessage = require('../lib/codec').encodeMessage;
var expect = chai.expect;
var intervalToMicros = require('../lib/codec').intervalToMicros;
var irreverser = require('./util').irreverser;
var isInterval = require('../lib/codec').isInterval;
var microsToInterval = require('../lib/codec').microsToInterval;
var reverser = require('./util').reverser;

var ConcatStream = require('concat-stream');
var EncodingStream = require('../lib/codec').EncodingStream;
var DecodingStream = require('../lib/codec').DecodingStream;
var Readable = require('stream').Readable;
var Writable = require('stream').Writable;

describe('codec', function() {
  describe('interval conversion', function() {
    var _1e6 = Math.pow(10, 6);
    var intervalTests = [
      [3600 * (Math.pow(10, 8) - 1) * _1e6, '99999999H'],
      [7200 * _1e6, '2H'],
      [60 * (Math.pow(10, 8) - 1) * _1e6, '99999999M'],
      [3600 * _1e6, '1H'],
      [5400 * _1e6, '90M'],
      [2700 * _1e6, '45M'],
      [2701 * _1e6, '2701S'],
      [27 * _1e6 + 1, '27000001u']
    ];
    var roundingTests = [
      [7200 * _1e6 + 1, '7200000m'],
      [60 * (Math.pow(10, 8)) * _1e6, '1666666H'],
      [2700 * _1e6 + 1, '2700000m']
    ];
    var nanoSecondTests = [
      [10, '10000n'],
      [1, '1000n'],
      [1, '1001n'],
      [0, '100n'],
      [0, '10n']
    ];
    describe('microsToInterval', function() {
      intervalTests.forEach(function(t) {
        it('it should convert ' + t[0] + ' to ' + t[1] , function() {
          expect(microsToInterval(t[0])).to.eql(t[1]);
        });
      });
      roundingTests.forEach(function(t) {
        it('it should convert ' + t[0] + ' to ' + t[1] , function() {
          expect(microsToInterval(t[0])).to.eql(t[1]);
        });
      });
      it('should raise if the interval is too large', function() {
        var shouldThrow = function shouldThrow() {
          microsToInterval(Math.pow(10, 8) * 3600 * _1e6);
        };
        expect(shouldThrow).to.throw(RangeError);
      });
    });
    var invalidIntervals = [
      '100d',
      '9x9M',
      'notANumber',
      '1000',
      'm1000'
    ];
    describe('intervalToMicros', function() {
      intervalTests.forEach(function(t) {
        it('it should convert ' + t[1] + ' to ' + t[0] , function() {
          expect(intervalToMicros(t[1])).to.eql(t[0]);
        });
      });
      nanoSecondTests.forEach(function(t) {
        it('it should convert ' + t[1] + ' to ' + t[0] , function() {
          expect(intervalToMicros(t[1])).to.eql(t[0]);
        });
      });
      it('should raise if the interval value is invalid', function() {
        invalidIntervals.forEach(function(t) {
          var shouldThrow = function shouldThrow() {
            intervalToMicros(t);
          };
          expect(shouldThrow).to.throw(RangeError);
        });
      });
    });
    describe('isInterval', function() {
      it('should be false for invalid intervals', function() {
        invalidIntervals.forEach(function(t) {
          expect(isInterval(t)).to.be.false();
        });
      });
      it('should be true for valid intervals', function() {
        intervalTests.forEach(function(t) {
          expect(isInterval(t[1])).to.be.true();
        });
        nanoSecondTests.forEach(function(t) {
          expect(isInterval(t[1])).to.be.true();
        });
      });
    });
  });

  describe('DecodingStream', function() {
    it('should decode from a valid encoded stream ok', function(done) {
      var sink = new Writable();
      var collected = [];
      sink._write = function _write(chunk, enc, next) {
        collected.push(chunk.toString());
        next();
      };
      var wanted = [];
      sink.on('finish', function() {
        expect(collected).to.eql(wanted);
        done();
      });
      var source = new Readable();
      var num = 3; // arbitrary
      for (var i = 0; i < num; i++) {
        var nextMsg = 'msg' + i;
        source.push(nextMsg);
        wanted.push(nextMsg);
      }
      var enc = new EncodingStream();
      var dec = new DecodingStream();
      source.pipe(enc).pipe(dec).pipe(sink);
      source.push(null);
    });
    it('should decode using the unmarshalr when present', function(done) {
      var sink = new Writable();
      var collected = [];
      sink._write = function _write(chunk, enc, next) {
        collected.push(chunk.toString());
        next();
      };
      var wanted = [];
      sink.on('finish', function() {
        expect(collected).to.eql(wanted);
        done();
      });
      var source = new Readable();
      var num = 3; // arbitrary
      for (var i = 0; i < num; i++) {
        var nextMsg = 'msg' + i;
        source.push(nextMsg);
        wanted.push(nextMsg);
      }
      var enc = new EncodingStream({marshal: reverser});
      var dec = new DecodingStream({unmarshal: irreverser});
      source.pipe(enc).pipe(dec).pipe(sink);
      source.push(null);
    });
  });

  describe('EncodingStream', function() {
    it('ignores empty pushes', function(done){
      var enc = new EncodingStream();
      var num = 7; // arbitrary
      var sink = new ConcatStream({encoding: 'buffer'}, function(buf) {
        expect(buf.length).to.equal(0);
        done();
      });
      var source = new Readable();
      for (var i = 0; i < num; i++) {
        var buf = new Buffer(0);
        source.push(buf);
      }
      source.pipe(enc).pipe(sink);
      source.push(null);
    });

    it('should write a series multiple distinct messages ok', function(done){
      var enc = new EncodingStream();
      var num = 3; // arbitrary
      var partSize = Buffer.byteLength('msg0');
      var sink = new ConcatStream({encoding: 'buffer'}, function(buf) {
        expect(buf).to.be.an.instanceof(Buffer);
        expect(buf.length).to.eql((partSize + 5) * num);
        var firstPart = buf.slice(5, 5 + partSize);
        expect(firstPart.toString()).to.eql('msg0');
        done();
      });
      var source = new Readable();
      for (var i = 0; i < num; i++) {
        source.push('msg' + i);
      }
      source.pipe(enc).pipe(sink);
      source.push(null);
    });
    it('should use the marshalr when present', function(done){
      var enc = new EncodingStream({marshal: reverser});
      var num = 6; // arbitrary
      var partSize = Buffer.byteLength('msg0');
      var sink = new ConcatStream({encoding: 'buffer'}, function(buf) {
        expect(buf).to.be.an.instanceof(Buffer);
        expect(buf.length).to.eql((partSize + 5) * num);
        var firstPart = buf.slice(5, 5 + partSize);
        expect(firstPart.toString()).to.eql('0gsm');
        done();
      });
      var source = new Readable();
      for (var i = 0; i < num; i++) {
        source.push('msg' + i);
      }
      source.pipe(enc).pipe(sink);
      source.push(null);
    });
  });
  describe('decodeMessage', function() {
    it('should fail if the message is too small', function(done) {
      var willFail = new Buffer(2);
      decodeMessage(willFail, null, function(err) {
        expect(err).to.be.an.instanceof(Error);
        done();
      });
    });
    it('should fail if the message is size is wrong', function(done) {
      var msg = 'some text';
      var suffix = new Buffer(msg);
      var prefix = new Buffer(5);
      prefix.writeUIntBE(0, 0, 1);
      prefix.writeUIntBE(Buffer.byteLength(msg) + 1 /* wrong !! */, 1, 4);
      var willFail = Buffer.concat([prefix, suffix]);
      expect(willFail.length).to.be.above(5);
      decodeMessage(willFail, null, function(err) {
        expect(err).to.be.an.instanceof(Error);
        done();
      });
    });
    it('should decode a simple string ok', function(done) {
      var msg = 'some text';
      var suffix = new Buffer(msg);
      var prefix = new Buffer(5);
      prefix.writeUIntBE(0, 0, 1);
      prefix.writeUIntBE(Buffer.byteLength(msg), 1, 4);
      var encoded = Buffer.concat([prefix, suffix]);
      decodeMessage(encoded, null, function(err, buf) {
        expect(err).to.be.null();
        expect(buf.toString()).to.eql(msg);
        done();
      });
    });
    it('should apply the unmarshalr when present', function(done) {
      var msg = 'some text';
      var suffix = new Buffer(msg);
      var prefix = new Buffer(5);
      prefix.writeUIntBE(0, 0, 1);
      prefix.writeUIntBE(Buffer.byteLength(msg), 1, 4);
      var encoded = Buffer.concat([prefix, suffix]);
      decodeMessage(encoded, {unmarshal: irreverser}, function(err, s) {
        expect(err).to.be.null();
        expect(s).to.eql('txet emos');
        done();
      });
    });
  });
  describe('encodeMessage', function() {
    it('should encode a zero-length buffer correctly', function(done) {
      var want = new Buffer(5);
      want.writeUIntBE(0, 0, 5);
      encodeMessage('', null, function(got) {
        expect(got).to.eql(want);
        done();
      });
    });
    it('should encode a simple string correctly', function(done) {
      var msg = 'some text';
      var suffix = new Buffer(msg);
      var prefix = new Buffer(5);
      prefix.writeUIntBE(0, 0, 1);
      prefix.writeUIntBE(Buffer.byteLength(msg), 1, 4);
      var want = Buffer.concat([prefix, suffix]);
      encodeMessage(msg, null, function(got) {
        expect(got).to.eql(want);
        done();
      });
    });
    it('should apply the marshal when present', function(done) {
      var msg = 'some text';
      var suffix = reverser(msg);
      var prefix = new Buffer(5);
      prefix.writeUIntBE(0, 0, 1);
      prefix.writeUIntBE(Buffer.byteLength(msg), 1, 4);
      var want = Buffer.concat([prefix, suffix]);
      encodeMessage(msg, {marshal: reverser}, function(got) {
        expect(got).to.eql(want);
        done();
      });
    });
  });
});
