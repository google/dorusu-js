'use strict';

var _ = require('lodash');
var clientLog = require('./util').clientLog;
var decodeMessage = require('../lib/codec').decodeMessage;
var encodeMessage = require('../lib/codec').encodeMessage;
var expect = require('chai').expect;
var http2 = require('http2');
var insecureOptions = require('./util').insecureOptions;
var irreverser = require('./util').irreverser;
var listenOnFreePort = require('./util').listenOnFreePort;
var reverser = require('./util').reverser;
var nurpc = require('../lib/nurpc');
var secureOptions = require('./util').secureOptions;

var Readable = require('stream').Readable;
var Stub = require('../lib/client').Stub;

// Tests here cannot rely on RpcServer, they use the base http2 server
// along with functions in the codec module.
//
//
// - start a http2 server, i.e, do not assume the rpc server is available
// - send a request via the nurpc client
// - verify behaviour on the server using the http2 library + decodeMessage
// - respond using the http2 library + encodeMessage
// - verify the expected client response

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

http2.globalAgent = new http2.Agent({ log: clientLog });

describe('RpcClient', function() {
  var path = '/x';
  var msg = 'hello';
  var reply = 'world';
  var testOptions = {
    secure: secureOptions,
    insecure: insecureOptions
  };
  _.forEach(testOptions, function(serverOpts, connType) {
    var createServer = http2.createServer;
    if (connType == 'insecure') {
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
            var msgs = Readable();
            msgs.push(msg);
            msgs.push(msg);
            msgs.push(null);
            call(path, msgs, {}, function(response) {
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
                  'code': nurpc.rpcCode('OK')
                });
                expect(theError).to.be.undefined;
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
              if (count == 2) {
                encodeMessage(wantedReply, null,
                              makeSendEncodedResponse(response));
              }
            };
            request.on('data', function(data) {
              count += 1;
              response.addTrailers({'grpc-status': nurpc.rpcCode('OK')});
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
            var call = stub.postFunc(opts.marshal, opts.unmarshal);
            call(path, msg, {}, function(response) {
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
                  'code': nurpc.rpcCode('OK')
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
              expect(decoded.toString()).to.equal(wantedReq);
              encodeMessage(wantedReply, null, makeSendEncodedResponse(response));
            };
            request.on('data', function(data) {
              response.addTrailers({'grpc-status': nurpc.rpcCode('OK')});
              decodeMessage(data, null, validateReqThenRespond);
            });
          };
          checkClientAndServer(thisTest, thisServer, serverOpts);
        });
      });
    });
    describe(connType + ': headers', function() {
      it('should update headers via options.updateHeaders', function(done) {
        var headerName = 'name';
        var headerValue = 'value';
        var server = createServer(serverOpts, function(request, response) {
          expect(request.headers[headerName]).to.equal(headerValue);
          server.close();
          done();
        });

        // thisTest sends a test header that gets add via the updateHeaders
        // callback option.
        var thisTest = function(srv, stub) {
          stub.post(path, msg, {}, _.noop);
        };
        var fullOpts = {
          updateHeaders: function(path, headers, cb) {
            headers = headers || {};
            headers[headerName] = headerValue;
            cb(headers);
          }
        };
        _.merge(fullOpts, serverOpts);
        checkClient(server, thisTest, fullOpts);
      });
      describe('single-valued, non-reserved', function() {
        it('should send headers when provided', function(done) {
          var headerName = 'name';
          var headerValue = 'value';
          var server = createServer(serverOpts, function(request, response) {
            expect(request.headers[headerName]).to.equal(headerValue);
            server.close();
            done();
          });

          // thisTest sends a test header.
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, headers, _.noop);
          };
          checkClient(server, thisTest, serverOpts);
        });
        it('should base64+rename if value is a Buffer', function(done) {
          var headerName = 'name';
          var headerValue = new Buffer('value');
          var server = createServer(serverOpts, function(request, response) {
            var want = headerValue.toString('base64');
            expect(request.headers[headerName + '-bin']).to.equal(want);
            expect(request.headers[headerName]).to.be.undefined;
            server.close();
            done();
          });

          // thisTest sends a test header with Buffer value.
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, headers, _.noop);
          };
          checkClient(server, thisTest, serverOpts);
        });
        it('should base64+rename if value is non-ascii', function(done) {
          var headerName = 'name';
          var headerValue = '\u00bd + \u00bc = \u00be';
          var server = createServer(serverOpts, function(request, response) {
            var want = new Buffer(headerValue).toString('base64');
            expect(request.headers[headerName + '-bin']).to.equal(want);
            expect(request.headers[headerName]).to.be.undefined;
            server.close();
            done();
          });

          // thisTest sends a test header with an non-ascii value
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, headers, _.noop);
          };
          checkClient(server, thisTest, serverOpts);
        });
      });
      describe('multi-valued', function() {
        it('should send headers when provided', function(done) {
          var headerName = 'name';
          var headerValue = ['value1', 'value2'];
          var server = createServer(serverOpts, function(request, response) {
            expect(request.headers[headerName]).to.deep.equal(headerValue);
            server.close();
            done();
          });

          // thisTest sends a test header with an array value
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, headers, _.noop);
          };
          checkClient(server, thisTest, serverOpts);
        });
        it('should base64+rename if any item is a Buffer', function(done) {
          var headerName = 'name';
          var headerValue = [new Buffer('value'), 'this is ascii'];
          var server = createServer(serverOpts, function(request, response) {
            var want = [
              headerValue[0].toString('base64'),
              new Buffer(headerValue[1]).toString('base64')
            ];
            expect(request.headers[headerName + '-bin']).to.deep.equal(want);
            expect(request.headers[headerName]).to.be.undefined;
            server.close();
            done();
          });

          // thisTest sends a test header with an array containing one Buffer
          // value.
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, headers, _.noop);
          };
          checkClient(server, thisTest, serverOpts);
        });
        it('should base64+rename if any item that is non-ascii', function(done) {
          var headerName = 'name';
          var headerValue = ['\u00bd + \u00bc = \u00be', 'this is ascii'];
          var server = createServer(serverOpts, function(request, response) {
            var want = [
              new Buffer(headerValue[0]).toString('base64'),
              new Buffer(headerValue[1]).toString('base64')
            ];
            expect(request.headers[headerName + '-bin']).to.deep.equal(want);
            expect(request.headers[headerName]).to.be.undefined;
            server.close();
            done();
          });
          // thisTest sends a test header with an array containing one non-ascii
          // value.
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, headers, _.noop);
          };
          checkClient(server, thisTest, serverOpts);
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
              var req = stub.post(path, msg, headers, _.noop);
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
          var server = createServer(serverOpts, function(request, response) {
            expect(request.headers[headerName]).to.equal(headerValue);
            server.close();
            done();
          });

          // thisTest sends the grpc-timeout header with a valid value.
          var headers = {};
          headers[headerName] = headerValue;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, headers, _.noop);
          };
          checkClient(server, thisTest, serverOpts);
        });
        it('should send a grpc-timeout when a deadline is provided', function(done) {
          // thisTest sends the test header.
          var headers = {};
          var testDeadline = new Date();
          var nowPlus10 = Date.now() + Math.pow(10, 4);
          testDeadline.setTime(nowPlus10);
          headers['deadline'] = testDeadline;
          var thisTest = function(srv, stub) {
            stub.post(path, msg, headers, _.noop);
          };

          var server = createServer(serverOpts, function(request, response) {
            expect(request.headers['grpc-timeout']).to.exist;
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
          headers['deadline'] = testDeadline;
          var thisTest = function(srv, stub) {
            var req = stub.post(path, msg, headers, _.noop);
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
          checkClientAndServer(thisTest, thisServer, serverOpts);
        });
      });
    });
    describe(connType + ': response metadata', function() {
      it('only emits a metadata event when any is present', function(done) {
        // thisTest checks that no metadata is set
        var thisTest = function(srv, stub) {
          stub.post(path, msg, {}, function(response) {
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
          request.on('data', function(data) {
            response.setHeader('content-type', 'not-counted-as-metadata');
            response.setHeader('user-agent', 'not-counted-as-metadata');
            response.addTrailers({
              'grpc-status': nurpc.rpcCode('OK'),
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
          stub.post(path, msg, {}, function(response) {
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
          request.on('data', function(data) {
            response.setHeader('my-header', 'my-header-value');
            response.addTrailers({
              'my-trailer': 'my-trailer-value',
              'content-type': 'this-is-reserved-and-is-not-metadata',
              'grpc-status': nurpc.rpcCode('OK'),
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
          stub.post(path, msg, {}, function(response) {
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
          request.on('data', function(data) {
            response.setHeader(
              'my-header', ['my-header-value', 'my-header-value2']);
            response.addTrailers({
              'grpc-status': nurpc.rpcCode('OK'),
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
          stub.post(path, msg, {}, function(response) {
            var theMetadata = undefined;
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
          var receiveThenReply = function(err, decoded){
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.on('data', function(data) {
            response.setHeader(
              'my-header-bin', buf.toString('base64'));
            response.addTrailers({
              'grpc-status': nurpc.rpcCode('OK'),
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
          stub.post(path, msg, {}, function(response) {
            var theMetadata = undefined;
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
          var receiveThenReply = function(err, decoded){
            encodeMessage(reply, null, makeSendEncodedResponse(response));
          };
          request.on('data', function(data) {
            response.setHeader(
              'my-header-bin', [buf.toString('base64'), buf.toString('base64')]);
            response.addTrailers({
              'grpc-status': nurpc.rpcCode('OK'),
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
              var checkError = function checkError(resp) {
                resp.on('error', function() {
                  srv.close();
                  done();
                });
              };
              stub.post(path, msg, {}, checkError);
            };

            var thisServer = function(request, response) {
              var receiveThenReply = function(err, decoded) {
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
          stub.post(path, msg, {}, function(response) {
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
          var req = stub.post(path, msg, {}, _.noop);
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
        checkClientAndServer(thisTest, thisServer, serverOpts);
      });
      it('should abort a request ok', function(done) {
        // thisTest makes a request then aborts it.
        var thisTest = function(srv, stub) {
          var req = stub.post(path, msg, {}, _.noop);
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
        checkClientAndServer(thisTest, thisServer, serverOpts);
      });
    });
  });
});

function checkClient(server, clientExpects, opts) {
  listenOnFreePort(server, function(addr, server) {
    var stubOpts = {};
    _.merge(stubOpts, addr, opts);
    clientExpects(server, new Stub(stubOpts));
  });
}

function makeServer(opts, serverExpects) {
  if (opts.plain) {
    return http2.raw.createServer(opts, serverExpects);
  } else {
    return http2.createServer(opts, serverExpects);
  }
};

function checkClientAndServer(clientExpects, serverExpects, opts) {
  checkClient(makeServer(opts, serverExpects), clientExpects, opts);
}

function makeSendEncodedResponse(response) {
  return function sendEncodedResponse(encoded) {
    response.end(encoded);
  };
}
