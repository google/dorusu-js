'use strict';

var expect = require('chai').expect;
var nurpc = require('../lib/nurpc');

describe('nurpc', function() {
  describe('method `isReservedHeader(headerName)`', function() {
    var colonStarters = [':random', ':authority', ':host'];
      colonStarters.forEach(function(h) {
      it('should be true for ' + h, function() {
        expect(nurpc.isReservedHeader(h)).to.be.true;
      });
    });
    nurpc.reservedHeaders.forEach(function(h) {
      it('should be true for ' + h, function() {
        expect(nurpc.isReservedHeader(h)).to.be.true;
      });
    });
    var unreservedHeaders =  [
      'myapp-foo',
      'myapp-bar',
      'x-my-well-known-header',
    ];
    unreservedHeaders.forEach(function(h) {
      it('should be false for ' + h, function() {
        expect(nurpc.isReservedHeader(h)).to.be.false;
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
      if (unmapped.indexOf(c) == -1) {
        it('should return a valid name for ' + c, function() {
          expect(nurpc.h2NameToRpcName(c)).to.be.ok;
          expect(nurpc.h2NameToRpcName(c)).to.not.eql('UNKNOWN');
          });
      }
    });
    unmapped.forEach(function(c) {
      it('should return null for ' + c, function() {
        expect(nurpc.h2NameToRpcName(c)).to.be.null;
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
});
