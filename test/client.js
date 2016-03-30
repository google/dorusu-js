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
var buildClient = require('../lib/client').buildClient;
var chai = require('chai');
chai.use(require('dirty-chai'));
var clientLog = require('./util').clientLog;
var decodeMessage = require('../lib/codec').decodeMessage;
var encodeMessage = require('../lib/codec').encodeMessage;
var expect = chai.expect;
var http2 = require('http2');
var insecureOptions = require('./util').insecureOptions;
var irreverser = require('./util').irreverser;
var listenOnFreePort = require('./util').listenOnFreePort;
var reverser = require('./util').reverser;
var dorusu = require('../lib/dorusu');
var secureOptions = require('../example/certs').options;
var serverLog = require('./util').serverLog;

var Readable = require('stream').Readable;
var Stub = require('../lib/client').Stub;

// Tests here cannot rely on RpcServer, they use the base http2 server
// along with functions in the codec module.
//
//
// - start a http2 server, i.e, do not assume the rpc server is available
// - send a request via the dorusu client
// - verify behaviour on the server using the http2 library + decodeMessage
// - respond using the http2 library + encodeMessage
// - verify the expected client response

http2.globalAgent = new http2.Agent({ log: clientLog });

var testOptions = {
  secure: secureOptions,
  insecure: insecureOptions
};

describe('Service Client', function() {
  var msg = 'hello';
  var testService = app.Service('test', [
    app.Method('do_echo', reverser, irreverser),
    app.Method('do_reverse', reverser),
    app.Method('do_irreverse', null, reverser)
  ]);
  _.forEach(testOptions, function(serverOpts, connType) {
    describe(connType + ': function `buildClient(service)`', function() {
      it('should build a constructor that adds the expected methods', function() {
        var Ctor = buildClient(testService);
        expect(Ctor).to.be.a('function');
        var instance = new Ctor('http://localhost:8080/dummy/path');
        expect(instance.doEcho).to.be.a('function');
        expect(instance.doReverse).to.be.a('function');
        expect(instance.doIrreverse).to.be.a('function');
      });
      it('should send multiple messages ok', function(done) {
        // thisTest checks that the expected text is in the reply, and that the
        // server received two messages.
        var count = 0;
        var thisTest = function(srv, stub) {
          var msgs = new Readable();
          msgs.push(msg);
          msgs.push(msg);
          msgs.push(null);
          stub.doEcho(msgs, function(response) {
            var theStatus;
            var theError;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(msg);
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
                'code': dorusu.rpcCode('OK')
              });
              expect(theError).to.be.undefined();
              expect(count).to.eql(2);
              srv.close();
              done();
            });
          });
        };
        var wantedMsg = reverser(msg).toString();
        var thisServer = function(request, response) {
          expect(request.url).to.equal('/test/do_echo');
          var validateReqThenRespond = function(err, decoded){
            expect(decoded.toString()).to.equal(wantedMsg);
            if (count === 2) {
              encodeMessage(decoded, null,
                            makeSendEncodedResponse(response));
            }
          };
          request.on('data', function(data) {
            count += 1;
            response.addTrailers({'grpc-status': dorusu.rpcCode('OK')});
            decodeMessage(data, null, validateReqThenRespond);
          });
        };
        var testClient = buildClient(testService);
        checkServiceClientAndServer(testClient, thisTest, thisServer, serverOpts);
      });
    });
  });
});

describe('Base RPC Client', function() {
  var path = '/x';
  var msg = 'hello';
  var reply = 'world';
  _.forEach(testOptions, function(serverOpts, connType) {
    var createServer = http2.createServer;
    if (connType === 'insecure') {
      createServer = http2.raw.createServer;
    }
    var payloadTests = [{
      'name': 'without serialization'
    },{
      'name': 'with a marshaller',
      'marshal': reverser
    },{
      'name': 'with a marshaller and unmarshaller',
      'marshal': reverser,
      'unmarshal': irreverser
    }];
    _.forEach(payloadTests, function(opts) {
      describe(connType + ': multi-message rpc ' + opts.name, function() {
        it('should work as expected', function(done) {
          var wantedReq = msg, wantedReply = reply;
          if (opts.marshal) {
            wantedReq = opts.marshal(msg).toString();
          }
          if (opts.unmarshal) {
            wantedReply = opts.marshal(reply).toString();
          }
          // thisTest checks that the expected text is in the reply,
          // and that the server received two messages.
          var count = 0;
          var thisTest = function(srv, stub) {
            var call = stub.rpcFunc(opts.marshal, opts.unmarshal);
            var msgs = new Readable();
            msgs.push(msg);
            msgs.push(msg);
            msgs.push(null);
            call(path, msgs, function(response) {
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
                  'code': dorusu.rpcCode('OK')
                });
                expect(theError).to.be.undefined();
                expect(count).to.eql(2);
                srv.close();
                done();
              });
            });
          };
          var thisServer = function(request, response) {
            expect(request.url).to.equal(path);
            var validateReqThenRespond = function(err, decoded){
              expect(decoded.toString()).to.equal(wantedReq);
              if (count === 2) {
                encodeMessage(wantedReply, null,
                              makeSendEncodedResponse(response));
              }
            };
            request.on('data', function(data) {
              count += 1;
              response.addTrailers({'grpc-status': dorusu.rpcCode('OK')});
              decodeMessage(data, null, validateReqThenRespond);
            });
          };
          checkClientAndServer(thisTest, thisServer, serverOpts);
        });
      });
      describe(connType + ': simple post ' + opts.name, function() {
        it('should work as expected', function(done) {
          var wantedReq = msg, wantedReply = reply;
          if (opts.marshal) {
            wantedReq = opts.marshal(msg).toString();
          }
          if (opts.unmarshal) {
            wantedReply = opts.marshal(reply).toString();
          }
          // thisTest checks that the expected text is in the reply, i.e, it
          // has been decoded successfully.
          var thisTest = function(srv, stub) {
            var call = stub.rpcFunc(opts.marshal, opts.unmarshal);
            call(path, msg, function(response) {
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
                  'code': dorusu.rpcCode('OK')
                });
                expect(theError).to.be.undefined();
                srv.close();
                done();
              });
            });
          };
          var thisServer = function(request, response) {
            expect(request.url).to.equal(path);
            var validateReqThenRespond = function(err, decoded){
              expect(decoded.toString()).to.equal(wantedReq);
              encodeMessage(wantedReply, null, makeSendEncodedResponse(response));
            };
            request.on('data', function(data) {
              response.addTrailers({'grpc-status': dorusu.rpcCode('OK')});
              decodeMessage(data, null, validateReqThenRespond);
            });
          };
          checkClientAndServer(thisTest, thisServer, serverOpts);
        });
      });
    });
    describe(connType + ': headers', function() {
      it('should update headers via options.updateHeaders', function(done) {
        var serviceNameHeader = 'service_name';
        var headerName = 'name';
        var headerValue = 'value';
        var server = createServer(serverOpts, function(request) {
          var wantServiceName = 'https://localhost/testservice';
          expect(request.headers[headerName]).to.equal(headerValue);
          expect(request.headers[serviceNameHeader]).to.equal(wantServiceName);
          server.close();
          done();
        });

        // thisTest sends a test header that gets add via the updateHeaders
        // callback option.
        var thisTest = function(srv, stub) {
          stub.post(path, msg, _.noop);
        };
        var fullOpts = {
          serviceName: 'testservice',
          updateHeaders: function(serviceName, headers, done) {
            headers = headers || {};
            headers[headerName] = headerValue;
            headers[serviceNameHeader] = serviceName;
            done(null, headers);
          }
        };
        _.merge(fullOpts, serverOpts);
        checkClient(server, thisTest, fullOpts);
      });
      describe('single-valued, non-reserved', function() {
        it('should send headers when provided', function(done) {
          var headerName = 'name';
          var headerValue = 'value';
          var server = createServer(serverOpts, function(request) {
            expect(request.headers[headerName]).to.equal(headerValue);
            server.close();
            done();
          });

          // thisTest sends a test header.
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, _.noop, {headers: headers});
          };
          checkClient(server, thisTest, serverOpts);
        });
        it('should base64+rename if value is a Buffer', function(done) {
          var headerName = 'name';
          var headerValue = new Buffer('value');
          var server = createServer(serverOpts, function(request) {
            var want = headerValue.toString('base64');
            expect(request.headers[headerName + '-bin']).to.equal(want);
            expect(request.headers[headerName]).to.be.undefined();
            server.close();
            done();
          });

          // thisTest sends a test header with Buffer value.
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, _.noop, {headers: headers});
          };
          checkClient(server, thisTest, serverOpts);
        });
        it('should base64+rename if value is non-ascii', function(done) {
          var headerName = 'name';
          var headerValue = '\u00bd + \u00bc = \u00be';
          var server = createServer(serverOpts, function(request) {
            var want = new Buffer(headerValue).toString('base64');
            expect(request.headers[headerName + '-bin']).to.equal(want);
            expect(request.headers[headerName]).to.be.undefined();
            server.close();
            done();
          });

          // thisTest sends a test header with an non-ascii value
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, _.noop, {headers: headers});
          };
          checkClient(server, thisTest, serverOpts);
        });
      });
      describe('multi-valued', function() {
        it('should send headers when provided', function(done) {
          var headerName = 'name';
          var headerValue = ['value1', 'value2'];
          var server = createServer(serverOpts, function(request) {
            expect(request.headers[headerName]).to.deep.equal(headerValue);
            server.close();
            done();
          });

          // thisTest sends a test header with an array value
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, _.noop, {headers: headers});
          };
          checkClient(server, thisTest, serverOpts);
        });
        it('should base64+rename if any item is a Buffer', function(done) {
          var headerName = 'name';
          var headerValue = [new Buffer('value'), 'this is ascii'];
          var server = createServer(serverOpts, function(request) {
            var want = [
              headerValue[0].toString('base64'),
              new Buffer(headerValue[1]).toString('base64')
            ];
            expect(request.headers[headerName + '-bin']).to.deep.equal(want);
            expect(request.headers[headerName]).to.be.undefined();
            server.close();
            done();
          });

          // thisTest sends a test header with an array containing one Buffer
          // value.
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, _.noop, {headers: headers});
          };
          checkClient(server, thisTest, serverOpts);
        });
        it('should base64+rename if any item that is non-ascii', function(done) {
          var headerName = 'name';
          var headerValue = ['\u00bd + \u00bc = \u00be', 'this is ascii'];
          var server = createServer(serverOpts, function(request) {
            var want = [
              new Buffer(headerValue[0]).toString('base64'),
              new Buffer(headerValue[1]).toString('base64')
            ];
            expect(request.headers[headerName + '-bin']).to.deep.equal(want);
            expect(request.headers[headerName]).to.be.undefined();
            server.close();
            done();
          });
          // thisTest sends a test header with an array containing one non-ascii
          // value.
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, _.noop, {headers: headers});
          };
          checkClient(server, thisTest, serverOpts);
        });
      });
      describe('special: on secure header', function() {
        var action = 'block';
        if (connType === 'secure') {
          action = 'allow';
        }
        it('should ' + action + ' the secure header', function(done) {
          // thisTest sends a dummy secure header
          var headers = {'authorization': 'dummyValue'};
          var thisTest = function(srv, stub) {
            try {
              stub.post(path, msg, _.noop, {headers: headers});
              expect(connType).to.equal('secure');
              done();
            } catch (err) {
              expect(connType).to.equal('insecure');
              srv.close();
              done();
            }
          };
          checkClientAndServer(thisTest, _.noop, serverOpts);
        });
      });
      describe('special: timeout headers', function() {
        it('should fail on sending a bad grpc-timeout value', function(done) {
          // thisTest sends a bad grpc-timeout header.
          var headers = {};
          headers['grpc-timeout'] = 'this will not work';
          var thisTest = function(srv, stub) {
            // TODO: investigate a way of writing EncodedOutgoingRequest._start
            // so that error handling of this case is simpler
            try {
              var req = stub.post(path, msg, _.noop, {headers: headers});
              req.on('error', function(){
                // This works when the timeout is bad for secure requests
                srv.close();
                done();
              });
            } catch (err) {
              // This works when the timeout is bad for insecure requests
              srv.close();
              done();
            }
          };
          checkClientAndServer(thisTest, _.noop, serverOpts);
        });
        it('should succeed in sending a good grpc-timeout value', function(done) {
          var headerName = 'grpc-timeout';
          var headerValue = '10S';
          var server = createServer(serverOpts, function(request) {
            expect(request.headers[headerName]).to.equal(headerValue);
            server.close();
            done();
          });

          // thisTest sends the grpc-timeout header with a valid value.
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, _.noop, {headers: headers});
          };
          checkClient(server, thisTest, serverOpts);
        });
        it('should send a grpc-timeout when a deadline is provided', function(done) {
          // thisTest sends the test header.
          var headers = {};
          var testDeadline = new Date();
          var nowPlus10 = Date.now() + Math.pow(10, 4);
          testDeadline.setTime(nowPlus10);
          headers.deadline = testDeadline;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, _.noop, {headers: headers});
          };

          var server = createServer(serverOpts, function(request) {
            expect(request.headers['grpc-timeout']).to.exist();
            server.close();
            done();
          });
          checkClient(server, thisTest, serverOpts);
        });
        it('should timeout a request when a deadline is provided', function(done) {
          // thisTest sends a request with a timeout
          var headers = {};
          var testDeadline = new Date();
          var nowPlusHalfSec = Date.now() + 500; // 500 ms
          testDeadline.setTime(nowPlusHalfSec);
          headers.deadline = testDeadline;
          var wantedCode = dorusu.rpcCode('DEADLINE_EXCEEDED');
          var thisTest = function(srv, stub) {
            var req = stub.post(path, msg, _.noop, { headers: headers});
            req.on('cancel', function(code) {
              expect(wantedCode).to.equal(code);
              done();
            });
          };

          var thisServer = function(request) {
            expect(request.headers['grpc-timeout']).to.exist();
            // don't handle response, this should cause the client to cancel.
          };
          checkClientAndServer(thisTest, thisServer, serverOpts);
        });
      });
    });
    describe(connType + ': response metadata', function() {
      it('only emits a metadata event when any is present', function(done) {
        // thisTest checks that no metadata is set
        var thisTest = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var metadataFired = false;
            response.on('data', _.noop);
            response.on('metadata', function() {
              metadataFired = true;
            });
            response.on('end', function() {
              expect(metadataFired).to.be.false();
              srv.close();
              done();
            });
          });
        };
        var thisServer = function(request, response) {
          var receiveThenReply = function() {
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.on('data', function(data) {
            response.setHeader('content-type', 'not-counted-as-metadata');
            response.setHeader('user-agent', 'not-counted-as-metadata');
            response.addTrailers({
              'grpc-status': dorusu.rpcCode('OK'),
              'grpc-message': 'not-counted-as-metadata'
            });
            response.sendDate = false;  // by default the date header gets sent
            decodeMessage(data, null, receiveThenReply);
          });
        };
        checkClientAndServer(thisTest, thisServer, serverOpts);
      });
      it('should include any unreserved headers', function(done) {
        // thisTest checks that the metadata includes expected headers
        var thisTest = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var theMetadata;
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
          var receiveThenReply = function() {
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.on('data', function(data) {
            response.setHeader('my-header', 'my-header-value');
            response.addTrailers({
              'my-trailer': 'my-trailer-value',
              'content-type': 'this-is-reserved-and-is-not-metadata',
              'grpc-status': dorusu.rpcCode('OK'),
              'grpc-message': 'not-counted-as-metadata'
            });
            response.sendDate = false;  // by default the date header gets sent
            decodeMessage(data, null, receiveThenReply);
          });
        };
        checkClientAndServer(thisTest, thisServer, serverOpts);
      });
      it('should represent multi-value metadata as arrays', function(done) {
        // thisTest checks that multi-value metadata is propagated as an
        // array.
        var thisTest = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var theMetadata;
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
          var receiveThenReply = function() {
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.on('data', function(data) {
            response.setHeader(
              'my-header', ['my-header-value', 'my-header-value2']);
            response.addTrailers({
              'grpc-status': dorusu.rpcCode('OK'),
              'grpc-message': 'not-counted-as-metadata'
            });
            response.sendDate = false;  // stop 'date' from being sent
            decodeMessage(data, null, receiveThenReply);
          });
        };
        checkClientAndServer(thisTest, thisServer, serverOpts);
      });
      it('should decode binary metadata ok', function(done) {
        var buf = new Buffer('\u00bd + \u00bc = \u00be');
        // thisTest checks that binary metadata is decoded into a Buffer.
        var thisTest = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var theMetadata;
            response.on('data', _.noop);
            response.on('metadata', function(md) {
              theMetadata = md;
            });
            var want = {
              'my-header': buf
            };
            response.on('end', function() {
              expect(theMetadata).to.deep.eql(want);
              srv.close();
              done();
            });
          });
        };
        var thisServer = function(request, response) {
          var receiveThenReply = function() {
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.on('data', function(data) {
            response.setHeader(
              'my-header-bin', buf.toString('base64'));
            response.addTrailers({
              'grpc-status': dorusu.rpcCode('OK'),
              'grpc-message': 'not-counted-as-metadata'
            });
            response.sendDate = false;  // stop 'date' from being sent
            decodeMessage(data, null, receiveThenReply);
          });
        };
        checkClientAndServer(thisTest, thisServer, serverOpts);
      });
      it('should decode multi-value binary metadata ok', function(done) {
        var buf = new Buffer('\u00bd + \u00bc = \u00be');
        // thisTest checks that multi-value binary metadata is decoded into
        // buffers.
        var thisTest = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var theMetadata;
            response.on('data', _.noop);
            response.on('metadata', function(md) {
              theMetadata = md;
            });
            var want = {
              'my-header': [buf, buf]
            };
            response.on('end', function() {
              expect(theMetadata).to.deep.eql(want);
              srv.close();
              done();
            });
          });
        };
        var thisServer = function(request, response) {
          var receiveThenReply = function() {
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.on('data', function(data) {
            response.setHeader(
              'my-header-bin', [buf.toString('base64'), buf.toString('base64')]);
            response.addTrailers({
              'grpc-status': dorusu.rpcCode('OK'),
              'grpc-message': 'not-counted-as-metadata'
            });
            response.sendDate = false;  // stop 'date' from being sent
            decodeMessage(data, null, receiveThenReply);
          });
        };
        checkClientAndServer(thisTest, thisServer, serverOpts);
      });
    });
    describe(connType + ': the response status', function() {
      var badStatuses = [
        'not-a-number-is-bad',
        '',
        {}
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
              var checkError = function checkError(resp) {
                resp.on('error', function() {
                  srv.close();
                  done();
                });
              };
              stub.post(path, msg, checkError);
            };

            var thisServer = function(request, response) {
              var receiveThenReply = function() {
                encodeMessage(reply, null, makeSendEncodedResponse(response));
              };
              request.on('data', function(data) {
                if (inTrailer) {
                  response.addTrailers({'grpc-status': badStatus});
                } else {
                  response.setHeader('grpc-status', badStatus);
                }
                decodeMessage(data, null, receiveThenReply);
              });
            };
            checkClientAndServer(thisTest, thisServer, serverOpts);
          });
        });
      });
      it('should receive the status message and code', function(done) {
        // thisTest checks that the expected status code and message are received.
        var code = 14014;
        var message = 'code is fourteen-o-fourteen';
        var thisTest = function(srv, stub) {
          stub.post(path, msg, function(response) {
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
          var receiveThenReply = function() {
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.on('data', function(data) {
            response.addTrailers({
              'grpc-status': code,
              'grpc-message': message
            });
            decodeMessage(data, null, receiveThenReply);
          });
        };
        checkClientAndServer(thisTest, thisServer, serverOpts);
      });
    });
    describe(connType + ': cancellation', function() {
      it('should cancel a request ok', function(done) {
        // thisTest makes a request then cancels it.
        var thisTest = function(srv, stub) {
          var req = stub.post(path, msg, _.noop);
          req.on('cancel', function() {
            srv.close();
            done();
          });
          req.cancel();
        };

        var thisServer = function(request) {
          expect(request.headers['grpc-timeout']).to.not.exist();
          // confirm that no timeout header was sent
          // don't handle response, this should cause the client to cancel.
        };
        checkClientAndServer(thisTest, thisServer, serverOpts);
      });
      it('should abort a request ok', function(done) {
        // thisTest makes a request then aborts it.
        var thisTest = function(srv, stub) {
          var req = stub.post(path, msg, _.noop);
          req.on('cancel', function() {
            srv.close();
            done();
          });
          req.abort();
        };

        var thisServer = function(request) {
          expect(request.headers['grpc-timeout']).to.not.exist();
          // confirm that no timeout header was sent
          // don't handle response, this should cause the client to cancel.
        };
        checkClientAndServer(thisTest, thisServer, serverOpts);
      });
    });
  });
});

function checkClient(server, clientExpects, opts) {
  listenOnFreePort(server, function(addr, server) {
    var stubOpts = {
      log: clientLog
    };
    _.merge(stubOpts, addr, opts);
    clientExpects(server, new Stub(stubOpts));
  });
}

function makeServer(opts, serverExpects) {
  opts = _.clone(opts);
  opts.log = serverLog;
  if (opts.plain) {
    return http2.raw.createServer(opts, serverExpects);
  } else {
    return http2.createServer(opts, serverExpects);
  }
}

function checkClientAndServer(clientExpects, serverExpects, opts) {
  checkClient(makeServer(opts, serverExpects), clientExpects, opts);
}

function makeSendEncodedResponse(response) {
  return function sendEncodedResponse(encoded) {
    response.end(encoded);
  };
}

function checkServiceClient(Ctor, server, clientExpects, opts) {
  listenOnFreePort(server, function(addr, server) {
    var stubOpts = {
      log: clientLog
    };
    _.merge(stubOpts, addr, opts);
    clientExpects(server, new Ctor(stubOpts));
  });
}

function checkServiceClientAndServer(
  clientCls, clientExpects, serverExpects, opts) {
  checkServiceClient(
    clientCls, makeServer(opts, serverExpects),
    clientExpects,
    opts);
}
