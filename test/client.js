'use strict';

var _ = require('lodash');
var clientLog = require('./util').clientLog;
var decodeMessage = require('../lib/codec').decodeMessage;
var encodeMessage = require('../lib/codec').encodeMessage;
var expect = require('chai').expect;
var fs = require('fs');
var http2 = require('http2');
var path = require('path');
var nextAvailablePort = require('./util').nextAvailablePort;
var serverLog = require('./util').serverLog;
var url = require('url');
var util = require('util');

var Stub = require('../lib/client').Stub;

var options = {
  key: fs.readFileSync(path.join(__dirname, '../example/localhost.key')),
  cert: fs.readFileSync(path.join(__dirname, '../example/localhost.crt')),
  log: serverLog
};


// typical tests should
// - start a http2 server
// - send a request using the grpc surface
// - verify behaviour on the server using the http2 surface
// - respond using the http2 surface
// - verify the expected client response

// use the same options object fields names as a http request would use
// refactor surface to the current gRPC one, apart from headers

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

http2.globalAgent = new http2.Agent({ log: clientLog });

function listenOnNextPort(server, opts, cb) {
  opts = opts || {};
  if (!opts.protocol) {
    opts.protocol = 'https:';
  }
  var setUpStub = function setUpStub(addr) {
    server.listen(addr.port, function() {
      var stubAddr = url.format({
        protocol: opts.protocol,
        hostname: 'localhost',
        port: addr.port
      });
      var stub = new Stub(stubAddr);
      cb(server, stub);
    });
  };
  nextAvailablePort(setUpStub);
}

function makeSendEncodedResponse(response) {
  var res = function sendEncodedResponse(encoded) {
    response.end(encoded);
  };
  return res;
}

describe('client', function() {
  describe('test scenario', function() {
    var path = '/x';
    var msg = 'hello';
    var reply = 'world';
    describe('request_response', function() {
      it('should work as expected', function(done) {
        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          var validateReqThenRespond = function(err, decoded){
            expect(decoded.toString()).to.equal(msg);
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.once('data', function(data) {
            decodeMessage(data, null, validateReqThenRespond);
          });
        });

        // verifyResponse checks that the data is the reply, i.e, it has been
        // decoded successfully.
        var verifyResponse = function(srv, stub) {
          stub.request_response(path, msg, {}, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('end', function() {
              srv.close();
              done();
            });
          });
        };
        listenOnNextPort(server, {}, verifyResponse);
      });
      it('should send arbitrary headers when requested', function(done) {
        var headerName = 'name';
        var headerValue = 'value';
        var server = http2.createServer(options, function(request, response) {
          expect(request.headers[headerName]).to.equal(headerValue);
          var validateReqThenRespond = function(err, decoded){
            expect(decoded.toString()).to.equal(msg);
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.once('data', function(data) {
            decodeMessage(data, null, validateReqThenRespond);
          });
        });

        // verifyResponse checks that the data is the reply, i.e, it has been
        // decoded successfully.
        var headers = {};
        headers[headerName] = headerValue;
        var verifyResponse = function(srv, stub) {
          stub.request_response(path, msg, headers, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('end', function() {
              srv.close();
              done();
            });
          });
        };
        listenOnNextPort(server, null, verifyResponse);
      });
      it.skip('should fail on sending bad grpc-timeout value', function(done) {
        var headerName = 'grpc-timeout';
        var headerValue = 'foo';
        var server = http2.createServer(options, function(request, response) {
          expect(request.headers[headerName]).to.equal(headerValue);
          var validateReqThenRespond = function(err, decoded){
            expect(decoded.toString()).to.equal(msg);
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.once('data', function(data) {
            decodeMessage(data, null, validateReqThenRespond);
          });
        });

        // verifyResponse checks that the data is the reply, i.e, it has been
        // decoded successfully.
        var headers = {};
        headers[headerName] = headerValue;
        var verifyResponse = function(srv, stub) {
          util.log('before request_response');
          stub.request_response(path, msg, headers, _.noop);
          util.log('after request_response');
        };
        // var shouldThrow = function() {
        //   listenOnNextPort(server, null, verifyResponse);
        // };
        // expect(shouldThrow).to.throw(Error);
        listenOnNextPort(server, null, verifyResponse);
      });
      it('should succeed in sending a good grpc-timeout value', function(done) {
        var headerName = 'grpc-timeout';
        var headerValue = '10S';
        var server = http2.createServer(options, function(request, response) {
          expect(request.headers[headerName]).to.equal(headerValue);
          var validateReqThenRespond = function(err, decoded){
            expect(decoded.toString()).to.equal(msg);
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.once('data', function(data) {
            decodeMessage(data, null, validateReqThenRespond);
          });
        });

        // verifyResponse checks that the data is the reply, i.e, it has been
        // decoded successfully.
        var headers = {};
        headers[headerName] = headerValue;
        var verifyResponse = function(srv, stub) {
          stub.request_response(path, msg, headers, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('end', function() {
              srv.close();
              done();
            });
          });
        };
        listenOnNextPort(server, null, verifyResponse);
      });
      it('should send a grpc-timeout when a deadline is provided', function(done) {
        var headerName = 'grpc-timeout';
        var deadlineOpt = 'deadline';
        var headerValue = '10S';
        var server = http2.createServer(options, function(request, response) {
          expect(request.headers[headerName]).to.exist;
          var validateReqThenRespond = function(err, decoded){
            expect(decoded.toString()).to.equal(msg);
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.once('data', function(data) {
            decodeMessage(data, null, validateReqThenRespond);
          });
        });

        // verifyResponse checks that the data is the reply, i.e, it has been
        // decoded successfully.
        var headers = {};
        var testDeadline = new Date();
        var nowPlus10 = Date.now() + Math.pow(10, 4);
        testDeadline.setTime(nowPlus10);
        headers[deadlineOpt] = testDeadline;
        var verifyResponse = function(srv, stub) {
          stub.request_response(path, msg, headers, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('end', function() {
              srv.close();
              done();
            });
          });
        };
        listenOnNextPort(server, null, verifyResponse);
      });
    });
  });
});
