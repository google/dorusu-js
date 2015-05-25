'use strict';

var decodeMessage = require('../lib/codec').decodeMessage;
var encodeMessage = require('../lib/codec').encodeMessage;
var expect = require('chai').expect;
var intervalToMicros = require('../lib/codec').intervalToMicros;
var microsToInterval = require('../lib/codec').microsToInterval;
var util = require('util');

var ConcatStream = require('concat-stream');
var EncodingStream = require('../lib/codec').EncodingStream;
var DecodingStream = require('../lib/codec').DecodingStream;
var Readable = require('stream').Readable;
var Writable = require('stream').Writable;

describe('codec', function() {
  describe('interval conversion', function() {
    var _1e6 = Math.pow(10, 6);
    var _1e3 = Math.pow(10, 3);
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
        expect(shouldThrow).to.throw(Error);
      });
    });
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
      var invalidIntervals = [
        '100d',
        '9x9M',
        'notANumber',
        '1000',
        'm1000',
      ];
      it('should raise if the interval value is invalid', function() {
        invalidIntervals.forEach(function(t) {
          var shouldThrow = function shouldThrow() {
            intervalToMicros(t);
          };
          expect(shouldThrow).to.throw(Error);
        });
      });
    });
  });

  // reverser is used as a test serialization func
  var reverser = function reverser(s) {
    var r = s.toString().split('').reverse().join('');
    return new Buffer(r);
  };

  // irreverser is used as a test deserialization func
  var irreverser = function irreverser(s) {
    return s.toString().split('').reverse().join('');
  };

  describe('DecodingStream', function() {
    it('should decode from a valid encoded stream ok', function(done) {
      var sink = Writable();
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
      var source = Readable();
      var num = 3; // arbitrary
      for (var i = 0; i < num; i++) {
        var nextMsg = 'msg' + i;
        source.push(nextMsg);
        wanted.push(nextMsg);
      }
      var enc = EncodingStream();
      var dec = DecodingStream();
      source.pipe(enc).pipe(dec).pipe(sink);
      source.push(null);
    });
    it('should decode using the deserializer when present', function(done) {
      var sink = Writable();
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
      var source = Readable();
      var num = 3; // arbitrary
      for (var i = 0; i < num; i++) {
        var nextMsg = 'msg' + i;
        source.push(nextMsg);
        wanted.push(nextMsg);
      }
      var enc = EncodingStream({serializer: reverser});
      var dec = DecodingStream({deserializer: irreverser});
      source.pipe(enc).pipe(dec).pipe(sink);
      source.push(null);
    });
  });

  describe('EncodingStream', function() {
    it('ignores empty pushes', function(done){
      var enc = EncodingStream();
      var num = 7; // arbitrary
      var sink = ConcatStream({encoding: 'buffer'}, function(buf) {
        expect(buf.length).to.equal(0);
        done();
      });
      var source = Readable();
      for (var i = 0; i < num; i++) {
        var buf = new Buffer(0);
        source.push(buf);
      }
      source.pipe(enc).pipe(sink);
      source.push(null);
    });

    it('should write a series multiple distinct messages ok', function(done){
      var enc = EncodingStream();
      var num = 3; // arbitrary
      var partSize = Buffer.byteLength('msg0');
      var sink = ConcatStream({encoding: 'buffer'}, function(buf) {
        expect(buf).to.be.an.instanceof(Buffer);
        expect(buf.length).to.eql((partSize + 5) * num);
        var firstPart = buf.slice(5, 5 + partSize);
        expect(firstPart.toString()).to.eql('msg0');
        done();
      });
      var source = Readable();
      for (var i = 0; i < num; i++) {
        source.push('msg' + i);
      }
      source.pipe(enc).pipe(sink);
      source.push(null);
    });
    it('should use the serializer when present', function(done){
      var enc = EncodingStream({serializer: reverser});
      var num = 6; // arbitrary
      var partSize = Buffer.byteLength('msg0');
      var sink = ConcatStream({encoding: 'buffer'}, function(buf) {
        expect(buf).to.be.an.instanceof(Buffer);
        expect(buf.length).to.eql((partSize + 5) * num);
        var firstPart = buf.slice(5, 5 + partSize);
        expect(firstPart.toString()).to.eql('0gsm');
        done();
      });
      var source = Readable();
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
        expect(err).to.be.null;
        expect(buf.toString()).to.eql(msg);
        done();
      });
    });
    it('should apply the deserializer when present', function(done) {
      var msg = 'some text';
      var suffix = new Buffer(msg);
      var prefix = new Buffer(5);
      prefix.writeUIntBE(0, 0, 1);
      prefix.writeUIntBE(Buffer.byteLength(msg), 1, 4);
      var encoded = Buffer.concat([prefix, suffix]);
      decodeMessage(encoded, {deserializer: irreverser}, function(err, s) {
        expect(err).to.be.null;
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
    it('should apply the serializer when present', function(done) {
      var msg = 'some text';
      var suffix = reverser(msg);
      var prefix = new Buffer(5);
      prefix.writeUIntBE(0, 0, 1);
      prefix.writeUIntBE(Buffer.byteLength(msg), 1, 4);
      var want = Buffer.concat([prefix, suffix]);
      encodeMessage(msg, {serializer: reverser}, function(got) {
        expect(got).to.eql(want);
        done();
      });
    });
  });
});
