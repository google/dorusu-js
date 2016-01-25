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
var expect = chai.expect;
var nurpc = require('../lib');

describe('nurpc', function() {
  describe('method `isReservedHeader(headerName)`', function() {
    var colonStarters = [':random', ':authority', ':host'];
      colonStarters.forEach(function(h) {
      it('should be true for ' + h, function() {
        expect(nurpc.isReservedHeader(h)).to.be.true();
      });
    });
    nurpc.reservedHeaders.forEach(function(h) {
      it('should be true for ' + h, function() {
        expect(nurpc.isReservedHeader(h)).to.be.true();
      });
      it('should be true for ' + h.toUpperCase(), function() {
        expect(nurpc.isReservedHeader(h.toUpperCase())).to.be.true();
      });
    });
    var unreservedHeaders =  [
      'myapp-foo',
      'myapp-bar',
      'x-my-well-known-header'
    ];
    unreservedHeaders.forEach(function(h) {
      it('should be false for ' + h, function() {
        expect(nurpc.isReservedHeader(h)).to.be.false();
      });
    });
  });
  describe('method `isKnownSecureHeader(headerName)`', function() {
    nurpc.knownSecureHeaders.forEach(function(h) {
      it('should be true for ' + h, function() {
        expect(nurpc.isKnownSecureHeader(h)).to.be.true();
      });
      it('should be true for ' + h.toUpperCase(), function() {
        expect(nurpc.isKnownSecureHeader(h.toUpperCase())).to.be.true();
      });
    });
    var nonSecureHeaders =  [
      'myapp-foo',
      'myapp-bar',
      'x-my-well-known-header'
    ];
    nonSecureHeaders.forEach(function(h) {
      it('should be false for ' + h, function() {
        expect(nurpc.isKnownSecureHeader(h)).to.be.false();
      });
    });
  });
  describe('method `h2NameToRpcName`', function() {
    it('should return UNKNOWN for an invalid name', function() {
      expect(nurpc.h2NameToRpcName('foo')).to.eql('UNKNOWN');
    });
    var unmapped = ['HTTP_1_1_REQUIRED', 'STREAM_CLOSED'];
    var h2Codes = nurpc.h2Codes;
    h2Codes.forEach(function(c) {
      if (unmapped.indexOf(c) === -1) {
        it('should return a valid name for ' + c, function() {
          expect(nurpc.h2NameToRpcName(c)).to.be.ok();
          expect(nurpc.h2NameToRpcName(c)).to.not.eql('UNKNOWN');
          });
      }
    });
    unmapped.forEach(function(c) {
      it('should return null for ' + c, function() {
        expect(nurpc.h2NameToRpcName(c)).to.be.null();
      });
    });
  });

  describe('method `rpcCode`', function() {
    it('should throw an exception for unknown names', function() {
      expect(function() { nurpc.rpcCode('foo'); }).to.throw(RangeError);
    });
    nurpc.rpcCodes.forEach(function(c) {
      it('should return a valid code for ' + c, function() {
        expect(nurpc.rpcCode(c)).to.be.at.least(0);
      });
    });
  });

  describe('method `blockSecureHeader`', function() {
    nurpc.knownSecureHeaders.forEach(function(c) {
      it('initally, should throw an exception for ' + c, function() {
        expect(function() { nurpc.blockSecureHeader(c); }).to.throw(Error);
      });
      describe('with SECURE_HEADER_POLICY as WARN', function() {
        it('should be false for ' + c, function() {
          var initial = nurpc.SECURE_HEADER_POLICY;
          nurpc.SECURE_HEADER_POLICY = 'WARN';
          expect(nurpc.blockSecureHeader(c)).to.be.false();
          nurpc.SECURE_HEADER_POLICY = initial;
        });
      });
      describe('with SECURE_HEADER_POLICY as DROP', function() {
        it('should be false for ' + c, function() {
          var initial = nurpc.SECURE_HEADER_POLICY;
          nurpc.SECURE_HEADER_POLICY = 'DROP';
          expect(nurpc.blockSecureHeader(c)).to.be.true();
          nurpc.SECURE_HEADER_POLICY = initial;
        });
      });
    });
  });
});
