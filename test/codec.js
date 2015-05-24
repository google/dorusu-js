'use strict';

var decodeMessage = require('../lib/codec').decodeMessage;
var encodeMessage = require('../lib/codec').encodeMessage;
var expect = require('chai').expect;

var ConcatStream = require('concat-stream');
var EncodingStream = require('../lib/codec').EncodingStream;
var DecodingStream = require('../lib/codec').EncodingStream;
var Readable = require('stream').Readable;
var Writable = require('stream').Writable;

describe('codec', function() {
  describe('DecodingStream', function() {
    it('decodes from a valid encoded stream ok', function(done) {
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
      decodeMessage(willFail, function(err) {
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
      decodeMessage(willFail, function(err) {
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
      decodeMessage(encoded, function(err, buf) {
        expect(err).to.be.null;
        expect(buf.toString()).to.eql(msg);
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
  });
});
