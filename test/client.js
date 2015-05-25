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

function listenOnFreePort(server, opts, cb) {
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

        // thisTest checks that the expected text is the reply, i.e, it
        // has been decoded successfully.
        var thisTest = function(srv, stub) {
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
        listenOnFreePort(server, {}, thisTest);
      });
      it('should send arbitrary headers when requested', function(done) {
        var headerName = 'name';
        var headerValue = 'value';
        var server = http2.createServer(options, function(request, response) {
          expect(request.headers[headerName]).to.equal(headerValue);
          server.close();
          done();
        });

        // thisTest sends a test header is sent.
        var headers = {};
        headers[headerName] = headerValue;
        var thisTest = function(srv, stub) {
          stub.request_response(path, msg, headers, _.noop);
        };
        listenOnFreePort(server, null, thisTest);
      });
      it('should fail on sending bad grpc-timeout value', function(done) {
        var server = http2.createServer(options, _.noop);

        // thisTest sends a bad grpc-timeout header.
        var headers = {};
        headers['grpc-timeout'] = 'this will not work';
        var thisTest = function(srv, stub) {
          var shouldThrow = function shouldThrow() {
            stub.request_response(path, msg, headers, _.noop);
            done();
          };
          expect(shouldThrow).to.throw(Error);
        };
        listenOnFreePort(server, null, thisTest);
      });
      it('should succeed in sending a good grpc-timeout value', function(done) {
        var headerName = 'grpc-timeout';
        var headerValue = '10S';
        var server = http2.createServer(options, function(request, response) {
          expect(request.headers[headerName]).to.equal(headerValue);
          server.close();
          done();
        });

        // thisTest sends a test header.
        var headers = {};
        headers[headerName] = headerValue;
        var thisTest = function(srv, stub) {
          stub.request_response(path, msg, headers, _.noop);
        };
        listenOnFreePort(server, null, thisTest);
      });
      it('should send a grpc-timeout when a deadline is provided', function(done) {
        var server = http2.createServer(options, function(request, response) {
          expect(request.headers['grpc-timeout']).to.exist;
          server.close();
          done();
        });

        // thisTest sends the test header.
        var headers = {};
        var testDeadline = new Date();
        var nowPlus10 = Date.now() + Math.pow(10, 4);
        testDeadline.setTime(nowPlus10);
        headers['deadline'] = testDeadline;
        var thisTest = function(srv, stub) {
          stub.request_response(path, msg, headers, _.noop);
        };
        listenOnFreePort(server, null, thisTest);
      });
      it('should timeout a request when a deadline is provided', function(done) {
        var server = http2.createServer(options, function(request, response) {
          expect(request.headers['grpc-timeout']).to.exist;
          // don't handle response, this should cause the client to cancel.
        });

        // thisTest sends a request with a timeout
        var headers = {};
        var testDeadline = new Date();
        var nowPlusHalfSec = Date.now() + 500; // 500 ms
        testDeadline.setTime(nowPlusHalfSec);
        headers['deadline'] = testDeadline;
        var thisTest = function(srv, stub) {
          var req = stub.request_response(path, msg, headers, _.noop);
          req.on('cancel', function() {
            server.close();
            expect(Date.now()).to.be.above(nowPlusHalfSec);
            done();
          });
        };
        listenOnFreePort(server, null, thisTest);
      });
    });
  });
});
