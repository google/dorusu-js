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

var _ = require('lodash');
var app = require('../lib/app');
var checkResponseUsing = require('./util').checkResponseUsing;
var clientLog = require('./util').clientLog;
var expect = require('chai').expect;
var irreverser = require('./util').irreverser;
var insecureOptions = require('./util').insecureOptions;
var listenOnFreePort = require('./util').listenOnFreePort;
var reverser = require('./util').reverser;
var dorusu = require('../lib');
var secureOptions = require('../example/certs').serverOptions;
var serverLog = require('./util').serverLog;
var thrower = require('./util').thrower;

var Stub = require('../lib/client').Stub;


// testTable is used to verify dorusu.makeDispatcher.
var testTable = {
  '/x': function xHandler(request, response) {
    request.once('data', function() {
      response.end('response from /x');
    });
  },
  '/y': function yHandler(request, response) {
    request.once('data', function() {
      response.end('response from /y');
    });
  }
};

function createDelayedApp() {
  return new app.RpcApp(
    app.Service('test', [
      app.Method('delayed_by_a_half', null, reverser)
    ])
  );
}

// testApp is used to verify app handling
var testApp = new app.RpcApp(
  app.Service('test', [
    app.Method('do_echo', reverser, irreverser),
    app.Method('do_reverse', reverser),
    app.Method('do_irreverse', null, reverser),
    app.Method('do_throw_on_encode', thrower, null),
    app.Method('do_throw_on_decode', null, thrower),
    app.Method('try_echo_but_fail', reverser, irreverser),
    app.Method('try_echo_but_fail2', reverser, irreverser)
  ])
);
testApp.register('/test/do_echo', echoHandler);
testApp.register('/test/do_reverse', echoHandler);
testApp.register('/test/do_irreverse', echoHandler);
testApp.register('/test/do_throw_on_decode', echoHandler);
testApp.register('/test/do_throw_on_encode', echoHandler);
testApp.register('/test/try_echo_but_fail', throwingHandler);
testApp.register('/test/try_echo_but_fail2', throwingHandler2);


// Tests here can use the dorusu client as it's tests do not depend on RpcServer.
//
// Typically flow is:
// - start a RpcServer
// - send a request via the dorusu client
// - verify behaviour on the server without functions from ./codec.js
// - optionally verify what the client receives using the dorusu

describe('RpcServer', function() {
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
  };
  var testStatusMsg = 'a test status message';
  var testCode = 10101;
  var path = '/x';
  var msg = 'hello';
  var reply = 'world';
  var testOptions = {
    secure: _.merge(_.clone(secureOptions), {
      rejectUnauthorized: false
    }),
    insecure: _.clone(insecureOptions)
  };

  _.forEach(testOptions, function(serverOptions, connType) {
    describe(connType + ': server with an app', function() {
      it('should use the fallback on unknown routes', function(done) {
        function thisClient(srv, stub) {
          function onEnd(gotStatus, gotError) {
            expect(gotStatus).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNKNOWN')
            });
            expect(gotError).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNKNOWN')
            });
            srv.close();
            done();
          }
          stub.post(path, msg, checkResponseUsing(onEnd));
        }

        var appOptions = _.clone(serverOptions);
        appOptions.app = testApp;
        function fallback(request, response) {
          // use a different status code than unknown
          response.rpcCode = dorusu.rpcCode('UNKNOWN');
          response.end('');
        }
        // here, null === no requestListener fallback
        checkClientAndServer(thisClient, fallback, appOptions);
      });
      it('should use `dorusu.unimplemented` as the default fallback', function(done) {
        function thisClient(srv, stub) {
          function onEnd(gotStatus, gotError) {
            expect(gotStatus).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNIMPLEMENTED')
            });
            expect(gotError).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNIMPLEMENTED')
            });
            srv.close();
            done();
          }
          stub.post(path, msg, checkResponseUsing(onEnd));
        }

        var appOptions = _.clone(serverOptions);
        appOptions.app = testApp;
        // here, null === no requestListener fallback
        checkClientAndServer(thisClient, null, appOptions);
      });
      it('should respond on registered handlers', function(done) {
        function thisClient(srv, stub) {
          function onEnd(gotStatus, gotError, gotData) {
            expect(gotData[0].toString()).to.eql(msg);
            expect(gotStatus).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('OK')
            });
            expect(gotError).to.equal(undefined);
            srv.close();
            done();
          }
          stub.post('/test/do_echo', msg, checkResponseUsing(onEnd));
        }
        var appOptions = _.clone(serverOptions);
        appOptions.app = testApp;
        checkClientAndServer(thisClient, _.noop, appOptions);
      });
      it('should use the specified encoder on the response', function(done) {
        function thisClient(srv, stub) {
          stub.post('/test/do_reverse', msg, function(response) {
            var want = reverser(msg);
            response.on('data', function(data) {
              expect(data).to.eql(want);
            });
            response.on('end', function() {
              srv.close();
              done();
            });
          });
        }

        var appOptions = _.clone(serverOptions);
        appOptions.app = testApp;
        checkClientAndServer(thisClient, _.noop, appOptions);
      });
      it('should be ok when the timeout is long enough', function(done) {
        function thisClient(srv, stub) {
          stub.post('/test/delayed_by_a_half', msg, function(response) {
            var want = reverser(msg);
            response.on('data', function(data) {
              expect(data).to.eql(want);
            });
            response.on('end', function() {
              srv.close();
              done();
            });
          }, {
            headers: {
              'grpc-timeout': '1S'
            }
          });
        }

        var appOptions = _.clone(serverOptions);
        appOptions.app = createDelayedApp();
        appOptions.app.register('/test/delayed_by_a_half', delayedHandler);
        checkClientAndServer(thisClient, _.noop, appOptions);
      });
      it('should apply the timeout on server', function(done) {
        function thisClient(srv, stub) {
          stub.post('/test/delayed_by_a_half', msg, _.noop, {
            headers: {
              'grpc-timeout': '300m'
            }
          });
        }

        function lateHandler(request, response) {
          request.once('data', function(data) {
            // reply in 500ms, longer the requested grpc-timeout, to trigger
            // client and server timeouts
            setTimeout(() => {
              response.end(data);
            }, 500);
          });
          request.on('cancel', function(code) {
            // complete the test on server
            if (code === dorusu.rpcCode('DEADLINE_EXCEEDED')) {
              // complete the test when the server deadline exceeded
              // occurs
              done();
            } else {
              // the cancel from the client closing the stream may also
              // occur
              expect(code).to.eql(dorusu.rpcCode('CANCELLED'));
            }
          });
        }

        var appOptions = _.clone(serverOptions);
        appOptions.app = createDelayedApp();
        appOptions.app.register('/test/delayed_by_a_half', lateHandler);
        checkClientAndServer(thisClient, _.noop, appOptions);
      });
      it('should send status UNKNOWN if response handler fails', function(done) {
        function thisClient(srv, stub) {
          function onEnd(gotStatus, gotError) {
            expect(gotStatus).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNKNOWN')
            });
            expect(gotError).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNKNOWN')
            });
            srv.close();
            done();
          }
          stub.post('/test/try_echo_but_fail', msg, checkResponseUsing(onEnd));
        }

        var appOptions = _.clone(serverOptions);
        appOptions.app = testApp;
        checkClientAndServer(thisClient, _.noop, appOptions);
      });
      it('should send status UNKNOWN if data handler fails', function(done) {
        function thisClient(srv, stub) {
          function onEnd(gotStatus, gotError) {
            expect(gotStatus).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNKNOWN')
            });
            expect(gotError).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNKNOWN')
            });
            srv.close();
            done();
          }
          stub.post('/test/try_echo_but_fail2', msg, checkResponseUsing(onEnd));
        }

        var appOptions = _.clone(serverOptions);
        appOptions.app = testApp;
        checkClientAndServer(thisClient, _.noop, appOptions);
      });
      ['encode', 'decode'].forEach(function(whatFailed) {
        it('should send status INTERNAL if ' + whatFailed + ' fails', function(done) {
          function thisClient(srv, stub) {
            function onEnd(gotStatus, gotError, gotData) {
              expect(gotStatus).to.deep.equal({
                'message': '',
                'code': dorusu.rpcCode('INTERNAL')
              });
              expect(gotError).to.deep.equal({
                'message': '',
                'code': dorusu.rpcCode('INTERNAL')
              });
              expect(gotData).to.deep.equal([]);
              srv.close();
              done();
            }
            var failingUri = '/test/do_throw_on_' + whatFailed;
            stub.post(failingUri, msg, checkResponseUsing(onEnd));
          }

          var appOptions = _.clone(serverOptions);
          appOptions.app = testApp;
          checkClientAndServer(thisClient, _.noop, appOptions);
        });
      });
      it('should use the specified decoder on the request', function(done) {
        function thisClient(srv, stub) {
          var sent = reverser(msg).toString();
          stub.post('/test/do_irreverse', sent, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.eql(msg);
            });
            response.on('end', function() {
              srv.close();
              done();
            });
          });
        }

        var appOptions = _.clone(serverOptions);
        appOptions.app = testApp;
        checkClientAndServer(thisClient, _.noop, appOptions);
      });
    });
    describe(connType + ': `dorusu.makeDispatcher`', function() {
      it('should respond with status UNIMPLEMENTED for an empty table', function(done) {
        function thisClient(srv, stub) {
          function onEnd(gotStatus, gotError) {
            expect(gotStatus).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNIMPLEMENTED')
            });
            expect(gotError).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNIMPLEMENTED')
            });
            srv.close();
            done();
          }
          stub.post(path, msg, checkResponseUsing(onEnd));
        }

        checkClientAndServer(thisClient, dorusu.makeDispatcher(), serverOptions);
      });
      it('should respond with status UNIMPLEMENTED for unknown routes', function(done) {
        function thisClient(srv, stub) {
          function onEnd(gotStatus, gotError) {
            expect(gotStatus).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNIMPLEMENTED')
            });
            expect(gotError).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNIMPLEMENTED')
            });
            srv.close();
            done();
          }
          stub.post(path, msg, checkResponseUsing(onEnd));
        }

        var table = _.clone(testTable);
        delete table['/x'];
        var dispatcher = dorusu.makeDispatcher(table);
        checkClientAndServer(thisClient, dispatcher, serverOptions);
      });
      it('should respond for configured routes', function(done) {
        function thisClient(srv, stub) {
          function onEnd(gotStatus, gotError) {
            expect(gotStatus).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('OK')
            });
            expect(gotError).to.equal(undefined);
            srv.close();
            done();
          }
          stub.post(path, msg, checkResponseUsing(onEnd));
        }

        var dispatcher = dorusu.makeDispatcher(testTable);
        checkClientAndServer(thisClient, dispatcher, serverOptions);
      });
    });
    describe(connType + ': `dorusu.unimplemented`', function() {
      it('should respond with status UNIMPLEMENTED', function(done) {
        function thisClient(srv, stub) {
          function onEnd(gotStatus, gotError) {
            expect(gotStatus).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNIMPLEMENTED')
            });
            expect(gotError).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('UNIMPLEMENTED')
            });
            srv.close();
            done();
          }
          stub.post(path, msg, checkResponseUsing(onEnd));
        }

        checkClientAndServer(thisClient, dorusu.unimplemented, serverOptions);
      });
    });
    describe(connType + ': simple request/response', function() {
      it('should work as expected', function(done) {
        function thisClient(srv, stub) {
          function onEnd(gotStatus, gotError, gotData) {
            expect(gotData[0].toString()).to.equal(reply);
            expect(gotStatus).to.deep.equal({
              'message': '',
              'code': dorusu.rpcCode('OK')
            });
            expect(gotError).to.equal(undefined);
            srv.close();
            done();
          }
          stub.post(path, msg, checkResponseUsing(onEnd));
        }

        // thisTest checks that the expected text is decoded from the request
        // and that the response is successfully encoded.
        function thisTest(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            response.end(reply);
          });
        }
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should can receive status and status messages', function(done) {
        function thisClient(srv, stub) {
          stub.post(path, msg, function(response) {
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
        }

        // thisTest sets up the client to receive different status messages and
        // codes.
        function thisTest(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            response.rpcMessage = testStatusMsg;
            response.rpcCode = testCode;
            response.end(reply);
          });
        }
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should send non-binary trailers ok', function(done) {
        var want = _.clone(nonBinMd);
        function thisClient(srv, stub) {
          stub.post(path, msg, function(response) {
            var got;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('metadata', function(md) {
              got = md;
            });
            response.on('end', function() {
              expect(got).to.deep.equal(want);
              srv.close();
              done();
            });
          });
        }

        // thisTest sets up the client to receive non-binary trailers.
        function thisTest(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            response.addTrailers(want);
            response.end(reply);
          });
        }
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should send non-binary headers ok', function(done) {
        var want = _.clone(nonBinMd);
        function thisClient(srv, stub) {
          stub.post(path, msg, function(response) {
            var got;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('metadata', function(md) {
              got = md;
            });
            response.on('end', function() {
              expect(got).to.deep.equal(want);
              srv.close();
              done();
            });
          });
        }

        // thisTest sets up the client to receive non-binary headers.
        function thisTest(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            _.forEach(want, function(value, key) {
              response.setHeader(key, value);
            });
            response.end(reply);
          });
        }
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should send binary headers ok', function(done) {
        var want = _.clone(binMdEx);
        function thisClient(srv, stub) {
          stub.post(path, msg, function(response) {
            var got;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('metadata', function(md) {
              got = md;
            });
            response.on('end', function() {
              expect(got).to.deep.equal(want);
              srv.close();
              done();
            });
          });
        }

        // thisTest sets up the client to receive binary headers.
        function thisTest(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            _.forEach(want, function(value, key) {
              response.setHeader(key, value);
            });
            response.end(reply);
          });
        }
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should send binary trailers ok', function(done) {
        var want = _.clone(binMdEx);
        function thisClient(srv, stub) {
          stub.post(path, msg, function(response) {
            var got;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('metadata', function(md) {
              got = md;
            });
            response.on('end', function() {
              expect(got).to.deep.equal(want);
              srv.close();
              done();
            });
          });
        }

        // thisTest sets up the client to receive binary trailers.
        function thisTest(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            response.addTrailers(want);
            response.end(reply);
          });
        }
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should receive a good timeout OK', function(done) {
        function thisClient(srv, stub) {
          stub.post(path, msg, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('end', function() {
              srv.close();
              done();
            });
          }, {headers: timeoutOpts});
        }
        // thisTest sets up the client to receive non-binary headers.
        function thisTest(request, response) {
          var want = timeoutOpts['grpc-timeout'];
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(request.timeoutValue).to.equal(want);
            expect(data.toString()).to.equal(msg);
            response.end(reply);
          });
        }
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should receive non-binary headers OK', function(done) {
        function thisClient(srv, stub) {
          stub.post(path, msg, function(response) {
            response.on('data', _.noop);
            response.on('end', function() { srv.close(); });
          }, {headers: nonBinMd});
        }
        // thisTest checks that the server receives non-binary metadata
        function thisTest(request, response) {
          expect(request.url).to.equal(path);
          request.on('metadata', function(md) {
            expect(md).to.deep.equal(nonBinMd);
          });
          request.once('data', function() {
            response.end(reply);
            done();
          });
        }
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should receive binary headers OK', function(done) {
        function thisClient(srv, stub) {
          stub.post(path, msg, function(response) {
            response.on('data', _.noop);
            response.on('end', function() { srv.close(); });
          }, {headers: binMd});
        }
        // thisTest checks that the server receives non-binary metadata
        function thisTest(request, response) {
          expect(request.url).to.equal(path);
          request.on('metadata', function(md) {
            expect(md).to.deep.equal(binMdEx);
          });
          request.once('data', function() {
            response.end(reply);
            done();
          });
        }
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
    });
  });
  describe('secure server factory', function() {
    it('must specify some secure configuration options', function() {
      function shouldFail() {
        dorusu.createServer(_.noop);  /* no options */
      }
      expect(shouldFail).to.throw(Error);
    });
    it('should specify both cert and key in configuration options', function() {
      _.forEach(['key', 'cert'], function(toRemove) {
        function shouldFail() {
          var badOpts = _.clone(secureOptions);
          delete badOpts[toRemove];
          dorusu.createServer(badOpts, _.noop);
        }
        expect(shouldFail).to.throw(Error);
      });
    });
    it('can be constructed with secure options', function() {
      expect(dorusu.createServer(secureOptions, _.noop)).to.be.ok();
    });
  });
  describe('insecure server factory', function() {
    it('can create instances without specifying options', function() {
      expect(dorusu.raw.createServer(_.noop)).to.be.ok();
    });
    it('should fail if secure options cert and key are specified', function() {
      function shouldFail() {
        dorusu.raw.createServer(secureOptions, _.noop);
      }
      expect(shouldFail).to.throw(Error);
    });
  });
});

function makeRpcServer(opts, serverExpects) {
  opts = _.clone(opts);
  opts.log = serverLog;
  if (opts.plain) {
    return dorusu.raw.createServer(opts, serverExpects);
  } else {
    return dorusu.createServer(opts, serverExpects);
  }
}

function checkClientAndServer(clientExpects, serverExpects, opts) {
  var srv = makeRpcServer(opts, serverExpects);
  listenOnFreePort(srv, function(addr, server) {
    var stubOpts = {
      log: clientLog
    };
    _.merge(stubOpts, addr, opts);
    clientExpects(server, new Stub(stubOpts));
  });
}

function echoHandler(request, response) {
  request.once('data', function(data) {
    response.end(data);
  });
}

function delayedHandler(request, response) {
  request.once('data', function(data) {
    // reply in 500ms, timing tests will use timeouts either much shorter or
    // much longer than that
    setTimeout(() => { response.end(data); }, 500);
  });
}

function throwingHandler() {
  throw new Error('something went wrong');
}

function throwingHandler2(request) {
  request.once('data', () => {
    throw new Error('something went wrong');
  });
}
