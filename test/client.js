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

function makeServer(serverExpects) {
  return http2.createServer(options, serverExpects);
};

function checkClientAndServer(clientExpects, serverExpects, opts) {
  var s = makeServer(serverExpects);
  listenOnFreePort(s, opts, clientExpects);
}

function makeSendEncodedResponse(response) {
  return function sendEncodedResponse(encoded) {
    response.end(encoded);
  };
}

describe('client', function() {
  describe('test scenario', function() {
    var path = '/x';
    var msg = 'hello';
    var reply = 'world';
    describe('request_response', function() {
      it('should work as expected', function(done) {
        // thisTest checks that the expected text is the reply, i.e, it
        // has been decoded successfully.
        var thisTest = function(srv, stub) {
          stub.request_response(path, msg, {}, function(response) {
            var theStatus;
            var theError;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('status', function(status) {
              theStatus = status;
            });
            response.on('error', function(err) {
              theError = err;
            });
            response.on('end', function() {
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': 0
              });
              expect(theError).to.be.undefined;
              srv.close();
              done();
            });
          });
        };
        var thisServer = function(request, response) {
          expect(request.url).to.equal(path);
          var validateReqThenRespond = function(err, decoded){
            expect(decoded.toString()).to.equal(msg);
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.once('data', function(data) {
            // TODO: add symbols for the well-known status codes: OK == 0, etc.
            response.addTrailers({'grpc-status': 0});
            decodeMessage(data, null, validateReqThenRespond);
          });
        };
        checkClientAndServer(thisTest, thisServer);
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
        checkClientAndServer(thisTest, _.noop);
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
        // thisTest sends the test header.
        var headers = {};
        var testDeadline = new Date();
        var nowPlus10 = Date.now() + Math.pow(10, 4);
        testDeadline.setTime(nowPlus10);
        headers['deadline'] = testDeadline;
        var thisTest = function(srv, stub) {
          stub.request_response(path, msg, headers, _.noop);
        };

        var server = http2.createServer(options, function(request, response) {
          expect(request.headers['grpc-timeout']).to.exist;
          server.close();
          done();
        });
        listenOnFreePort(server, null, thisTest);
      });
      it('should timeout a request when a deadline is provided', function(done) {
        // thisTest sends a request with a timeout
        var headers = {};
        var testDeadline = new Date();
        var nowPlusHalfSec = Date.now() + 500; // 500 ms
        testDeadline.setTime(nowPlusHalfSec);
        headers['deadline'] = testDeadline;
        var thisTest = function(srv, stub) {
          var req = stub.request_response(path, msg, headers, _.noop);
          req.on('cancel', function() {
            srv.close();
            expect(Date.now()).to.be.above(nowPlusHalfSec);
            done();
          });
        };

        var thisServer = function(request, response) {
          expect(request.headers['grpc-timeout']).to.exist;
          // don't handle response, this should cause the client to cancel.
        };
        checkClientAndServer(thisTest, thisServer);
      });
      it('should cancel a request ok', function(done) {
        // thisTest makes a request then cancels it.
        var thisTest = function(srv, stub) {
          var req = stub.request_response(path, msg, {}, _.noop);
          req.cancel();
          req.on('cancel', function() {
            srv.close();
            done();
          });
        };

        var thisServer = function(request, response) {
          expect(request.headers['grpc-timeout']).to.not.exist;
          // confirm that no timeout header was sent
          // don't handle response, this should cause the client to cancel.
        };
        checkClientAndServer(thisTest, thisServer);
      });
      it('should abort a request ok', function(done) {
        // thisTest makes a request then aborts it.
        var thisTest = function(srv, stub) {
          var req = stub.request_response(path, msg, {}, _.noop);
          req.abort();
          req.on('cancel', function() {
            srv.close();
            done();
          });
        };

        var thisServer = function(request, response) {
          expect(request.headers['grpc-timeout']).to.not.exist;
          // confirm that no timeout header was sent
          // don't handle response, this should cause the client to cancel.
        };
        checkClientAndServer(thisTest, thisServer);
      });
      describe('when the response status is bad', function() {
        var badStatuses = [
          'not-a-number-is-bad',
          '',
          new Object()
        ];
        var inTrailers = [true, false];
        badStatuses.forEach(function(badStatus) {
          inTrailers.forEach(function(inTrailer) {
            var inName = inTrailer ? 'trailers' : 'headers';
            var testDesc = 'fails if status in ' + inName + ' is ' + badStatus;
            it(testDesc, function(done) {
              // thisTest checks that the client throws an error on a bad
              // status.
              var thisTest = function(srv, stub) {
                var shouldThrow = function shouldThrow() {
                  stub.request_response(path, msg, {}, _.noop);
                  srv.close();
                  done();
                };
                expect(shouldThrow).to.throw(Error);
              };

              var thisServer = function(request, response) {
                var receiveThenReply = function(err, decoded) {
                  encodeMessage(reply, null, makeSendEncodedResponse(response));
                };
                request.once('data', function(data) {
                  if (inTrailer) {
                    response.addTrailers({'grpc-status': badStatus});
                  } else {
                    response.setHeader('grpc-status', badStatus);
                  }
                  decodeMessage(data, null, receiveThenReply);
                });
              };
              checkClientAndServer(thisTest, thisServer);
            });
          });
        });
      });
      it('should receive the status message and code', function(done) {
        // thisTest checks that the expected status code and message are received.
        var code = 14014;
        var message = 'code is fourteen-o-fourteen';
        var thisTest = function(srv, stub) {
          stub.request_response(path, msg, {}, function(response) {
            var theStatus;
            var theError;
            response.on('data', _.noop);
            response.on('status', function(status) {
              theStatus = status;
            });
            response.on('error', function(err) {
              theError = err;
            });
            response.on('end', function() {
              var wanted = {
                'message': message,
                'code': code
              };
              expect(theStatus).to.deep.equal(wanted);
              expect(theError).to.deep.equal(wanted);
              srv.close();
              done();
            });
          });
        };
        var thisServer = function(request, response) {
          var receiveThenReply = function(err, decoded){
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.once('data', function(data) {
            // TODO: add symbols for the well-known status codes: OK == 0, etc.
            response.addTrailers({
              'grpc-status': code,
              'grpc-message': message
            });
            decodeMessage(data, null, receiveThenReply);
          });
        };
        checkClientAndServer(thisTest, thisServer);
      });
      describe('with response metadata', function() {
        it('only emits a metadata event when any is present', function(done) {
          // thisTest checks that no metadata is set
          var thisTest = function(srv, stub) {
            stub.request_response(path, msg, {}, function(response) {
              var metadataFired = false;
              response.on('data', _.noop);
              response.on('metadata', function(md) {
                metadataFired = true;
              });
              response.on('end', function() {
                expect(metadataFired).to.be.false;
                srv.close();
                done();
              });
            });
          };
          var thisServer = function(request, response) {
            var receiveThenReply = function(err, decoded){
              encodeMessage(reply, null, makeSendEncodedResponse(response));
            };
            request.once('data', function(data) {
              response.setHeader('content-type', 'not-counted-as-metadata');
              response.setHeader('user-agent', 'not-counted-as-metadata');
              response.addTrailers({
                'grpc-status': 0,
                'grpc-message': 'not-counted-as-metadata'
              });
              response.sendDate = false;  // by default the date header gets sent
              decodeMessage(data, null, receiveThenReply);
            });
          };
          checkClientAndServer(thisTest, thisServer);
        });
        it('should include any unreserved headers', function(done) {
          // thisTest checks that no metadata is set
          var thisTest = function(srv, stub) {
            stub.request_response(path, msg, {}, function(response) {
              var theMetadata = undefined;
              var want = {
                'my-header': 'my-header-value',
                'my-trailer': 'my-trailer-value'
              };
              response.on('data', _.noop);
              response.on('metadata', function(md) {
                theMetadata = md;
              });
              response.on('end', function() {
                expect(theMetadata).to.be.deep.eql(want);
                srv.close();
                done();
              });
            });
          };
          var thisServer = function(request, response) {
            var receiveThenReply = function(err, decoded){
              encodeMessage(reply, null, makeSendEncodedResponse(response));
            };
            request.once('data', function(data) {
              response.setHeader('my-header', 'my-header-value');
              response.addTrailers({
                'my-trailer': 'my-trailer-value',
                'content-type': 'this-is-reserved-and-is-not-metadata',
                'grpc-status': 0,
                'grpc-message': 'not-counted-as-metadata'
              });
              response.sendDate = false;  // by default the date header gets sent
              decodeMessage(data, null, receiveThenReply);
            });
          };
          checkClientAndServer(thisTest, thisServer);
        });
        it('should represent multi-value metadata as arrays', function(done) {
          // thisTest checks that multi-value metadata is propagated as an
          // array.
          var thisTest = function(srv, stub) {
            stub.request_response(path, msg, {}, function(response) {
              var theMetadata = undefined;
              response.on('data', _.noop);
              response.on('metadata', function(md) {
                theMetadata = md;
              });
              var want = {
                'my-header': ['my-header-value', 'my-header-value2']
              };
              response.on('end', function() {
                expect(theMetadata).to.deep.eql(want);
                srv.close();
                done();
              });
            });
          };
          var thisServer = function(request, response) {
            var receiveThenReply = function(err, decoded){
              encodeMessage(reply, null, makeSendEncodedResponse(response));
            };
            request.once('data', function(data) {
              response.setHeader(
                'my-header', ['my-header-value', 'my-header-value2']);
              response.addTrailers({
                'grpc-status': 0,
                'grpc-message': 'not-counted-as-metadata'
              });
              response.sendDate = false;  // stop 'date' from being sent
              decodeMessage(data, null, receiveThenReply);
            });
          };
          checkClientAndServer(thisTest, thisServer);
        });
      });
    });
  });
});
