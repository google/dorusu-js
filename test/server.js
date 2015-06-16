'use strict';

var _ = require('lodash');
var expect = require('chai').expect;
var http2 = require('http2');
var insecureOptions = require('./util').insecureOptions;
var listenOnFreePort = require('./util').listenOnFreePort;
var nurpc = require('../lib/nurpc');
var secureOptions = require('./util').secureOptions;
var server = require('../lib/server');

var Stub = require('../lib/client').Stub;


// Tests here can rely on the nurpc client being available in tests as it is
// tested without any dependencies on RpcServer.
//
// Typically flow is:
// - start a RpcServer
// - send a request via the nurpc client
// - verify behaviour on the server without functions from ./codec.js
// - optionally verify what the client receives using the nurpc

describe('RpcServer', function() {
  var testTable = {
    '/x': function yHandler(request, response) {
      request.once('data', function(data) {
        response.end('response from /x');
      });
    },
    '/y': function yHandler(request, response) {
      request.once('data', function(data) {
        response.end('response from /y');
      });
    }
  };

  var nonBinMd = {
    trailer1: 'value1',
    trailer2: 'value2'
  };
  var binMd = {
    bt1: new Buffer('\u00bd + \u00bc = \u00be'),
    bt2: ['notBin', new Buffer('\u00bd + \u00bc = \u00be')]
  };
  var binMdEx = {
    bt1: new Buffer('\u00bd + \u00bc = \u00be'),
    bt2: [new Buffer('notBin'), new Buffer('\u00bd + \u00bc = \u00be')]
  };
  var timeoutOpts = {
    'grpc-timeout': '10S'
  }
  var testStatusMsg = 'a test status message';
  var testCode = 10101;
  var path = '/x';
  var msg = 'hello';
  var reply = 'world';
  var testOptions = {
    secure: secureOptions,
    insecure: insecureOptions
  };
  _.forEach(testOptions, function(serverOptions, connType) {
    describe(connType + ': `server.makeDispatcher`', function() {
      it('should respond with rpcCode 404 for empty table', function(done) {
        var thisClient = function(srv, stub) {
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
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              expect(theError).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              srv.close();
              done();
            });
          });
        };

        checkClientAndServer(thisClient, server.makeDispatcher(), serverOptions);
      });
      it('should respond with rpcCode 404 for unknown routes', function(done) {
        var thisClient = function(srv, stub) {
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
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              expect(theError).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              srv.close();
              done();
            });
          });
        };

        var table = _.clone(testTable);
        delete table['/x'];
        var dispatcher = server.makeDispatcher(table);
        checkClientAndServer(thisClient, dispatcher, serverOptions);
      });
      it('should respond for configured routes', function(done) {
        var thisClient = function(srv, stub) {
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
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('OK')
              });
              expect(theError).to.be.undefined;
              srv.close();
              done();
            });
          });
        };

        var dispatcher = server.makeDispatcher(testTable);
        checkClientAndServer(thisClient, dispatcher, serverOptions);
      });
    })
    describe(connType + ': `server.notFound`', function() {
      it('should respond with rpcCode 404', function(done) {
        var thisClient = function(srv, stub) {
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
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              expect(theError).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              srv.close();
              done();
            });
          });
        };

        checkClientAndServer(thisClient, server.notFound, serverOptions);
      });
    })
    describe(connType + ': simple request/response', function() {
      it('should work as expected', function(done) {
        var thisClient = function(srv, stub) {
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

        // thisTest checks that the expected text is decoded from the request
        // and that the response is successfully encoded.
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should can receive status and status messages', function(done) {
        var thisClient = function(srv, stub) {
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
                'message': testStatusMsg,
                'code': testCode
              });
              expect(theStatus).to.deep.equal({
                'message': testStatusMsg,
                'code': testCode
              });
              srv.close();
              done();
            });
          });
        };

        // thisTest sets up the client to receive different status messages and
        // codes.
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            response.rpcMessage = testStatusMsg;
            response.rpcCode = testCode;
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should send non-binary trailers ok', function(done) {
        var want = _.clone(nonBinMd);
        var thisClient = function(srv, stub) {
          stub.request_response(path, msg, {}, function(response) {
            var got;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('metadata', function(md) {
              got = md;
            })
            response.on('end', function() {
              expect(got).to.deep.equal(want);
              srv.close();
              done();
            });
          });
        };

        // thisTest sets up the client to receive non-binary trailers.
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            response.addTrailers(want);
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should send non-binary headers ok', function(done) {
        var want = _.clone(nonBinMd);
        var thisClient = function(srv, stub) {
          stub.request_response(path, msg, {}, function(response) {
            var got;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('metadata', function(md) {
              got = md;
            })
            response.on('end', function() {
              expect(got).to.deep.equal(want);
              srv.close();
              done();
            });
          });
        };

        // thisTest sets up the client to receive non-binary headers.
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            _.forEach(want, function(value, key) {
              response.setHeader(key, value);
            });
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should send binary headers ok', function(done) {
        var want = _.clone(binMdEx);
        var thisClient = function(srv, stub) {
          stub.request_response(path, msg, {}, function(response) {
            var got;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('metadata', function(md) {
              got = md;
            })
            response.on('end', function() {
              expect(got).to.deep.equal(want);
              srv.close();
              done();
            });
          });
        };

        // thisTest sets up the client to receive binary headers.
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            _.forEach(want, function(value, key) {
              response.setHeader(key, value);
            });
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should send binary trailers ok', function(done) {
        var want = _.clone(binMdEx);
        var thisClient = function(srv, stub) {
          stub.request_response(path, msg, {}, function(response) {
            var got;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('metadata', function(md) {
              got = md;
            })
            response.on('end', function() {
              expect(got).to.deep.equal(want);
              srv.close();
              done();
            });
          });
        };

        // thisTest sets up the client to receive binary trailers.
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            response.addTrailers(want);
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should receive a good timeout OK', function(done) {
        var thisClient = function(srv, stub) {
          stub.request_response(path, msg, timeoutOpts, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('end', function() {
              srv.close();
              done();
            });
          });
        };
        // thisTest sets up the client to receive non-binary headers.
        var thisTest = function(request, response) {
          var want = timeoutOpts['grpc-timeout'];
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(request.timeoutValue).to.equal(want);
            expect(data.toString()).to.equal(msg);
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should receive non-binary headers OK', function(done) {
        var thisClient = function(srv, stub) {
          stub.request_response(path, msg, nonBinMd, function(response) {
            response.on('data', _.noop);
            response.on('end', function() { srv.close() });
          });
        };
        // thisTest checks that the server receives non-binary metadata
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.on('metadata', function(md) {
            expect(md).to.deep.equal(nonBinMd);
          });
          request.once('data', function(data) {
            response.end(reply);
            done();
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should receive binary headers OK', function(done) {
        var thisClient = function(srv, stub) {
          stub.request_response(path, msg, binMd, function(response) {
            response.on('data', _.noop);
            response.on('end', function() { srv.close() });
          });
        };
        // thisTest checks that the server receives non-binary metadata
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.on('metadata', function(md) {
            expect(md).to.deep.equal(binMdEx);
          });
          request.once('data', function(data) {
            response.end(reply);
            done();
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
    });
  })
});

function makeRpcServer(opts, serverExpects) {
  if (opts.plain) {
    return server.raw.createServer(opts, serverExpects);
  } else {
    return server.createServer(opts, serverExpects);
  }
};

function checkClientAndServer(clientExpects, serverExpects, opts) {
  var srv = makeRpcServer(opts, serverExpects);
  listenOnFreePort(srv, function(addr, server) {
    var stubOpts = {};
    _.merge(stubOpts, addr, opts);
    clientExpects(server, new Stub(stubOpts));
  });
}
